/**
 * Inference de l'auto-layout Figma depuis le CSS.
 *
 * C'est ce qui distingue une maquette exploitable d'un empilement de rectangles.
 * Un developpeur qui recoit des frames en auto-layout lit directement les
 * intentions : direction, espacement, remplissage, alignement. Sans cela, il doit
 * tout re-deduire a la souris.
 *
 * Trois sources de structure, par ordre de fiabilite :
 *   1. `display: flex`     -> direction et alignements explicites ;
 *   2. `display: grid`     -> grille, rendue en auto-layout (avec retour a la ligne) ;
 *   3. flux en bloc        -> empilement vertical implicite, deduit de la geometrie.
 */

import type { AxisAlign, CounterAlign, LayoutSpec, SizingMode } from '@sfs/spec';
import type { RawDeclared } from '../browser/raw.js';
import { px, splitTopLevel } from './css-map.js';

export interface LayoutInput {
  style: Record<string, string>;
  box: { x: number; y: number; w: number; h: number };
  children: Array<{ box: { x: number; y: number; w: number; h: number }; style: Record<string, string> }>;
}

export interface LayoutDecision {
  layout: LayoutSpec;
  /** `row-reverse` / `column-reverse` : Figma n'a pas d'inversion, on inverse la liste. */
  reverseChildren: boolean;
  /** Ce qui n'a pas pu etre reproduit fidelement, pour les notes de passation. */
  notes: string[];
}

const PRIMARY_ALIGN: Record<string, AxisAlign> = {
  'flex-start': 'MIN', start: 'MIN', normal: 'MIN', left: 'MIN',
  center: 'CENTER',
  'flex-end': 'MAX', end: 'MAX', right: 'MAX',
  'space-between': 'SPACE_BETWEEN',
  'space-around': 'SPACE_BETWEEN', 'space-evenly': 'SPACE_BETWEEN',
  stretch: 'MIN',
};

const COUNTER_ALIGN: Record<string, CounterAlign> = {
  'flex-start': 'MIN', start: 'MIN', normal: 'MIN', 'self-start': 'MIN',
  center: 'CENTER',
  'flex-end': 'MAX', end: 'MAX',
  baseline: 'BASELINE', 'first baseline': 'BASELINE', 'last baseline': 'BASELINE',
  stretch: 'MIN',
};

/** Compte les colonnes declarees par `grid-template-columns`. */
export function countGridColumns(template: string | undefined): number {
  if (!template || template === 'none') return 0;
  // La valeur calculee est une liste de largeurs resolues : « 320px 320px 320px ».
  const tracks = template.trim().split(/\s+(?![^(]*\))/).filter(Boolean);
  return tracks.length;
}

/** Ecart median entre boites consecutives sur un axe : robuste aux marges isolees. */
function medianGap(
  children: LayoutInput['children'],
  axis: 'x' | 'y',
): number {
  if (children.length < 2) return 0;
  const size = axis === 'x' ? 'w' : 'h';
  const sorted = [...children].sort((a, b) => a.box[axis] - b.box[axis]);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!.box;
    const gap = sorted[i]!.box[axis] - (previous[axis] + previous[size]);
    // Un chevauchement signale un positionnement absolu, pas un flux : on ignore.
    if (gap >= -1) gaps.push(Math.max(0, gap));
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 0 ? (gaps[middle - 1]! + gaps[middle]!) / 2 : gaps[middle]!;
  return Math.round(median * 10) / 10;
}

/** Les enfants s'empilent-ils proprement sur cet axe, sans chevauchement ? */
function isStacked(children: LayoutInput['children'], axis: 'x' | 'y'): boolean {
  if (children.length < 2) return false;
  const size = axis === 'x' ? 'w' : 'h';
  const sorted = [...children].sort((a, b) => a.box[axis] - b.box[axis]);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!.box;
    // Tolerance de 1px : les arrondis sous-pixels du navigateur.
    if (sorted[i]!.box[axis] < previous[axis] + previous[size] - 1) return false;
  }
  return true;
}

