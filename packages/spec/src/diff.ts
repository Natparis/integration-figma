/**
 * Comparaison de deux `design-spec`.
 *
 * Sert deux usages : le rapport `sfs diff` (« qu'est-ce qui a change sur le site
 * depuis la derniere synchro ? ») et le resume affiche par le plugin avant
 * ecriture, pour qu'on sache ce qu'on s'apprete a modifier dans Figma.
 */

import type { DesignSpec, PageSpec, SpecNode } from './types.js';

export type ChangeKind = 'added' | 'removed' | 'modified' | 'moved';

export interface NodeChange {
  kind: ChangeKind;
  sid: string;
  name: string;
  page: string;
  breakpoint: string;
  /** Champs de premier niveau qui different (`text`, `style`, `layout`, `box`...). */
  fields?: string[];
}

export interface SpecDiff {
  unchanged: boolean;
  previousRevision: string | null;
  nextRevision: string;
  pages: { added: string[]; removed: string[]; kept: string[] };
  nodes: NodeChange[];
  tokens: { added: string[]; removed: string[]; modified: string[] };
  styles: { added: string[]; removed: string[]; modified: string[] };
  assets: { added: string[]; removed: string[]; modified: string[] };
  summary: {
    nodesAdded: number;
    nodesRemoved: number;
    nodesModified: number;
    nodesMoved: number;
  };
}

interface FlatEntry {
  node: SpecNode;
  page: string;
  breakpoint: string;
  /** Position parmi les freres, pour detecter les reordonnancements. */
  position: number;
  parentSid: string | null;
}

function flatten(pages: PageSpec[]): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  for (const page of pages) {
    for (const bp of page.breakpoints) {
      const walk = (node: SpecNode, position: number, parentSid: string | null): void => {
        out.set(node.sid, { node, page: page.name, breakpoint: bp.name, position, parentSid });
        node.children.forEach((child, i) => walk(child, i, node.sid));
      };
      walk(bp.root, 0, null);
    }
  }
  return out;
}

/** Champs de premier niveau qui different entre deux versions d'un noeud. */
function changedFields(a: SpecNode, b: SpecNode): string[] {
  const fields: string[] = [];
  const cmp = (key: keyof SpecNode): void => {
    if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) fields.push(key);
  };
  if (a.kind !== b.kind) fields.push('kind');
  if (a.name !== b.name) fields.push('name');
  cmp('box');
  cmp('layout');
  cmp('style');
  cmp('text');
  cmp('image');
  cmp('vector');
  if ((a.instanceOf ?? null) !== (b.instanceOf ?? null)) fields.push('instanceOf');
  return fields;
}

function diffNamed<T extends { name: string }>(
  prev: T[],
  next: T[],
  fingerprint: (item: T) => string,
): { added: string[]; removed: string[]; modified: string[] } {
  const prevMap = new Map(prev.map((item) => [item.name, item]));
  const nextMap = new Map(next.map((item) => [item.name, item]));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [name, item] of nextMap) {
    const before = prevMap.get(name);
    if (!before) added.push(name);
    else if (fingerprint(before) !== fingerprint(item)) modified.push(name);
  }
  for (const name of prevMap.keys()) if (!nextMap.has(name)) removed.push(name);
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

