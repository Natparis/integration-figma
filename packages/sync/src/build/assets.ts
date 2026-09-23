/**
 * Collecte des assets : images bitmap et SVG inline.
 *
 * Deroulement en deux temps, impose par la construction de l'arbre : les
 * identifiants d'assets doivent exister AVANT de traduire les noeuds. On parcourt
 * donc d'abord la capture pour tout enregistrer, on telecharge, puis on construit.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, BrowserContext } from 'playwright-core';
import type { AssetSpec, Diagnostic } from '@sfs/spec';
import type { RawCapture, RawNode } from '../browser/raw.js';

const shortHash = (input: string | Buffer): string =>
  createHash('sha256').update(input).digest('hex').slice(0, 12);

const MIME_EXTENSION: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/bmp': '.bmp',
};

/** Formats que Figma sait importer comme remplissage bitmap. */
const FIGMA_RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

interface PendingImage {
  id: string;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
}

export class AssetCollector {
  private readonly images = new Map<string, PendingImage>();
  private readonly svgs = new Map<string, { id: string; markup: string }>();
  private readonly resolved = new Map<string, AssetSpec>();
  private readonly failed = new Set<string>();

  constructor(
    private readonly outputDir: string,
    private readonly diagnostics: Diagnostic[],
    /** Origine servie, retiree des URL pour que les identifiants soient stables. */
    private readonly origin: string,
  ) {}

  /** Parcourt une capture et enregistre tout ce qui devra etre telecharge. */
  scan(capture: RawCapture): void {
    const walk = (node: RawNode): void => {
      for (const image of node.images) {
        if (!image.src) continue;
        this.registerImage(image.src, image.naturalWidth, image.naturalHeight);
      }
      if (node.svg) this.registerSvg(node.svg);
      node.children.forEach(walk);
    };
    walk(capture.root);
  }

  private registerImage(src: string, width: number, height: number): string {
    const existing = this.images.get(src);
    if (existing) {
      // Une meme image peut apparaitre a plusieurs tailles : on garde la plus
      // grande, pour ne pas importer une version degradee dans Figma.
      if (width * height > existing.naturalWidth * existing.naturalHeight) {
        existing.naturalWidth = width;
        existing.naturalHeight = height;
      }
      return existing.id;
    }
    const id = `img_${shortHash(stableAssetKey(src, this.origin))}`;
    this.images.set(src, { id, src, naturalWidth: width, naturalHeight: height });
    return id;
  }

  private registerSvg(markup: string): string {
    const key = shortHash(markup);
    const existing = this.svgs.get(key);
    if (existing) return existing.id;
    const id = `svg_${key}`;
    this.svgs.set(key, { id, markup });
    return id;
  }

  /** Telecharge les images et ecrit les SVG. A appeler avant la construction. */
  /**
   * Contexte navigateur, s'il est fourni : sert a reencoder les formats que
   * Figma refuse mais que Chromium sait lire (AVIF en particulier).
   */
  private navigateur: BrowserContext | null = null;

  async materialize(request: APIRequestContext, navigateur?: BrowserContext): Promise<void> {
    this.navigateur = navigateur ?? null;
    const assetsDir = path.join(this.outputDir, 'assets');
    await mkdir(assetsDir, { recursive: true });

    for (const [key, svg] of this.svgs) {
      const file = `assets/${svg.id}.svg`;
      await writeFile(path.join(this.outputDir, file), svg.markup, 'utf8');
      this.resolved.set('svg:' + key, {
        id: svg.id,
        kind: 'SVG',
        file,
        source: 'inline',
        mime: 'image/svg+xml',
        bytes: Buffer.byteLength(svg.markup),
        hash: shortHash(svg.markup),
      });
    }

    // Telechargements en petits lots : assez rapide, sans saturer un
    // hebergement mutualise.
    const pending = [...this.images.values()];
    const BATCH = 6;
    for (let i = 0; i < pending.length; i += BATCH) {
      await Promise.all(pending.slice(i, i + BATCH).map((image) => this.fetchOne(request, image, assetsDir)));
    }
  }

