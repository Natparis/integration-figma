import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LayoutSpec } from '@sfs/spec';
import { countGridColumns, inferLayout, inferSizing, sizeLimits } from './layout.js';
import type { RawDeclared } from '../browser/raw.js';

const box = (w = 100, h = 100) => ({ x: 0, y: 0, w, h });

const autoLayout = (over: Partial<LayoutSpec> = {}): LayoutSpec => ({
  mode: 'VERTICAL',
  wrap: false,
  padding: [0, 0, 0, 0],
  itemSpacing: 0,
  counterAxisSpacing: 0,
  primaryAxisAlignItems: 'MIN',
  counterAxisAlignItems: 'MIN',
  sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
  clipsContent: false,
  positioning: 'AUTO',
  ...over,
});

const sizing = (
  style: Record<string, string>,
  declared: RawDeclared,
  over: Partial<Parameters<typeof inferSizing>[0]> = {},
) =>
  inferSizing({
    style,
    declared,
    box: box(),
    parentLayout: autoLayout(),
    parentCounterStretch: false,
    selfHasLayout: true,
    kind: 'FRAME',
    ...over,
  });

/* ------------------------------ auto-layout ------------------------------- */

test('flex row : direction, ecart et alignements', () => {
  const result = inferLayout({
    style: {
      display: 'flex',
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      columnGap: '24px',
      paddingTop: '16px',
      paddingLeft: '24px',
    },
    box: box(1140, 82),
    children: [],
  });
  assert.equal(result.layout.mode, 'HORIZONTAL');
  assert.equal(result.layout.itemSpacing, 24);
  assert.equal(result.layout.primaryAxisAlignItems, 'SPACE_BETWEEN');
  assert.equal(result.layout.counterAxisAlignItems, 'CENTER');
  assert.deepEqual(result.layout.padding, [16, 0, 0, 24]);
});

test('la bordure CSS est absorbee dans le padding Figma', () => {
  // `getBoundingClientRect` est en border-box, alors qu'un contour « interieur »
  // de Figma ne prend pas de place : sans cette compensation, le contenu serait
  // decale de l epaisseur de la bordure.
  const result = inferLayout({
    style: { display: 'flex', paddingTop: '10px', borderTopWidth: '2px' },
    box: box(),
    children: [],
  });
  assert.equal(result.layout.padding[0], 12);
});

test('row-reverse : Figma n a pas d inversion, on inverse la liste des enfants', () => {
  const result = inferLayout({
    style: { display: 'flex', flexDirection: 'row-reverse' },
    box: box(),
    children: [],
  });
  assert.equal(result.layout.mode, 'HORIZONTAL');
  assert.equal(result.reverseChildren, true);
});

test('grille a une colonne : auto-layout vertical sans perte', () => {
  const result = inferLayout({
    style: { display: 'grid', gridTemplateColumns: '1140px', rowGap: '24px' },
    box: box(),
    children: [],
  });
  assert.equal(result.layout.mode, 'VERTICAL');
  assert.equal(result.layout.itemSpacing, 24);
});

test('grille multi-colonnes : horizontal avec retour a la ligne', () => {
  const result = inferLayout({
    style: {
      display: 'grid',
      gridTemplateColumns: '348px 348px 348px',
      columnGap: '24px',
      rowGap: '24px',
    },
    box: box(1092, 560),
    children: Array.from({ length: 6 }, () => ({ box: box(348, 268), style: {} })),
  });
  assert.equal(result.layout.mode, 'HORIZONTAL');
  assert.equal(result.layout.wrap, true);
  assert.equal(result.layout.itemSpacing, 24);
  assert.equal(result.layout.counterAxisSpacing, 24);
});

test('grille a colonnes inegales : signalee au developpeur', () => {
  const result = inferLayout({
    style: { display: 'grid', gridTemplateColumns: '600px 260px 260px' },
    box: box(1140, 200),
    children: Array.from({ length: 6 }, () => ({ box: box(260, 100), style: {} })),
  });
  assert.match(result.notes.join(' '), /colonnes inegales/);
});

test('flux en bloc : empilement vertical deduit de la geometrie', () => {
  // C est ce qui rend la maquette modifiable : ajouter une section dans Figma
  // repousse la suite, comme dans le navigateur.
  const result = inferLayout({
    style: { display: 'block' },
    box: box(1440, 300),
    children: [
      { box: { x: 0, y: 0, w: 1440, h: 80 }, style: {} },
      { box: { x: 0, y: 100, w: 1440, h: 80 }, style: {} },
      { box: { x: 0, y: 200, w: 1440, h: 80 }, style: {} },
    ],
  });
  assert.equal(result.layout.mode, 'VERTICAL');
  assert.equal(result.layout.itemSpacing, 20);
});

test('enfants superposes : pas d auto-layout, positionnement libre', () => {
  const result = inferLayout({
    style: { display: 'block' },
    box: box(400, 400),
    children: [
      { box: { x: 0, y: 0, w: 400, h: 300 }, style: {} },
      { box: { x: 20, y: 20, w: 200, h: 100 }, style: {} },
    ],
  });
  assert.equal(result.layout.mode, 'NONE');
});

test('les enfants absolus ne comptent pas dans la deduction de direction', () => {
  const result = inferLayout({
    style: { display: 'block' },
    box: box(400, 400),
    children: [
      { box: { x: 0, y: 0, w: 400, h: 100 }, style: {} },
      { box: { x: 0, y: 120, w: 400, h: 100 }, style: {} },
      { box: { x: 10, y: 10, w: 50, h: 50 }, style: { position: 'absolute' } },
    ],
  });
  assert.equal(result.layout.mode, 'VERTICAL');
});

