#!/usr/bin/env node
/**
 * Interface en ligne de commande.
 *
 *   sfs init                      cree un sfs.config.json commente
 *   sfs extract                   visite le site et produit le design-spec
 *   sfs diff                      compare a la derniere extraction
 *   sfs bundle                    spec autonome, assets incorpores
 *   sfs serve                     relay local pour le plugin Figma
 *   sfs sync                      extract + serve, en une commande
 *   sfs watch                     re-extrait a chaque changement du site
 *   sfs doctor                     verifie l environnement
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { diffSpecs, formatDiff, validateSpec } from '@sfs/spec';
import type { DesignSpec } from '@sfs/spec';
import { ConfigError, DEFAULT_CONFIG, loadConfig } from './config.js';
import type { SfsConfig } from './config.js';
import { Logger, logger } from './logger.js';
import { extract, readPreviousSpec } from './build/spec.js';
import { startRelay } from './relay/server.js';
import { bundleSpec } from './bundle.js';
import { ecrireRapport } from './preview/report.js';
import { BrowserNotFoundError, launchBrowser } from './browser/launch.js';

interface Args {
  command: string;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const flags = new Map<string, string | boolean>();
  for (let i = command === 'help' ? 0 : 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 0) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(token.slice(2), next);
      i++;
    } else {
      flags.set(token.slice(2), true);
    }
  }
  return { command, flags };
}

/** Options de ligne de commande traduites en surcharges de configuration. */
function overridesFrom(flags: Map<string, string | boolean>): Partial<SfsConfig> {
  const out: Partial<SfsConfig> = {};
  const source = flags.get('source');
  if (typeof source === 'string') out.source = { ...DEFAULT_CONFIG.source, path: source };
  const fileKey = flags.get('file-key');
  if (typeof fileKey === 'string') out.figma = { ...DEFAULT_CONFIG.figma, fileKey };
  const outDir = flags.get('out');
  if (typeof outDir === 'string') out.output = { ...DEFAULT_CONFIG.output, dir: outDir };
  if (flags.get('pretty')) {
    out.output = { ...(out.output ?? DEFAULT_CONFIG.output), pretty: true };
  }
  if (flags.get('no-annotations')) {
    out.output = { ...(out.output ?? DEFAULT_CONFIG.output), devAnnotations: false };
  }
  const maxPages = flags.get('max-pages');
  if (typeof maxPages === 'string') {
    out.source = { ...(out.source ?? DEFAULT_CONFIG.source), maxPages: Number(maxPages) };
  }
  const port = flags.get('port');
  if (typeof port === 'string') out.relay = { ...DEFAULT_CONFIG.relay, port: Number(port) };
  if (flags.get('verbose')) out.logLevel = 'debug';
  if (flags.get('quiet')) out.logLevel = 'warn';
  const breakpoints = flags.get('breakpoints');
  if (typeof breakpoints === 'string') {
    // « Desktop:1440,Mobile:390 » ou simplement « 1440,390 ».
    out.breakpoints = breakpoints.split(',').map((entry) => {
      const [left, right] = entry.includes(':') ? entry.split(':') : [undefined, entry];
      const width = Number(right);
      const name = left?.trim() || defaultBreakpointName(width);
      return { name, width, height: width >= 1024 ? 1024 : width >= 700 ? 1112 : 844 };
    });
  }
  return out;
}

function defaultBreakpointName(width: number): string {
  if (width >= 1200) return 'Desktop';
  if (width >= 700) return 'Tablet';
  return 'Mobile';
}

