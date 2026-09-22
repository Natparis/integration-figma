/** Constructeurs de `design-spec` minimaux, partages par les tests. */
import type { DesignSpec, LayoutSpec, SpecNode, StyleSpec } from './types.js';
import { hashValue } from './hash.js';

export const emptyLayout: LayoutSpec = {
  mode: 'NONE',
  wrap: false,
  padding: [0, 0, 0, 0],
  itemSpacing: 0,
  counterAxisSpacing: 0,
  primaryAxisAlignItems: 'MIN',
  counterAxisAlignItems: 'MIN',
  sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
  clipsContent: false,
  positioning: 'AUTO',
};

export const emptyStyle: StyleSpec = {
  fills: [],
  strokes: [],
  strokeWeight: 0,
  strokeAlign: 'INSIDE',
  cornerRadius: [0, 0, 0, 0],
  effects: [],
  opacity: 1,
  visible: true,
};

export function node(sid: string, over: Partial<SpecNode> = {}): SpecNode {
  const base: SpecNode = {
    sid,
    name: sid,
    kind: 'FRAME',
    box: { x: 0, y: 0, w: 100, h: 100 },
    layout: emptyLayout,
    style: emptyStyle,
    children: [],
    hash: '',
    subtreeHash: '',
    ...over,
  };
  return rehash(base);
}

/** Recalcule `hash` / `subtreeHash` comme le fait l'extracteur. */
export function rehash(n: SpecNode): SpecNode {
  const { hash: _h, subtreeHash: _s, children, ...rest } = n;
  const kids = children.map(rehash);
  const hash = hashValue(rest);
  return {
    ...n,
    children: kids,
    hash,
    subtreeHash: hashValue([hash, ...kids.map((k) => k.subtreeHash)]),
  };
}

export function spec(over: Partial<DesignSpec> = {}): DesignSpec {
  const root = node('root.desktop.aaa', { children: [node('desktop.h1.bbb', { kind: 'TEXT', text: text('Bonjour') })] });
  const base: DesignSpec = {
    specVersion: 1,
    revision: 'rev1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: {
      kind: 'url',
      root: 'https://example.test/',
      extractedAt: '2026-01-01T00:00:00.000Z',
      contentHash: 'abc',
      extractorVersion: '0.1.0',
    },
    tokens: [],
    paintStyles: [],
    textStyles: [],
    effectStyles: [],
    components: [],
    pages: [
      {
        name: '01 · Accueil',
        route: '/',
        title: 'Accueil',
        breakpoints: [{ name: 'Desktop', width: 1440, height: 2000, root }],
      },
    ],
    assets: [],
    diagnostics: [],
    stats: {
      pages: 1,
      breakpoints: 1,
      nodes: 2,
      textNodes: 1,
      assets: 0,
      variables: 0,
      components: 0,
    },
    ...over,
  };
  return base;
}

export function text(characters: string): NonNullable<SpecNode['text']> {
  return {
    characters,
    font: {
      family: 'Inter',
      style: 'Regular',
      weight: 400,
      italic: false,
      size: 16,
      lineHeight: { unit: 'PIXELS', value: 24 },
      letterSpacing: { unit: 'PIXELS', value: 0 },
    },
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    textAlignHorizontal: 'LEFT',
    textAlignVertical: 'TOP',
    textAutoResize: 'HEIGHT',
    textDecoration: 'NONE',
    textCase: 'ORIGINAL',
    paragraphSpacing: 0,
  };
}
