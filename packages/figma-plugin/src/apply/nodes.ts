/**
 * Creation et mise a jour d'un noeud Figma a partir du spec.
 *
 * L'ordre des operations n'est pas negociable, faute de quoi Figma refuse
 * l'ecriture :
 *   1. le noeud doit etre RATTACHE a son parent avant qu'on puisse lui donner
 *      un dimensionnement « remplir » ;
 *   2. le parent doit avoir son auto-layout AVANT que l'enfant demande a remplir ;
 *   3. le noeud doit avoir SES enfants avant de demander « ajuster au contenu ».
 * D'ou le decoupage : `applyNode` pose tout sauf le dimensionnement, que le
 * parent applique ensuite via `applySizing`.
 */

import type { DesignSpec, SpecNode } from '@sfs/spec';
import { HASH_KEY, SID_KEY } from '../context.js';
import type { SyncContext } from '../context.js';
import { toEffects, toPaints } from './paints.js';
import { loadSvgMarkup } from './assets.js';
import { resolveFont } from './fonts.js';
import { toLetterSpacing, toLineHeight } from './styles.js';
import { annotate } from './annotations.js';

/** Types Figma acceptant un auto-layout et des enfants. */
type ContainerNode = FrameNode | ComponentNode | InstanceNode;

export function isContainer(node: BaseNode): node is ContainerNode {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';
}

/** Un noeud existant peut-il etre reutilise pour ce spec, ou faut-il le recreer ? */
export function isCompatible(node: SceneNode, spec: SpecNode): boolean {
  switch (spec.kind) {
    case 'TEXT':
      return node.type === 'TEXT';
    case 'ELLIPSE':
      return node.type === 'ELLIPSE';
    case 'VECTOR':
      // Un SVG importe devient une frame contenant des vecteurs.
      return node.type === 'FRAME' || node.type === 'VECTOR' || node.type === 'GROUP';
    case 'INSTANCE':
      return node.type === 'INSTANCE';
    default:
      return node.type === 'FRAME';
  }
}

export async function createNode(
  spec: SpecNode,
  contextSpec: DesignSpec,
  context: SyncContext,
): Promise<SceneNode> {
  if (spec.kind === 'TEXT') return figma.createText();
  if (spec.kind === 'ELLIPSE') return figma.createEllipse();

  if (spec.kind === 'VECTOR' && spec.vector) {
    const markup = await loadSvgMarkup(spec.vector.assetId, contextSpec, context);
    if (markup) {
      try {
        // `createNodeFromSvg` rend un arbre vectoriel modifiable : le
        // developpeur peut en extraire une icone propre.
        return figma.createNodeFromSvg(markup);
      } catch (error) {
        context.warnings.push(`SVG « ${spec.name} » non importe : ${String(error)}`);
      }
    }
  }

  if (spec.kind === 'INSTANCE' && spec.instanceOf) {
    const component = context.components.get(spec.instanceOf);
    if (component) {
      const target =
        component.type === 'COMPONENT_SET' ? component.defaultVariant : component;
      if (target) return target.createInstance();
    }
  }

  return figma.createFrame();
}

/* ------------------------------ mise a jour -------------------------------- */

export async function applyNode(
  node: SceneNode,
  spec: SpecNode,
  contextSpec: DesignSpec,
  context: SyncContext,
): Promise<void> {
  node.name = spec.name;
  node.setPluginData(SID_KEY, spec.sid);

  if ('opacity' in node) node.opacity = clamp(spec.style.opacity);
  if ('visible' in node) node.visible = spec.style.visible;
  if ('blendMode' in node && spec.style.blendMode) {
    node.blendMode = spec.style.blendMode as BlendMode;
  }

  /* ------------------------------- geometrie ----------------------------- */

  if ('resize' in node) {
    const width = Math.max(0.01, spec.box.w);
    const height = Math.max(0.01, spec.box.h);
    try {
      // `resizeWithoutConstraints` evite de deformer les enfants ; tous les
      // types de noeuds ne l'exposent pas.
      if (node.type !== 'TEXT' && 'resizeWithoutConstraints' in node) {
        node.resizeWithoutConstraints(width, height);
      } else {
        node.resize(width, height);
      }
    } catch {
      // Un noeud verrouille ou a taille imposee refuse le redimensionnement.
    }
  }

  /* ---------------------------- apparence -------------------------------- */

  if ('fills' in node && node.type !== 'TEXT') {
    const fills = toPaints(spec.style.fills, context);
    // Une image liee a un noeud dedie est posee comme remplissage du noeud.
    if (spec.image) {
      const image = context.images.get(spec.image.assetId);
      if (image) {
        fills.push({
          type: 'IMAGE',
          imageHash: image.hash,
          scaleMode: spec.image.scaleMode === 'CROP' ? 'CROP' : spec.image.scaleMode,
        });
      }
    }
    node.fills = fills;
  }

  if ('strokes' in node) {
    node.strokes = toPaints(spec.style.strokes, context);
    if (spec.style.strokeWeight > 0 && 'strokeWeight' in node) {
      node.strokeWeight = spec.style.strokeWeight;
    }
    if ('strokeAlign' in node) node.strokeAlign = spec.style.strokeAlign;
    if (spec.style.dashPattern && 'dashPattern' in node) {
      node.dashPattern = spec.style.dashPattern;
    }
    const individual = spec.style.individualStrokeWeights;
    if (individual && 'strokeTopWeight' in node) {
      // Bordure sur un seul cote : separateurs et soulignements, tres courants.
      node.strokeTopWeight = individual.top;
      node.strokeRightWeight = individual.right;
      node.strokeBottomWeight = individual.bottom;
      node.strokeLeftWeight = individual.left;
    }
  }

  if ('effects' in node) {
    const styleName = spec.style.effects.find((effect) => effect.style)?.style;
    const shared = styleName ? context.effectStyles.get(styleName) : undefined;
    if (shared && 'setEffectStyleIdAsync' in node) {
      try {
        await node.setEffectStyleIdAsync(shared.id);
      } catch {
        node.effects = toEffects(spec.style.effects);
      }
    } else {
      node.effects = toEffects(spec.style.effects);
    }
  }

  applyCornerRadius(node, spec);

  /* ------------------------------ auto-layout ---------------------------- */

  if (isContainer(node) && spec.kind !== 'VECTOR') {
    applyLayout(node, spec, context);
  }

  /* --------------------------------- texte ------------------------------- */

  if (node.type === 'TEXT' && spec.text) {
    await applyText(node, spec, context);
  }

  annotate(node, spec, context);

  node.setPluginData(HASH_KEY, spec.subtreeHash);
}