const HELP = `
site-to-figma-sync — construit et met a jour un fichier Figma depuis un site web.

  sfs init                       cree un sfs.config.json pret a remplir
  sfs doctor                     verifie que l environnement est operationnel
  sfs extract                    visite le site et produit .sfs/design-spec.json
  sfs diff                       compare le site a la derniere extraction
  sfs compare                    rapport de comparaison site / lecture (HTML)
  sfs bundle                     produit un spec autonome (assets incorpores)
  sfs serve                      lance le relay local pour le plugin Figma
  sfs sync                       extract puis serve
  sfs watch [--interval 60]      re-extrait quand le site change

Options principales
  --source <zip|dossier|url>     source du site (sinon sfs.config.json)
  --file-key <cle>               cle du fichier Figma cible
  --breakpoints 1440,834,390     largeurs a capturer
  --max-pages <n>                plafond de pages visitees
  --out <dossier>                dossier de travail (defaut .sfs)
  --pretty                       design-spec indente (3,6x plus lourd, lisible)
  --no-annotations               sans styles calcules : spec nettement plus leger
  --port <n>                     port du relay (defaut 7788)
  --config <fichier>             autre fichier de configuration
  --verbose | --quiet            niveau de journalisation

Exemples
  sfs extract --source ./export-site.zip
  sfs sync --source https://projet.exemple.fr/ --file-key AbCdEf123456
  sfs watch --source http://localhost:8080/ --interval 30
`;

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === 'help' || flags.get('help')) {
    logger.plain(HELP.trim());
    return 0;
  }
  if (command === 'version') {
    logger.plain('0.1.0');
    return 0;
  }
  if (command === 'init') return commandInit();

  const configFile = typeof flags.get('config') === 'string' ? (flags.get('config') as string) : undefined;

  if (command === 'doctor') return commandDoctor(configFile, flags);

  const { config, file } = await loadConfig(configFile, overridesFrom(flags));
  const log = new Logger(config.logLevel);
  if (file) log.debug(`Configuration : ${file}`);

  switch (command) {
    case 'extract':
      return commandExtract(config, log);
    case 'diff':
      return commandDiff(config, log);
    case 'bundle':
      return commandBundle(config, log);
    case 'compare':
      return commandCompare(config, log);
    case 'serve':
      return commandServe(config, log);
    case 'sync':
      return commandSync(config, log);
    case 'watch':
      return commandWatch(config, log, Number(flags.get('interval') ?? 60));
    default:
      log.error(`Commande inconnue : « ${command} ». Lancez \`sfs help\`.`);
      return 2;
  }
}

/* --------------------------------- commandes ------------------------------- */

const SAMPLE_CONFIG = {
  $schema: './sfs.schema.json',
  source: {
    path: 'https://projet.exemple.fr/',
    entries: ['/'],
    exclude: ['/mentions-legales', '/^\\/admin/'],
    maxPages: 40,
    settleMs: 400,
  },
  breakpoints: [
    { name: 'Desktop', width: 1440, height: 1024 },
    { name: 'Tablet', width: 834, height: 1112 },
    { name: 'Mobile', width: 390, height: 844 },
  ],
  figma: {
    fileKey: '',
    pagePrefix: 'Site',
    componentsPage: 'Composants',
    documentationPage: 'Documentation',
  },
  tokens: {
    useCssVariables: true,
    inferMissing: true,
    darkMode: true,
    themeAttribute: 'data-theme',
    collectionName: 'Design Tokens',
  },
  components: { enabled: true, minOccurrences: 3 },
  output: { dir: '.sfs', devAnnotations: true, pretty: false },
  relay: { host: '127.0.0.1', port: 7788 },
  sync: { onRemoved: 'archive' },
  logLevel: 'info',
};

async function commandInit(): Promise<number> {
  const target = path.resolve('sfs.config.json');
  try {
    await readFile(target, 'utf8');
    logger.error('sfs.config.json existe deja : je ne l ecrase pas.');
    return 1;
  } catch {
    /* le fichier n existe pas : c'est le cas attendu */
  }
  await writeFile(target, JSON.stringify(SAMPLE_CONFIG, null, 2) + '\n', 'utf8');
  logger.success(`Cree : ${target}`);
  logger.plain(
    [
      '',
      'A completer :',
      '  1. source.path    — URL du site en ligne, chemin du .zip, ou dossier local',
      '  2. figma.fileKey  — dans l URL du fichier Figma :',
      '                      figma.com/design/<CLE>/<nom>',
      '',
      'Puis :  npx sfs sync',
    ].join('\n'),
  );
  return 0;
}

async function commandDoctor(
  configFile: string | undefined,
  flags: Map<string, string | boolean>,
): Promise<number> {
  let problems = 0;
  logger.plain('Verification de l environnement\n');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  report(nodeMajor >= 20, `Node.js ${process.versions.node}`, 'Node 20 ou superieur est requis.');
  if (nodeMajor < 20) problems++;

  try {
    const { resolveBrowser } = await import('./browser/launch.js');
    const choix = resolveBrowser();
    const browser = await launchBrowser();
    const version = browser.version();
    await browser.close();
    report(true, `Chromium ${version} — ${choix?.nom ?? 'inconnu'}`, '');
    if (choix?.origine === 'systeme') {
      logger.plain(`      ${choix.executablePath}`);
    }
  } catch (error) {
    problems++;
    report(
      false,
      'Chromium',
      error instanceof BrowserNotFoundError ? error.message : String(error),
    );
    // Lister les emplacements inspectes : sans cela, il faut deviner pourquoi un
    // navigateur pourtant installe n'est pas vu.
    const { inspectedPaths } = await import('./browser/launch.js');
    logger.plain('');
    logger.plain('      Emplacements inspectes :');
    for (const chemin of inspectedPaths()) logger.plain(`        · ${chemin}`);
  }

  try {
    const { config } = await loadConfig(configFile, overridesFrom(flags));
    report(true, `Configuration lue (source : ${config.source.path})`, '');
    if (!config.figma.fileKey) {
      logger.warn('figma.fileKey est vide : le plugin demandera le fichier cible a la main.');
    }
  } catch (error) {
    problems++;
    report(false, 'Configuration', error instanceof Error ? error.message : String(error));
  }

  logger.plain('');
  if (problems === 0) logger.success('Tout est pret.');
  else logger.error(`${problems} probleme(s) a corriger.`);
  return problems === 0 ? 0 : 1;
}

