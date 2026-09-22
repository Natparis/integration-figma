/**
 * Design tokens et styles partages.
 *
 * Principe directeur : le CSS du site est la source de verite. Un site construit
 * avec des variables `:root` porte deja son systeme de design — noms compris. On
 * le transpose tel quel en variables Figma plutot que de deviner. L'inference par
 * analyse statistique n'intervient qu'en complement, pour ce que le CSS ne
 * declare pas.
 *
 * C'est ce qui permet au developpeur de retrouver dans Figma les memes noms que
 * dans le code, et a la cliente de changer une couleur a un seul endroit.
 */

import type {
  EffectStyleSpec, PaintStyleSpec, RGBA, TextStyleSpec, TokenCollection, VariableSpec,
} from '@sfs/spec';
import { hashValue } from '@sfs/spec';
import type { Diagnostic } from '@sfs/spec';
import type { RawCapture, RawNode } from '../browser/raw.js';
import { hsl, luminance, parseColor, toHex } from './color.js';
import type { Rgba } from './color.js';
import { parseBoxShadow, px } from './css-map.js';
import { buildFont } from './fonts.js';
import type { TokenBinder } from './tree.js';

/* ------------------------------ nomenclature ------------------------------ */

/** Familles reconnues dans les noms de variables CSS. */
const COLOR_HINTS = /^(color|colour|bg|background|fg|foreground|text|border|surface|brand|accent|primary|secondary|tertiary|muted|neutral|success|warning|danger|error|info|ring|outline|shadow|overlay|link|card|popover|input|destructive|chart|sidebar)$/;
const RADIUS_HINTS = /^(radius|rounded|corner)$/;
const SPACE_HINTS = /^(space|spacing|gap|inset|gutter)$/;
const FONT_SIZE_HINTS = /^(font|fontsize|text|size|leading|tracking)$/;

/**
 * `--color-brand-600` -> `color/brand/600`.
 *
 * Figma regroupe les variables par `/`. On reproduit la hierarchie deja presente
 * dans le nom CSS, en evitant les doublons de segment (`color/color/...`) et en
 * bornant la profondeur a 3 : au-dela, le panneau Figma devient illisible.
 */
const FAMILY_HEADS = [COLOR_HINTS, RADIUS_HINTS, SPACE_HINTS, FONT_SIZE_HINTS];

export function variableNameFromCss(cssName: string, family: string): string {
  const raw = cssName.replace(/^--/, '');
  let segments = raw.split(/-+/).filter(Boolean);
  if (segments.length === 0) return `${family}/inconnu`;

  const head = segments[0]!.toLowerCase();
  // On ne decoupe en niveaux que si le nom CSS porte lui-meme une hierarchie,
  // reconnaissable a son premier segment. Sinon `--max-width` deviendrait
  // `size/max/width`, ce qui n'a aucun sens dans le panneau Figma.
  const hierarchical =
    head === family.toLowerCase() || FAMILY_HEADS.some((pattern) => pattern.test(head));
  if (!hierarchical) return `${family}/${segments.join('-')}`;

  if (head === family.toLowerCase()) segments = segments.slice(1);
  if (segments.length === 0) return family;

  if (segments.length > 3) {
    segments = [segments[0]!, segments[1]!, segments.slice(2).join('-')];
  }
  return `${family}/${segments.join('/')}`;
}

/** Determine la famille (et donc le type) d'une variable CSS d'apres sa valeur. */
export function classifyVariable(
  cssName: string,
  value: string,
): { family: string; type: VariableSpec['type'] } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Une variable qui pointe vers une autre variable n'a pas de valeur propre a
  // transposer : Figma resoudra via l'alias, ou la valeur calculee suffira.
  if (trimmed.startsWith('var(')) return null;

  if (parseColor(trimmed)) return { family: 'color', type: 'COLOR' };

  const segments = cssName.replace(/^--/, '').split(/-+/);
  const head = (segments[0] ?? '').toLowerCase();

  if (/^-?[\d.]+(px|rem|em)$/.test(trimmed)) {
    if (RADIUS_HINTS.test(head)) return { family: 'radius', type: 'FLOAT' };
    if (SPACE_HINTS.test(head)) return { family: 'space', type: 'FLOAT' };
    if (FONT_SIZE_HINTS.test(head)) return { family: 'font-size', type: 'FLOAT' };
    return { family: 'size', type: 'FLOAT' };
  }
  if (/^-?[\d.]+$/.test(trimmed)) return { family: 'number', type: 'FLOAT' };
  if (/^-?[\d.]+m?s$/.test(trimmed)) return { family: 'duration', type: 'FLOAT' };
  if (COLOR_HINTS.test(head)) return null;
  // Chaines : piles de polices, courbes d'animation, ombres composees.
  if (trimmed.length <= 200) return { family: 'string', type: 'STRING' };
  return null;
}