/** Un enfant hors flux ne compte pas dans la deduction de direction. */
function inFlow(child: { style: Record<string, string> }): boolean {
  const position = child.style.position ?? 'static';
  return position !== 'absolute' && position !== 'fixed';
}

export function inferLayout(input: LayoutInput): LayoutDecision {
  const { style, box } = input;
  const notes: string[] = [];
  const display = style.display ?? 'block';
  const flowChildren = input.children.filter(inFlow);

  // Le padding Figma est interieur, comme en CSS. La bordure CSS s'ajoute a la
  // boite mesuree (`getBoundingClientRect` est en border-box) alors qu'un contour
  // Figma « interieur » ne prend pas de place : on l'integre au padding pour que
  // le contenu tombe au bon endroit.
  const padding: [number, number, number, number] = [
    px(style.paddingTop) + px(style.borderTopWidth),
    px(style.paddingRight) + px(style.borderRightWidth),
    px(style.paddingBottom) + px(style.borderBottomWidth),
    px(style.paddingLeft) + px(style.borderLeftWidth),
  ];

  const base: LayoutSpec = {
    mode: 'NONE',
    wrap: false,
    padding,
    itemSpacing: 0,
    counterAxisSpacing: 0,
    primaryAxisAlignItems: 'MIN',
    counterAxisAlignItems: 'MIN',
    sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
    clipsContent:
      style.overflowX === 'hidden' || style.overflowY === 'hidden' ||
      style.overflowX === 'clip' || style.overflowY === 'clip' ||
      style.overflowY === 'auto' || style.overflowY === 'scroll',
    positioning: 'AUTO',
  };

  const rowGap = style.rowGap && style.rowGap !== 'normal' ? px(style.rowGap) : null;
  const columnGap = style.columnGap && style.columnGap !== 'normal' ? px(style.columnGap) : null;

  /* ------------------------------- flexbox ------------------------------- */

  if (display === 'flex' || display === 'inline-flex') {
    const direction = style.flexDirection ?? 'row';
    const horizontal = direction.startsWith('row');
    const reverse = direction.endsWith('-reverse');
    const wrap = (style.flexWrap ?? 'nowrap').startsWith('wrap');

    const justify = (style.justifyContent ?? 'normal').trim();
    const align = (style.alignItems ?? 'normal').trim();

    if (justify === 'space-around' || justify === 'space-evenly') {
      notes.push(
        `justify-content: ${justify} rendu en « espace entre » (Figma n'a pas d'equivalent exact).`,
      );
    }

    return {
      layout: {
        ...base,
        mode: horizontal ? 'HORIZONTAL' : 'VERTICAL',
        wrap,
        itemSpacing: (horizontal ? columnGap : rowGap) ?? 0,
        counterAxisSpacing: (horizontal ? rowGap : columnGap) ?? 0,
        primaryAxisAlignItems: PRIMARY_ALIGN[justify] ?? 'MIN',
        counterAxisAlignItems: COUNTER_ALIGN[align] ?? 'MIN',
      },
      reverseChildren: reverse,
      notes,
    };
  }

  /* -------------------------------- grille ------------------------------- */

  if (display === 'grid' || display === 'inline-grid') {
    const columns = countGridColumns(style.gridTemplateColumns);
    const rows = countGridColumns(style.gridTemplateRows);

    // Une grille a une seule colonne (ou une seule ligne) est exactement un
    // auto-layout : on la traduit sans perte.
    if (columns <= 1 && rows !== 1) {
      return {
        layout: {
          ...base,
          mode: 'VERTICAL',
          itemSpacing: rowGap ?? 0,
          counterAxisAlignItems: COUNTER_ALIGN[(style.alignItems ?? 'normal').trim()] ?? 'MIN',
        },
        reverseChildren: false,
        notes,
      };
    }
    if (rows === 1 && columns > 1 && flowChildren.length <= columns) {
      return {
        layout: {
          ...base,
          mode: 'HORIZONTAL',
          itemSpacing: columnGap ?? 0,
          counterAxisAlignItems: COUNTER_ALIGN[(style.alignItems ?? 'normal').trim()] ?? 'MIN',
        },
        reverseChildren: false,
        notes,
      };
    }

    // Grille a plusieurs lignes et colonnes : auto-layout horizontal avec retour
    // a la ligne. Le rendu est identique tant que les colonnes sont uniformes.
    const tracks = splitTopLevel(style.gridTemplateColumns ?? '', ' ');
    const uniform = new Set(tracks.map((t) => Math.round(px(t)))).size <= 1;
    if (!uniform && tracks.length > 1) {
      notes.push(
        `Grille a colonnes inegales (${style.gridTemplateColumns}) : rendue en auto-layout avec retour a la ligne, les largeurs de colonnes sont a re-declarer en CSS.`,
      );
    }
    return {
      layout: {
        ...base,
        mode: 'HORIZONTAL',
        wrap: true,
        itemSpacing: columnGap ?? 0,
        counterAxisSpacing: rowGap ?? 0,
        primaryAxisAlignItems: PRIMARY_ALIGN[(style.justifyContent ?? 'normal').trim()] ?? 'MIN',
        counterAxisAlignItems: 'MIN',
      },
      reverseChildren: false,
      notes,
    };
  }

  /* --------------------------- flux en bloc ------------------------------ */

  // Le flux HTML normal empile verticalement. Le reconnaitre rend la maquette
  // reellement modifiable : ajouter une section dans Figma repousse la suite,
  // exactement comme dans le navigateur.
  if (flowChildren.length >= 2 && isStacked(flowChildren, 'y')) {
    return {
      layout: {
        ...base,
        mode: 'VERTICAL',
        itemSpacing: medianGap(flowChildren, 'y'),
        counterAxisAlignItems: inferBlockAlignment(input, flowChildren),
      },
      reverseChildren: false,
      notes,
    };
  }

  // Un enfant unique en flux : auto-layout vertical quand meme, pour que le
  // padding du parent reste vivant.
  if (flowChildren.length === 1 && display !== 'inline') {
    return {
      layout: { ...base, mode: 'VERTICAL', itemSpacing: 0,
        counterAxisAlignItems: inferBlockAlignment(input, flowChildren) },
      reverseChildren: false,
      notes,
    };
  }

  // Enfants qui se chevauchent ou absolus : on garde un positionnement libre.
  if (input.children.length > 0 && flowChildren.length > 1) {
    notes.push('Enfants superposes : positionnement libre conserve (pas d auto-layout).');
  }
  return { layout: base, reverseChildren: false, notes };
}

