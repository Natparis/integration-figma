import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, hashString, hashValue } from './hash.js';

test('canonicalize : l ordre des cles ne change pas le resultat', () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.equal(canonicalize({ x: { p: 1, q: 2 } }), canonicalize({ x: { q: 2, p: 1 } }));
});

test('canonicalize : les cles undefined sont ignorees', () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
});

test('canonicalize : le bruit sous-pixel est absorbe a 3 decimales', () => {
  // Chrome renvoie des rects comme 123.45600128173828 ; sans arrondi, deux
  // extractions du meme site produiraient des hashes differents.
  assert.equal(hashValue({ w: 123.4560012 }), hashValue({ w: 123.456 }));
  assert.notEqual(hashValue({ w: 123.456 }), hashValue({ w: 123.457 }));
});

test('canonicalize : ordre des tableaux significatif', () => {
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test('hashString : deterministe, longueur fixe', () => {
  assert.equal(hashString('bonjour'), hashString('bonjour'));
  assert.notEqual(hashString('bonjour'), hashString('bonsoir'));
  assert.equal(hashString('bonjour').length, 13);
  assert.equal(hashString('').length, 13);
  assert.match(hashString('metiers d expertise'), /^[0-9a-f]{13}$/);
});

test('hashValue : valeurs non finies neutralisees', () => {
  assert.equal(hashValue({ v: Number.NaN }), hashValue({ v: null }));
  assert.equal(hashValue({ v: Number.POSITIVE_INFINITY }), hashValue({ v: null }));
});
