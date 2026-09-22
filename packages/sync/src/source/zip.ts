/**
 * Lecteur ZIP sans dependance.
 *
 * L'export d'un site tient dans quelques centaines de fichiers : inutile
 * d'ajouter une bibliotheque. On lit le repertoire central, puis chaque entree
 * (methode 0 = stocke, methode 8 = deflate, les deux seules utilisees par les
 * outils d'export courants).
 */

import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;

export interface ZipEntry {
  /** Chemin dans l'archive, separateurs normalises en `/`. */
  name: string;
  isDirectory: boolean;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {}

function findEocd(buf: Buffer): number {
  // Le commentaire d'archive peut faire jusqu'a 65535 octets : on remonte
  // depuis la fin jusqu'a trouver la signature.
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError(
    "Ce fichier n'est pas une archive ZIP valide (fin de repertoire central introuvable).",
  );
}

export function listZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);

  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_EOCD64_LOCATOR) {
    throw new ZipError(
      'Archive ZIP64 non prise en charge. Re-exportez le site, ou decompressez-le et pointez `source.path` sur le dossier.',
    );
  }

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new ZipError(`Entree ZIP corrompue a l'offset ${offset}.`);
    }
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength).replace(/\\/g, '/');

    entries.push({
      name,
      isDirectory: name.endsWith('/') || uncompressedSize === 0 && name.endsWith('/'),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  // L'en-tete local redonne les longueurs de nom et d'extra, qui peuvent
  // differer de celles du repertoire central.
  const nameLength = buf.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buf.readUInt16LE(entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const raw = buf.subarray(start, start + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(raw);
  if (entry.compressionMethod === 8) return inflateRawSync(raw);
  throw new ZipError(
    `Methode de compression ${entry.compressionMethod} non prise en charge pour « ${entry.name} ».`,
  );
}

/** Refuse tout chemin qui sortirait du dossier de destination (zip slip). */
function safeJoin(destination: string, name: string): string {
  const target = path.resolve(destination, name);
  const root = path.resolve(destination) + path.sep;
  if (!target.startsWith(root) && target !== path.resolve(destination)) {
    throw new ZipError(`Chemin d'archive refuse (sortie du dossier cible) : « ${name} ».`);
  }
  return target;
}

export interface ExtractResult {
  /** Dossier contenant le site, en descendant les dossiers racine uniques. */
  root: string;
  fileCount: number;
  bytes: number;
}

/**
 * Decompresse l'archive puis retourne la racine reelle du site. Les exports
 * enveloppent souvent tout dans un dossier unique (`mon-site/`) : on descend
 * jusqu'a trouver le niveau qui contient reellement le HTML.
 */
export async function extractZip(zipPath: string, destination: string): Promise<ExtractResult> {
  const buf = await readFile(zipPath);
  const entries = listZipEntries(buf);
  let fileCount = 0;
  let bytes = 0;

  for (const entry of entries) {
    const target = safeJoin(destination, entry.name);
    if (entry.name.endsWith('/')) {
      await mkdir(target, { recursive: true });
      continue;
    }
    // Metadonnees macOS et fichiers systeme : inutiles et bruyants.
    if (/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/i.test(entry.name)) continue;
    const data = readZipEntry(buf, entry);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    fileCount++;
    bytes += data.length;
  }

  return { root: await findSiteRoot(destination), fileCount, bytes };
}

async function findSiteRoot(dir: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  let current = dir;
  // Au plus 5 niveaux : evite de partir dans un arbre profond en cas d'export
  // inattendu.
  for (let depth = 0; depth < 5; depth++) {
    const items = await readdir(current, { withFileTypes: true });
    const visible = items.filter((item) => !item.name.startsWith('.'));
    const hasHtml = visible.some((item) => item.isFile() && /\.html?$/i.test(item.name));
    if (hasHtml) return current;
    const dirs = visible.filter((item) => item.isDirectory());
    if (dirs.length === 1 && visible.length === dirs.length) {
      current = path.join(current, dirs[0]!.name);
      continue;
    }
    return current;
  }
  return current;
}