/**
 * Alignement horizontal deduit d'un empilement en bloc : un contenu centre par
 * `margin: 0 auto` doit ressortir comme centre, pas comme cale a gauche.
 */
function inferBlockAlignment(
  input: LayoutInput,
  children: LayoutInput['children'],
): CounterAlign {
  const inner = {
    left: input.box.x + px(input.style.paddingLeft) + px(input.style.borderLeftWidth),
    right:
      input.box.x + input.box.w - px(input.style.paddingRight) - px(input.style.borderRightWidth),
  };
  const width = inner.right - inner.left;
  if (width <= 0) return 'MIN';

  let centered = 0;
  for (const child of children) {
    const leftGap = child.box.x - inner.left;
    const rightGap = inner.right - (child.box.x + child.box.w);
    // Marges laterales egales et non nulles = centrage.
    if (leftGap > 2 && Math.abs(leftGap - rightGap) <= 2) centered++;
  }
  return centered === children.length ? 'CENTER' : 'MIN';
}

/* ------------------------------ dimensionnement --------------------------- */

export interface SizingInput {
  style: Record<string, string>;
  /** Dimensions declarees par l'auteur, lues dans les feuilles de style. */
  declared: RawDeclared;
  box: { w: number; h: number };
  /** Auto-layout du parent : determine quels axes peuvent « remplir ». */
  parentLayout: LayoutSpec | null;
  /** Le parent etire-t-il ses enfants sur l'axe transversal (`align-items: stretch`) ? */
  parentCounterStretch: boolean;
  /** Le noeud a-t-il un auto-layout propre (condition pour « ajuster ») ? */
  selfHasLayout: boolean;
  kind: 'FRAME' | 'TEXT' | 'IMAGE' | 'VECTOR' | 'OTHER';
}

