/**
 * Inventaire des composants.
 *
 * Les composants sont publies sur une page dediee, a partir des motifs repetes
 * detectes sur le site. Les pages, elles, restent un rendu litteral : un
 * developpeur a besoin d'une verite exacte ET d'un inventaire des motifs, pas
 * d'une abstraction approximative posee sur ses pages.
 */

import type { ComponentSpec, DesignSpec } from '@sfs/spec';
import { SID_KEY } from '../context.js';
import type { SyncContext } from '../context.js';
import { applyNode, applySizing } from './nodes.js';
import { ensurePage } from './pages.js';
import { reconcileNode } from './reconcile.js';

const COLUMN_GAP = 80;
const ROW_GAP = 80;

export async function syncComponents(
  spec: DesignSpec,
  pageName: string,
  context: SyncContext,
): Promise<void> {
  if (spec.components.length === 0) return;

  const page = await ensurePage(pageName);

  /*
   * Balayage prealable.
   *
   * L'inventaire est reconstruit a chaque synchronisation : sans ce nettoyage,
   * les composants de la fois precedente restaient en place et les nouveaux
   * s'ajoutaient a cote. Observe sur un vrai fichier — la page devenait un
   * empilement illisible de doublons, annotations comprises.
   *
   * On ne retire que ce que NOUS avons cree, reconnaissable a sa marque : un
   * composant ajoute a la main par la cliente sur cette page n'est pas touche.
   */
  let balayes = 0;
  for (const enfant of [...page.children]) {
    if (enfant.getPluginData(SID_KEY).startsWith('component:')) {
      enfant.remove();
      balayes++;
    }
  }
  if (balayes > 0) context.stats.removed += balayes;

  let x = 0;
  let y = 0;
  let rowHeight = 0;

  for (const component of spec.components) {
    const built = await buildComponent(component, spec, context, page);
    if (!built) continue;

    built.x = x;
    built.y = y;
    x += built.width + COLUMN_GAP;
    rowHeight = Math.max(rowHeight, built.height);
    // Retour a la ligne au-dela de 2400 px : au-dela, l'inventaire devient une
    // bande illisible.
    if (x > 2400) {
      x = 0;
      y += rowHeight + ROW_GAP;
      rowHeight = 0;
    }
    if (built.parent !== page) page.appendChild(built);
    context.components.set(component.key, built);
    context.stats.componentsWritten++;
  }
}

async function buildComponent(
  spec: ComponentSpec,
  designSpec: DesignSpec,
  context: SyncContext,
  page: PageNode,
): Promise<ComponentNode | ComponentSetNode | null> {
  try {
    if (!spec.variants || spec.variants.length < 2) {
      const component = await materialize(spec.node.name, spec.node, designSpec, context, spec.key, page);
      component.name = spec.name;
      component.description = spec.description ?? '';
      return component;
    }

    // Plusieurs variantes : Figma attend des noms « Propriete=Valeur » avant de
    // les combiner en un jeu de variantes.
    const variants: ComponentNode[] = [];
    for (const variant of spec.variants) {
      const pairs = Object.entries(variant.properties)
        .map(([property, value]) => `${property}=${value}`)
        .join(', ');
      const component = await materialize(
        pairs,
        variant.node,
        designSpec,
        context,
        `${spec.key}:${pairs}`,
        page,
      );
      component.name = pairs;
      variants.push(component);
    }
    // Sur la page d'inventaire, jamais sur la page courante : cette derniere est
    // celle que regarde la cliente, et elle n'a rien a y faire.
    const set = figma.combineAsVariants(variants, page);
    set.name = spec.name;
    set.description = spec.description ?? '';
    // Marquer le jeu lui-meme : sans cela le balayage de la prochaine
    // synchronisation ne le reconnaitrait pas et il resterait en doublon.
    set.setPluginData(SID_KEY, `component:${spec.key}`);
    return set;
  } catch (error) {
    context.warnings.push(`Composant « ${spec.name} » non publie : ${String(error)}`);
    return null;
  }
}

/** Construit une frame conforme au spec puis la convertit en composant. */
async function materialize(
  name: string,
  node: ComponentSpec['node'],
  designSpec: DesignSpec,
  context: SyncContext,
  key: string,
  page: PageNode,
): Promise<ComponentNode> {
  const frame = figma.createFrame();
  frame.name = name;
  page.appendChild(frame);

  await applyNode(frame, node, designSpec, context);

  const childIndex = new Map<string, { node: SceneNode; sid: string; hash: string }>();
  const unmatched: SceneNode[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const childSpec = node.children[i]!;
    const result = await reconcileNode(
      frame,
      childSpec,
      node,
      childIndex,
      unmatched,
      i,
      designSpec,
      context,
    );
    applySizing(result.node, childSpec, context);
  }

  const component = figma.createComponentFromNode(frame);
  // Le `sid` du composant ne doit pas se confondre avec celui de l'occurrence
  // de page dont il est issu, sinon la reconciliation des pages le happerait.
  component.setPluginData(SID_KEY, `component:${key}`);
  return component;
}
