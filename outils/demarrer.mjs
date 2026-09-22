#!/usr/bin/env node
/**
 * Assistant de demarrage.
 *
 * Public vise : une personne qui n'utilise pas le terminal au quotidien. Le
 * script fait lui-meme tout ce qui peut l'etre, pose le minimum de questions, et
 * explique chaque echec en francais avec la marche a suivre.
 *
 * Aucun prerequis au-dela de Node.js : les dependances, la construction et le
 * navigateur sont installes a la demande.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(RACINE, 'sfs.config.json');

const C = {
  reset: '\u001b[0m', gras: '\u001b[1m', pale: '\u001b[2m',
  bleu: '\u001b[36m', vert: '\u001b[32m', jaune: '\u001b[33m', rouge: '\u001b[31m',
};
const couleurs = process.stdout.isTTY === true && !process.env.NO_COLOR;
const peindre = (texte, couleur) => (couleurs ? C[couleur] + texte + C.reset : texte);

const dire = (texte = '') => process.stdout.write(texte + '\n');
const titre = (texte) => {
  dire('');
  dire(peindre('── ' + texte + ' ' + '─'.repeat(Math.max(0, 62 - texte.length)), 'bleu'));
};
const bien = (texte) => dire('  ' + peindre('✓', 'vert') + ' ' + texte);
const info = (texte) => dire('  ' + peindre('·', 'pale') + ' ' + texte);
const alerte = (texte) => dire('  ' + peindre('!', 'jaune') + ' ' + texte);
const erreur = (texte) => dire('  ' + peindre('✗', 'rouge') + ' ' + texte);

/** Lance une commande en affichant sa sortie, et attend la fin. */
function executer(commande, args, options = {}) {
  return new Promise((resolve) => {
    const enfant = spawn(commande, args, {
      cwd: RACINE,
      stdio: options.silencieux ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      // Sous Windows, `npm` et `npx` sont des scripts : ils ont besoin du shell.
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        // Les avertissements de depreciation de Node n'appellent aucune action
        // de la part de l'utilisatrice et noient les lignes qui comptent.
        NODE_NO_WARNINGS: '1',
      },
    });
    let sortie = '';
    if (options.silencieux) {
      enfant.stdout?.on('data', (bloc) => (sortie += bloc));
      enfant.stderr?.on('data', (bloc) => (sortie += bloc));
    }
    enfant.on('error', () => resolve({ code: -1, sortie }));
    enfant.on('close', (code) => resolve({ code: code ?? -1, sortie }));
  });
}