/** Mots-cles CSS qui demandent explicitement un ajustement au contenu. */
const CONTENT_SIZED = /^(fit-content|max-content|min-content|auto)/;

function isPxLength(value: string | undefined): boolean {
  return value !== undefined && /^-?[\d.]+(px|r?em|ch|ex)$/.test(value.trim());
}

/** Longueur CSS en pixels (1rem = 16px), ou `null` si ce n'est pas une longueur. */
function parseCssPx(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(-?[\d.]+)(px|r?em)$/.exec(value.trim());
  if (!match) return null;
  const n = parseFloat(match[1]!);
  if (!Number.isFinite(n)) return null;
  return match[2] === 'px' ? n : n * 16;
}

function isFullRelative(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim();
  return v === '100%' || v === '100vw' || v === '100vh' || v === 'stretch' || v === '-webkit-fill-available';
}

/**
 * Deduit « fixe / ajuster / remplir » par axe.
 *
 * Point cle : on ne se fie PAS a la largeur calculee pour decider si une taille
 * est fixe. Chromium rend `width` en pixels meme pour un simple element de bloc
 * qui occupe la largeur de son parent. S'y fier figeait toute la maquette — une
 * maquette Figma ou rien ne s'adapte est inutilisable pour un developpeur.
 *
 * On combine donc trois sources : la valeur DECLAREE par l'auteur, la geometrie
 * (l'element occupe-t-il exactement la largeur de contenu de son parent ?), et le
 * niveau de rendu (ligne ou bloc).
 *
 * Contrainte Figma a respecter absolument : « remplir » n'est valable que dans un
 * parent en auto-layout, et « ajuster » que si le noeud a lui-meme un auto-layout
 * (ou est un texte). Emettre une valeur invalide fait echouer l'ecriture.
 */
export function inferSizing(input: SizingInput): { horizontal: SizingMode; vertical: SizingMode } {
  const { style, declared, box, parentLayout, selfHasLayout, kind } = input;
  const position = style.position ?? 'static';
  const outOfFlow = position === 'absolute' || position === 'fixed';

  const canFill = !!parentLayout && parentLayout.mode !== 'NONE' && !outOfFlow;
  const canHug = kind === 'TEXT' || selfHasLayout;
  const fill = (): SizingMode | null => (canFill ? 'FILL' : null);
  const hug = (): SizingMode | null => (canHug ? 'HUG' : null);

  const parentIsHorizontal = parentLayout?.mode === 'HORIZONTAL';
  const grow = (() => {
    const fromDeclared = declared.flex;
    if (fromDeclared) {
      // `flex: 1` et `flex: 1 1 0%` demandent tous deux a remplir.
      const first = parseFloat(fromDeclared);
      if (Number.isFinite(first) && first > 0) return first;
      if (/^(auto|1)$/.test(fromDeclared.trim())) return 1;
    }
    return parseFloat(style.flexGrow ?? '0') || 0;
  })();

  /* --------------------------------- largeur ------------------------------- */

  const horizontal = ((): SizingMode => {
    if (outOfFlow) return 'FIXED';
    if (isPxLength(declared.width)) return 'FIXED';
    if (isFullRelative(declared.width)) return fill() ?? 'FIXED';
    if (declared.width && CONTENT_SIZED.test(declared.width) && declared.width !== 'auto') {
      return hug() ?? 'FIXED';
    }
    // Pourcentage partiel (`width: 48%`) : rien dans Figma ne l'exprime. On fixe,
    // et l'annotation Dev Mode conserve la valeur d'origine.
    if (declared.width?.endsWith('%')) return 'FIXED';

    if (parentIsHorizontal && grow > 0) return fill() ?? 'FIXED';

    // Conteneur de contenu : `max-width` + `margin: 0 auto`, le motif le plus
    // repandu du web. Sa largeur vient de sa contrainte, pas de son contenu :
    // « remplir, plafonne a max-width » est la traduction exacte dans Figma, et
    // c'est ce qui fait que la maquette reste adaptable.
    // On prend le `max-width` CALCULE : contrairement a `width`, il ne vaut que
    // s'il a ete declare (sinon `none`), et il a l'avantage de resoudre les
    // `var(--max-width)` que la valeur declaree laisse tels quels.
    const declaredMax = parseCssPx(style.maxWidth) ?? parseCssPx(declared.maxWidth);
    if (declaredMax !== null && Math.abs(box.w - declaredMax) <= 1.5) {
      return fill() ?? 'FIXED';
    }

    if (declared.inlineLevel) return hug() ?? 'FIXED';

    // Element de bloc sans largeur declaree : il occupe la largeur de contenu de
    // son parent. C'est le comportement HTML par defaut, et c'est exactement ce
    // que « remplir le conteneur » signifie dans Figma.
    const parentWidth = declared.parentContentWidth;
    if (parentWidth !== undefined && Math.abs(box.w - parentWidth) <= 1.5) {
      return fill() ?? (hug() ?? 'FIXED');
    }
    return hug() ?? 'FIXED';
  })();

  /* --------------------------------- hauteur ------------------------------- */

  const vertical = ((): SizingMode => {
    if (outOfFlow) return 'FIXED';
    if (isPxLength(declared.height)) return 'FIXED';
    // Un ratio d'aspect lie la hauteur a la largeur : Figma ne le reproduit pas,
    // une hauteur fixe est le rendu le plus proche.
    if (style.aspectRatio && style.aspectRatio !== 'auto') return 'FIXED';
    if (kind === 'IMAGE' || kind === 'VECTOR') return 'FIXED';
    if (isFullRelative(declared.height)) return fill() ?? 'FIXED';
    if (declared.height?.endsWith('%')) return 'FIXED';

    if (!parentIsHorizontal && grow > 0) return fill() ?? 'FIXED';

    // Enfant d'une rangee en auto-layout qui etire ses enfants : « remplir »
    // reproduit `align-items: stretch`.
    const alignSelf = (style.alignSelf ?? 'auto').trim();
    if (parentIsHorizontal && canFill && !declared.height) {
      if (alignSelf === 'stretch') return 'FILL';
      if (alignSelf === 'auto' && input.parentCounterStretch) return 'FILL';
    }

    // Sans hauteur declaree, un element se dimensionne a son contenu.
    return hug() ?? 'FIXED';
  })();

  return { horizontal, vertical };
}

