import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPath, makeRootSid, makeSid, normalizeRoute, slug } from './ids.js';
import type { PathSegment } from './ids.js';

const seg = (tag: string, over: Partial<PathSegment> = {}): PathSegment => ({
  tag,
  index: 1,
  ...over,
});

test('normalizeRoute : formes equivalentes reduites a la meme route', () => {
  for (const input of [
    '/index.html',
    'index.html',
    'https://projet.example.fr/index.html',
    '/',
    '/?utm_source=x',
    '/#ancre',
  ]) {
    assert.equal(normalizeRoute(input), '/', `echec pour ${input}`);
  }
  assert.equal(normalizeRoute('/nos-metiers/'), '/nos-metiers');
  assert.equal(normalizeRoute('/nos-metiers.html'), '/nos-metiers');
  assert.equal(normalizeRoute('https://projet.example.fr/a/b/'), '/a/b');
});

test('makeSid : stable entre deux appels identiques', () => {
  const path = [seg('body'), seg('main'), seg('section', { cls: 'hero' })];
  assert.equal(makeSid('/', 'Desktop', path), makeSid('/index.html', 'Desktop', path));
});

test('makeSid : differe par breakpoint et par route', () => {
  const path = [seg('body'), seg('main')];
  assert.notEqual(makeSid('/', 'Desktop', path), makeSid('/', 'Mobile', path));
  assert.notEqual(makeSid('/', 'Desktop', path), makeSid('/contact', 'Desktop', path));
});

test('une ancre id rend le sid insensible aux changements au-dessus', () => {
  // C est la garantie qui compte : ajouter une banniere en haut de page ne doit
  // pas recreer toutes les sections dans Figma (sinon commentaires perdus).
  const avant = [seg('body'), seg('main'), seg('section', { anchor: 'metiers' }), seg('h2')];
  const apres = [
    seg('body'),
    seg('div', { cls: 'banniere' }),
    seg('main'),
    seg('section', { anchor: 'metiers', index: 2 }),
    seg('h2'),
  ];
  assert.equal(makeSid('/', 'Desktop', avant), makeSid('/', 'Desktop', apres));
});

test('sans ancre, un decalage de freres change le sid (repli gere cote plugin)', () => {
  const avant = [seg('body'), seg('section', { index: 1 })];
  const apres = [seg('body'), seg('section', { index: 2 })];
  assert.notEqual(makeSid('/', 'Desktop', avant), makeSid('/', 'Desktop', apres));
});

test('formatPath : lisible, et l ancre remet le chemin a zero', () => {
  assert.equal(
    formatPath([seg('body'), seg('main'), seg('h1', { cls: 'titre', index: 2 })]),
    'body>main>h1.titre:2',
  );
  assert.equal(formatPath([seg('body'), seg('section', { anchor: 'hero' }), seg('p')]), '#hero>p');
  assert.equal(formatPath([seg('div'), seg('div', { pseudo: 'before' })]), 'div>div::before');
});

test('makeRootSid : une frame racine par route et par breakpoint', () => {
  assert.equal(makeRootSid('/', 'Desktop'), makeRootSid('/index.html', 'Desktop'));
  assert.notEqual(makeRootSid('/', 'Desktop'), makeRootSid('/', 'Tablet'));
  assert.match(makeRootSid('/', 'Desktop'), /^root\.desktop\.[0-9a-f]{13}$/);
});

test('slug : accents, ponctuation, longueur bornee', () => {
  assert.equal(slug('Les Métiers d’Expertise'), 'les-metiers-d-expertise');
  assert.equal(slug('  --  '), 'x');
  assert.ok(slug('a'.repeat(100)).length <= 32);
});