/** Convertit une longueur CSS en pixels (1rem = 16px, convention du web). */
function lengthToPx(value: string): number | null {
  const match = /^(-?[\d.]+)(px|rem|em)$/.exec(value.trim());
  if (!match) return null;
  const n = parseFloat(match[1]!);
  if (!Number.isFinite(n)) return null;
  return match[2] === 'px' ? n : n * 16;
}

/* --------------------------------- analyse -------------------------------- */

interface FontUsage {
  key: string;
  family: string;
  style: string;
  size: number;
  lineHeight: string;
  letterSpacing: string;
  textCase: string;
  decoration: string;
  /** Balises HTML qui utilisent cette combinaison, avec leur decompte. */
  tags: Map<string, number>;
  /** Breakpoints ou cette combinaison apparait, avec leur decompte. */
  breakpoints: Map<string, number>;
  count: number;
}

export interface Analysis {
  colors: Map<string, { color: Rgba; count: number }>;
  fonts: Map<string, FontUsage>;
  spacings: Map<number, number>;
  radii: Map<number, number>;
  shadows: Map<string, { signature: string; css: string; blur: number; count: number }>;
}

export function analyzeCaptures(captures: RawCapture[]): Analysis {
  const analysis: Analysis = {
    colors: new Map(),
    fonts: new Map(),
    spacings: new Map(),
    radii: new Map(),
    shadows: new Map(),
  };

  const addColor = (value: string | undefined): void => {
    const color = parseColor(value);
    if (!color || color.a < 0.05) return;
    const key = toHex(color);
    const entry = analysis.colors.get(key);
    if (entry) entry.count++;
    else analysis.colors.set(key, { color, count: 1 });
  };

  const bump = <K>(map: Map<K, number>, key: K): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  let breakpoint = '';
  const walk = (node: RawNode): void => {
    const style = node.style;
    addColor(style.backgroundColor);
    addColor(style.color);
    addColor(style.borderTopColor);
    addColor(style.borderBottomColor);

    for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap'] as const) {
      const value = style[prop];
      if (!value || value === 'normal') continue;
      const n = px(value);
      if (n > 0 && n <= 200) bump(analysis.spacings, Math.round(n));
    }
    for (const prop of ['borderTopLeftRadius', 'borderTopRightRadius'] as const) {
      const value = style[prop];
      if (!value) continue;
      const n = px(value);
      if (n > 0 && n <= 100) bump(analysis.radii, Math.round(n));
    }

    if (style.boxShadow && style.boxShadow !== 'none') {
      for (const effect of parseBoxShadow(style.boxShadow)) {
        const signature = hashValue(effect);
        const entry = analysis.shadows.get(signature);
        if (entry) entry.count++;
        else {
          analysis.shadows.set(signature, {
            signature,
            css: style.boxShadow,
            blur: effect.radius,
            count: 1,
          });
        }
      }
    }

    if (node.text?.characters) {
      const dominant = node.text.runs[0];
      const { font } = buildFont({
        fontFamily: dominant?.fontFamily ?? style.fontFamily,
        fontSize: dominant?.fontSize ?? style.fontSize,
        fontWeight: dominant?.fontWeight ?? style.fontWeight,
        fontStyle: dominant?.fontStyle ?? style.fontStyle,
        lineHeight: style.lineHeight,
        letterSpacing: dominant?.letterSpacing ?? style.letterSpacing,
      });
      const textCase = (style.textTransform ?? 'none').trim();
      const decoration = (dominant?.textDecorationLine ?? style.textDecorationLine ?? 'none').trim();
      const key = [
        font.family, font.style, font.size,
        JSON.stringify(font.lineHeight), JSON.stringify(font.letterSpacing),
        textCase, decoration,
      ].join('|');

      const existing = analysis.fonts.get(key);
      const tag = node.seg.tag;
      if (existing) {
        existing.count++;
        existing.tags.set(tag, (existing.tags.get(tag) ?? 0) + 1);
        existing.breakpoints.set(breakpoint, (existing.breakpoints.get(breakpoint) ?? 0) + 1);
      } else {
        analysis.fonts.set(key, {
          key,
          family: font.family,
          style: font.style,
          size: font.size,
          lineHeight: JSON.stringify(font.lineHeight),
          letterSpacing: JSON.stringify(font.letterSpacing),
          textCase,
          decoration,
          tags: new Map([[tag, 1]]),
          breakpoints: new Map([[breakpoint, 1]]),
          count: 1,
        });
      }
    }

    node.children.forEach(walk);
  };

  for (const capture of captures) {
    breakpoint = capture.breakpointName ?? 'Desktop';
    walk(capture.root);
  }
  return analysis;
}

