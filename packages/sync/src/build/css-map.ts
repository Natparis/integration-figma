/**
 * Traduction des styles calcules CSS vers les primitives Figma :
 * remplissages, contours, rayons, effets.
 */

import type { Effect, Paint, RGB } from '@sfs/spec';
import { parseColor } from './color.js';
import type { Rgba } from './color.js';

export const px = (value: string | undefined, fallback = 0): number => {
  if (!value) return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

export const rgbOf = (c: Rgba): RGB => ({ r: c.r, g: c.g, b: c.b });

/** Decoupe sur les virgules de premier niveau : les couleurs en contiennent. */
export function splitTopLevel(input: string, separator = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === separator && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/* ------------------------------- degrades -------------------------------- */

const DIRECTION_ANGLES: Record<string, number> = {
  'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
  'to top right': 45, 'to right top': 45,
  'to bottom right': 135, 'to right bottom': 135,
  'to bottom left': 225, 'to left bottom': 225,
  'to top left': 315, 'to left top': 315,
};

function parseAngle(token: string): number | null {
  const normalized = token.trim().toLowerCase();
  if (normalized in DIRECTION_ANGLES) return DIRECTION_ANGLES[normalized]!;
  const match = /^(-?[\d.]+)(deg|grad|rad|turn)$/.exec(normalized);
  if (!match) return null;
  const value = parseFloat(match[1]!);
  switch (match[2]) {
    case 'turn': return value * 360;
    case 'rad': return (value * 180) / Math.PI;
    case 'grad': return value * 0.9;
    default: return value;
  }
}

/**
 * Analyse un `linear-gradient` / `radial-gradient` / `conic-gradient`.
 *
 * Les positions d'arret manquantes sont interpolees comme le fait le navigateur :
 * repartition uniforme entre les arrets connus.
 */
export function parseGradient(value: string): Paint | null {
  const match = /^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/i.exec(value.trim());
  if (!match) return null;
  const family = match[2]!.toLowerCase();
  const args = splitTopLevel(match[3]!);
  if (args.length === 0) return null;

  let angle = family === 'linear' ? 180 : 0;
  let start = 0;
  const first = args[0]!;
  const explicitAngle = parseAngle(first);
  if (explicitAngle !== null) {
    angle = explicitAngle;
    start = 1;
  } else if (/^(at|circle|ellipse|closest|farthest|from)\b/i.test(first)) {
    // Geometrie de degrade radial/conique : Figma ne la reproduit pas
    // exactement, on garde l'orientation par defaut.
    start = 1;
  }

  const stops: Array<{ position: number | null; color: Rgba }> = [];
  for (const arg of args.slice(start)) {
    // Un arret peut porter deux positions (`red 10% 20%`) : on prend la premiere.
    const parts = arg.trim().split(/\s+(?=[\d.-]+(?:%|px|em|rem)?$)/);
    const colorText = parts[0]!.trim();
    const color = parseColor(colorText);
    if (!color) continue;
    const positionText = arg.slice(colorText.length).trim().split(/\s+/)[0];
    let position: number | null = null;
    if (positionText?.endsWith('%')) position = parseFloat(positionText) / 100;
    else if (positionText && /^[\d.-]+px$/.test(positionText)) position = null;
    stops.push({ position, color });
  }
  if (stops.length < 2) return null;

  // Interpolation des positions absentes, comme le navigateur.
  if (stops[0]!.position === null) stops[0]!.position = 0;
  if (stops[stops.length - 1]!.position === null) stops[stops.length - 1]!.position = 1;
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i]!.position !== null) continue;
    let next = i + 1;
    while (next < stops.length && stops[next]!.position === null) next++;
    const from = stops[i - 1]!.position!;
    const to = stops[next]?.position ?? 1;
    const span = next - (i - 1);
    for (let k = i; k < next; k++) {
      stops[k]!.position = from + ((to - from) * (k - (i - 1))) / span;
    }
    i = next - 1;
  }

  const type =
    family === 'linear' ? 'GRADIENT_LINEAR' : family === 'radial' ? 'GRADIENT_RADIAL' : 'GRADIENT_ANGULAR';

  return {
    type,
    angle,
    opacity: 1,
    stops: stops.map((stop) => ({
      position: Math.min(1, Math.max(0, stop.position ?? 0)),
      color: { r: stop.color.r, g: stop.color.g, b: stop.color.b, a: stop.color.a },
    })),
  };
}

/* ----------------------------- remplissages ------------------------------ */