function report(ok: boolean, label: string, detail: string): void {
  logger.plain(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok && detail) {
    for (const line of detail.split('\n')) logger.plain(`      ${line}`);
  }
}

async function commandExtract(config: SfsConfig, log: Logger): Promise<number> {
  // Le spec precedent doit etre lu AVANT l extraction, qui ecrase le fichier.
  const previous = await readPreviousSpec(config.output.dir);
  const { spec, outputDir } = await extract(config, log);

  const validation = validateSpec(spec);
  for (const warning of validation.warnings.slice(0, 10)) log.warn(warning);
  if (validation.warnings.length > 10) {
    log.warn(`… et ${validation.warnings.length - 10} autres avertissements de validation.`);
  }

  const diff = diffSpecs(previous, spec);
  if (previous) {
    log.plain('');
    log.plain(formatDiff(diff, 15));
  }

  printDiagnostics(spec, log);
  log.plain('');
  log.success(`Spec ecrit : ${path.join(outputDir, 'design-spec.json')}`);

  // Rapport de comparaison systematique : c'est le seul moyen de verifier ce qui
  // a ete compris sans ouvrir Figma, et il ne coute presque rien a produire.
  try {
    const rapport = await ecrireRapport(outputDir);
    log.success(`Comparaison : ${rapport.fichier}`);
    log.plain('   Ouvrez ce fichier pour voir, cote a cote, votre site et ce qui en a ete compris.');
  } catch (error) {
    log.warn(`Rapport de comparaison non produit : ${error instanceof Error ? error.message : String(error)}`);
  }

  log.plain(`Prochaine etape :  sfs serve    puis lancez le plugin dans Figma.`);
  return 0;
}

async function commandCompare(config: SfsConfig, log: Logger): Promise<number> {
  try {
    const rapport = await ecrireRapport(config.output.dir);
    log.success(
      `${rapport.fichier} — ${rapport.vues} vues, ${rapport.avecCapture} avec capture du site.`,
    );
    if (rapport.avecCapture === 0) {
      log.warn(
        'Aucune capture du site : relancez `sfs extract` (les captures sont activees par defaut).',
      );
    }
    return 0;
  } catch (error) {
    log.error(
      `Rapport impossible : ${error instanceof Error ? error.message : String(error)}`,
    );
    log.plain('   Lancez `sfs extract` au prealable.');
    return 1;
  }
}

async function commandDiff(config: SfsConfig, log: Logger): Promise<number> {
  const previous = await readPreviousSpec(config.output.dir);
  if (!previous) {
    log.error('Aucune extraction precedente. Lancez `sfs extract` une premiere fois.');
    return 1;
  }
  // On extrait dans un dossier temporaire pour ne pas ecraser la reference.
  const temporary = path.join(config.output.dir, '.diff');
  const { spec } = await extract({ ...config, output: { ...config.output, dir: temporary } }, log);
  log.plain('');
  log.plain(formatDiff(diffSpecs(previous, spec)));
  return diffSpecs(previous, spec).unchanged ? 0 : 3;
}

async function commandBundle(config: SfsConfig, log: Logger): Promise<number> {
  const result = await bundleSpec(config.output.dir, log);
  log.success(
    `${result.file} — ${(result.bytes / 1048576).toFixed(1)} Mo, ${result.embedded} assets incorpores.`,
  );
  log.plain('Deposez ce fichier dans l interface du plugin Figma : aucun serveur necessaire.');
  return 0;
}