/* ------------------------------- construction ----------------------------- */

export interface TokenBuildOptions {
  collectionName: string;
  useCssVariables: boolean;
  inferMissing: boolean;
  /** Variables `:root` relevees en mode clair (valeurs calculees). */
  lightVariables: Record<string, string>;
  /** Variables `:root` relevees en mode sombre, si le site en a un. */
  darkVariables: Record<string, string> | null;
  /** Valeurs DECLAREES en mode clair, `var(...)` compris : sert aux alias. */
  declaredVariables: Record<string, string>;
  /** Nom du breakpoint de reference, pour nommer les styles de texte. */
  primaryBreakpoint: string;
}

export interface TokenResult {
  collections: TokenCollection[];
  paintStyles: PaintStyleSpec[];
  textStyles: TextStyleSpec[];
  effectStyles: EffectStyleSpec[];
  binder: TokenBinder;
}

const LIGHT = 'Clair';
const DARK = 'Sombre';

export function buildTokens(
  analysis: Analysis,
  options: TokenBuildOptions,
  diagnostics: Diagnostic[],
): TokenResult {
  const variables: VariableSpec[] = [];
  const hasDark =
    options.darkVariables !== null &&
    Object.entries(options.darkVariables).some(
      ([name, value]) => options.lightVariables[name] !== value,
    );
  const modes = hasDark ? [LIGHT, DARK] : [LIGHT];

  /* --- 1. les variables CSS du site, transposees telles quelles --- */

  const colorToVariable = new Map<string, string[]>();
  const spaceToVariable = new Map<number, string>();
  const radiusToVariable = new Map<number, string>();
  const usedNames = new Set<string>();

  const aliasNames = new Set<string>();

  if (options.useCssVariables) {
    // Premiere passe : attribuer les noms Figma. Necessaire avant la seconde,
    // car un alias doit pouvoir designer le nom Figma de sa cible.
    const planned: Array<{
      cssName: string;
      value: string;
      name: string;
      classified: NonNullable<ReturnType<typeof classifyVariable>>;
    }> = [];
    for (const [cssName, value] of Object.entries(options.lightVariables).sort()) {
      const classified = classifyVariable(cssName, value);
      if (!classified) continue;
      let name = variableNameFromCss(cssName, classified.family);
      // Deux variables CSS peuvent produire le meme nom Figma apres conversion.
      if (usedNames.has(name)) {
        let suffix = 2;
        while (usedNames.has(`${name}-${suffix}`)) suffix++;
        name = `${name}-${suffix}`;
      }
      usedNames.add(name);
      planned.push({ cssName, value, name, classified });
    }
    const cssToFigma = new Map(planned.map((entry) => [entry.cssName, entry.name]));

    for (const { cssName, value, name, classified } of planned) {
      const darkValue = hasDark ? options.darkVariables?.[cssName] : undefined;
      const variable: VariableSpec = {
        name,
        type: classified.type,
        valuesByMode: {},
        cssVariable: cssName,
      };

      // Alias : `--color-text: var(--color-neutral-900)`. On reproduit
      // l'indirection plutot que de copier la couleur, pour que modifier la cible
      // dans Figma mette bien a jour tout ce qui en depend.
      const declared = options.declaredVariables[cssName];
      const aliasTarget = /^var\(\s*(--[\w-]+)/.exec(declared ?? '')?.[1];
      if (aliasTarget) {
        const targetName = cssToFigma.get(aliasTarget);
        const targetType = planned.find((entry) => entry.cssName === aliasTarget)?.classified.type;
        if (targetName && targetName !== name && targetType === classified.type) {
          variable.aliasOf = targetName;
          aliasNames.add(name);
        }
      }

      if (classified.type === 'COLOR') {
        const light = parseColor(value);
        if (!light) continue;
        variable.valuesByMode[LIGHT] = toRgba(light);
        if (hasDark) {
          const dark = parseColor(darkValue ?? value) ?? light;
          variable.valuesByMode[DARK] = toRgba(dark);
        }
        const hex = toHex(light);
        const list = colorToVariable.get(hex) ?? [];
        list.push(name);
        colorToVariable.set(hex, list);
      } else if (classified.type === 'FLOAT') {
        const light = lengthToPx(value) ?? parseFloat(value);
        if (!Number.isFinite(light)) continue;
        variable.valuesByMode[LIGHT] = light;
        if (hasDark) {
          variable.valuesByMode[DARK] = lengthToPx(darkValue ?? value) ?? light;
        }
        if (classified.family === 'space') spaceToVariable.set(Math.round(light), name);
        if (classified.family === 'radius') radiusToVariable.set(Math.round(light), name);
      } else {
        variable.valuesByMode[LIGHT] = value;
        if (hasDark) variable.valuesByMode[DARK] = darkValue ?? value;
      }

      variable.description = variable.aliasOf
        ? `Variable CSS ${cssName} — alias de ${variable.aliasOf}`
        : `Variable CSS ${cssName}`;
      variables.push(variable);
    }

    if (variables.length > 0) {
      diagnostics.push({
        level: 'info',
        code: 'tokens-from-css',
        message: `${variables.length} variables CSS transposees en variables Figma${hasDark ? ' (modes clair et sombre)' : ''}.`,
        hint: 'Les noms Figma reprennent les noms CSS : le developpeur retrouve son vocabulaire.',
      });
    }
  }

  /* --- 2. complement par analyse, pour ce que le CSS ne declare pas --- */

  if (options.inferMissing) {
    const covered = new Set(colorToVariable.keys());
    // Seules les couleurs reellement recurrentes : en dessous, c'est du bruit
    // (une ombre unique, un liserai ponctuel) qui polluerait la bibliotheque.
    const threshold = Math.max(3, Math.round(analysis.colors.size * 0.02));
    const candidates = [...analysis.colors.entries()]
      .filter(([hex, entry]) => !covered.has(hex) && entry.count >= threshold)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 48);

    for (const [hex, entry] of assignInferredNames(candidates)) {
      if (usedNames.has(entry.name)) continue;
      usedNames.add(entry.name);
      const variable: VariableSpec = {
        name: entry.name,
        type: 'COLOR',
        valuesByMode: { [LIGHT]: toRgba(entry.color) },
        inferred: true,
        description: `Deduite par analyse — ${entry.count} occurrences sur le site`,
      };
      if (hasDark) variable.valuesByMode[DARK] = toRgba(entry.color);
      variables.push(variable);
      colorToVariable.set(hex, [entry.name]);
    }

    // Echelle d'espacement : les valeurs les plus employees, arrondies au pas de 4.
    const spacings = [...analysis.spacings.entries()]
      .filter(([value, count]) => count >= 4 && value % 2 === 0)
      .sort((a, b) => a[0] - b[0])
      .slice(0, 16);
    for (const [value] of spacings) {
      if (spaceToVariable.has(value)) continue;
      const name = `space/${value}`;
      if (usedNames.has(name)) continue;
      usedNames.add(name);
      const variable: VariableSpec = {
        name,
        type: 'FLOAT',
        valuesByMode: { [LIGHT]: value },
        inferred: true,
        description: `Espacement recurrent — ${analysis.spacings.get(value)} occurrences`,
      };
      if (hasDark) variable.valuesByMode[DARK] = value;
      variables.push(variable);
      spaceToVariable.set(value, name);
    }

    const radii = [...analysis.radii.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => a[0] - b[0])
      .slice(0, 8);
    for (const [value] of radii) {
      if (radiusToVariable.has(value)) continue;
      const name = `radius/${value}`;
      if (usedNames.has(name)) continue;
      usedNames.add(name);
      const variable: VariableSpec = {
        name,
        type: 'FLOAT',
        valuesByMode: { [LIGHT]: value },
        inferred: true,
        description: `Rayon recurrent — ${analysis.radii.get(value)} occurrences`,
      };
      if (hasDark) variable.valuesByMode[DARK] = value;
      variables.push(variable);
      radiusToVariable.set(value, name);
    }
  }

  /* --- 3. collisions : plusieurs tokens pour une meme couleur --- */

  const resolvedColor = new Map<string, string>();
  for (const [hex, names] of colorToVariable) {
    if (names.length === 1) {
      resolvedColor.set(hex, names[0]!);
      continue;
    }
    // Le navigateur resout `var()` en couleur : impossible de savoir quel token
    // etait ecrit dans le code. On prefere donc une variable de palette a un
    // alias semantique — lier un fond a `color/text` serait trompeur — puis, a
    // egalite, le nom le plus court.
    const chosen = [...names].sort((a, b) => {
      const aliasDiff = Number(aliasNames.has(a)) - Number(aliasNames.has(b));
      if (aliasDiff !== 0) return aliasDiff;
      return a.length - b.length || a.localeCompare(b);
    })[0]!;
    resolvedColor.set(hex, chosen);
    diagnostics.push({
      level: 'info',
      code: 'token-alias',
      message: `${hex} correspond a ${names.length} tokens (${names.join(', ')}) : « ${chosen} » retenu.`,
      hint: 'Les styles calcules ne conservent pas le nom du var() d origine.',
    });
  }

  /* --- 4. styles de texte --- */

  const textStyles = buildTextStyles(analysis, options.primaryBreakpoint);
  // Index (famille, style, taille) -> nom de style. C'est tout ce que
  // `buildText` connait au moment de la liaison ; quand plusieurs combinaisons
  // partagent ce triplet (interlignes differents), la plus employee gagne.
  const textStyleByTriplet = new Map<string, { name: string; count: number }>();
  for (const [key, name] of textStyles.mapping) {
    const usage = analysis.fonts.get(key);
    const parts = key.split('|');
    const triplet = `${parts[0]}|${parts[1]}|${parts[2]}`;
    const existing = textStyleByTriplet.get(triplet);
    const count = usage?.count ?? 0;
    if (!existing || count > existing.count) textStyleByTriplet.set(triplet, { name, count });
  }

  /* --- 5. styles d'effet --- */

  const effectStyles: EffectStyleSpec[] = [];
  const effectBySignature = new Map<string, string>();
  const shadows = [...analysis.shadows.values()]
    .filter((s) => s.count >= 2)
    .sort((a, b) => a.blur - b.blur);
  const ELEVATION = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];
  shadows.slice(0, ELEVATION.length).forEach((shadow, index) => {
    const name = `Elevation/${ELEVATION[index]}`;
    const effects = parseBoxShadow(shadow.css);
    if (effects.length === 0) return;
    effectStyles.push({
      name,
      description: `${shadow.css} — ${shadow.count} occurrences`,
      effects,
    });
    effectBySignature.set(shadow.signature, name);
  });

  /* --- 6. styles de peinture semantiques --- */

  const paintStyles: PaintStyleSpec[] = [];
  for (const variable of variables) {
    if (variable.type !== 'COLOR') continue;
    // Un style de peinture par token de couleur : les styles restent la maniere
    // la plus rapide d'appliquer une couleur a la main dans Figma.
    const value = variable.valuesByMode[LIGHT] as RGBA | undefined;
    if (!value) continue;
    paintStyles.push({
      name: variable.name.replace(/^color\//, 'Couleur/'),
      description: variable.description,
      paints: [
        {
          type: 'SOLID',
          color: { r: value.r, g: value.g, b: value.b },
          opacity: value.a,
          variable: variable.name,
        },
      ],
    });
  }

  const collection: TokenCollection = {
    name: options.collectionName,
    modes,
    defaultMode: LIGHT,
    variables,
  };

  const binder: TokenBinder = {
    colorVariable: (hex) => resolvedColor.get(hex.toLowerCase()),
    spacingVariable: (value) => spaceToVariable.get(Math.round(value)),
    radiusVariable: (value) => radiusToVariable.get(Math.round(value)),
    textStyle: (font) =>
      textStyleByTriplet.get(`${font.family}|${font.style}|${font.size}`)?.name,
    effectStyle: (signature) => effectBySignature.get(signature),
  };

  reportFontInconsistencies(analysis, diagnostics);

  return {
    collections: variables.length > 0 ? [collection] : [],
    paintStyles,
    textStyles: textStyles.styles,
    effectStyles,
    binder,
  };
}