function applyCornerRadius(node: SceneNode, spec: SpecNode): void {
  if (!('cornerRadius' in node)) return;
  const [tl, tr, br, bl] = spec.style.cornerRadius;
  try {
    // Les rayons se posent coin par coin : `cornerRadius` est en lecture seule
    // dans les versions recentes de l'API (il vaut `mixed` des que les quatre
    // coins different).
    if ('topLeftRadius' in node) {
      node.topLeftRadius = Math.max(0, tl);
      node.topRightRadius = Math.max(0, tr);
      node.bottomRightRadius = Math.max(0, br);
      node.bottomLeftRadius = Math.max(0, bl);
    }
  } catch {
    // Certains types de noeuds n'acceptent pas de rayons independants.
  }
}

function applyLayout(node: ContainerNode, spec: SpecNode, context: SyncContext): void {
  const layout = spec.layout;

  node.layoutMode = layout.mode;
  if (layout.mode !== 'NONE') {
    node.layoutWrap = layout.wrap ? 'WRAP' : 'NO_WRAP';
    node.paddingTop = Math.max(0, layout.padding[0]);
    node.paddingRight = Math.max(0, layout.padding[1]);
    node.paddingBottom = Math.max(0, layout.padding[2]);
    node.paddingLeft = Math.max(0, layout.padding[3]);
    node.itemSpacing = Math.max(0, layout.itemSpacing);
    if (layout.wrap) node.counterAxisSpacing = Math.max(0, layout.counterAxisSpacing);
    node.primaryAxisAlignItems = layout.primaryAxisAlignItems;
    // `BASELINE` n'est accepte que sur une rangee.
    node.counterAxisAlignItems =
      layout.counterAxisAlignItems === 'BASELINE' && layout.mode !== 'HORIZONTAL'
        ? 'MIN'
        : layout.counterAxisAlignItems;

    // Liaison des espacements aux variables : changer `space/6` dans Figma
    // repercute partout, comme en CSS.
    bindNumber(node, 'itemSpacing', layout.bound?.itemSpacing, context);
    bindNumber(node, 'paddingTop', layout.bound?.paddingTop, context);
    bindNumber(node, 'paddingRight', layout.bound?.paddingRight, context);
    bindNumber(node, 'paddingBottom', layout.bound?.paddingBottom, context);
    bindNumber(node, 'paddingLeft', layout.bound?.paddingLeft, context);
  }

  node.clipsContent = layout.clipsContent;

  // Contraintes de taille : `max-width` sur un conteneur de contenu est l'un des
  // reglages les plus structurants d'un site.
  try {
    node.maxWidth = layout.maxWidth ?? null;
    node.minWidth = layout.minWidth ?? null;
    node.maxHeight = layout.maxHeight ?? null;
    node.minHeight = layout.minHeight ?? null;
  } catch {
    // Contraintes refusees hors auto-layout : sans consequence.
  }
}

function bindNumber(
  node: ContainerNode,
  field: 'itemSpacing' | 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft',
  variableName: string | undefined,
  context: SyncContext,
): void {
  if (!variableName) return;
  const variable = context.variables.get(variableName);
  if (!variable) return;
  try {
    node.setBoundVariable(field, variable);
  } catch {
    // Champ non liable dans cette version de l'API : la valeur numerique reste.
  }
}