test('contenu centre par margin auto : alignement centre deduit', () => {
  const result = inferLayout({
    style: { display: 'block' },
    box: box(1440, 200),
    children: [
      { box: { x: 150, y: 0, w: 1140, h: 80 }, style: {} },
      { box: { x: 150, y: 100, w: 1140, h: 80 }, style: {} },
    ],
  });
  assert.equal(result.layout.counterAxisAlignItems, 'CENTER');
});

test('countGridColumns', () => {
  assert.equal(countGridColumns('348px 348px 348px'), 3);
  assert.equal(countGridColumns('none'), 0);
  assert.equal(countGridColumns(undefined), 0);
  assert.equal(countGridColumns('repeat(3, 1fr)'), 1);
});

/* ----------------------------- dimensionnement ---------------------------- */

test('une largeur CALCULEE ne vaut pas une largeur declaree', () => {
  // Le bug qui figeait toute la maquette : Chromium rend `width` en pixels meme
  // pour un element de bloc qui occupe simplement la largeur de son parent. Un
  // fichier Figma ou rien ne s adapte est inutilisable pour un developpeur.
  const result = sizing(
    { display: 'block', width: '1440px' },
    { parentContentWidth: 1440 },
    { box: box(1440, 80) },
  );
  assert.equal(result.horizontal, 'FILL');
});

test('largeur reellement declaree en pixels : taille fixe', () => {
  const result = sizing(
    { display: 'block' },
    { width: '320px', parentContentWidth: 1440 },
    { box: box(320, 80) },
  );
  assert.equal(result.horizontal, 'FIXED');
});

test('conteneur a max-width : remplit, plafonne', () => {
  // Le motif le plus repandu du web (`max-width` + `margin: 0 auto`). Sa largeur
  // vient de sa contrainte, pas de son contenu.
  const result = sizing(
    { display: 'block', maxWidth: '1140px' },
    { parentContentWidth: 1440 },
    { box: box(1140, 82) },
  );
  assert.equal(result.horizontal, 'FILL');
});

test('flex-grow declare : remplit l axe principal', () => {
  const result = sizing(
    { display: 'block' },
    { flex: '1', parentContentWidth: 1000 },
    { parentLayout: autoLayout({ mode: 'HORIZONTAL' }), box: box(400, 80) },
  );
  assert.equal(result.horizontal, 'FILL');
});

test('element de niveau ligne : ajuste a son contenu', () => {
  const result = sizing(
    { display: 'inline-flex' },
    { inlineLevel: true, parentContentWidth: 1000 },
    { parentLayout: autoLayout({ mode: 'HORIZONTAL' }), box: box(227, 50) },
  );
  assert.equal(result.horizontal, 'HUG');
});

test('align-items: stretch du parent : remplit l axe transversal', () => {
  const result = sizing({}, { parentContentWidth: 1000 }, {
    parentLayout: autoLayout({ mode: 'HORIZONTAL' }),
    parentCounterStretch: true,
    box: box(300, 116),
  });
  assert.equal(result.vertical, 'FILL');
});

test('remplir est refuse hors d un parent en auto-layout (regle Figma)', () => {
  // Emettre « remplir » sans auto-layout parent fait echouer l ecriture.
  const result = sizing(
    { display: 'block' },
    { width: '100%', parentContentWidth: 1440 },
    { parentLayout: null, box: box(1440, 80) },
  );
  assert.equal(result.horizontal, 'FIXED');
});

test('ajuster est refuse si le noeud n a pas d auto-layout', () => {
  const result = sizing({ display: 'block' }, { parentContentWidth: 1440 }, {
    selfHasLayout: false,
    box: box(200, 80),
  });
  assert.equal(result.horizontal, 'FIXED');
});

test('element hors flux : toujours fixe', () => {
  const result = sizing(
    { position: 'absolute' },
    { width: '100%', parentContentWidth: 1440 },
    { box: box(1440, 80) },
  );
  assert.deepEqual(result, { horizontal: 'FIXED', vertical: 'FIXED' });
});

test('images et vecteurs : jamais en ajustement', () => {
  for (const kind of ['IMAGE', 'VECTOR'] as const) {
    const result = sizing({}, { parentContentWidth: 1000 }, { kind, box: box(320, 200) });
    assert.equal(result.vertical, 'FIXED', kind);
  }
});

test('aspect-ratio : hauteur fixe, Figma ne sait pas lier les deux axes', () => {
  const result = sizing({ aspectRatio: '16 / 9' }, { parentContentWidth: 1000 });
  assert.equal(result.vertical, 'FIXED');
});

test('hauteur non declaree : ajuste au contenu', () => {
  const result = sizing({ display: 'block' }, { parentContentWidth: 1440 }, { box: box(1440, 900) });
  assert.equal(result.vertical, 'HUG');
});

test('pourcentage partiel : fixe (Figma ne sait pas l exprimer)', () => {
  const result = sizing({ display: 'block' }, { width: '48%', parentContentWidth: 1000 });
  assert.equal(result.horizontal, 'FIXED');
});

test('fit-content : ajuste', () => {
  const result = sizing({ display: 'block' }, { width: 'fit-content', parentContentWidth: 1000 });
  assert.equal(result.horizontal, 'HUG');
});

test('sizeLimits ne retient que les longueurs absolues', () => {
  assert.deepEqual(sizeLimits({ maxWidth: '1140px', minHeight: '48px' }), {
    maxWidth: 1140,
    minHeight: 48,
  });
  assert.deepEqual(sizeLimits({ maxWidth: 'none', minWidth: 'auto', maxHeight: '100%' }), {});
});
