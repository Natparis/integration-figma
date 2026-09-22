/**
 * Correspondance polices CSS -> polices Figma.
 *
 * Figma identifie une police par (famille, style) ou le style est un nom
 * (« Semi Bold Italic »), pas un nombre. La conversion doit etre exacte, sinon le
 * plugin ne trouve pas la police et le texte tombe sur un substitut.
 */

import type { FontSpec } from '@sfs/spec';
import { px } from './css-map.js';

const WEIGHT_NAMES: Array<[number, string]> = [
  [100, 'Thin'],
  [200, 'Extra Light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semi Bold'],
  [700, 'Bold'],
  [800, 'Extra Bold'],
  [900, 'Black'],
];

/** Familles generiques CSS : remplacees par une police reellement presente. */
const GENERIC_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
]);

/** Piles systeme courantes : leur premier element n'est jamais installe. */
const SYSTEM_STACK = new Set([
  '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica neue',
  'apple color emoji', 'segoe ui emoji', 'segoe ui symbol', 'noto color emoji',
]);

export const GENERIC_FALLBACKS: Record<string, string> = {
  'sans-serif': 'Inter',
  'system-ui': 'Inter',
  'ui-sans-serif': 'Inter',
  serif: 'Source Serif 4',
  'ui-serif': 'Source Serif 4',
  monospace: 'Roboto Mono',
  'ui-monospace': 'Roboto Mono',
  cursive: 'Inter',
  fantasy: 'Inter',
};

/** Decoupe une pile `font-family` en familles nettoyees de leurs guillemets. */
export function parseFontStack(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Choisit la famille a demander a Figma : la premiere de la pile qui soit une
 * vraie police, en ignorant les polices systeme et les generiques.
 */
export function resolveFamily(stack: string[]): { family: string; substituted: boolean } {
  for (const candidate of stack) {
    const lower = candidate.toLowerCase();
    if (GENERIC_FAMILIES.has(lower) || SYSTEM_STACK.has(lower)) continue;
    return { family: candidate, substituted: false };
  }
  // Toute la pile est generique ou systeme : on prend un equivalent disponible.
  for (const candidate of stack) {
    const fallback = GENERIC_FALLBACKS[candidate.toLowerCase()];
    if (fallback) return { family: fallback, substituted: true };
  }
  return { family: 'Inter', substituted: true };
}

export function weightToStyleName(weight: number): string {
  let best = WEIGHT_NAMES[3]!;
  let distance = Infinity;
  for (const entry of WEIGHT_NAMES) {
    const d = Math.abs(entry[0] - weight);
    if (d < distance) {
      distance = d;
      best = entry;
    }
  }
  return best[1];
}

/** Nom de style Figma complet : « Semi Bold Italic ». */
export function figmaStyleName(weight: number, italic: boolean): string {
  const base = weightToStyleName(weight);
  if (!italic) return base;
  return base === 'Regular' ? 'Italic' : `${base} Italic`;
}

export interface FontInput {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  fontStyle?: string;
  lineHeight?: string;
  letterSpacing?: string;
}

export function buildFont(input: FontInput): { font: FontSpec; substituted: boolean } {
  const stack = parseFontStack(input.fontFamily);
  const { family, substituted } = resolveFamily(stack);

  // `font-weight` calcule peut valoir « bold » / « normal » sur d'anciens sites.
  const rawWeight = (input.fontWeight ?? '400').trim();
  const weight =
    rawWeight === 'bold' ? 700 : rawWeight === 'normal' ? 400 : parseInt(rawWeight, 10) || 400;
  const italic = (input.fontStyle ?? 'normal').startsWith('italic') ||
    (input.fontStyle ?? '').startsWith('oblique');

  const size = px(input.fontSize, 16);

  // `line-height: normal` n'a pas de valeur numerique : c'est exactement ce que
  // represente le mode AUTO de Figma.
  const lineHeightRaw = (input.lineHeight ?? 'normal').trim();
  const lineHeight: FontSpec['lineHeight'] =
    lineHeightRaw === 'normal'
      ? { unit: 'AUTO' }
      : lineHeightRaw.endsWith('%')
        ? { unit: 'PERCENT', value: parseFloat(lineHeightRaw) }
        : { unit: 'PIXELS', value: px(lineHeightRaw, size * 1.2) };

  const spacingRaw = (input.letterSpacing ?? 'normal').trim();
  const letterSpacing: FontSpec['letterSpacing'] =
    spacingRaw === 'normal'
      ? { unit: 'PIXELS', value: 0 }
      : spacingRaw.endsWith('%')
        ? { unit: 'PERCENT', value: parseFloat(spacingRaw) }
        : { unit: 'PIXELS', value: px(spacingRaw, 0) };

  return {
    font: {
      family,
      style: figmaStyleName(weight, italic),
      weight,
      italic,
      size: Math.round(size * 100) / 100,
      lineHeight,
      letterSpacing,
    },
    substituted,
  };
}
