import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpecValidationError, validateSpec } from './validate.js';
import { node, spec, text } from './fixtures.test-util.js';

test('un spec valide passe et compte ses noeuds', () => {
  const result = validateSpec(spec());
  assert.equal(result.nodeCount, 2);
  assert.deepEqual(result.warnings, []);
});

test('version de spec incompatible : message actionnable', () => {
  assert.throws(
    () => validateSpec({ ...spec(), specVersion: 2 }),
    (err: unknown) =>
      err instanceof SpecValidationError && /mettez a jour le plugin ou le CLI/.test(err.message),
  );
});

test('sid en doublon refuse : la synchro ecraserait un noeud par un autre', () => {
  const s = spec();
  const bp = s.pages[0]!.breakpoints[0]!;
  bp.root.children.push(node('desktop.h1.bbb', { kind: 'TEXT', text: text('Doublon') }));
  assert.throws(() => validateSpec(s), /doublon/);
});

test('noeud TEXT sans text refuse', () => {
  const s = spec();
  delete s.pages[0]!.breakpoints[0]!.root.children[0]!.text;
  assert.throws(() => validateSpec(s), /doit porter `text`/);
});

test('type de noeud inconnu refuse', () => {
  const s = spec();
  (s.pages[0]!.breakpoints[0]!.root.children[0] as { kind: string }).kind = 'BLOB';
  assert.throws(() => validateSpec(s), /type de noeud inconnu/);
});

test('aucune page : refuse plutot que de vider le fichier Figma', () => {
  assert.throws(() => validateSpec(spec({ pages: [] })), /aucune page extraite/);
});

test('references orphelines : avertissement, pas blocage', () => {
  const s = spec();
  s.pages[0]!.breakpoints[0]!.root.children.push(
    node('desktop.img', { kind: 'IMAGE', image: { assetId: 'absent', scaleMode: 'FILL' } }),
  );
  const result = validateSpec(s);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /asset introuvable/);
});

test('variable de peinture orpheline signalee', () => {
  const s = spec();
  s.pages[0]!.breakpoints[0]!.root.style.fills = [
    { type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1, variable: 'color/fantome' },
  ];
  assert.match(validateSpec(s).warnings.join('\n'), /variable introuvable/);
});

test('mode par defaut absent de la collection : refuse', () => {
  assert.throws(
    () =>
      validateSpec(
        spec({
          tokens: [{ name: 'T', modes: ['Light'], defaultMode: 'Dark', variables: [] }],
        }),
      ),
    /mode par defaut/,
  );
});

test('arbre trop profond refuse (protection de la pile du plugin)', () => {
  const s = spec();
  let deep = node('deep.0');
  for (let i = 1; i < 250; i++) deep = node(`deep.${i}`, { children: [deep] });
  s.pages[0]!.breakpoints[0]!.root.children.push(deep);
  assert.throws(() => validateSpec(s), /trop profond/);
});
