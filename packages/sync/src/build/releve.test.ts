import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LayoutSpec, SpecNode } from '@sfs/spec';
import type { RawCapture } from '../browser/raw.js';
import { construireReleve, releveVide } from './releve.js';

const layout = (patch: Partial<LayoutSpec> = {}): LayoutSpec => ({
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
  ...patch,
});

const noeud = (
  name: string,
  box: { x: number; y: number; w: number; h: number },
  patch: Partial<SpecNode> = {},
): SpecNode => ({
  sid: name,
  name,
  kind: 'FRAME',
  box,
  layout: layout(),
  style: {
    fills: [],
    strokes: [],
    strokeWeight: 0,
    strokeAlign: 'INSIDE',
    cornerRadius: [0, 0, 0, 0],
    effects: [],
    opacity: 1,
    visible: true,
  },
  children: [],
  hash: '',
  subtreeHash: '',
  ...patch,
});

const capture = (patch: Partial<RawCapture> = {}): RawCapture =>
  ({
    route: '/',
    title: '',
    lang: 'fr',
    viewport: { width: 1440, height: 900 },
    documentHeight: 3000,
    root: {} as never,
    rootVariables: {},
    rootVariablesDeclared: {},
    fonts: [],
    links: [],
    stats: { visited: 0, emitted: 0, skipped: 0, truncated: false },
    warnings: [],
    ...patch,
  }) as RawCapture;

test('un heros ecarte par un parent replie est nomme, mesure et motive', () => {
  const releve = construireReleve(
    noeud('racine', { x: 0, y: 0, w: 1440, h: 3000 }),
    capture({
      discards: [
        {
          what: 'section.hero',
          rect: { x: 0, y: 0, w: 1440, h: 800 },
          reason: 'replie dans un parent a debordement masque',
          text: 'LES ATELIERS DE SAVOIR-FAIRE',
        },
        // Sous le seuil de surface et sans texte : bruit, on ne le remonte pas.
        { what: 'span.puce', rect: { x: 0, y: 0, w: 8, h: 8 }, reason: 'opacity: 0' },
      ],
    }),
    1440,
  );
  assert.equal(releve.ecartes.length, 1);
  assert.equal(releve.ecartes[0]?.what, 'section.hero');
  assert.equal(releve.ecartes[0]?.w, 1440);
  assert.match(releve.ecartes[0]?.reason ?? '', /replie/);
  assert.match(releve.ecartes[0]?.text ?? '', /SAVOIR-FAIRE/);
});

test('une boite qui commence avant le bord gauche est signalee hors cadre', () => {
  // Le symptome vu sur le site : « Mars 2027 » ampute de ses premieres lettres.
  const racine = noeud('racine', { x: 0, y: 0, w: 1440, h: 3000 }, {
    children: [noeud('Chiffres cles', { x: -62, y: 900, w: 1440, h: 140 })],
  });
  const releve = construireReleve(racine, capture(), 1440);
  assert.equal(releve.horsCadre.length, 1);
  assert.equal(releve.horsCadre[0]?.name, 'Chiffres cles');
  assert.equal(releve.horsCadre[0]?.x, -62);
});

test('deux lignes qui se recouvrent dans une pile verticale sont signalees', () => {
  const racine = noeud('Accordeon', { x: 0, y: 0, w: 800, h: 300 }, {
    layout: layout({ mode: 'VERTICAL' }),
    children: [
      noeud('Vins & Spiritueux', { x: 0, y: 0, w: 800, h: 80 }),
      noeud('Couture', { x: 0, y: 60, w: 800, h: 80 }),
      noeud('Maroquinerie', { x: 0, y: 140, w: 800, h: 80 }),
    ],
  });
  const releve = construireReleve(racine, capture(), 800);
  assert.equal(releve.chevauchements.length, 1);
  assert.equal(releve.chevauchements[0]?.name, 'Couture');
  assert.equal(releve.chevauchements[0]?.voisin, 'Vins & Spiritueux');
  assert.equal(releve.chevauchements[0]?.recouvrement, 20);
});

test('un enfant absolu ne compte pas comme chevauchement', () => {
  const racine = noeud('Section', { x: 0, y: 0, w: 800, h: 300 }, {
    layout: layout({ mode: 'VERTICAL' }),
    children: [
      noeud('Fond', { x: 0, y: 0, w: 800, h: 300 }, { layout: layout({ positioning: 'ABSOLUTE' }) }),
      noeud('Titre', { x: 0, y: 40, w: 800, h: 60 }),
    ],
  });
  assert.equal(construireReleve(racine, capture(), 800).chevauchements.length, 0);
});

test('un en-tete cale sur la fenetre est signale comme remonte a la racine', () => {
  const racine = noeud('racine', { x: 0, y: 0, w: 1440, h: 3000 }, {
    children: [
      noeud('Corps', { x: 0, y: 0, w: 1440, h: 3000 }),
      noeud('En-tete', { x: 0, y: 0, w: 1440, h: 88 }, {
        layout: layout({ viewportFixed: true, positioning: 'ABSOLUTE' }),
      }),
    ],
  });
  const releve = construireReleve(racine, capture(), 1440);
  assert.deepEqual(releve.cales, [{ name: 'En-tete', x: 0, y: 0, w: 1440, h: 88 }]);
});

test('une animation encore en vol est relevee avec son decalage', () => {
  const releve = construireReleve(
    noeud('racine', { x: 0, y: 0, w: 1440, h: 3000 }),
    capture({
      shifted: [{ what: 'div.stats', rect: { x: -62, y: 900, w: 1440, h: 140 }, dx: -62, dy: 0 }],
    }),
    1440,
  );
  assert.equal(releve.decales.length, 1);
  assert.equal(releve.decales[0]?.dx, -62);
});

test('une page saine ne produit aucun releve', () => {
  const racine = noeud('racine', { x: 0, y: 0, w: 1440, h: 600 }, {
    layout: layout({ mode: 'VERTICAL' }),
    children: [noeud('Corps', { x: 0, y: 0, w: 1440, h: 600 })],
  });
  assert.equal(releveVide(construireReleve(racine, capture(), 1440)), true);
});
