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

test('une diapositive hors cadre est conservee, et c est voulu', () => {
  // Choix delibere apres un incident : le filtre anti-accordeon ne se declenche
  // que sur un conteneur REPLIE (hauteur quasi nulle). Une diapositive hors
  // cadre est donc gardee, et Figma la decoupera avec la frame.
  //
  // La regle large — « hors du cadre d'un ancetre a debordement masque » —
  // supprimait tout ce qui suit la premiere zone visible sur les sites a
  // defilement fluide, pied de page compris. Mieux vaut un element de trop
  // qu'une page amputee.
  assert.ok(contient('DIAPO VISIBLE'));
  assert.ok(contient('DIAPO PARTIELLE'));
  assert.ok(contient('DIAPO HORS CADRE'));
});

test('le texte masque pour lecteurs d ecran reste hors de la maquette', () => {
  assert.ok(!contient('TEXTE MASQUE ACCESSIBLE'));
});

test('un titre decoupe lettre par lettre reste UN seul texte', () => {
  // Procede courant pour animer un titre : une `<span>` inline-block par
  // lettre. Sans traitement, chacune devenait un calque distinct — un titre de
  // seize lettres produisait seize calques, empiles n'importe comment.
  assert.ok(contient('TITREDECOUPE'), 'le titre decoupe n a pas ete recompose');
  const lettresIsolees = textes(capture.root).filter((t) => t.length === 1);
  assert.deepEqual(lettresIsolees, [], `calques d une seule lettre : ${lettresIsolees.join(', ')}`);
});

test('un badge avec un fond reste une boite a part entiere', () => {
  // Le contre-exemple : tout `inline-block` n'est pas du texte. Un badge a une
  // presence visuelle, il doit rester un calque distinct.
  const tous = textes(capture.root);
  assert.ok(tous.some((t) => t === 'COMPLET'), 'le badge a ete fondu dans le texte');
  // Le texte qui entoure le badge est reparti de part et d'autre : ce sont deux
  // fragments distincts, et non une seule chaine.
  assert.ok(tous.some((t) => t.includes('Atelier')), 'texte avant le badge perdu');
  assert.ok(tous.some((t) => t.includes('ce jour-la')), 'texte apres le badge perdu');
});

test('le contenu en lumiere reste capture normalement', () => {
  assert.ok(contient('CONTENU LUMIERE'));
  assert.ok((capture.stats.shadowRootsVisites ?? 0) >= 2, 'arbres ouverts non comptes');
});