function toRgba(color: Rgba): RGBA {
  return { r: color.r, g: color.g, b: color.b, a: color.a };
}

/* ---------------------- nommage des couleurs deduites --------------------- */

const HUE_FAMILIES: Array<[number, string]> = [
  [15, 'rouge'], [45, 'orange'], [70, 'jaune'], [150, 'vert'],
  [200, 'cyan'], [255, 'bleu'], [290, 'violet'], [330, 'rose'], [360, 'rouge'],
];

function hueFamily(h: number): string {
  for (const [limit, name] of HUE_FAMILIES) if (h < limit) return name;
  return 'rouge';
}

/**
 * Attribue des noms lisibles aux couleurs deduites : famille de teinte + palier
 * de luminosite sur l'echelle 50-950, celle que tout le monde connait.
 */
function assignInferredNames(
  candidates: Array<[string, { color: Rgba; count: number }]>,
): Array<[string, { name: string; color: Rgba; count: number }]> {
  const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  const byFamily = new Map<string, Array<[string, { color: Rgba; count: number }]>>();

  for (const entry of candidates) {
    const { s, l } = hsl(entry[1].color);
    // Sous 12 % de saturation, la teinte n'a pas de sens perceptif : c'est un gris.
    const family = s < 0.12 ? 'neutre' : hueFamily(hsl(entry[1].color).h);
    void l;
    const list = byFamily.get(family) ?? [];
    list.push(entry);
    byFamily.set(family, list);
  }

  const out: Array<[string, { name: string; color: Rgba; count: number }]> = [];
  for (const [family, list] of byFamily) {
    // Du plus clair au plus sombre : l'ordre des echelles de palette.
    const sorted = [...list].sort((a, b) => luminance(b[1].color) - luminance(a[1].color));
    sorted.forEach(([hex, entry], index) => {
      const step = STEPS[Math.min(STEPS.length - 1, Math.round((index / Math.max(1, sorted.length - 1)) * (STEPS.length - 1)))]!;
      out.push([hex, { name: `color/${family}/${step}`, color: entry.color, count: entry.count }]);
    });
  }

  // Deux couleurs d'une meme famille peuvent tomber sur le meme palier.
  const seen = new Set<string>();
  return out.filter(([, entry]) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  });
}

