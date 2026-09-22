/**
 * Assemblage : capture brute du DOM -> arbre `SpecNode`.
 *
 * Toutes les decisions de traduction vers Figma se prennent ici, dans du code
 * Node testable, et non dans le navigateur.
 */

import type {
  Diagnostic, LayoutSpec, NodeKind, Paint, SpecNode, StyleSpec, TextSpec,
} from '@sfs/spec';
import { hashValue, makeSid } from '@sfs/spec';
import type { PathSegment } from '@sfs/spec';
import type { RawNode } from '../browser/raw.js';
import { parseColor } from './color.js';
import {
  buildFills, buildStrokes, cornerRadii, parseBlur, parseBoxShadow,
  parseFilterDropShadow, px, rgbOf, rotationFromTransform,
} from './css-map.js';
import { absoluteConstraints, inferLayout, inferSizing, sizeLimits } from './layout.js';
import { disambiguate, nameNode } from './naming.js';
import { buildFont } from './fonts.js';

/** Fournit les identifiants d'assets deja telecharges/serialises. */
export interface AssetResolver {
  imageId(src: string): string | undefined;
  svgId(markup: string): string | undefined;
}

/** Relie une couleur a un token, quand le site en declare un. */
export interface TokenBinder {
  colorVariable(hex: string, alpha: number): string | undefined;
  spacingVariable(value: number): string | undefined;
  radiusVariable(value: number): string | undefined;
  textStyle(font: { family: string; style: string; size: number }): string | undefined;
  effectStyle(signature: string): string | undefined;
}

export interface BuildContext {
  route: string;
  breakpoint: string;
  assets: AssetResolver;
  tokens: TokenBinder | null;
  devAnnotations: boolean;
  diagnostics: Diagnostic[];
  /** Polices substituees, remontees une seule fois chacune. */
  substitutedFonts: Set<string>;
}

/** Proprietes conservees pour les annotations Dev Mode : les plus parlantes. */
const DEV_CSS_PROPS = [
  'display', 'position', 'flexDirection', 'justifyContent', 'alignItems',
  'gridTemplateColumns', 'gap', 'rowGap', 'columnGap',
  'width', 'height', 'maxWidth', 'minHeight', 'aspectRatio',
  'padding', 'margin', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
  'letterSpacing', 'color', 'backgroundColor', 'backgroundImage',
  'borderRadius', 'boxShadow', 'overflow', 'zIndex', 'transform', 'objectFit',
];

const DEV_CSS_SHORTHAND: Record<string, string[]> = {
  padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
  borderRadius: [
    'borderTopLeftRadius', 'borderTopRightRadius',
    'borderBottomRightRadius', 'borderBottomLeftRadius',
  ],
  gap: ['rowGap', 'columnGap'],
  overflow: ['overflowX', 'overflowY'],
};

function devCss(style: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prop of DEV_CSS_PROPS) {
    const parts = DEV_CSS_SHORTHAND[prop];
    if (parts) {
      const values = parts.map((p) => style[p]).filter((v): v is string => v !== undefined);
      if (values.length === 0) continue;
      // Une valeur unique se note en abrege ; sinon on liste les cotes.
      out[dashCase(prop)] = new Set(values).size === 1 ? values[0]! : parts
        .map((p) => style[p] ?? '0px')
        .join(' ');
      continue;
    }
    const value = style[prop];
    if (value !== undefined) out[dashCase(prop)] = value;
  }
  return out;
}