async function principal() {
  dire('');
  dire(peindre('  Site → Figma — assistant de demarrage', 'gras'));
  dire(peindre('  Ce script prepare tout. Laissez-le travailler.', 'pale'));

  /* --------------------------- 1. Node.js ------------------------------- */

  titre('1/6  Verification de Node.js');
  const versionMajeure = Number(process.versions.node.split('.')[0]);
  if (versionMajeure < 20) {
    erreur(`Node.js ${process.versions.node} est trop ancien (il faut au moins la version 20).`);
    dire('');
    dire('    Installez la version « LTS » depuis  https://nodejs.org/fr');
    dire('    puis relancez ce script.');
    return 1;
  }
  bien(`Node.js ${process.versions.node}`);

  /* ------------------------ 2. Dependances ------------------------------ */

  titre('2/6  Installation des dependances');
  if (existsSync(path.join(RACINE, 'node_modules', 'playwright-core'))) {
    bien('Deja installees.');
  } else {
    info('Premiere installation — comptez une a deux minutes.');
    const { code } = await executer('npm', [
      'install', '--no-audit', '--no-fund', '--loglevel=error',
    ]);
    if (code !== 0) {
      erreur("L'installation a echoue.");
      dire('');
      dire('    Cause la plus frequente : pas de connexion, ou un proxy d entreprise.');
      dire('    Reessayez, et si cela persiste envoyez-moi le message ci-dessus.');
      return 1;
    }
    bien('Dependances installees.');
  }

  /* -------------------------- 3. Construction --------------------------- */

  titre('3/6  Construction du logiciel');
  const { code: codeBuild } = await executer('npm', ['run', 'build'], { silencieux: true });
  if (codeBuild !== 0) {
    erreur('La construction a echoue.');
    dire('    Relancez ce script ; si le probleme persiste, signalez-le-moi.');
    return 1;
  }
  bien('Logiciel construit (le plugin Figma est pret a etre importe).');

  /* --------------------------- 4. Navigateur ---------------------------- */

  titre('4/6  Verification du navigateur de mesure');
  const sonde = await executer(
    process.execPath,
    [path.join('packages', 'sync', 'dist', 'cli.js'), 'doctor'],
    { silencieux: true },
  );
  if (/✓ Chromium/.test(sonde.sortie)) {
    bien('Chromium est disponible.');
  } else {
    info('Telechargement de Chromium — environ 150 Mo, quelques minutes.');
    info('C est le navigateur qui visitera votre site pour le mesurer.');
    const { code } = await executer('npx', ['--yes', 'playwright', 'install', 'chromium']);
    if (code !== 0) {
      erreur('Le telechargement de Chromium a echoue.');
      dire('    Verifiez votre connexion, puis relancez ce script.');
      return 1;
    }
    bien('Chromium installe.');
  }

  /* -------------------------- 5. Configuration -------------------------- */

  titre('5/6  Configuration');

  const lecteur = createInterface({ input: process.stdin, output: process.stdout });
  let entreeFermee = false;
  lecteur.once('close', () => {
    entreeFermee = true;
  });

  /**
   * Pose une question.
   *
   * La course avec l'evenement `close` est indispensable : si l'entree est
   * fermee (script lance sans terminal, ou entree redirigee), `question()` ne se
   * resout jamais et le processus s'arreterait en silence — le pire des
   * comportements pour quelqu'un qui ne saurait pas quoi en conclure.
   */
  const demander = async (question, defaut = '') => {
    if (entreeFermee) return defaut;
    const reponse = await Promise.race([
      lecteur.question('  ' + question),
      new Promise((resoudre) => lecteur.once('close', () => resoudre(null))),
    ]);
    if (reponse === null) return defaut;
    return reponse.trim() || defaut;
  };

  // Reponses fournies en ligne de commande : permet de rejouer l'assistant sans
  // aucune question (mise en place assistee a distance, ou automatisation).
  const argument = (nom) => {
    const prefixe = `--${nom}=`;
    const trouve = process.argv.find((valeur) => valeur.startsWith(prefixe));
    return trouve ? trouve.slice(prefixe.length) : null;
  };
  const sourceArg = argument('source');
  const cleArg = argument('cle') ?? argument('file-key');

  let config = null;
  if (existsSync(CONFIG) && !sourceArg) {
    config = JSON.parse(await readFile(CONFIG, 'utf8'));
    bien(`Configuration existante : ${config.source?.path || '(source non renseignee)'}`);
    const changer = await demander('Changer de site ou de fichier Figma ? [o/N] ');
    if (!/^o/i.test(changer)) {
      lecteur.close();
      return lancer(config);
    }
  }

  if (sourceArg) info('Source fournie en ligne de commande.');
  dire('');
  dire('  Deux informations suffisent.');
  dire('');
  dire(peindre('  1) L adresse de votre site', 'gras'));
  dire(peindre('     Exemples :  https://projet.campagnesdecom.fr/', 'pale'));
  dire(peindre('                 http://localhost:8080/', 'pale'));
  dire(peindre('                 C:\\Users\\vous\\Downloads\\export-site.zip', 'pale'));
  dire('');
  const source = sourceArg ?? (await demander('Adresse ou fichier : '));
  if (!source) {
    lecteur.close();
    erreur('Aucune adresse indiquee.');
    dire('');
    if (entreeFermee) {
      dire('    Ce script attend des reponses au clavier.');
      dire('    Sous Windows : double-cliquez  demarrer.bat');
      dire('    Sous macOS   : double-cliquez  demarrer.command');
      dire('');
      dire('    Ou passez les reponses directement :');
      dire('      node outils/demarrer.mjs --source=https://mon-site.fr/ --cle=AbCdEf123456');
    }
    return 1;
  }

  dire('');
  dire(peindre('  2) La cle de votre fichier Figma', 'gras'));
  dire(peindre('     Ouvrez le fichier dans Figma, copiez son adresse. Elle ressemble a :', 'pale'));
  dire(peindre('       figma.com/design/AbCdEf123456/Mon-fichier', 'pale'));
  dire(peindre('                        ^^^^^^^^^^^^  c est cette partie', 'pale'));
  dire(peindre('     Vous pouvez coller l adresse entiere : je la lirai.', 'pale'));
  dire(peindre('     Laissez vide si vous ne l avez pas encore.', 'pale'));
  dire('');
  const cleBrute = cleArg ?? (await demander('Cle ou adresse Figma : '));
  lecteur.close();

  const fileKey = extraireCle(cleBrute);
  if (cleBrute && !fileKey) {
    alerte("Cette adresse ne ressemble pas a un lien de fichier Figma. On continue sans.");
  }

  const modele = JSON.parse(
    await readFile(path.join(RACINE, 'sfs.config.example.json'), 'utf8'),
  );
  config = {
    ...modele,
    source: { ...modele.source, path: source },
    figma: { ...modele.figma, fileKey: fileKey ?? '' },
  };
  await writeFile(CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf8');
  bien(`Configuration enregistree dans  sfs.config.json`);

  return lancer(config);
}

/** Extrait la cle d un lien Figma, ou accepte une cle deja isolee. */
function extraireCle(entree) {
  if (!entree) return null;
  const parLien = /figma\.com\/(?:design|file|board|slides)\/([0-9a-zA-Z]{22,128})/.exec(entree);
  if (parLien) return parLien[1];
  if (/^[0-9a-zA-Z]{22,128}$/.test(entree.trim())) return entree.trim();
  return null;
}

/* ----------------------------- 6. Execution ------------------------------ */

async function lancer(config) {
  titre('6/6  Lecture de votre site');
  info(`Source : ${config.source.path}`);
  info('Chaque page est ouverte a trois largeurs d ecran. Comptez une minute.');
  dire('');

  const cli = path.join('packages', 'sync', 'dist', 'cli.js');
  const { code } = await executer(process.execPath, [cli, 'extract']);
  if (code !== 0) {
    dire('');
    erreur("La lecture du site n a pas abouti.");
    dire('');
    dire('    Verifications utiles :');
    dire('      · le site s ouvre-t-il dans votre navigateur a cette adresse ?');
    dire('      · si c est une adresse locale, le serveur du site tourne-t-il ?');
    dire('      · si c est un .zip, le chemin est-il exact ?');
    dire('');
    dire('    Le message ci-dessus indique la cause. Envoyez-le-moi si besoin.');
    return 1;
  }

  dire('');
  dire(peindre('  ══ Votre site est lu. Il reste deux gestes dans Figma. ══', 'gras'));
  dire('');
  dire('  A) Importer le plugin — une seule fois, jamais a refaire :');
  dire('');
  dire('       1. ouvrez Figma (l application installee, pas le navigateur)');
  dire('       2. appuyez sur  ' + peindre('Ctrl + /', 'gras'));
  dire('       3. tapez  ' + peindre('manifest', 'gras'));
  dire('       4. choisissez « Importer un plugin depuis le manifeste »');
  dire('       5. selectionnez ce fichier :');
  dire('');
  dire('          ' + peindre(path.join(RACINE, 'packages', 'figma-plugin', 'manifest.json'), 'bleu'));
  dire('');
  dire('  B) Lancer la synchronisation :');
  dire('');
  dire('       1. ouvrez le fichier Figma qui doit recevoir la maquette');
  dire('       2. appuyez sur  ' + peindre('Ctrl + /', 'gras') + '  et tapez  ' + peindre('Site', 'gras'));
  dire('       3. lancez « Site → Figma Sync », puis cliquez sur Synchroniser');
  dire('');
  dire(peindre('  Laissez cette fenetre ouverte pendant la synchronisation.', 'jaune'));
  dire(peindre('  Fermez-la avec Ctrl + C quand vous avez fini.', 'pale'));
  dire('');

  await executer(process.execPath, [cli, 'serve']);
  return 0;
}

principal()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    dire('');
    erreur(e instanceof Error ? e.message : String(e));
    dire('');
    dire('    Copiez ce message et envoyez-le-moi : je vous dirai quoi faire.');
    process.exit(1);
  });