/* -------------------------- styles de texte ------------------------------- */

/** Nom de style deduit de la balise qui porte majoritairement la combinaison. */
const TAG_STYLE_NAMES: Record<string, string> = {
  h1: 'Titre/H1', h2: 'Titre/H2', h3: 'Titre/H3',
  h4: 'Titre/H4', h5: 'Titre/H5', h6: 'Titre/H6',
  p: 'Corps/Paragraphe',
  li: 'Corps/Liste',
  a: 'Interface/Lien',
  button: 'Interface/Bouton',
  label: 'Interface/Etiquette',
  small: 'Corps/Petit',
  blockquote: 'Corps/Citation',
  code: 'Corps/Code',
  pre: 'Corps/Code',
  th: 'Tableau/En-tete',
  td: 'Tableau/Cellule',
  input: 'Interface/Champ',
  figcaption: 'Corps/Legende',
  strong: 'Corps/Accentue',
  em: 'Corps/Italique',
};
// `span`, `div` et `#text` sont volontairement absents : ils ne portent aucune
// semantique. Un nombre de 40 px en serif dans un `<span>` nomme « Corps/Inline »
// serait trompeur ; `Texte/40px` est exact.

function buildTextStyles(
  analysis: Analysis,
  primaryBreakpoint: string,
): {
  styles: TextStyleSpec[];
  mapping: Map<string, string>;
} {
  const styles: TextStyleSpec[] = [];
  const mapping = new Map<string, string>();
  const used = new Set<string>();

  // Les combinaisons employees une seule fois ne meritent pas un style partage.
  const combos = [...analysis.fonts.values()]
    .filter((usage) => usage.count >= 2)
    .sort((a, b) => b.count - a.count || b.size - a.size);

  for (const usage of combos) {
    const dominantTag = [...usage.tags.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'span';
    const dominantBreakpoint =
      [...usage.breakpoints.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? primaryBreakpoint;
    let name = TAG_STYLE_NAMES[dominantTag] ?? `Texte/${Math.round(usage.size)}px`;

    // Une meme combinaison vue a deux tailles est presque toujours le MEME role
    // decline par breakpoint (un h1 a 52 / 40 / 32 px). Le nommer « Titre/H1 ·
    // Mobile » dit au developpeur ce qu'il doit ecrire dans sa media query ;
    // « Titre/H1 2 » ne lui dit rien.
    if (used.has(name)) {
      const candidate =
        dominantBreakpoint !== primaryBreakpoint
          ? `${name} · ${dominantBreakpoint}`
          : `${name} · ${Math.round(usage.size)}px`;
      name = candidate;
      if (used.has(name)) {
        let suffix = 2;
        while (used.has(`${name} (${suffix})`)) suffix++;
        name = `${name} (${suffix})`;
      }
    }
    used.add(name);

    const lineHeight = JSON.parse(usage.lineHeight) as TextStyleSpec['font']['lineHeight'];
    const letterSpacing = JSON.parse(usage.letterSpacing) as TextStyleSpec['font']['letterSpacing'];

    styles.push({
      name,
      description: `${usage.count} occurrences — ${usage.family} ${usage.style} ${usage.size}px`,
      font: {
        family: usage.family,
        style: usage.style,
        weight: 400,
        italic: usage.style.includes('Italic'),
        size: usage.size,
        lineHeight,
        letterSpacing,
      },
      textDecoration:
        usage.decoration.includes('underline') ? 'UNDERLINE'
          : usage.decoration.includes('line-through') ? 'STRIKETHROUGH'
            : 'NONE',
      textCase:
        usage.textCase === 'uppercase' ? 'UPPER'
          : usage.textCase === 'lowercase' ? 'LOWER'
            : usage.textCase === 'capitalize' ? 'TITLE'
              : 'ORIGINAL',
      paragraphSpacing: 0,
    });
    mapping.set(usage.key, name);
  }

  return { styles, mapping };
}

/**
 * Signale les polices minoritaires.
 *
 * Detecte un defaut reel et courant : un `<button>` n'herite pas de
 * `font-family`, il retombe sur la police par defaut du navigateur. Le bouton
 * s'affiche alors en Arial au milieu d'un site en Inter — invisible a la
 * relecture, evident dans la maquette. Autant le dire au developpeur.
 */
function reportFontInconsistencies(analysis: Analysis, diagnostics: Diagnostic[]): void {
  const byFamily = new Map<string, { count: number; tags: Set<string> }>();
  for (const usage of analysis.fonts.values()) {
    const entry = byFamily.get(usage.family) ?? { count: 0, tags: new Set<string>() };
    entry.count += usage.count;
    for (const tag of usage.tags.keys()) entry.tags.add(tag);
    byFamily.set(usage.family, entry);
  }
  if (byFamily.size <= 1) return;

  const total = [...byFamily.values()].reduce((sum, entry) => sum + entry.count, 0);
  const ranked = [...byFamily.entries()].sort((a, b) => b[1].count - a[1].count);
  const dominant = ranked[0]!;

  // Les controles de formulaire n'heritent pas de `font-family` : c'est la cause
  // quasi unique d'une police parasite sur un site moderne.
  const FORM_CONTROLS = new Set(['button', 'input', 'select', 'textarea', 'option', 'optgroup']);

  for (const [family, entry] of ranked.slice(1)) {
    const share = entry.count / total;
    const onlyFormControls = [...entry.tags].every((tag) => FORM_CONTROLS.has(tag));

    // Une seconde police voulue (un serif de titrage) represente une part
    // notable ET porte des balises de contenu. On signale donc : soit une part
    // marginale, soit — quelle que soit la part — une police cantonnee aux
    // controles de formulaire, signature de l'oubli de `font-family: inherit`.
    const marginal = share < 0.05;
    if (!marginal && !(onlyFormControls && share < 0.25)) continue;

    diagnostics.push({
      level: 'warn',
      code: 'font-inconsistent',
      message: `« ${family} » n'apparait que ${entry.count} fois (${(share * 100).toFixed(1)} %) sur ${total} textes, alors que le site est en « ${dominant[0]} ». Elements concernes : ${[...entry.tags].sort().join(', ')}.`,
      hint: onlyFormControls
        ? "Cause certaine : <button>, <input>, <select> et <textarea> n'heritent pas de `font-family`. Ajoutez `font: inherit` sur ces elements dans le CSS du site."
        : 'Police minoritaire : verifiez qu elle est voulue, sinon la maquette la reproduira telle quelle.',
    });
  }
}