function dashCase(prop: string): string {
  return prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

/** L'element a-t-il une presence visuelle propre (fond, contour, ombre) ? */
function hasVisualBox(node: RawNode): boolean {
  const style = node.style;
  const background = parseColor(style.backgroundColor);
  if (background && background.a > 0.01) return true;
  if (style.backgroundImage && style.backgroundImage !== 'none') return true;
  if (style.boxShadow && style.boxShadow !== 'none') return true;
  for (const side of ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) {
    if (px(style[side]) > 0) return true;
  }
  return false;
}

function hasPadding(style: Record<string, string>): boolean {
  return (
    px(style.paddingTop) > 0 || px(style.paddingRight) > 0 ||
    px(style.paddingBottom) > 0 || px(style.paddingLeft) > 0
  );
}

/* --------------------------------- styles --------------------------------- */

function buildStyle(node: RawNode, context: BuildContext): StyleSpec {
  const style = node.style;
  const imageAssetIds = node.images
    .filter((img) => img.origin === 'background')
    .map((img) => context.assets.imageId(img.src))
    .filter((id): id is string => id !== undefined);

  const fills = buildFills({
    backgroundColor: style.backgroundColor,
    backgroundImage: style.backgroundImage,
    backgroundSize: style.backgroundSize,
    imageAssetIds,
  });

  // Liaison aux variables : c'est ce qui rend le fichier pilotable par tokens
  // plutot que par couleurs figees.
  const bound = fills.map((paint) => bindPaint(paint, context));

  const strokeResult = buildStrokes({
    top: { width: px(style.borderTopWidth), style: style.borderTopStyle ?? 'none', color: style.borderTopColor },
    right: { width: px(style.borderRightWidth), style: style.borderRightStyle ?? 'none', color: style.borderRightColor },
    bottom: { width: px(style.borderBottomWidth), style: style.borderBottomStyle ?? 'none', color: style.borderBottomColor },
    left: { width: px(style.borderLeftWidth), style: style.borderLeftStyle ?? 'none', color: style.borderLeftColor },
  });

  const effects = [
    ...parseBoxShadow(style.boxShadow),
    ...parseFilterDropShadow(style.filter),
    ...parseBlur(style.filter, 'LAYER_BLUR'),
    ...parseBlur(style.backdropFilter, 'BACKGROUND_BLUR'),
  ];
  if (context.tokens) {
    for (const effect of effects) {
      const name = context.tokens.effectStyle(hashValue(effect));
      if (name) effect.style = name;
    }
  }

  const radii = cornerRadii(style, node.rect);
  const result: StyleSpec = {
    fills: bound,
    strokes: strokeResult.strokes.map((paint) => bindPaint(paint, context)),
    strokeWeight: strokeResult.strokeWeight,
    strokeAlign: 'INSIDE',
    cornerRadius: radii,
    effects,
    opacity: Math.min(1, Math.max(0, parseFloat(style.opacity ?? '1') || 1)),
    visible: true,
  };
  if (strokeResult.individualStrokeWeights) {
    result.individualStrokeWeights = strokeResult.individualStrokeWeights;
  }
  if (strokeResult.dashPattern) result.dashPattern = strokeResult.dashPattern;

  const uniformRadius = radii.every((r) => Math.abs(r - radii[0]) < 0.01) ? radii[0] : null;
  if (uniformRadius !== null && uniformRadius > 0 && context.tokens) {
    const token = context.tokens.radiusVariable(uniformRadius);
    if (token) result.cornerRadiusToken = token;
  }

  const blend = style.mixBlendMode;
  if (blend && blend !== 'normal') {
    const supported = ['multiply', 'screen', 'overlay', 'darken', 'lighten'];
    if (supported.includes(blend)) {
      result.blendMode = blend.toUpperCase() as StyleSpec['blendMode'];
    }
  }
  return result;
}

function bindPaint(paint: Paint, context: BuildContext): Paint {
  if (paint.type !== 'SOLID' || !context.tokens) return paint;
  const hex = hexOf(paint.color);
  const variable = context.tokens.colorVariable(hex, paint.opacity);
  return variable ? { ...paint, variable } : paint;
}

function hexOf({ r, g, b }: { r: number; g: number; b: number }): string {
  const part = (v: number): string => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/* ---------------------------------- texte --------------------------------- */

const TEXT_CASE: Record<string, TextSpec['textCase']> = {
  uppercase: 'UPPER',
  lowercase: 'LOWER',
  capitalize: 'TITLE',
};

function buildText(node: RawNode, context: BuildContext, sizing: {
  horizontal: string;
}): TextSpec | undefined {
  const raw = node.text;
  if (!raw?.characters) return undefined;

  const dominant = raw.runs[0];
  const { font, substituted } = buildFont({
    fontFamily: dominant?.fontFamily ?? node.style.fontFamily,
    fontSize: dominant?.fontSize ?? node.style.fontSize,
    fontWeight: dominant?.fontWeight ?? node.style.fontWeight,
    fontStyle: dominant?.fontStyle ?? node.style.fontStyle,
    lineHeight: node.style.lineHeight,
    letterSpacing: dominant?.letterSpacing ?? node.style.letterSpacing,
  });
  if (substituted) {
    const stack = dominant?.fontFamily ?? node.style.fontFamily ?? '';
    if (!context.substitutedFonts.has(stack)) {
      context.substitutedFonts.add(stack);
      context.diagnostics.push({
        level: 'info',
        code: 'font-substituted',
        message: `Pile de polices « ${stack} » remplacee par « ${font.family} » dans Figma.`,
        where: `${context.route} / ${context.breakpoint}`,
        hint: 'Police systeme ou generique : aucune equivalence exacte n existe dans Figma.',
      });
    }
  }

  const color = parseColor(dominant?.color ?? node.style.color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const fill: Paint = { type: 'SOLID', color: rgbOf(color), opacity: color.a };

  const align = (node.style.textAlign ?? 'start').trim();
  const textAlignHorizontal: TextSpec['textAlignHorizontal'] =
    align === 'center' ? 'CENTER'
      : align === 'right' || align === 'end' ? 'RIGHT'
        : align === 'justify' ? 'JUSTIFIED'
          : 'LEFT';

  const decoration = dominant?.textDecorationLine ?? node.style.textDecorationLine ?? 'none';
  const textDecoration: TextSpec['textDecoration'] =
    decoration.includes('underline') ? 'UNDERLINE'
      : decoration.includes('line-through') ? 'STRIKETHROUGH'
        : 'NONE';

  // Une seule ligne qui ajuste sa largeur peut grandir dans les deux sens ;
  // un texte a largeur contrainte ne doit grandir qu'en hauteur, sinon il
  // deborde de sa colonne.
  const clamped = node.style.webkitLineClamp && node.style.webkitLineClamp !== 'none';
  const ellipsis = node.style.textOverflow === 'ellipsis';
  const textAutoResize: TextSpec['textAutoResize'] =
    clamped || ellipsis ? 'TRUNCATE'
      : sizing.horizontal === 'HUG' ? 'WIDTH_AND_HEIGHT'
        : 'HEIGHT';

  const text: TextSpec = {
    characters: raw.characters,
    font,
    fills: [bindPaint(fill, context)],
    textAlignHorizontal,
    textAlignVertical: 'TOP',
    textAutoResize,
    textDecoration,
    textCase: TEXT_CASE[(node.style.textTransform ?? 'none').trim()] ?? 'ORIGINAL',
    paragraphSpacing: 0,
  };

  if (context.tokens) {
    const styleName = context.tokens.textStyle(font);
    if (styleName) text.styleName = styleName;
  }
  const href = dominant?.href ?? node.link;
  if (href) text.href = href;
  return text;
}

/* ------------------------------- construction ----------------------------- */

interface BuildArgs {
  node: RawNode;
  path: PathSegment[];
  parentLayout: LayoutSpec | null;
  /** Le parent etire-t-il ses enfants sur l'axe transversal ? */
  parentCounterStretch?: boolean;
  parentName?: string;
  context: BuildContext;
}

/** `align-items` du parent : `stretch` (ou son defaut `normal`) etire les enfants. */
function stretchesChildren(style: Record<string, string>): boolean {
  const align = (style.alignItems ?? 'normal').trim();
  return align === 'stretch' || align === 'normal';
}

function classify(node: RawNode, context: BuildContext): NodeKind {
  if (node.svg && context.assets.svgId(node.svg)) return 'VECTOR';
  const primaryImage = node.images.find((img) => img.origin !== 'background');
  if (primaryImage && context.assets.imageId(primaryImage.src)) return 'IMAGE';
  // Un cercle parfait se lit mieux comme ellipse dans Figma (et s'edite mieux).
  const radii = cornerRadii(node.style, node.rect);
  const isCircle =
    node.children.length === 0 && !node.text &&
    Math.abs(node.rect.w - node.rect.h) < 1 && node.rect.w > 0 &&
    radii.every((r) => Math.abs(r - node.rect.w / 2) < 1);
  if (isCircle) return 'ELLIPSE';
  if (node.text && node.children.length === 0) return 'TEXT';
  return 'FRAME';
}

export function buildNode(args: BuildArgs): SpecNode {
  const { node, path, parentLayout, context } = args;

  const decision = inferLayout({
    style: node.style,
    box: node.rect,
    children: node.children.map((child) => ({ box: child.rect, style: child.style })),
  });
  for (const note of decision.notes) {
    context.diagnostics.push({
      level: 'info',
      code: 'layout-approximation',
      message: note,
      where: `${context.route} / ${context.breakpoint} / ${nameNode(node)}`,
    });
  }

  let kind = classify(node, context);

  // Un element avec du texte ET une boite visuelle (fond, bordure, padding) ne
  // peut pas etre un simple noeud texte : dans Figma c'est une frame qui contient
  // un texte. C'est exactement ainsi qu'un designer construit un bouton.
  const textNeedsWrapper =
    node.text !== undefined &&
    node.children.length === 0 &&
    (hasVisualBox(node) || hasPadding(node.style));
  if (textNeedsWrapper) kind = 'FRAME';

  const selfHasLayout = decision.layout.mode !== 'NONE' || textNeedsWrapper;
  const sizing = inferSizing({
    style: node.style,
    declared: node.declared,
    box: node.rect,
    parentLayout,
    parentCounterStretch: args.parentCounterStretch ?? false,
    selfHasLayout,
    kind: kind === 'ELLIPSE' || kind === 'LINE' ? 'OTHER' : kind === 'INSTANCE' ? 'FRAME' : kind,
  });

  const layout: LayoutSpec = { ...decision.layout, sizing, ...sizeLimits(node.style) };
  if (textNeedsWrapper) {
    // Frame-enveloppe de texte : ajustement au contenu, centrage vertical.
    layout.mode = layout.mode === 'NONE' ? 'HORIZONTAL' : layout.mode;
    layout.counterAxisAlignItems = 'CENTER';
    layout.primaryAxisAlignItems =
      node.style.textAlign === 'center' ? 'CENTER'
        : node.style.textAlign === 'right' || node.style.textAlign === 'end' ? 'MAX'
          : 'MIN';
  }

  const position = node.style.position ?? 'static';
  if (position === 'absolute' || position === 'fixed' || position === 'sticky') {
    layout.positioning = 'ABSOLUTE';
    layout.constraints = absoluteConstraints(node.style);
    if (position === 'sticky' || position === 'fixed') {
      context.diagnostics.push({
        level: 'info',
        code: 'fixed-position',
        message: `Element en position: ${position} place a sa position de repos, en couche absolue.`,
        where: `${context.route} / ${context.breakpoint} / ${nameNode(node)}`,
        hint: 'Le comportement collant est a re-implementer en CSS.',
      });
    }
  }

  const sid = makeSid(context.route, context.breakpoint, path);
  const name = nameNode(node, { parentName: args.parentName });
  const style = buildStyle(node, context);

  const spec: SpecNode = {
    sid,
    name,
    kind,
    box: {
      x: round(node.rect.x),
      y: round(node.rect.y),
      w: round(Math.max(kind === 'TEXT' ? 1 : 0.01, node.rect.w)),
      h: round(Math.max(kind === 'TEXT' ? 1 : 0.01, node.rect.h)),
    },
    layout,
    style,
    children: [],
    hash: '',
    subtreeHash: '',
  };

  /* ------------------------------- feuilles ------------------------------- */

  if (kind === 'VECTOR' && node.svg) {
    const assetId = context.assets.svgId(node.svg);
    if (assetId) spec.vector = { assetId };
  }

  if (kind === 'IMAGE') {
    const primary = node.images.find((img) => img.origin !== 'background');
    const assetId = primary ? context.assets.imageId(primary.src) : undefined;
    if (assetId) {
      const fit = (primary?.objectFit ?? 'fill').toLowerCase();
      spec.image = {
        assetId,
        scaleMode: fit === 'contain' || fit === 'scale-down' ? 'FIT' : fit === 'none' ? 'CROP' : 'FILL',
      };
    }
  }

  if (kind === 'TEXT') {
    // Figma n'accepte ni auto-layout ni padding sur un noeud texte : le laisser
    // heriter du mode du parent produirait une ecriture invalide.
    layout.mode = 'NONE';
    layout.wrap = false;
    layout.itemSpacing = 0;
    layout.counterAxisSpacing = 0;
    layout.padding = [0, 0, 0, 0];
    layout.clipsContent = false;
    const text = buildText(node, context, sizing);
    if (text) {
      spec.text = text;
      // Le rectangle des lignes de texte est plus juste que celui de l'element,
      // qui inclut le padding et l'interligne debordant.
      if (node.text?.bounds && node.text.bounds.w > 0) {
        spec.box = {
          x: round(node.text.bounds.x),
          y: round(node.text.bounds.y),
          w: round(Math.max(1, node.text.bounds.w)),
          h: round(Math.max(1, node.text.bounds.h)),
        };
      }
    } else {
      spec.kind = 'FRAME';
    }
  }

  /* -------------------------------- enfants ------------------------------- */

  const childNodes = decision.reverseChildren ? [...node.children].reverse() : node.children;

  if (textNeedsWrapper && node.text) {
    // Enfant texte synthetique : son `sid` derive de celui du parent, donc il
    // reste stable d'une synchro a l'autre.
    const inner = buildText(node, context, { horizontal: 'HUG' });
    if (inner) {
      const innerBox = node.text.bounds ?? {
        x: node.rect.x + px(node.style.paddingLeft),
        y: node.rect.y + px(node.style.paddingTop),
        w: Math.max(1, node.rect.w - px(node.style.paddingLeft) - px(node.style.paddingRight)),
        h: Math.max(1, node.rect.h - px(node.style.paddingTop) - px(node.style.paddingBottom)),
      };
      spec.children.push({
        sid: `${sid}~t`,
        name: 'Libelle',
        kind: 'TEXT',
        box: {
          x: round(innerBox.x), y: round(innerBox.y),
          w: round(Math.max(1, innerBox.w)), h: round(Math.max(1, innerBox.h)),
        },
        layout: {
          mode: 'NONE', wrap: false, padding: [0, 0, 0, 0], itemSpacing: 0,
          counterAxisSpacing: 0, primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'MIN',
          sizing: { horizontal: 'HUG', vertical: 'HUG' },
          clipsContent: false, positioning: 'AUTO',
        },
        style: {
          fills: [], strokes: [], strokeWeight: 0, strokeAlign: 'INSIDE',
          cornerRadius: [0, 0, 0, 0], effects: [], opacity: 1, visible: true,
        },
        text: inner,
        children: [],
        hash: '', subtreeHash: '',
      });
    }
  }

  const builtChildren: SpecNode[] = [];
  const seenTags = new Map<string, number>();
  for (const child of childNodes) {
    // Recalcul de l'index de fratrie apres inversion eventuelle : le chemin doit
    // refleter l'ordre reellement emis.
    const key = child.seg.tag + (child.seg.pseudo ?? '');
    const index = (seenTags.get(key) ?? 0) + 1;
    seenTags.set(key, index);

    const segment: PathSegment = { tag: child.seg.tag, index: child.seg.index || index };
    if (child.seg.anchor) segment.anchor = child.seg.anchor;
    if (child.seg.cls) segment.cls = child.seg.cls;
    if (child.seg.pseudo) segment.pseudo = child.seg.pseudo;

    builtChildren.push(
      buildNode({
        node: child,
        path: [...path, segment],
        parentLayout: layout,
        parentCounterStretch: stretchesChildren(node.style),
        parentName: name,
        context,
      }),
    );
  }

  // Noms uniques entre freres : sans cela, impossible de designer une couche
  // precise dans une conversation ou une revue.
  const names = disambiguate(builtChildren.map((child) => child.name));
  builtChildren.forEach((child, i) => {
    child.name = names[i]!;
  });
  spec.children.push(...builtChildren);

  /* ------------------------- annotations et rotation ---------------------- */

  if (context.devAnnotations) {
    const notes: SpecNode['devNotes'] = {
      tag: node.seg.tag,
      selector: selectorOf(path),
      css: devCss(node.style),
    };
    if (node.seg.cls) notes.cls = node.seg.cls;
    if (node.role) notes.role = node.role;
    if (node.link) notes.href = node.link;
    const alt = node.images[0]?.alt;
    if (alt) notes.alt = alt;
    if (node.a11y?.length) notes.a11y = node.a11y;
    spec.devNotes = notes;
  }

  const rotation = rotationFromTransform(node.style.transform);
  if (Math.abs(rotation) > 0.5) {
    context.diagnostics.push({
      level: 'info',
      code: 'transform-partial',
      message: `transform: ${node.style.transform} — seule la rotation (${Math.round(rotation)}°) est transposee.`,
      where: `${context.route} / ${context.breakpoint} / ${name}`,
    });
  }

  /* --------------------------------- hashes ------------------------------- */

  return finalizeHashes(spec);
}

/** Selecteur CSS lisible, pour retrouver l'element dans le code source. */
function selectorOf(path: PathSegment[]): string {
  const parts: string[] = [];
  for (const segment of path) {
    if (segment.anchor) {
      parts.length = 0;
      parts.push('#' + segment.anchor);
      continue;
    }
    let part = segment.tag;
    if (segment.cls) part += '.' + segment.cls;
    if (segment.index > 1) part += `:nth-of-type(${segment.index})`;
    if (segment.pseudo) part += '::' + segment.pseudo;
    parts.push(part);
  }
  return parts.join(' > ');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Calcule `hash` (le noeud seul) et `subtreeHash` (le noeud et sa descendance).
 *
 * `hash` sert a savoir s'il faut reecrire ce noeud ; `subtreeHash` a savoir s'il
 * faut descendre du tout. Sur un site de plusieurs milliers de noeuds ou trois
 * mots ont change, c'est la difference entre une synchro instantanee et une
 * reecriture complete.
 */
export function finalizeHashes(node: SpecNode): SpecNode {
  const { hash: _h, subtreeHash: _s, children, ...rest } = node;
  const kids = children.map(finalizeHashes);
  const hash = hashValue(rest);
  node.children = kids;
  node.hash = hash;
  node.subtreeHash = hashValue([hash, ...kids.map((child) => child.subtreeHash)]);
  return node;
}
