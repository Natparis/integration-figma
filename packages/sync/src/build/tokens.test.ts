import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Diagnostic } from '@sfs/spec';
import { analyzeCaptures, buildTokens, classifyVariable, variableNameFromCss } from './tokens.js';
import type { RawCapture, RawNode } from '../browser/raw.js';

const node = (over: Partial<RawNode> = {}): RawNode => ({
  seg: { tag: 'div', index: 1 },
  rect: { x: 0, y: 0, w: 100, h: 100 },
  style: {},
  declared: {},
  images: [],
  children: [],
  ...over,
});

const capture = (root: RawNode, over: Partial<RawCapture> = {}): RawCapture => ({
  route: '/',
  breakpointName: 'Desktop',
  title: 'Test',
  lang: 'fr',
  viewport: { width: 1440, height: 1024 },
  documentHeight: 2000,
  root,
  rootVariables: {},
  rootVariablesDeclared: {},
  fonts: [],
  links: [],
  stats: { visited: 1, emitted: 1, skipped: 0, truncated: false },
  warnings: [],
  ...over,
});

const textNode = (tag: string, size: string, family = 'Inter', weight = '400'): RawNode =>
  node({
    seg: { tag, index: 1 },
    style: { fontFamily: family, fontSize: size, fontWeight: weight, lineHeight: '24px' },
    text: {
      characters: 'Bonjour',
      runs: [
        {
          start: 0, end: 7, fontFamily: family, fontSize: size, fontWeight: weight,
          fontStyle: 'normal', color: 'rgb(0,0,0)', textDecorationLine: 'none',
          letterSpacing: 'normal',
        },
      ],
      bounds: null,
      lineCount: 1,
    },
  });

/* ------------------------------ nomenclature ------------------------------ */

test('les noms CSS hierarchiques deviennent des groupes Figma', () => {
  assert.equal(variableNameFromCss('--color-brand-600', 'color'), 'color/brand/600');
  assert.equal(variableNameFromCss('--radius-lg', 'radius'), 'radius/lg');
  assert.equal(variableNameFromCss('--space-4', 'space'), 'space/4');
});

test('un nom sans hierarchie reste une feuille', () => {
  // `--max-width` deviendrait `size/max/width` avec un decoupage aveugle : deux
  // niveaux de groupe pour une seule valeur, illisible dans le panneau Figma.
  assert.equal(variableNameFromCss('--max-width', 'size'), 'size/max-width');
  assert.equal(variableNameFromCss('--gouttiere', 'size'), 'size/gouttiere');
});

test('profondeur bornee a trois niveaux', () => {
  assert.equal(
    variableNameFromCss('--color-bouton-principal-fond-survol', 'color'),
    'color/bouton/principal/fond-survol',
  );
});

test('classifyVariable : famille deduite de la valeur puis du nom', () => {
  assert.deepEqual(classifyVariable('--color-brand', 'oklch(0.55 0.18 250)'), {
    family: 'color',
    type: 'COLOR',
  });
  assert.deepEqual(classifyVariable('--radius-lg', '20px'), { family: 'radius', type: 'FLOAT' });
  assert.deepEqual(classifyVariable('--space-4', '1rem'), { family: 'space', type: 'FLOAT' });
  assert.deepEqual(classifyVariable('--gouttiere', '24px'), { family: 'size', type: 'FLOAT' });
  assert.deepEqual(classifyVariable('--font-sans', '"Inter", sans-serif'), {
    family: 'string',
    type: 'STRING',
  });
});

test('classifyVariable : une reference var() n a pas de valeur propre', () => {
  assert.equal(classifyVariable('--color-surface', 'var(--color-neutral-0)'), null);
});

/* ------------------------------- construction ----------------------------- */

const buildOptions = (over = {}) => ({
  collectionName: 'Design Tokens',
  useCssVariables: true,
  inferMissing: false,
  lightVariables: {},
  darkVariables: null,
  declaredVariables: {},
  primaryBreakpoint: 'Desktop',
  ...over,
});

test('les alias CSS deviennent des alias de variables Figma', () => {
  // Sans cela, la couleur serait dupliquee : changer `color/neutral/900` dans
  // Figma ne mettrait pas a jour `color/text`, et les deux divergeraient.
  const diagnostics: Diagnostic[] = [];
  const result = buildTokens(
    analyzeCaptures([capture(node())]),
    buildOptions({
      lightVariables: { '--color-neutral-900': '#101828', '--color-text': '#101828' },
      declaredVariables: {
        '--color-neutral-900': '#101828',
        '--color-text': 'var(--color-neutral-900)',
      },
    }),
    diagnostics,
  );
  const alias = result.collections[0]!.variables.find((v) => v.name === 'color/text');
  assert.equal(alias?.aliasOf, 'color/neutral/900');
  const target = result.collections[0]!.variables.find((v) => v.name === 'color/neutral/900');
  assert.equal(target?.aliasOf, undefined);
});

