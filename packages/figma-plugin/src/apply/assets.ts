/**
 * Import des images et des SVG.
 *
 * Deux provenances possibles : le relay local (`sfs serve`) ou un spec autonome
 * dont les assets sont incorpores en base64 (`sfs bundle`). Le second mode evite
 * d'avoir a lancer un serveur.
 */

import type { AssetSpec, DesignSpec } from '@sfs/spec';
import type { SyncContext } from '../context.js';

/** Contenu brut d'un asset, quelle que soit sa provenance. */
async function loadBytes(
  asset: AssetSpec,
  relayUrl: string | null,
): Promise<Uint8Array | null> {
  if (asset.data) return figma.base64Decode(asset.data);
  if (!relayUrl) return null;
  const response = await fetch(`${relayUrl.replace(/\/$/, '')}/asset/${encodeURIComponent(asset.id)}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Importe les images bitmap.
 *
 * Les SVG ne passent pas par ici : ce ne sont pas des remplissages mais des
 * arbres de formes vectorielles, crees au moment ou le noeud est construit.
 */
export async function loadImages(spec: DesignSpec, context: SyncContext): Promise<void> {
  const images = spec.assets.filter((asset) => asset.kind === 'IMAGE');
  if (images.length === 0) return;

  let index = 0;
  for (const asset of images) {
    index++;
    context.report(`Images (${index}/${images.length})`, 0.3 + (0.15 * index) / images.length);
    try {
      const bytes = await loadBytes(asset, context.options.relayUrl);
      if (!bytes) {
        context.warnings.push(
          `Image « ${asset.id} » indisponible : ni incorporee, ni relay accessible.`,
        );
        continue;
      }
      context.images.set(asset.id, figma.createImage(bytes));
      context.stats.assetsLoaded++;
    } catch (error) {
      context.warnings.push(`Image « ${asset.file} » non importee : ${String(error)}`);
    }
  }
}

/** Cache des SVG deja recuperes, pour ne les telecharger qu'une fois. */
const svgCache = new Map<string, string>();

export async function loadSvgMarkup(
  assetId: string,
  spec: DesignSpec,
  context: SyncContext,
): Promise<string | null> {
  const cached = svgCache.get(assetId);
  if (cached !== undefined) return cached;

  const asset = spec.assets.find((candidate) => candidate.id === assetId);
  if (!asset) return null;

  try {
    if (asset.data) {
      const markup = decodeUtf8(figma.base64Decode(asset.data));
      svgCache.set(assetId, markup);
      return markup;
    }
    if (!context.options.relayUrl) return null;
    const response = await fetch(
      `${context.options.relayUrl.replace(/\/$/, '')}/asset/${encodeURIComponent(assetId)}`,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const markup = await response.text();
    svgCache.set(assetId, markup);
    return markup;
  } catch (error) {
    context.warnings.push(`SVG « ${assetId} » non recupere : ${String(error)}`);
    return null;
  }
}

/** Le bac a sable du plugin n'expose pas TextDecoder : decodage manuel. */
function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i]!;
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
      i += 1;
    } else if (byte < 0xe0) {
      out += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i + 1]! & 0x3f));
      i += 2;
    } else if (byte < 0xf0) {
      out += String.fromCharCode(
        ((byte & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f),
      );
      i += 3;
    } else {
      // Hors du plan multilingue de base : encode en paire de substitution.
      const codePoint =
        ((byte & 0x07) << 18) |
        ((bytes[i + 1]! & 0x3f) << 12) |
        ((bytes[i + 2]! & 0x3f) << 6) |
        (bytes[i + 3]! & 0x3f);
      const offset = codePoint - 0x10000;
      out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
      i += 4;
    }
  }
  return out;
}

export { svgCache };
