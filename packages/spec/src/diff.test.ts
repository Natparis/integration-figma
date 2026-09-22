import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSpecs, formatDiff } from './diff.js';
import { node, rehash, spec, text } from './fixtures.test-util.js';

test('premiere extraction : tout est en ajout', () => {
  const d = diffSpecs(null, spec());
  assert.equal(d.previousRevision, null);
  assert.equal(d.summary.nodesAdded, 2);
  assert.equal(d.summary.nodesRemoved, 0);
  assert.deepEqual(d.pages.added, ['01 · Accueil']);
});

test('specs identiques : aucun changement', () => {
  const a = spec();
  const d = diffSpecs(a, spec());
  assert.equal(d.unchanged, true);
  assert.equal(d.nodes.length, 0);
  assert.match(formatDiff(d), /Aucun changement/);
});

test('texte modifie : signale comme modification du champ text', () => {
  const before = spec();
  const after = spec({ revision: 'rev2' });
  const bp = after.pages[0]!.breakpoints[0]!;
  bp.root.children[0]!.text = text('Bonsoir');
  after.pages[0]!.breakpoints[0]!.root = rehash(bp.root);

  const d = diffSpecs(before, after);
  assert.equal(d.unchanged, false);
  assert.equal(d.summary.nodesModified, 1);
  const change = d.nodes.find((n) => n.kind === 'modified')!;
  assert.ok(change.fields!.includes('text'));
  assert.equal(change.page, '01 · Accueil');
});

test('sous-arbre inchange : pas de parcours inutile', () => {
  // Tout l interet de subtreeHash : un noeud dont le sous-arbre est identique ne
  // produit aucun changement, meme s il a des centaines d enfants.
  const before = spec();
  const after = spec();
  const d = diffSpecs(before, after);
  assert.equal(d.nodes.length, 0);
});

test('noeud supprime et noeud ajoute', () => {
  const before = spec();
  const after = spec({ revision: 'rev2' });
  const bp = after.pages[0]!.breakpoints[0]!;
  bp.root.children = [node('desktop.p.ccc', { kind: 'TEXT', text: text('Nouveau') })];
  bp.root = rehash(bp.root);

  const d = diffSpecs(before, after);
  assert.equal(d.summary.nodesAdded, 1);
  assert.equal(d.summary.nodesRemoved, 1);
  assert.equal(d.nodes.find((n) => n.kind === 'removed')!.sid, 'desktop.h1.bbb');
});

test('reordonnancement detecte comme deplacement, pas comme recreation', () => {
  const a = node('desktop.a', { kind: 'TEXT', text: text('A') });
  const b = node('desktop.b', { kind: 'TEXT', text: text('B') });
  const before = spec();
  before.pages[0]!.breakpoints[0]!.root = rehash(node('root.desktop.aaa', { children: [a, b] }));
  const after = spec({ revision: 'rev2' });
  after.pages[0]!.breakpoints[0]!.root = rehash(node('root.desktop.aaa', { children: [b, a] }));

  const d = diffSpecs(before, after);
  assert.equal(d.summary.nodesAdded, 0);
  assert.equal(d.summary.nodesRemoved, 0);
  assert.equal(d.summary.nodesMoved, 2);
});

test('tokens : ajout, suppression et modification de valeur', () => {
  const collection = (vars: Array<[string, string]>) => [
    {
      name: 'Design Tokens',
      modes: ['Light'],
      defaultMode: 'Light',
      variables: vars.map(([name, hex]) => ({
        name,
        type: 'COLOR' as const,
        valuesByMode: { Light: { r: 0, g: 0, b: 0, a: 1, hex } as never },
      })),
    },
  ];
  const before = spec({ tokens: collection([['color/brand/600', '#123456'], ['color/old', '#fff']]) });
  const after = spec({
    revision: 'rev2',
    tokens: collection([['color/brand/600', '#654321'], ['color/new', '#000']]),
  });
  const d = diffSpecs(before, after);
  assert.deepEqual(d.tokens.modified, ['Design Tokens/color/brand/600']);
  assert.deepEqual(d.tokens.added, ['Design Tokens/color/new']);
  assert.deepEqual(d.tokens.removed, ['Design Tokens/color/old']);
});

test('assets : compares par hash de contenu, pas par nom', () => {
  const asset = (id: string, hash: string) => ({
    id,
    kind: 'IMAGE' as const,
    file: `assets/${id}.png`,
    source: `/${id}.png`,
    mime: 'image/png',
    bytes: 10,
    hash,
  });
  const d = diffSpecs(
    spec({ assets: [asset('img_1', 'h1')] }),
    spec({ revision: 'rev2', assets: [asset('img_1', 'h2')] }),
  );
  assert.deepEqual(d.assets.modified, ['img_1']);
});

test('formatDiff : resume lisible et borne', () => {
  const before = spec();
  const after = spec({ revision: 'rev2' });
  const bp = after.pages[0]!.breakpoints[0]!;
  bp.root.children = Array.from({ length: 100 }, (_, i) =>
    node(`desktop.n${i}`, { kind: 'TEXT', text: text(`Ligne ${i}`) }),
  );
  bp.root = rehash(bp.root);
  const out = formatDiff(diffSpecs(before, after), 5);
  assert.match(out, /Revision rev1 -> rev2/);
  assert.match(out, /et \d+ de plus/);
  assert.ok(out.split('\n').length < 30);
});
