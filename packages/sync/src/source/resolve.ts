/**
 * Resout la source configuree (archive, dossier ou URL) en une origine HTTP
 * exploitable par Chromium, plus un hash du contenu.
 *
 * Le hash sert a repondre a « est-ce que le site a bouge ? » sans relancer une
 * extraction complete : c'est ce qui rend le mode `watch` peu couteux.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import type { SourceInfo } from '@sfs/spec';
import { extractZip } from './zip.js';
import { BRANCHES_PAR_DEFAUT, reconnaitreDepot, urlArchive } from './github.js';
import { serveDirectory } from './static-server.js';
import type { StaticServer } from './static-server.js';

export interface SourceConfig {
  /** Archive `.zip`, dossier, ou URL http(s). */
  path: string;
}

export interface ResolvedSource {
  kind: SourceInfo['kind'];
  /** Origine a partir de laquelle crawler, ex. `http://127.0.0.1:53124`. */
  origin: string;
  /** Racine locale quand la source est un dossier ou une archive. */
  localRoot?: string;
  contentHash: string;
  describe: string;
  dispose(): Promise<void>;
}

/** Fichiers pertinents pour le hash de contenu : rien qui ne change le rendu. */
const HASHED_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.otf',
]);

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash('sha256');
  const files: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else if (HASHED_EXTENSIONS.has(path.extname(item.name).toLowerCase())) files.push(full);
    }
  };
  await walk(root);

  // Tri global : l'ordre de parcours du systeme de fichiers ne doit pas
  // influencer le hash.
  for (const file of files.sort()) {
    hash.update(path.relative(root, file).split(path.sep).join('/'));
    hash.update(createHash('sha256').update(await readFile(file)).digest());
  }
  return hash.digest('hex').slice(0, 32);
}

export async function resolveSource(config: SourceConfig): Promise<ResolvedSource> {
  const target = config.path.trim();

  // AVANT le cas general des URL : `https://github.com/...` est une adresse de
  // depot, pas celle d'un site. La lire en direct donnerait la page web de
  // GitHub — du code source affiche, pas le site.
  const depot = reconnaitreDepot(target);
  if (depot) return resoudreDepot(depot, target);

  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target);
    return {
      kind: 'url',
      origin: url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')),
      // Le hash d'un site distant n'est connu qu'apres le crawl : il est
      // recalcule a partir du HTML recu (voir `crawl.ts`).
      contentHash: '',
      describe: url.href,
      dispose: async () => {},
    };
  }

  const absolute = path.resolve(target);
  const info = await stat(absolute).catch(() => null);
  if (!info) {
    throw new Error(
      `Source introuvable : « ${target} ». Attendu : un fichier .zip, un dossier, ou une URL http(s).`,
    );
  }

  if (info.isFile()) {
    if (!/\.zip$/i.test(absolute)) {
      throw new Error(`« ${target} » est un fichier mais pas une archive .zip.`);
    }
    const temp = await mkdtemp(path.join(os.tmpdir(), 'sfs-zip-'));
    const { root, fileCount } = await extractZip(absolute, temp);
    const server = await serveDirectory(root);
    return {
      kind: 'zip',
      origin: server.origin,
      localRoot: root,
      contentHash: await hashDirectory(root),
      describe: `${target} (${fileCount} fichiers)`,
      dispose: async () => {
        await closeQuietly(server);
        await rm(temp, { recursive: true, force: true });
      },
    };
  }

  const server = await serveDirectory(absolute);
  return {
    kind: 'directory',
    origin: server.origin,
    localRoot: absolute,
    contentHash: await hashDirectory(absolute),
    describe: absolute,
    dispose: () => closeQuietly(server),
  };
}

/**
 * Telecharge l'archive du depot, puis suit exactement le chemin d'une archive
 * locale : meme extraction, meme serveur statique, meme hash de contenu.
 */
async function resoudreDepot(depot: ReturnType<typeof reconnaitreDepot> & object, entree: string): Promise<ResolvedSource> {
  const branches = depot.branch ? [depot.branch] : [...BRANCHES_PAR_DEFAUT];
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sfs-github-'));
  // L'archive et son contenu dans DEUX dossiers distincts.
  //
  // `findSiteRoot` ne descend dans un dossier unique que s'il est seul : laisser
  // `depot.zip` a cote de `LVMH-main/` lui faisait servir le niveau du dessus.
  // Le site repondait alors sur `/LVMH-main` — sans barre finale — et toutes les
  // ressources relatives (`./support.js`) etaient cherchees a la racine. Le
  // moteur de rendu du site ne demarrait pas, et la maquette se remplissait de
  // gabarits `{{ ... }}` au lieu du contenu.
  const archive = path.join(temp, 'depot.zip');
  const contenu = path.join(temp, 'contenu');
  await mkdir(contenu, { recursive: true });

  let derniereErreur = '';
  let telechargee = false;
  let brancheUtilisee = '';
  for (const branche of branches) {
    const reponse = await fetch(urlArchive(depot, branche)).catch((error: unknown) => {
      derniereErreur = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (!reponse) continue;
    if (!reponse.ok) {
      derniereErreur = `HTTP ${reponse.status}`;
      continue;
    }
    await writeFile(archive, Buffer.from(await reponse.arrayBuffer()));
    telechargee = true;
    brancheUtilisee = branche;
    break;
  }

  if (!telechargee) {
    await rm(temp, { recursive: true, force: true });
    throw new Error(
      `Depot GitHub illisible : ${entree} (${derniereErreur || 'branche introuvable'}).\n` +
        (depot.branch
          ? 'Verifiez le nom de la branche dans l adresse.'
          : `Aucune branche « ${BRANCHES_PAR_DEFAUT.join(' » ni « ')} » : donnez l adresse complete de la branche.`) +
        '\nUn depot prive n est pas accessible : rendez-le public, ou donnez plutot l adresse du site publie.',
    );
  }

  const { root, fileCount } = await extractZip(archive, contenu);
  // Le sous-dossier demande dans l'adresse : `/tree/main/docs` sert `docs`.
  const racine = depot.subdir ? path.join(root, depot.subdir) : root;
  const existe = await stat(racine).catch(() => null);
  if (!existe?.isDirectory()) {
    await rm(temp, { recursive: true, force: true });
    throw new Error(`Le dossier « ${depot.subdir} » n existe pas dans ce depot.`);
  }

  const server = await serveDirectory(racine);
  return {
    kind: 'github',
    origin: server.origin,
    localRoot: racine,
    contentHash: await hashDirectory(racine),
    describe: `${depot.owner}/${depot.repo} (branche ${brancheUtilisee}, ${fileCount} fichiers)`,
    dispose: async () => {
      await closeQuietly(server);
      await rm(temp, { recursive: true, force: true });
    },
  };
}

async function closeQuietly(server: StaticServer): Promise<void> {
  try {
    await server.close();
  } catch {
    /* le serveur etait deja arrete */
  }
}