/** Contraintes de position pour un enfant hors flux. */
export function absoluteConstraints(style: Record<string, string>): NonNullable<LayoutSpec['constraints']> {
  const set = (value: string | undefined): boolean => value !== undefined && value !== 'auto';
  const hasLeft = set(style.left);
  const hasRight = set(style.right);
  const hasTop = set(style.top);
  const hasBottom = set(style.bottom);

  return {
    // Les deux cotes ancres = l'element s'etire avec son parent.
    horizontal: hasLeft && hasRight ? 'STRETCH' : hasRight ? 'MAX' : 'MIN',
    vertical: hasTop && hasBottom ? 'STRETCH' : hasBottom ? 'MAX' : 'MIN',
  };
}

/** `min-width` / `max-width` : Figma les gere sur les frames en auto-layout. */
export function sizeLimits(
  style: Record<string, string>,
): Pick<LayoutSpec, 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight'> {
  const out: Pick<LayoutSpec, 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight'> = {};
  const read = (value: string | undefined): number | undefined => {
    if (!value || value === 'auto' || value === 'none') return undefined;
    if (!/^[\d.]+px$/.test(value)) return undefined;
    const n = px(value);
    return n > 0 ? n : undefined;
  };
  // `max-width` sur un conteneur de contenu est l'un des reglages les plus
  // structurants d'un site : le transmettre evite au developpeur de le redecouvrir.
  const maxWidth = read(style.maxWidth);
  const minWidth = read(style.minWidth);
  const maxHeight = read(style.maxHeight);
  const minHeight = read(style.minHeight);
  if (maxWidth !== undefined) out.maxWidth = maxWidth;
  if (minWidth !== undefined) out.minWidth = minWidth;
  if (maxHeight !== undefined) out.maxHeight = maxHeight;
  if (minHeight !== undefined) out.minHeight = minHeight;
  return out;
}