export function diffSpecs(previous: DesignSpec | null, next: DesignSpec): SpecDiff {
  const nextRevision = next.revision;
  if (!previous) {
    const flat = flatten(next.pages);
    const nodes: NodeChange[] = [...flat.values()].map((entry) => ({
      kind: 'added' as const,
      sid: entry.node.sid,
      name: entry.node.name,
      page: entry.page,
      breakpoint: entry.breakpoint,
    }));
    return {
      unchanged: false,
      previousRevision: null,
      nextRevision,
      pages: { added: next.pages.map((p) => p.name), removed: [], kept: [] },
      nodes,
      tokens: {
        added: next.tokens.flatMap((c) => c.variables.map((v) => `${c.name}/${v.name}`)).sort(),
        removed: [],
        modified: [],
      },
      styles: {
        added: [...next.paintStyles, ...next.textStyles, ...next.effectStyles]
          .map((s) => s.name)
          .sort(),
        removed: [],
        modified: [],
      },
      assets: { added: next.assets.map((a) => a.id).sort(), removed: [], modified: [] },
      summary: {
        nodesAdded: nodes.length,
        nodesRemoved: 0,
        nodesModified: 0,
        nodesMoved: 0,
      },
    };
  }

  const before = flatten(previous.pages);
  const after = flatten(next.pages);
  const nodes: NodeChange[] = [];

  for (const [sid, entry] of after) {
    const old = before.get(sid);
    if (!old) {
      nodes.push({
        kind: 'added',
        sid,
        name: entry.node.name,
        page: entry.page,
        breakpoint: entry.breakpoint,
      });
      continue;
    }
    // Le deplacement se teste avant l'abandon sur `subtreeHash` : un noeud
    // reordonne garde exactement le meme contenu, donc le meme subtreeHash.
    if (old.position !== entry.position || old.parentSid !== entry.parentSid) {
      nodes.push({
        kind: 'moved',
        sid,
        name: entry.node.name,
        page: entry.page,
        breakpoint: entry.breakpoint,
      });
    }
    // `subtreeHash` identique : rien de plus a inspecter dans ce sous-arbre.
    if (old.node.subtreeHash === entry.node.subtreeHash) continue;
    if (old.node.hash !== entry.node.hash) {
      nodes.push({
        kind: 'modified',
        sid,
        name: entry.node.name,
        page: entry.page,
        breakpoint: entry.breakpoint,
        fields: changedFields(old.node, entry.node),
      });
    }
  }

  for (const [sid, entry] of before) {
    if (!after.has(sid)) {
      nodes.push({
        kind: 'removed',
        sid,
        name: entry.node.name,
        page: entry.page,
        breakpoint: entry.breakpoint,
      });
    }
  }

  const prevPages = new Set(previous.pages.map((p) => p.name));
  const nextPages = new Set(next.pages.map((p) => p.name));

  const prevVars = previous.tokens.flatMap((c) =>
    c.variables.map((v) => ({ name: `${c.name}/${v.name}`, v })),
  );
  const nextVars = next.tokens.flatMap((c) =>
    c.variables.map((v) => ({ name: `${c.name}/${v.name}`, v })),
  );

  const summary = {
    nodesAdded: nodes.filter((n) => n.kind === 'added').length,
    nodesRemoved: nodes.filter((n) => n.kind === 'removed').length,
    nodesModified: nodes.filter((n) => n.kind === 'modified').length,
    nodesMoved: nodes.filter((n) => n.kind === 'moved').length,
  };

  return {
    unchanged: previous.revision === nextRevision,
    previousRevision: previous.revision,
    nextRevision,
    pages: {
      added: [...nextPages].filter((n) => !prevPages.has(n)).sort(),
      removed: [...prevPages].filter((n) => !nextPages.has(n)).sort(),
      kept: [...nextPages].filter((n) => prevPages.has(n)).sort(),
    },
    nodes,
    tokens: diffNamed(prevVars, nextVars, (item) => JSON.stringify(item.v.valuesByMode)),
    styles: diffNamed(
      [...previous.paintStyles, ...previous.textStyles, ...previous.effectStyles],
      [...next.paintStyles, ...next.textStyles, ...next.effectStyles],
      (s) => JSON.stringify(s),
    ),
    assets: diffNamed(
      previous.assets.map((a) => ({ ...a, name: a.id })),
      next.assets.map((a) => ({ ...a, name: a.id })),
      (a) => a.hash,
    ),
    summary,
  };
}

/** Rapport texte pour le terminal. */
export function formatDiff(diff: SpecDiff, limit = 40): string {
  const lines: string[] = [];
  if (diff.unchanged) return 'Aucun changement : le site est identique a la derniere extraction.';
  lines.push(
    `Revision ${diff.previousRevision ?? '(aucune)'} -> ${diff.nextRevision}`,
    '',
    `Pages      : +${diff.pages.added.length} / -${diff.pages.removed.length} / =${diff.pages.kept.length}`,
    `Noeuds     : +${diff.summary.nodesAdded} / -${diff.summary.nodesRemoved} / ~${diff.summary.nodesModified} / deplaces ${diff.summary.nodesMoved}`,
    `Tokens     : +${diff.tokens.added.length} / -${diff.tokens.removed.length} / ~${diff.tokens.modified.length}`,
    `Styles     : +${diff.styles.added.length} / -${diff.styles.removed.length} / ~${diff.styles.modified.length}`,
    `Assets     : +${diff.assets.added.length} / -${diff.assets.removed.length} / ~${diff.assets.modified.length}`,
  );
  if (diff.tokens.modified.length) {
    lines.push('', 'Tokens modifies :');
    for (const name of diff.tokens.modified.slice(0, limit)) lines.push(`  ~ ${name}`);
  }
  const interesting = diff.nodes.filter((n) => n.kind !== 'moved');
  if (interesting.length) {
    lines.push('', 'Detail des noeuds :');
    const sign = { added: '+', removed: '-', modified: '~', moved: '>' } as const;
    for (const change of interesting.slice(0, limit)) {
      const fields = change.fields?.length ? `  (${change.fields.join(', ')})` : '';
      lines.push(
        `  ${sign[change.kind]} [${change.page} / ${change.breakpoint}] ${change.name}${fields}`,
      );
    }
    if (interesting.length > limit) lines.push(`  ... et ${interesting.length - limit} de plus`);
  }
  return lines.join('\n');
}