  /**
   * Reencode en PNG une image que Figma refuse.
   *
   * Chromium decode nativement l'AVIF, le BMP et l'ICO. On lui demande donc de
   * les dessiner dans un canvas, puis on ressort du PNG — le meme detour que
   * pour les images de video. Sans navigateur disponible, on renonce proprement.
   */
  private async reencoder(bytes: Buffer, mime: string): Promise<Buffer | null> {
    if (!this.navigateur) return null;
    const page = await this.navigateur.newPage();
    try {
      const donnees = await page.evaluate(
        async ({ b64, type }) => {
          const binaire = atob(b64);
          const octets = new Uint8Array(binaire.length);
          for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
          // Un type qui n'est pas `image/*` ferait echouer la construction du
          // Blob image ; sans type, le navigateur reconnait le format aux octets.
          const blob = type.startsWith('image/') ? new Blob([octets], { type }) : new Blob([octets]);
          const image = await createImageBitmap(blob);
          const canvas = document.createElement('canvas');
          // Plafond de largeur : une photo pleine resolution reencodee en PNG
          // depasserait vite la limite de 20 Mo de Figma.
          const largeur = Math.min(image.width, 2400);
          canvas.width = largeur;
          canvas.height = Math.max(1, Math.round((largeur * image.height) / image.width));
          const contexte = canvas.getContext('2d');
          if (!contexte) return null;
          contexte.drawImage(image, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/png');
        },
        { b64: bytes.toString('base64'), type: mime },
      );
      if (!donnees) return null;
      return Buffer.from(donnees.slice(donnees.indexOf(',') + 1), 'base64');
    } catch {
      return null;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async fetchOne(
    request: APIRequestContext,
    image: PendingImage,
    assetsDir: string,
  ): Promise<void> {
    try {
      let bytes: Buffer;
      let mime: string;

      if (image.src.startsWith('data:')) {
        const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(image.src);
        if (!match) throw new Error('URL de donnees illisible');
        mime = match[1]!;
        bytes = Buffer.from(
          match[2] ? match[3]! : decodeURIComponent(match[3]!),
          match[2] ? 'base64' : 'utf8',
        );
      } else {
        const response = await request.get(image.src, { timeout: 20000 });
        if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
        bytes = Buffer.from(await response.body());
        mime = (response.headers()['content-type'] ?? '').split(';')[0]!.trim() ||
          guessMime(image.src);
        // Un hebergement qui ne connait pas l'extension repond
        // `application/octet-stream`. L'extension du fichier en dit alors plus
        // long que l'en-tete : sans cela l'image est jugee non importable.
        if (!mime.startsWith('image/')) mime = guessMime(image.src) || mime;
      }

      if (bytes.length === 0) throw new Error('reponse vide');
      // Limite de Figma pour un remplissage bitmap.
      if (bytes.length > 20 * 1024 * 1024) {
        throw new Error(`${(bytes.length / 1048576).toFixed(1)} Mo : au-dela de la limite Figma de 20 Mo`);
      }

      if (mime === 'image/svg+xml') {
        const file = `assets/${image.id}.svg`;
        await writeFile(path.join(this.outputDir, file), bytes);
        this.resolved.set('img:' + image.src, {
          id: image.id,
          kind: 'SVG',
          file,
          source: image.src,
          mime,
          bytes: bytes.length,
          hash: shortHash(bytes),
        });
        return;
      }

      if (!FIGMA_RASTER.has(mime)) {
        // AVIF, ICO, BMP : Figma ne les accepte pas en remplissage. Chromium,
        // lui, sait les decoder — autant reencoder en PNG plutot que de laisser
        // un cadre vide dans la maquette pour une raison que le developpeur ne
        // pourra pas corriger de son cote.
        const converti = await this.reencoder(bytes, mime);
        if (converti) {
          this.diagnostics.push({
            level: 'info',
            code: 'asset-format-converted',
            message: `Image ${mime} reencodee en PNG pour Figma : ${shorten(image.src)}`,
            where: image.src,
          });
          bytes = converti;
          mime = 'image/png';
        } else {
          this.failed.add(image.src);
          this.diagnostics.push({
            level: 'warn',
            code: 'asset-format-unsupported',
            message: `Format ${mime || 'inconnu'} non importable dans Figma : ${shorten(image.src)}`,
            where: image.src,
            hint: 'Convertissez cette image en PNG, JPEG ou WebP sur le site.',
          });
          return;
        }
      }

      const file = `assets/${image.id}${MIME_EXTENSION[mime] ?? '.png'}`;
      await writeFile(path.join(assetsDir, path.basename(file)), bytes);
      const asset: AssetSpec = {
        id: image.id,
        kind: 'IMAGE',
        file,
        source: image.src,
        mime,
        bytes: bytes.length,
        hash: shortHash(bytes),
      };
      if (image.naturalWidth > 0) asset.width = image.naturalWidth;
      if (image.naturalHeight > 0) asset.height = image.naturalHeight;
      this.resolved.set('img:' + image.src, asset);
    } catch (error) {
      this.failed.add(image.src);
      this.diagnostics.push({
        level: 'warn',
        code: 'asset-download-failed',
        message: `Image non recuperee (${String(error instanceof Error ? error.message : error)}) : ${shorten(image.src)}`,
        where: image.src,
        hint: "Le noeud sera rendu sans remplissage. Verifiez que l'image est bien publiee.",
      });
    }
  }

  /** Resolveur passe au constructeur d'arbre. */
  resolver(): { imageId(src: string): string | undefined; svgId(markup: string): string | undefined } {
    return {
      imageId: (src: string) => this.resolved.get('img:' + src)?.id,
      svgId: (markup: string) => this.resolved.get('svg:' + shortHash(markup))?.id,
    };
  }

  list(): AssetSpec[] {
    return [...this.resolved.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get failureCount(): number {
    return this.failed.size;
  }
}

/**
 * Identite stable d'une image, independante de la facon dont le site est servi.
 *
 * Un export local est servi sur un port ephemere : hacher l'URL complete donnait
 * un identifiant different a chaque execution, donc une revision differente pour
 * un site inchange — et une reecriture inutile de tous les noeuds image dans
 * Figma. On retire donc l'origine quand elle est celle du site.
 */
export function stableAssetKey(src: string, origin: string): string {
  if (src.startsWith('data:')) return `data:${shortHash(src)}`;
  let originHost = '';
  try {
    originHost = origin ? new URL(origin).origin : '';
  } catch {
    originHost = '';
  }
  try {
    const url = new URL(src);
    // Asset du site lui-meme : seul le chemin identifie le fichier.
    if (originHost && url.origin === originHost) return url.pathname + url.search;
    // Asset externe (CDN, service d'images) : l'URL complete est deja stable.
    return url.href;
  } catch {
    return src;
  }
}

function guessMime(src: string): string {
  const extension = path.extname(new URL(src, 'http://x').pathname).toLowerCase();
  for (const [mime, ext] of Object.entries(MIME_EXTENSION)) {
    if (ext === extension) return mime;
  }
  return '';
}

function shorten(src: string): string {
  return src.length > 100 ? src.slice(0, 60) + '…' + src.slice(-30) : src;
}
