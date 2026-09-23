import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { DEFAULT_CONFIG } from '../config.js';
import { Logger } from '../logger.js';
import { extract } from './spec.js';
import type { SpecNode } from '@sfs/spec';

/**
 * Extraction complete de la page de cas limites.
 *
 * Verifie les decisions qui se prennent APRES la capture : remontee des
 * elements cales sur la fenetre, ordre de peinture, structure de la page.
 */

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'examples', 'cas-limites',
);

async function extraire(): Promise<SpecNode> {
  const sortie = await mkdtemp(path.join(os.tmpdir(), 'sfs-spec-test-'));
  try {
    const { spec } = await extract(
      {
        ...DEFAULT_CONFIG,
        source: { ...DEFAULT_CONFIG.source, path: FIXTURE, maxPages: 1, settleMs: 150 },
        breakpoints: [{ name: 'Desktop', width: 1440, height: 900 }],
        components: { ...DEFAULT_CONFIG.components, enabled: false },
        tokens: { ...DEFAULT_CONFIG.tokens, darkMode: false },
        output: { ...DEFAULT_CONFIG.output, dir: sortie },
      },
      new Logger('silent'),
    );
    return spec.pages[0]!.breakpoints[0]!.root;
  } finally {
    await rm(sortie, { recursive: true, force: true });
  }
}

test('un element cale sur la fenetre est remonte a la racine de la page', async () => {
  // En CSS, `position: fixed` se cale sur l'ecran, jamais sur le parent DOM. Le
  // laisser chez son parent — qui peut se trouver des milliers de pixels plus
  // bas — projette l'element hors du cadre : visible dans les calques,
  // invisible a l'ecran. C'est ce qui faisait disparaitre l'en-tete d'un vrai
  // site sur les trois largeurs a la fois.
  const racine = await extraire();

  const cale = racine.children.find((enfant) => enfant.layout.viewportFixed);
  assert.ok(cale, 'aucun element cale a la racine de la page');
  assert.match(cale!.name, /En-tete|Entete/i);

  // A la racine et non chez son parent d'origine.
  const profondeur = (noeud: SpecNode, cible: string, niveau = 0): number => {
    if (noeud.sid === cible) return niveau;
    for (const enfant of noeud.children) {
      const trouve = profondeur(enfant, cible, niveau + 1);
      if (trouve >= 0) return trouve;
    }
    return -1;
  };
  assert.equal(profondeur(racine, cale!.sid), 1, 'l element n est pas un enfant direct de la page');
});

test('un element cale est peint au-dessus du reste', async () => {
  // Dans Figma le dernier calque passe devant : un en-tete fixe declare en
  // debut de document doit donc arriver en fin de liste, sinon l image du heros
  // qui le suit le recouvre.
  const racine = await extraire();
  const dernier = racine.children[racine.children.length - 1]!;
  assert.equal(dernier.layout.viewportFixed, true, `dernier calque : ${dernier.name}`);
});

test('un element cale ne remplit pas son conteneur', async () => {
  // « Remplir » suppose de participer a l'auto-layout du parent, ce qu'un
  // element en position absolue ne fait pas : Figma refuserait l'ecriture.
  const racine = await extraire();
  const cale = racine.children.find((enfant) => enfant.layout.viewportFixed)!;
  assert.notEqual(cale.layout.sizing.horizontal, 'FILL');
  assert.notEqual(cale.layout.sizing.vertical, 'FILL');
});

test('le corps de page reste le premier enfant, en pleine largeur', async () => {
  const racine = await extraire();
  const corps = racine.children[0]!;
  assert.equal(corps.layout.sizing.horizontal, 'FILL');
  assert.equal(corps.layout.sizing.vertical, 'HUG');
});

/** Cherche le premier noeud dont le nom correspond. */
function trouverParNom(racine: SpecNode, motif: RegExp): SpecNode | null {
  if (motif.test(racine.name)) return racine;
  for (const enfant of racine.children) {
    const trouve = trouverParNom(enfant, motif);
    if (trouve) return trouve;
  }
  return null;
}

test('une apparition restee en vol est reposee avant la mesure', async () => {
  // La bibliotheque d'animation avait pose `translateX(-62px)` et n'est jamais
  // venue le retirer. Mesure telle quelle, la rangee commencait 62 px avant le
  // bord gauche : dans Figma, « Mars 2027 » perdait ses premieres lettres.
  const racine = await extraire();

  const rangee = trouverParNom(racine, /Chiffres animes/i);
  assert.ok(rangee, 'la rangee de chiffres est absente de la maquette');
  assert.ok(
    rangee!.box.x >= 0,
    `la rangee commence a x = ${rangee!.box.x}, donc avant le bord gauche du cadre`,
  );

  const premier = trouverParNom(racine, /^Chiffre 1$/i);
  assert.ok(premier, 'le premier chiffre est absent');
  assert.ok(
    premier!.box.x >= 0,
    `« Mars 2027 » commence a x = ${premier!.box.x} : son debut sera coupe`,
  );
});

test('un centrage par transformation n est pas defait', async () => {
  // Le menage des apparitions ne vise que les translations EN LIGNE sur des
  // elements dans le flux. Le centrage `position: absolute` + `translate(-50%,
  // -50%)` ecrit dans la feuille de style doit survivre intact, sans quoi tout
  // badge centre sauterait au coin de son conteneur.
  const racine = await extraire();

  const badge = trouverParNom(racine, /^Badge centre$/i);
  assert.ok(badge, 'le badge centre est absent de la maquette');

  const cadre = trouverParNom(racine, /^Cadre centre$/i);
  assert.ok(cadre, 'le conteneur du badge est absent');

  const centreBadge = badge!.box.x + badge!.box.w / 2;
  const centreCadre = cadre!.box.x + cadre!.box.w / 2;
  assert.ok(
    Math.abs(centreBadge - centreCadre) <= 2,
    `badge centre en ${centreBadge}, conteneur centre en ${centreCadre}`,
  );
});
