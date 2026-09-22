/**
 * Styles partages : peinture, texte, effets.
 *
 * Complementaires des variables, pas redondants : un style applique une
 * combinaison complete (police + taille + interligne) en un clic, la ou une
 * variable ne porte qu'une valeur.
 */

import type { DesignSpec, FontSpec } from '@sfs/spec';
import type { SyncContext } from '../context.js';
import { toEffects, toPaints } from './paints.js';
import { resolveFont } from './fonts.js';

export function toLineHeight(font: FontSpec): LineHeight {
  const { unit, value } = font.lineHeight;
  if (unit === 'AUTO' || value === undefined) return { unit: 'AUTO' };
  if (unit === 'PERCENT') return { unit: 'PERCENT', value };
  return { unit: 'PIXELS', value };
}

export function toLetterSpacing(font: FontSpec): LetterSpacing {
  const { unit, value } = font.letterSpacing;
  return unit === 'PERCENT' ? { unit: 'PERCENT', value } : { unit: 'PIXELS', value };
}

export async function applyStyles(spec: DesignSpec, context: SyncContext): Promise<void> {
  /* ----------------------------- peintures ------------------------------- */

  const existingPaints = await figma.getLocalPaintStylesAsync();
  const paintByName = new Map(existingPaints.map((style) => [style.name, style]));

  for (const styleSpec of spec.paintStyles) {
    let style = paintByName.get(styleSpec.name);
    if (!style) {
      style = figma.createPaintStyle();
      style.name = styleSpec.name;
    }
    style.paints = toPaints(styleSpec.paints, context);
    if (styleSpec.description) style.description = styleSpec.description;
    context.paintStyles.set(styleSpec.name, style);
    context.stats.stylesWritten++;
  }

  /* ------------------------------- textes -------------------------------- */

  const existingTexts = await figma.getLocalTextStylesAsync();
  const textByName = new Map(existingTexts.map((style) => [style.name, style]));

  for (const styleSpec of spec.textStyles) {
    let style = textByName.get(styleSpec.name);
    if (!style) {
      style = figma.createTextStyle();
      style.name = styleSpec.name;
    }
    const font = resolveFont(styleSpec.font, context);
    try {
      style.fontName = font;
      style.fontSize = Math.max(1, styleSpec.font.size);
      style.lineHeight = toLineHeight(styleSpec.font);
      style.letterSpacing = toLetterSpacing(styleSpec.font);
      style.textCase = styleSpec.textCase;
      style.textDecoration = styleSpec.textDecoration;
      style.paragraphSpacing = styleSpec.paragraphSpacing;
      if (styleSpec.description) style.description = styleSpec.description;
      context.textStyles.set(styleSpec.name, style);
      context.stats.stylesWritten++;
    } catch (error) {
      context.warnings.push(`Style de texte « ${styleSpec.name} » incomplet : ${String(error)}`);
    }
  }

  /* -------------------------------- effets ------------------------------- */

  const existingEffects = await figma.getLocalEffectStylesAsync();
  const effectByName = new Map(existingEffects.map((style) => [style.name, style]));

  for (const styleSpec of spec.effectStyles) {
    let style = effectByName.get(styleSpec.name);
    if (!style) {
      style = figma.createEffectStyle();
      style.name = styleSpec.name;
    }
    style.effects = toEffects(styleSpec.effects);
    if (styleSpec.description) style.description = styleSpec.description;
    context.effectStyles.set(styleSpec.name, style);
    context.stats.stylesWritten++;
  }
}
