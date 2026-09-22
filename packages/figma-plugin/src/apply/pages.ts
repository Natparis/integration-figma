/**
 * Pages Figma et frames de breakpoint.
 *
 * Une page Figma par page du site, une frame par breakpoint, posees cote a cote
 * sur un rail horizontal. C'est la disposition qu'attend un developpeur : il
 * compare desktop et mobile d'un coup d'oeil.
 */

import type { BreakpointSpec, DesignSpec, PageSpec } from '@sfs/spec';
import { REVISION_KEY, SID_KEY, SOURCE_KEY } from '../context.js';
import type { SyncContext } from '../context.js';
import { applyNode, applySizing } from './nodes.js';
import { indexChildren, reconcileNode } from './reconcile.js';

/** Espace entre deux frames de breakpoint. */
const GUTTER = 120;

export async function ensurePage(name: string): Promise<PageNode> {
  const existing = figma.root.children.find((page) => page.name === name);
  if (existing) {
    // En mode « dynamic-page », le contenu d'une page n'est charge qu'a la
    // demande : sans cet appel, ses enfants sont inaccessibles.
    await existing.loadAsync();
    return existing;
  }
  const page = figma.createPage();
  page.name = name;
  return page;
}

export async function syncPage(
  pageSpec: PageSpec,
  designSpec: DesignSpec,
  context: SyncContext,
): Promise<void> {
  const page = await ensurePage(pageSpec.name);
  page.setPluginData(SOURCE_KEY, pageSpec.route);
  page.setPluginData(REVISION_KEY, designSpec.revision);

  const wanted = context.options.breakpoints.length
    ? pageSpec.breakpoints.filter((bp) => context.options.breakpoints.includes(bp.name))
    : pageSpec.breakpoints;

  let offsetX = 0;
  for (const breakpoint of wanted) {
    const frame = await syncBreakpoint(page, breakpoint, designSpec, context);
    frame.x = offsetX;
    frame.y = 0;
    offsetX += breakpoint.width + GUTTER;
  }
}

async function syncBreakpoint(
  page: PageNode,
  breakpoint: BreakpointSpec,
  designSpec: DesignSpec,
  context: SyncContext,
): Promise<FrameNode> {
  const spec = breakpoint.root;
  const index = indexChildren(page);
  const existing = index.get(spec.sid)?.node;

  let frame: FrameNode;
  if (existing && existing.type === 'FRAME') {
    frame = existing;
  } else {
    if (existing) existing.remove();
    frame = figma.createFrame();
    page.appendChild(frame);
  }

  await applyNode(frame, spec, designSpec, context);
  frame.setPluginData(SID_KEY, spec.sid);
  // La frame de page est la seule a taille imposee : c'est la fenetre du
  // navigateur, elle ne doit ni s'ajuster ni remplir.
  frame.layoutSizingHorizontal = 'FIXED';
  frame.layoutSizingVertical = 'FIXED';
  frame.resize(breakpoint.width, Math.max(1, breakpoint.height));

  const childIndex = indexChildren(frame);
  const unmatched = frame.children.filter(
    (child) => !spec.children.some((candidate) => candidate.sid === child.getPluginData(SID_KEY)),
  );

  for (let i = 0; i < spec.children.length; i++) {
    const childSpec = spec.children[i]!;
    const result = await reconcileNode(
      frame,
      childSpec,
      spec,
      childIndex,
      unmatched,
      i,
      designSpec,
      context,
    );
    applySizing(result.node, childSpec, context);
  }

  return frame;
}