async function commandServe(config: SfsConfig, log: Logger): Promise<number> {
  const spec = await readPreviousSpec(config.output.dir);
  if (!spec) {
    log.error('Aucun design-spec.json. Lancez `sfs extract` d abord.');
    return 1;
  }
  const relay = await startRelay({ ...config.relay, outputDir: config.output.dir, log });
  log.success(`Relay actif : ${relay.url}`);
  log.plain(
    [
      '',
      `Revision servie : ${spec.revision}  (${spec.stats.pages} pages, ${spec.stats.assets} assets)`,
      '',
      'Dans Figma :',
      '  1. ouvrez le fichier cible,',
      '  2. Plugins ▸ Developpement ▸ « Site → Figma Sync »,',
      `  3. l adresse ${relay.url} est deja proposee, cliquez sur Synchroniser.`,
      '',
      'Ctrl+C pour arreter.',
    ].join('\n'),
  );
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void relay.close().then(resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

async function commandSync(config: SfsConfig, log: Logger): Promise<number> {
  const code = await commandExtract(config, log);
  if (code !== 0) return code;
  log.plain('');
  return commandServe(config, log);
}

async function commandWatch(config: SfsConfig, log: Logger, intervalSeconds: number): Promise<number> {
  const interval = Math.max(10, intervalSeconds) * 1000;
  const relay = await startRelay({ ...config.relay, outputDir: config.output.dir, log });
  log.success(`Relay actif : ${relay.url}`);
  log.info(`Surveillance du site toutes les ${interval / 1000} s. Ctrl+C pour arreter.`);

  let lastFingerprint = '';
  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (running) {
    try {
      const fingerprint = await fingerprintSource(config);
      if (fingerprint !== lastFingerprint) {
        if (lastFingerprint) log.step('Changement detecte sur le site : re-extraction…');
        lastFingerprint = fingerprint;
        const previous = await readPreviousSpec(config.output.dir);
        const { spec } = await extract(config, log);
        const diff = diffSpecs(previous, spec);
        if (!diff.unchanged && previous) {
          log.plain(formatDiff(diff, 10));
          log.info('Relancez la synchronisation depuis le plugin pour appliquer.');
        }
      } else {
        log.debug('Aucun changement.');
      }
    } catch (error) {
      log.error(`Cycle de surveillance en echec : ${error instanceof Error ? error.message : String(error)}`);
    }
    // Attente decoupee : reagit a Ctrl+C sans attendre la fin de l intervalle.
    for (let waited = 0; waited < interval && running; waited += 500) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await relay.close();
  return 0;
}

/**
 * Empreinte legere de la source : permet de savoir s il faut re-extraire, sans
 * lancer un navigateur. Pour un site distant on ne lit que le HTML des pages
 * connues ; c'est suffisant pour detecter une republication.
 */
async function fingerprintSource(config: SfsConfig): Promise<string> {
  const target = config.source.path;
  if (!/^https?:\/\//i.test(target)) {
    const { resolveSource } = await import('./source/resolve.js');
    const source = await resolveSource({ path: target });
    await source.dispose();
    return source.contentHash;
  }
  const spec = await readPreviousSpec(config.output.dir);
  const routes = spec?.pages.map((page) => page.route) ?? ['/'];
  const hash = createHash('sha256');
  for (const route of routes.slice(0, 12)) {
    const url = new URL(route === '/' ? '/' : route, target).href;
    try {
      const response = await fetch(url, { redirect: 'follow' });
      hash.update(route);
      hash.update(await response.text());
    } catch {
      hash.update(route + ':indisponible');
    }
  }
  return hash.digest('hex').slice(0, 32);
}

function printDiagnostics(spec: DesignSpec, log: Logger): void {
  const errors = spec.diagnostics.filter((d) => d.level === 'error');
  const warnings = spec.diagnostics.filter((d) => d.level === 'warn');
  const infos = spec.diagnostics.filter((d) => d.level === 'info');

  if (errors.length > 0) {
    log.plain('');
    for (const diagnostic of errors) {
      log.error(`${diagnostic.message}${diagnostic.where ? `  [${diagnostic.where}]` : ''}`);
    }
  }
  if (warnings.length > 0) {
    log.plain('');
    for (const diagnostic of warnings.slice(0, 12)) {
      log.warn(`${diagnostic.message}${diagnostic.where ? `  [${diagnostic.where}]` : ''}`);
      if (diagnostic.hint) log.plain(`    → ${diagnostic.hint}`);
    }
    if (warnings.length > 12) log.warn(`… et ${warnings.length - 12} autres avertissements.`);
  }
  if (infos.length > 0) {
    log.plain('');
    log.info(`${infos.length} notes d extraction (detail dans design-spec.json ▸ diagnostics).`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof ConfigError) {
      logger.error(error.message);
      logger.plain('\nLancez `sfs init` pour creer un fichier de configuration.');
      process.exit(2);
    }
    if (error instanceof BrowserNotFoundError) {
      logger.error(error.message);
      process.exit(2);
    }
    logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
