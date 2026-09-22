/**
 * Chargement des polices.
 *
 * Figma exige `loadFontAsync` avant toute ecriture de texte, et echoue si la
 * police n'existe pas. Une seule police manquante non anticipee fait donc
 * echouer la synchronisation au milieu de l'ecriture — le pire cas. On resout
 * donc TOUT en amont, en substituant ce qui manque.
 */

import type { DesignSpec, FontSpec } from '@sfs/spec';
import type { SyncContext } from '../context.js';

/** Ordre de repli, du plus proche au plus universel. */
const FALLBACK_FAMILIES = ['Inter', 'Roboto', 'Arial', 'Helvetica'];

/** Styles equivalents quand la graisse exacte n'est pas fournie par la police. */
const STYLE_EQUIVALENTS: Record<string, string[]> = {
  Thin: ['Extra Light', 'Light', 'Regular'],
  'Extra Light': ['Thin', 'Light', 'Regular'],
  Light: ['Extra Light', 'Regular', 'Thin'],
  Regular: ['Medium', 'Book', 'Light'],
  Medium: ['Regular', 'Semi Bold'],
  'Semi Bold': ['Bold', 'Medium'],
  Bold: ['Semi Bold', 'Extra Bold', 'Black'],
  'Extra Bold': ['Bold', 'Black'],
  Black: ['Extra Bold', 'Bold'],
  Italic: ['Regular Italic', 'Oblique', 'Regular'],
  'Medium Italic': ['Italic', 'Regular Italic', 'Medium'],
  'Semi Bold Italic': ['Bold Italic', 'Italic', 'Semi Bold'],
  'Bold Italic': ['Semi Bold Italic', 'Italic', 'Bold'],
};

const key = (font: FontName): string => `${font.family}|${font.style}`;

/** Toutes les polices citees par le spec, styles de texte compris. */
export function collectFonts(spec: DesignSpec): FontName[] {
  const wanted = new Map<string, FontName>();
  const add = (font: FontSpec): void => {
    const name: FontName = { family: font.family, style: font.style };
    wanted.set(key(name), name);
  };
  for (const style of spec.textStyles) add(style.font);
  const visit = (node: { text?: { font: FontSpec }; children: unknown[] }): void => {
    if (node.text) add(node.text.font);
    for (const child of node.children) {
      visit(child as { text?: { font: FontSpec }; children: unknown[] });
    }
  };
  for (const page of spec.pages) for (const bp of page.breakpoints) visit(bp.root);
  for (const component of spec.components) {
    visit(component.node);
    for (const variant of component.variants ?? []) visit(variant.node);
  }
  return [...wanted.values()];
}

/**
 * Charge toutes les polices necessaires et enregistre les substitutions.
 *
 * Retourne la table de repli : `applyText` la consulte pour ne jamais demander a
 * Figma une police qu'il n'a pas.
 */
export async function loadAllFonts(spec: DesignSpec, context: SyncContext): Promise<void> {
  const wanted = collectFonts(spec);
  if (wanted.length === 0) return;

  const available = await figma.listAvailableFontsAsync();
  const byFamily = new Map<string, Set<string>>();
  for (const entry of available) {
    const styles = byFamily.get(entry.fontName.family) ?? new Set<string>();
    styles.add(entry.fontName.style);
    byFamily.set(entry.fontName.family, styles);
  }

  const resolved = new Map<string, FontName>();
  const substitutions: string[] = [];

  for (const font of wanted) {
    const exact = byFamily.get(font.family);
    if (exact?.has(font.style)) {
      resolved.set(key(font), font);
      continue;
    }

    // Meme famille, style voisin : de loin la meilleure substitution.
    if (exact) {
      const candidate = [...(STYLE_EQUIVALENTS[font.style] ?? []), 'Regular'].find((style) =>
        exact.has(style),
      );
      if (candidate) {
        const replacement = { family: font.family, style: candidate };
        resolved.set(key(font), replacement);
        substitutions.push(`${font.family} ${font.style} → ${font.family} ${candidate}`);
        continue;
      }
    }

    // Famille absente : on change de famille en gardant la graisse.
    let replacement: FontName | null = null;
    for (const family of FALLBACK_FAMILIES) {
      const styles = byFamily.get(family);
      if (!styles) continue;
      const style = styles.has(font.style)
        ? font.style
        : [...(STYLE_EQUIVALENTS[font.style] ?? []), 'Regular'].find((s) => styles.has(s));
      if (style) {
        replacement = { family, style };
        break;
      }
    }
    if (!replacement) {
      const first = available[0];
      replacement = first ? first.fontName : { family: 'Roboto', style: 'Regular' };
    }
    resolved.set(key(font), replacement);
    substitutions.push(`${font.family} ${font.style} → ${replacement.family} ${replacement.style}`);
  }

  // Chargement effectif, dedoublonne.
  const toLoad = new Map<string, FontName>();
  for (const font of resolved.values()) toLoad.set(key(font), font);

  for (const font of toLoad.values()) {
    try {
      await figma.loadFontAsync(font);
      context.stats.fontsLoaded++;
    } catch (error) {
      context.warnings.push(
        `Police « ${font.family} ${font.style} » non chargee : ${String(error)}`,
      );
    }
  }

  context.fontFallbacks = resolved;

  if (substitutions.length > 0) {
    context.warnings.push(
      `${substitutions.length} police(s) substituee(s) : ${substitutions.slice(0, 6).join(' · ')}${substitutions.length > 6 ? ' …' : ''}`,
    );
  }
}

/** Police reellement utilisable pour un `FontSpec` donne. */
export function resolveFont(font: FontSpec, context: SyncContext): FontName {
  const wanted: FontName = { family: font.family, style: font.style };
  return context.fontFallbacks.get(key(wanted)) ?? wanted;
}
