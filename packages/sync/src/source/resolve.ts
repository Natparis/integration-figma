/**
 * Resout la source configuree (archive, dossier ou URL) en une origine HTTP
 * exploitable par Chromium, plus un hash du contenu.
 *
 * Le hash sert a repondre a « est-ce que le site a bouge ? » sans relancer une
 * extraction complete : c'est ce qui rend le mode `watch` peu couteux.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import type { SourceInfo } from '@sfs/spec';
import { extractZip } from './zip.js';
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

async function closeQuietly(server: StaticServer): Promise<void> {
  try {
    await server.close();
  } catch {
    /* le serveur etait deja arrete */
  }
}