export interface FillContext {
  /** `background-color` calcule. */
  backgroundColor?: string;
  /** `background-image` calcule : degrades et/ou url(). */
  backgroundImage?: string;
  backgroundSize?: string;
  /** Identifiants d'assets deja resolus pour les url() de cet element. */
  imageAssetIds?: string[];
}

/**
 * Construit la pile de remplissages Figma.
 *
 * Attention a l'ordre : en CSS, `background-image` se peint AU-DESSUS de
 * `background-color`, et les images multiples se peignent de la premiere a la
 * derniere, la premiere devant. Dans Figma, le dernier remplissage de la liste
 * est au-dessus. On inverse donc.
 */
export function buildFills(context: FillContext): Paint[] {
  const fills: Paint[] = [];

  const background = parseColor(context.backgroundColor);
  if (background && background.a > 0) {
    fills.push({ type: 'SOLID', color: rgbOf(background), opacity: background.a });
  }

  const image = context.backgroundImage;
  if (image && image !== 'none') {
    const layers = splitTopLevel(image);
    let assetIndex = 0;
    const built: Paint[] = [];
    for (const layer of layers) {
      if (/^(repeating-)?(linear|radial|conic)-gradient\(/i.test(layer)) {
        const gradient = parseGradient(layer);
        if (gradient) built.push(gradient);
        continue;
      }
      if (/^url\(/i.test(layer)) {
        const assetId = context.imageAssetIds?.[assetIndex++];
        if (!assetId) continue;
        const size = (context.backgroundSize ?? 'auto').toLowerCase();
        built.push({
          type: 'IMAGE',
          assetId,
          scaleMode: size.includes('contain') ? 'FIT' : size === 'auto' ? 'TILE' : 'FILL',
          opacity: 1,
        });
      }
    }
    // Premiere couche CSS = devant ; dernier remplissage Figma = devant.
    fills.push(...built.reverse());
  }

  return fills;
}

/* -------------------------------- contours ------------------------------- */

export interface BorderSides {
  top: { width: number; style: string; color: string | undefined };
  right: { width: number; style: string; color: string | undefined };
  bottom: { width: number; style: string; color: string | undefined };
  left: { width: number; style: string; color: string | undefined };
}

export interface StrokeResult {
  strokes: Paint[];
  strokeWeight: number;
  individualStrokeWeights?: { top: number; right: number; bottom: number; left: number };
  dashPattern?: number[];
}

export function buildStrokes(sides: BorderSides): StrokeResult {
  const active = (['top', 'right', 'bottom', 'left'] as const).filter((side) => {
    const s = sides[side];
    return s.width > 0 && s.style !== 'none' && s.style !== 'hidden';
  });
  if (active.length === 0) return { strokes: [], strokeWeight: 0 };

  // Figma n'a qu'une couleur de contour par noeud : on prend celle du cote le
  // plus epais, qui est visuellement dominant.
  const dominant = active.reduce((a, b) => (sides[b].width > sides[a].width ? b : a));
  const color = parseColor(sides[dominant].color);
  if (!color || color.a === 0) return { strokes: [], strokeWeight: 0 };

  const widths = {
    top: sides.top.width, right: sides.right.width,
    bottom: sides.bottom.width, left: sides.left.width,
  };
  const uniform =
    widths.top === widths.right && widths.right === widths.bottom && widths.bottom === widths.left;

  const result: StrokeResult = {
    strokes: [{ type: 'SOLID', color: rgbOf(color), opacity: color.a }],
    strokeWeight: sides[dominant].width,
  };
  // Bordure sur un seul cote (separateurs, soulignements) : tres courant, et
  // Figma sait le representer exactement.
  if (!uniform) result.individualStrokeWeights = widths;

  const style = sides[dominant].style;
  if (style === 'dashed') result.dashPattern = [sides[dominant].width * 3, sides[dominant].width * 2];
  else if (style === 'dotted') result.dashPattern = [sides[dominant].width, sides[dominant].width * 1.5];

  return result;
}

/* --------------------------------- effets -------------------------------- */

/**
 * Analyse `box-shadow`. Le format calcule de Chromium place la couleur en tete :
 * `rgba(0, 0, 0, 0.1) 0px 4px 6px -1px`, eventuellement avec `inset`.
 */
export function parseBoxShadow(value: string | undefined): Effect[] {
  if (!value || value === 'none') return [];
  const out: Effect[] = [];
  for (const shadow of splitTopLevel(value)) {
    let text = shadow.trim();
    const inset = /(^|\s)inset(\s|$)/.test(text);
    text = text.replace(/(^|\s)inset(\s|$)/, ' ').trim();

    // La couleur peut etre en tete ou en queue selon la source.
    let color: Rgba | null = null;
    const colorMatch = /(?:^|\s)((?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|#[0-9a-f]{3,8})/i.exec(text);
    if (colorMatch) {
      color = parseColor(colorMatch[1]!);
      text = text.replace(colorMatch[1]!, ' ').trim();
    }
    const numbers = text.split(/\s+/).filter((t) => /^-?[\d.]+(px|r?em|%)?$/.test(t)).map((t) => px(t));
    if (numbers.length < 2) continue;

    // Une ombre de couleur nulle ou entierement transparente n'ajoute rien.
    if (color && color.a === 0) continue;
    const resolved = color ?? { r: 0, g: 0, b: 0, a: 1 };

    out.push({
      type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: { r: resolved.r, g: resolved.g, b: resolved.b, a: resolved.a },
      offset: { x: numbers[0]!, y: numbers[1]! },
      radius: Math.max(0, numbers[2] ?? 0),
      spread: numbers[3] ?? 0,
    });
  }
  return out;
}

/** `filter: blur(8px)` -> flou de calque ; `backdrop-filter` -> flou d'arriere-plan. */
export function parseBlur(
  filter: string | undefined,
  kind: 'LAYER_BLUR' | 'BACKGROUND_BLUR',
): Effect[] {
  if (!filter || filter === 'none') return [];
  const match = /blur\(([\d.]+)(px|r?em)?\)/i.exec(filter);
  if (!match) return [];
  const radius = px(match[1]! + (match[2] ?? 'px'));
  if (radius <= 0) return [];
  return [{ type: kind, radius }];
}

/** `drop-shadow()` dans `filter` : frequent sur les icones et les logos. */
export function parseFilterDropShadow(filter: string | undefined): Effect[] {
  if (!filter || filter === 'none') return [];
  const out: Effect[] = [];
  const pattern = /drop-shadow\(([^)]*(?:\([^)]*\))?[^)]*)\)/gi;
  let match = pattern.exec(filter);
  while (match) {
    const shadows = parseBoxShadow(match[1]!);
    out.push(...shadows.map((s) => ({ ...s, type: 'DROP_SHADOW' as const })));
    match = pattern.exec(filter);
  }
  return out;
}

/* --------------------------------- rayons -------------------------------- */

/**
 * Rayons de coins, dans l'ordre Figma [hg, hd, bd, bg].
 *
 * Un rayon en pourcentage (`border-radius: 50%` pour un cercle) est resolu en
 * pixels d'apres la taille reelle de la boite.
 */
export function cornerRadii(
  style: Record<string, string>,
  box: { w: number; h: number },
): [number, number, number, number] {
  const resolve = (value: string | undefined): number => {
    if (!value) return 0;
    // Chromium peut renvoyer deux valeurs pour un rayon elliptique : on garde la
    // premiere, Figma n'ayant pas de coins elliptiques.
    const first = value.trim().split(/\s+/)[0]!;
    if (first.endsWith('%')) {
      return (parseFloat(first) / 100) * Math.min(box.w, box.h);
    }
    return Math.max(0, px(first));
  };
  const radii: [number, number, number, number] = [
    resolve(style.borderTopLeftRadius),
    resolve(style.borderTopRightRadius),
    resolve(style.borderBottomRightRadius),
    resolve(style.borderBottomLeftRadius),
  ];
  // Un rayon ne peut pas depasser la moitie de la plus petite dimension.
  const cap = Math.min(box.w, box.h) / 2;
  return radii.map((r) => Math.min(r, cap || r)) as [number, number, number, number];
}

/** Lit `transform: matrix(...)` pour recuperer une rotation simple. */
export function rotationFromTransform(transform: string | undefined): number {
  if (!transform || transform === 'none') return 0;
  const matrix = /^matrix\(([^)]+)\)$/.exec(transform.trim());
  if (matrix) {
    const [a, b] = matrix[1]!.split(',').map((v) => parseFloat(v));
    if (a !== undefined && b !== undefined) {
      return -(Math.atan2(b, a) * 180) / Math.PI;
    }
  }
  const rotate = /rotate\((-?[\d.]+)deg\)/.exec(transform);
  if (rotate) return -parseFloat(rotate[1]!);
  return 0;
}
