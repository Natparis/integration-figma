import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { launchBrowser } from './launch.js';
import { createContext, capturePage } from './capture.js';
import { serveDirectory } from '../source/static-server.js';
import type { RawCapture, RawNode } from './raw.js';
import type { StaticServer } from '../source/static-server.js';

/**
 * Tests du collecteur contre un vrai navigateur.
 *
 * Chaque cas couvert ici a reellement fait perdre du contenu sur un site de
 * production : ils ne sont pas hypothetiques.
 */

const RACINE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'examples', 'cas-limites',
);

let browser: Browser;
let serveur: StaticServer;
let capture: RawCapture;

before(async () => {
  browser = await launchBrowser();
  serveur = await serveDirectory(RACINE);
  const breakpoint = { name: 'Desktop', width: 1440, height: 900 };
  const contexte = await createContext(browser, breakpoint, 'light');
  const resultat = await capturePage(contexte, serveur.origin + '/', {
    breakpoint,
    settleMs: 200,
    maxNodes: 4000,
    devAnnotations: true,
    origin: serveur.origin,
  });
  capture = resultat.capture;
  await contexte.close();
});

after(async () => {
  await browser?.close();
  await serveur?.close();
});

function textes(node: RawNode, out: string[] = []): string[] {
  if (node.text?.characters) out.push(node.text.characters.trim());
  for (const enfant of node.children) textes(enfant, out);
  return out;
}

const contient = (fragment: string): boolean =>
  textes(capture.root).some((t) => t.includes(fragment));

test('le contenu du Shadow DOM est capture', () => {
  // Un site en Web Components place son en-tete et son pied de page dans un
  // arbre parallele, invisible depuis `element.children`. Sans descente, ils
  // disparaissent purement et simplement de la maquette.
  assert.ok(contient('TITRE OMBRE'), 'titre du Shadow DOM manquant');
  assert.ok(contient('LIEN OMBRE'), 'lien du Shadow DOM manquant');
  assert.ok(contient('PIED OMBRE'), 'pied de page du Shadow DOM manquant');
});

test('un Shadow DOM ferme est signale plutot que passe sous silence', () => {
  assert.ok(
    capture.warnings.some((a) => /Shadow DOM ferme/.test(a)),
    capture.warnings.join(' | '),
  );
  assert.ok(!contient('CONTENU INACCESSIBLE'), 'un arbre ferme ne devrait pas etre lisible');
});

test('un en-tete fixe echappe au decoupage de ses ancetres', () => {
  // L'en-tete est dans un conteneur `overflow: hidden` de 200 px, mais sa
  // position fixe le cale sur la fenetre : il reste visible.
  assert.ok(contient('ENTETE FIXE'), 'en-tete fixe absent');
});

test('un accordeon ferme n est pas deplie dans la maquette', () => {
  assert.ok(contient('PANNEAU OUVERT'), 'le panneau ouvert devrait etre present');
  assert.ok(!contient('PANNEAU FERME'), 'le panneau ferme ne devrait pas etre capture');
});

test('une diapositive hors cadre n est pas capturee', () => {
  assert.ok(contient('DIAPO VISIBLE'));
  assert.ok(contient('DIAPO PARTIELLE'), 'une diapositive partiellement visible compte');
  assert.ok(!contient('DIAPO HORS CADRE'), 'diapositive hors cadre capturee a tort');
});

test('le texte masque pour lecteurs d ecran reste hors de la maquette', () => {
  assert.ok(!contient('TEXTE MASQUE ACCESSIBLE'));
});

test('le contenu en lumiere reste capture normalement', () => {
  assert.ok(contient('CONTENU LUMIERE'));
  assert.ok((capture.stats.shadowRootsVisites ?? 0) >= 2, 'arbres ouverts non comptes');
});