test('collision de couleurs : la palette prime sur l alias semantique', () => {
  // Deux tokens de meme valeur : lier un fond a `color/text` serait trompeur.
  const diagnostics: Diagnostic[] = [];
  const result = buildTokens(
    analyzeCaptures([capture(node())]),
    buildOptions({
      lightVariables: { '--color-neutral-900': '#101828', '--color-text': '#101828' },
      declaredVariables: {
        '--color-neutral-900': '#101828',
        '--color-text': 'var(--color-neutral-900)',
      },
    }),
    diagnostics,
  );
  assert.equal(result.binder.colorVariable('#101828', 1), 'color/neutral/900');
});

test('mode sombre cree seulement si des valeurs different reellement', () => {
  const same = buildTokens(
    analyzeCaptures([capture(node())]),
    buildOptions({
      lightVariables: { '--color-a': '#fff' },
      darkVariables: { '--color-a': '#fff' },
    }),
    [],
  );
  assert.deepEqual(same.collections[0]!.modes, ['Clair']);

  const different = buildTokens(
    analyzeCaptures([capture(node())]),
    buildOptions({
      lightVariables: { '--color-a': '#fff' },
      darkVariables: { '--color-a': '#000' },
    }),
    [],
  );
  assert.deepEqual(different.collections[0]!.modes, ['Clair', 'Sombre']);
});

test('styles de texte : nommes par la balise dominante', () => {
  const analysis = analyzeCaptures([
    capture(node({ children: [textNode('h1', '52px'), textNode('h1', '52px')] })),
    capture(node({ children: [textNode('p', '16px'), textNode('p', '16px')] })),
  ]);
  const result = buildTokens(analysis, buildOptions(), []);
  const names = result.textStyles.map((s) => s.name);
  assert.ok(names.includes('Titre/H1'), names.join(', '));
  assert.ok(names.includes('Corps/Paragraphe'), names.join(', '));
});

test('un meme role a deux breakpoints est nomme par breakpoint', () => {
  // « Titre/H1 · Mobile » dit au developpeur ce qu il doit ecrire dans sa media
  // query ; « Titre/H1 2 » ne lui dit rien.
  const analysis = analyzeCaptures([
    capture(node({ children: [textNode('h1', '52px'), textNode('h1', '52px')] })),
    capture(node({ children: [textNode('h1', '32px'), textNode('h1', '32px')] }), {
      breakpointName: 'Mobile',
    }),
  ]);
  const names = buildTokens(analysis, buildOptions(), []).textStyles.map((s) => s.name);
  assert.ok(names.includes('Titre/H1'), names.join(', '));
  assert.ok(names.includes('Titre/H1 · Mobile'), names.join(', '));
});

test('une balise sans semantique n impose pas un nom trompeur', () => {
  // Un nombre de 40px en serif dans un <span> ne doit pas s appeler « Corps/Inline ».
  const analysis = analyzeCaptures([
    capture(
      node({
        children: [
          textNode('span', '40px', 'Source Serif 4', '700'),
          textNode('span', '40px', 'Source Serif 4', '700'),
        ],
      }),
    ),
  ]);
  const names = buildTokens(analysis, buildOptions(), []).textStyles.map((s) => s.name);
  assert.deepEqual(names, ['Texte/40px']);
});

test('police minoritaire signalee : un <button> sans font-family herite d Arial', () => {
  const children = Array.from({ length: 60 }, () => textNode('p', '16px', 'Inter'));
  children.push(textNode('button', '15px', 'Arial'), textNode('button', '15px', 'Arial'));
  const diagnostics: Diagnostic[] = [];
  buildTokens(analyzeCaptures([capture(node({ children }))]), buildOptions(), diagnostics);
  const found = diagnostics.find((d) => d.code === 'font-inconsistent');
  assert.ok(found, 'aucun diagnostic de police');
  assert.match(found!.message, /Arial/);
  assert.match(found!.message, /button/);
  assert.match(found!.hint!, /n.heritent pas de `font-family`/);
});

test('une seconde police assumee (serif de titrage) n est pas signalee', () => {
  const children = [
    ...Array.from({ length: 30 }, () => textNode('p', '16px', 'Inter')),
    ...Array.from({ length: 10 }, () => textNode('h2', '38px', 'Source Serif 4')),
  ];
  const diagnostics: Diagnostic[] = [];
  buildTokens(analyzeCaptures([capture(node({ children }))]), buildOptions(), diagnostics);
  assert.equal(diagnostics.find((d) => d.code === 'font-inconsistent'), undefined);
});

test('analyse : espacements, rayons et ombres recenses', () => {
  const analysis = analyzeCaptures([
    capture(
      node({
        style: {
          paddingTop: '24px',
          borderTopLeftRadius: '12px',
          boxShadow: 'rgba(0, 0, 0, 0.1) 0px 4px 6px 0px',
        },
      }),
    ),
  ]);
  assert.equal(analysis.spacings.get(24), 1);
  assert.equal(analysis.radii.get(12), 1);
  assert.equal(analysis.shadows.size, 1);
});
