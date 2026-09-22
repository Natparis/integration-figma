/**
 * Reconciliation : c'est ici que se joue le caractere idempotent de l'outil.
 *
 * Chaque noeud Figma porte l'identifiant stable (`sid`) de sa contrepartie dans
 * le site. Une seconde synchronisation retrouve donc les memes noeuds et les met
 * a jour SUR PLACE, au lieu de tout recreer. C'est ce qui preserve les
 * commentaires, les liens de prototype et le travail du developpeur.
 *
 * Trois niveaux d'appariement, du plus sur au plus tolerant :
 *   1. `sid` identique — le cas normal ;
 *   2. meme type + meme nom + meme empreinte de contenu — rattrape un decalage
 *      d'indices quand une section a ete inseree en amont ;
 *   3. meme type a la meme position — dernier recours.
 */

import type { DesignSpec, SpecNode } from '@sfs/spec';
import { HASH_KEY, SID_KEY } from '../context.js';
import type { SyncContext } from '../context.js';
import {
  applyNode, applyPosition, applySizing, createNode, isCompatible,
} from './nodes.js';

/** Nom de la frame ou sont ranges les noeuds disparus du site. */
export const ARCHIVE_NAME = '⚠︎ Retires du site';

interface Candidate {
  node: SceneNode;
  sid: string;
  hash: string;
}

function indexChildren(parent: ChildrenMixin): Map<string, Candidate> {
  const index = new Map<string, Candidate>();
  for (const child of parent.children) {
    const sid = child.getPluginData(SID_KEY);
    if (!sid) continue;
    index.set(sid, { node: child, sid, hash: child.getPluginData(HASH_KEY) });
  }
  return index;
}

/** Appariement de repli : le contenu prime sur la position. */
function matchByContent(
  spec: SpecNode,
  pool: SceneNode[],
): SceneNode | null {
  const sameNameAndHash = pool.find(
    (node) => node.name === spec.name && node.getPluginData(HASH_KEY) === spec.subtreeHash,
  );
  if (sameNameAndHash) return sameNameAndHash;
  const sameName = pool.find((node) => node.name === spec.name && isCompatible(node, spec));
  return sameName ?? null;
}

export interface ReconcileResult {
  node: SceneNode;
  /** Le sous-arbre a-t-il ete saute parce qu'inchange ? */
  skipped: boolean;
}

export async function reconcileNode(
  parent: ChildrenMixin & SceneNode,
  spec: SpecNode,
  parentSpec: SpecNode | null,
  index: Map<string, Candidate>,
  unmatched: SceneNode[],
  position: number,
  designSpec: DesignSpec,
  context: SyncContext,
): Promise<ReconcileResult> {
  let node: SceneNode | null = null;
  let existed = false;

  const byId = index.get(spec.sid);
  if (byId && isCompatible(byId.node, spec)) {
    node = byId.node;
    existed = true;
  } else {
    const fallback = matchByContent(spec, unmatched);
    if (fallback) {
      node = fallback;
      existed = true;
    }
  }

  if (node) {
    // Retirer du vivier : un meme noeud Figma ne doit pas servir deux fois.
    const poolIndex = unmatched.indexOf(node);
    if (poolIndex >= 0) unmatched.splice(poolIndex, 1);
  }

  // Le type a change (un texte est devenu une image) : on remplace, en
  // conservant la position dans la liste des enfants.
  if (node && !isCompatible(node, spec)) {
    node.remove();
    node = null;
    existed = false;
  }

  if (!node) {
    node = await createNode(spec, designSpec, context);
    existed = false;
  }

  if (node.parent !== parent) parent.appendChild(node);

  // Sous-arbre inchange : on ne reecrit rien. Sur un site de plusieurs milliers
  // de noeuds dont trois mots ont bouge, c'est la difference entre une
  // synchronisation instantanee et une reecriture complete.
  const unchanged =
    existed &&
    context.options.skipUnchanged &&
    node.getPluginData(HASH_KEY) === spec.subtreeHash;

  if (unchanged) {
    context.stats.skipped += countSpec(spec);
    parent.insertChild(position, node);
    return { node, skipped: true };
  }

  await applyNode(node, spec, designSpec, context);
  if (existed) context.stats.updated++;
  else context.stats.created++;

  /* ------------------------------- enfants ------------------------------- */

  if ('children' in node && spec.kind !== 'VECTOR') {
    const container = node as ChildrenMixin & SceneNode;
    const childIndex = indexChildren(container);
    const childUnmatched = container.children.filter(
      (child) => !spec.children.some((candidate) => candidate.sid === child.getPluginData(SID_KEY)),
    );

    for (let i = 0; i < spec.children.length; i++) {
      const childSpec = spec.children[i]!;
      const result = await reconcileNode(
        container,
        childSpec,
        spec,
        childIndex,
        childUnmatched,
        i,
        designSpec,
        context,
      );
      applyPosition(result.node, childSpec, spec);
      applySizing(result.node, childSpec, context);
    }

    disposeLeftovers(container, childUnmatched, context);
  }

  parent.insertChild(position, node);
  return { node, skipped: false };
}

/**
 * Traite les noeuds Figma dont la contrepartie a disparu du site.
 *
 * La suppression n'est PAS le defaut : un noeud qui disparait peut aussi
 * resulter d'une page temporairement en erreur. Les archiver rend la perte
 * visible et reversible.
 */
function disposeLeftovers(
  parent: ChildrenMixin & SceneNode,
  leftovers: SceneNode[],
  context: SyncContext,
): void {
  const managed = leftovers.filter((node) => node.getPluginData(SID_KEY) !== '');
  if (managed.length === 0) return;

  if (context.options.onRemoved === 'keep') return;

  if (context.options.onRemoved === 'delete') {
    for (const node of managed) {
      node.remove();
      context.stats.removed++;
    }
    return;
  }

  // Mode archive : on deplace hors de la mise en page, dans une frame dediee et
  // clairement signalee, a la racine de la page.
  const page = findPage(parent);
  if (!page) return;
  let archive = page.children.find(
    (child) => child.type === 'FRAME' && child.name === ARCHIVE_NAME,
  ) as FrameNode | undefined;

  if (!archive) {
    archive = figma.createFrame();
    archive.name = ARCHIVE_NAME;
    archive.layoutMode = 'VERTICAL';
    archive.itemSpacing = 24;
    archive.paddingTop = 24;
    archive.paddingBottom = 24;
    archive.paddingLeft = 24;
    archive.paddingRight = 24;
    archive.fills = [{ type: 'SOLID', color: { r: 1, g: 0.96, b: 0.9 } }];
    // Le rattachement precede le dimensionnement : Figma valide « ajuster » par
    // rapport au parent, qui doit donc exister.
    page.appendChild(archive);
    archive.layoutSizingHorizontal = 'HUG';
    archive.layoutSizingVertical = 'HUG';
  }

  for (const node of managed) {
    // On efface le `sid` : le noeud archive ne doit plus etre apparie lors des
    // synchronisations suivantes, sinon il serait « ressuscite ».
    node.setPluginData(SID_KEY, '');
    node.name = `${node.name} (retire)`;
    archive.appendChild(node);
    context.stats.removed++;
  }
}

function findPage(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE') current = current.parent;
  return current as PageNode | null;
}

function countSpec(spec: SpecNode): number {
  return 1 + spec.children.reduce((sum, child) => sum + countSpec(child), 0);
}

export { indexChildren };