async function applyText(node: TextNode, spec: SpecNode, context: SyncContext): Promise<void> {
  const text = spec.text!;
  const font = resolveFont(text.font, context);

  try {
    // La police doit etre posee AVANT le texte : Figma refuse d'ecrire des
    // caracteres dans une police non chargee.
    node.fontName = font;
  } catch (error) {
    context.warnings.push(`Police non appliquee sur « ${spec.name} » : ${String(error)}`);
  }

  if (node.characters !== text.characters) node.characters = text.characters;

  const shared = text.styleName ? context.textStyles.get(text.styleName) : undefined;
  if (shared) {
    try {
      // Appliquer le style partage plutot que les proprietes une a une : le
      // texte reste rattache au systeme, et changer le style change le texte.
      await node.setTextStyleIdAsync(shared.id);
    } catch {
      applyTextPropsDirectly(node, spec, context);
    }
  } else {
    applyTextPropsDirectly(node, spec, context);
  }

  node.textAlignHorizontal = text.textAlignHorizontal;
  node.textAlignVertical = text.textAlignVertical;
  try {
    node.textAutoResize = text.textAutoResize === 'TRUNCATE' ? 'HEIGHT' : text.textAutoResize;
    if (text.textAutoResize === 'TRUNCATE') node.textTruncation = 'ENDING';
  } catch {
    node.textAutoResize = 'HEIGHT';
  }

  node.fills = toPaints(text.fills, context);

  if (text.href) {
    try {
      // Rend le lien cliquable dans la maquette et visible en Dev Mode.
      node.setRangeHyperlink(0, node.characters.length, { type: 'URL', value: text.href });
    } catch {
      // Lien non absolu ou refuse : sans consequence sur le rendu.
    }
  }
}

function applyTextPropsDirectly(node: TextNode, spec: SpecNode, context: SyncContext): void {
  const text = spec.text!;
  try {
    node.fontSize = Math.max(1, text.font.size);
    node.lineHeight = toLineHeight(text.font);
    node.letterSpacing = toLetterSpacing(text.font);
    node.textCase = text.textCase;
    node.textDecoration = text.textDecoration;
    node.paragraphSpacing = text.paragraphSpacing;
  } catch (error) {
    context.warnings.push(`Proprietes de texte refusees sur « ${spec.name} » : ${String(error)}`);
  }
}

/* ----------------------------- dimensionnement ----------------------------- */

/**
 * Applique « fixe / ajuster / remplir ».
 *
 * A n'appeler qu'une fois le noeud rattache a son parent ET ses propres enfants
 * en place : Figma valide ces contraintes au moment de l'ecriture.
 */
export function applySizing(node: SceneNode, spec: SpecNode, context: SyncContext): void {
  if (!('layoutSizingHorizontal' in node)) return;

  const parent = node.parent;
  const parentIsAutoLayout =
    parent !== null && 'layoutMode' in parent && parent.layoutMode !== 'NONE';

  const resolve = (mode: 'FIXED' | 'HUG' | 'FILL'): 'FIXED' | 'HUG' | 'FILL' => {
    // Garde-fous : Figma leve une exception plutot que d'ignorer une valeur
    // invalide, et une exception ici interromprait toute la synchronisation.
    if (mode === 'FILL' && (!parentIsAutoLayout || spec.layout.positioning === 'ABSOLUTE')) {
      return 'FIXED';
    }
    if (mode === 'HUG' && node.type !== 'TEXT') {
      if (!('layoutMode' in node) || node.layoutMode === 'NONE') return 'FIXED';
    }
    return mode;
  };

  try {
    node.layoutSizingHorizontal = resolve(spec.layout.sizing.horizontal);
  } catch (error) {
    context.warnings.push(`Largeur de « ${spec.name} » : ${String(error)}`);
  }
  try {
    node.layoutSizingVertical = resolve(spec.layout.sizing.vertical);
  } catch (error) {
    context.warnings.push(`Hauteur de « ${spec.name} » : ${String(error)}`);
  }
}

/** Positionne un enfant hors flux, ou un enfant de conteneur sans auto-layout. */
export function applyPosition(
  node: SceneNode,
  spec: SpecNode,
  parentSpec: SpecNode | null,
): void {
  const parent = node.parent;
  const parentIsAutoLayout =
    parent !== null && 'layoutMode' in parent && parent.layoutMode !== 'NONE';

  if (spec.layout.positioning === 'ABSOLUTE' && parentIsAutoLayout) {
    if ('layoutPositioning' in node) node.layoutPositioning = 'ABSOLUTE';
  }

  const absolute = spec.layout.positioning === 'ABSOLUTE';
  if (parentIsAutoLayout && !absolute) return;

  // Les coordonnees du spec sont absolues dans la page : on les rend relatives
  // au parent, seule forme acceptee par Figma.
  if (parentSpec && 'x' in node) {
    node.x = spec.box.x - parentSpec.box.x;
    node.y = spec.box.y - parentSpec.box.y;
  }

  if (absolute && spec.layout.constraints && 'constraints' in node) {
    try {
      node.constraints = {
        horizontal: spec.layout.constraints.horizontal,
        vertical: spec.layout.constraints.vertical,
      };
    } catch {
      // Contraintes refusees sur ce type de noeud.
    }
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
