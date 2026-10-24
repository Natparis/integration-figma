import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { DEFAULT_CONFIG } from '../config.js';
import { Logger } from '../logger.js';
import { extract } from './spec.js';
import type { BreakpointSpec, DesignSpec, SpecNode } from '@sfs/spec';

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

/**
 * Regression : notre propre script d'initialisation levait « parameter 1 is not
 * of type 'Node' » sur les pages ou `documentElement` n'existe pas encore. La
 * console de la page remontait l'erreur — que l'on imputait au site — et le
 * chargement immediat des images differees n'etait jamais installe.
 */
async function extraireSpec(): Promise<DesignSpec> {
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
    return spec;
  } finally {
    await rm(sortie, { recursive: true, force: true });
  }
}

async function extraireBreakpoint(): Promise<BreakpointSpec> {
  return (await extraireSpec()).pages[0]!.breakpoints[0]!;
}

async function extraire(): Promise<SpecNode> {
  return (await extraireBreakpoint()).root;
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

test('un contenu revele par animation survit a la lecture', async () => {
  // Le piege : le site protege ses animations derriere
  // `@media (prefers-reduced-motion: reduce) { animation: none }`, et son etat
  // de base est `opacity: 0`. Annoncer `reduce` au navigateur supprimait alors
  // l'animation SANS retablir l'opacite — la diapositive restait invisible et
  // disparaissait de la maquette. C'est ce qui vidait le heros du site reel.
  const racine = await extraire();

  const diapo = trouverParNom(racine, /^Diapo$/);
  assert.ok(diapo, 'la diapositive revelee par animation est absente de la maquette');
});

test('un element repousse hors ecran est ecarte, pas place a -9999 px', async () => {
  const bp = await extraireBreakpoint();

  const repoussee = trouverParNom(bp.root, /REPOUSSEE|Repoussee/i);
  assert.equal(repoussee, null, 'l etiquette hors ecran ne doit pas entrer dans la maquette');

  const horsCadre = bp.releve?.horsCadre ?? [];
  assert.equal(
    horsCadre.some((n) => n.x < -1000),
    false,
    'aucun calque ne doit se retrouver a des milliers de pixels du cadre',
  );
});

test('un centrage par translation n est pas signale comme animation en vol', async () => {
  // `translate(-50%, -50%)` vaut exactement la moitie de la boite : c'est la
  // signature d'un centrage, pas d'une apparition restee en route. Le signaler
  // noierait le releve sous des faux positifs.
  const bp = await extraireBreakpoint();
  assert.deepEqual(bp.releve?.decales ?? [], []);
});

test('un format que Figma refuse est reencode, pas abandonne', async () => {
  // Deux images du site reel etaient en AVIF : Figma ne les importe pas, et le
  // developpeur ne pouvait rien y faire depuis la maquette. Chromium sait les
  // decoder — autant lui demander plutot que de livrer un cadre vide. Le BMP
  // tient ici le role de l'AVIF : meme refus cote Figma, meme detour.
  const spec = await extraireSpec();

  const pastille = spec.assets.find((a) => /pastille\.bmp$/.test(a.source));
  assert.ok(pastille, 'l image au format refuse est absente des assets');
  assert.equal(pastille!.mime, 'image/png', 'elle aurait du etre reencodee en PNG');
  assert.ok(pastille!.bytes > 0);

  const echecs = spec.diagnostics.filter((d) => d.code === 'asset-format-unsupported');
  assert.deepEqual(echecs, [], 'aucune image decodable ne doit etre declaree non importable');
});

test('le WebP est reencode : Figma ne l importe pas', async () => {
  // Regression : le WebP figurait parmi les formats supposes acceptes par
  // Figma. Or `figma.createImage` n accepte que PNG, JPEG et GIF. Un site
  // entierement livre en WebP — ce que produit toute chaine d optimisation
  // d images moderne — arrivait donc dans Figma sans une seule photo : heros
  // noir, vignettes vides, bandeau absent. Chaque import levait une erreur
  // rangee dans les avertissements du plugin, que personne ne lisait.
  const spec = await extraireSpec();

  const vignette = spec.assets.find((a) => /vignette\.webp$/.test(a.source));
  assert.ok(vignette, 'l image WebP est absente des assets');
  assert.equal(vignette!.mime, 'image/png', 'le WebP aurait du etre reencode en PNG');
  assert.ok(vignette!.bytes > 0);
  assert.match(vignette!.file, /\.png$/);
});

test('des enfants superposes font abandonner la disposition automatique', async () => {
  // Motif du site reel : photo, voile et date partagent la meme cellule de
  // grille. `grid-template-columns` n'annonce qu'une colonne, la grille passe
  // donc pour une pile — et Figma empilerait VRAIMENT, faisant tomber la date
  // sous la photo. Vingt cartes du catalogue etaient ainsi disloquees.
  const racine = await extraire();

  const carte = trouverParNom(racine, /^Carte empilee$/);
  assert.ok(carte, 'la carte empilee est absente de la maquette');
  assert.equal(
    carte!.layout.mode,
    'NONE',
    'une carte dont les enfants se superposent ne peut pas etre un auto-layout',
  );

  const fond = carte!.children.find((c) => /^Carte fond$/.test(c.name));
  const date = carte!.children.find((c) => /17 mars/.test(c.name));
  assert.ok(fond && date, 'le fond ou la date manque dans la carte');
  // La date doit REPOSER sur la photo, pas se ranger dessous.
  assert.ok(
    date!.box.y >= fond!.box.y && date!.box.y + date!.box.h <= fond!.box.y + fond!.box.h,
    `la date est a y = ${date!.box.y}, hors de la photo [${fond!.box.y}, ${fond!.box.y + fond!.box.h}]`,
  );
});

test('un chevauchement decoratif ne coute pas l auto-layout', async () => {
  // Des pastilles en cascade se mordent de 12 px sur 40 : c'est un espacement
  // negatif, pas une superposition. La regle doit rester muette, sinon toutes
  // les listes d'avatars du web perdraient leur disposition.
  const racine = await extraire();

  const rangee = trouverParNom(racine, /^Pastilles$/);
  assert.ok(rangee, 'la rangee de pastilles est absente');
  assert.equal(rangee!.layout.mode, 'HORIZONTAL');
});

test('une section ordinaire garde sa disposition verticale', async () => {
  const racine = await extraire();
  const cartes = trouverParNom(racine, /^Cartes$/);
  assert.ok(cartes);
  assert.equal(cartes!.layout.mode, 'VERTICAL');
});

test('l extraction ne pollue pas la console de la page', async () => {
  const spec = await extraireSpec();
  const notres = spec.diagnostics.filter(
    (d) => /MutationObserver|is not of type|not a function/i.test(d.message),
  );
  assert.deepEqual(notres, [], 'une erreur JavaScript vient de notre injection, pas du site');
});

test('un enfant peint en dernier mais place en haut reste en haut', async () => {
  // Le collecteur ordonne selon l'ordre de PEINTURE : un element positionne
  // passe apres ses freres, ou qu'il soit a l'ecran. C'est juste pour Figma,
  // ou le dernier calque est au-dessus — mais dans un auto-layout la liste est
  // l'ordre de MISE EN PAGE. Le heros du site reel se rangeait ainsi en bas de
  // sa section, sous le pied de page, alors qu'il est mesure a y = 0.
  const racine = await extraire();

  const bloc = trouverParNom(racine, /^Bloc ordre$/i);
  assert.ok(bloc, 'la section de test est absente');
  assert.equal(bloc!.layout.mode, 'VERTICAL');

  const noms = bloc!.children.map((c) => c.name);
  const heros = bloc!.children.findIndex((c) => /Heros releve/i.test(c.name));
  const suite = bloc!.children.findIndex((c) => /Apres/i.test(c.name));
  assert.ok(heros >= 0 && suite >= 0, `enfants trouves : ${noms.join(', ')}`);
  assert.ok(
    heros < suite,
    `le heros est en position ${heros}, apres « ${noms[suite]} » : il tombera en bas`,
  );
  assert.ok(bloc!.children[heros]!.box.y < bloc!.children[suite]!.box.y);
});

test('un cadre dont le contenu ne peut pas tenir la mesure passe en taille fixe', async () => {
  // Regression : le heros de l accueil, declare `height: max(640px, 88vh)`,
  // sortait a 1440x112 dans Figma au lieu de 1440x901. Ni longueur en pixels ni
  // pourcentage, la hauteur tombait sur « ajuster au contenu » ; tous les
  // enfants etant en positionnement libre, Figma n avait plus rien a mesurer et
  // le cadre se repliait sur son remplissage. Les cadres parents, eux aussi en
  // « ajuster », se repliaient a leur tour : la page perdait 685 px.
  const racine = await extraire();
  const heros = trouverParNom(racine, /^Heros mesure$/i);
  assert.ok(heros, 'section de heros introuvable dans la page de cas limites');

  assert.ok(heros!.box.h >= 290, `hauteur mesuree inattendue : ${heros!.box.h}`);
  assert.equal(heros!.layout.sizing.vertical, 'FIXED');
  assert.ok(
    heros!.children.every((enfant) => enfant.layout.positioning === 'ABSOLUTE'),
    'le cas ne reproduit plus des enfants tous en positionnement libre',
  );
});

test('« ajuster au contenu » survit a un minimum declare', async () => {
  // Garde-fou du correctif precedent : un bouton a `min-height` autour d un
  // texte plus court tient sa hauteur du minimum, pas d un defaut de mesure.
  // Le figer couterait l adaptabilite sans rien corriger.
  const racine = await extraire();
  const garde = (noeud: SpecNode): number => {
    let total = noeud.layout.sizing.vertical === 'HUG' ? 1 : 0;
    for (const enfant of noeud.children) total += garde(enfant);
    return total;
  };
  assert.ok(garde(racine) > 10, 'plus aucun cadre en « ajuster au contenu » : le garde-fou fige la maquette');
});

test('un filtre CSS est cuit dans l image, et donne un asset distinct', async () => {
  // Regression : le logo de l en-tete est une encre sombre que le site
  // retourne en blanc par `filter: brightness(0) invert(1)` tant que l en-tete
  // flotte sur le heros. Figma n a pas de filtre d image : le logo arrivait
  // noir sur fond noir, invisible. Le meme fichier servant aussi non filtre
  // une fois l en-tete pose, les deux versions doivent coexister.
  const spec = await extraireSpec();

  const versions = spec.assets.filter((a) => /vignette\.webp$/.test(a.source));
  assert.equal(versions.length, 2, 'la version filtree et la version brute doivent etre deux assets');
  assert.notEqual(versions[0]!.id, versions[1]!.id);
  for (const v of versions) assert.equal(v.mime, 'image/png');

  const applique = spec.diagnostics.filter((d) => d.code === 'asset-filter-applied');
  assert.ok(applique.length >= 1, 'aucun filtre applique');
  const ignore = spec.diagnostics.filter((d) => d.code === 'asset-filter-skipped');
  assert.deepEqual(ignore, [], 'un filtre decodable ne doit pas etre abandonne');
});

test('un conteneur centre par marges automatiques reste centre', async () => {
  // Regression : `max-width` + `margin-inline: auto` est le motif le plus
  // repandu du web. Figma n a pas de marge automatique : la largeur plafonnee
  // passait bien, mais l enfant se rangeait au bord gauche. La rangee de
  // chiffres cles de l accueil partait ainsi 184 px trop a gauche, et
  // « Avril 2027 » se faisait couper au bord de la page.
  const racine = await extraire();
  const colonne = trouverParNom(racine, /^Colonne large$/i);
  assert.ok(colonne, 'section de colonne introuvable dans la page de cas limites');
  assert.equal(colonne!.layout.counterAxisAlignItems, 'CENTER');
});

test('une colonne dont les enfants sont cales a gauche n est pas recentree', async () => {
  // Garde-fou : recentrer une colonne ordinaire deplacerait tout son contenu.
  // La section des cartes empilees commence au bord gauche de son
  // remplissage ; elle doit y rester.
  const racine = await extraire();
  const cartes = trouverParNom(racine, /^Cartes$/i);
  assert.ok(cartes, 'section des cartes introuvable');
  assert.notEqual(cartes!.layout.counterAxisAlignItems, 'CENTER');
});

test('un conteneur dont un enfant remplit le meme axe ne peut pas s ajuster a son contenu', async () => {
  // Regression de la vue tablette : « La programmation » tenait sa largeur de
  // sa piste de grille, pas de son contenu, et portait un filet de 56 px a
  // cote d un titre pleine largeur. En « ajuster au contenu », Figma replie le
  // cadre sur son plus large enfant NON remplissant — le filet — et le titre
  // sortait a 56 px de large, une lettre par ligne.
  const racine = await extraire();
  const bloc = trouverParNom(racine, /^Bloc circulaire$/i);
  assert.ok(bloc, 'bloc introuvable dans la page de cas limites');

  const remplit = bloc!.children.some(
    (enfant) =>
      enfant.layout.positioning !== 'ABSOLUTE' && enfant.layout.sizing.horizontal === 'FILL',
  );
  assert.ok(remplit, 'le cas ne reproduit plus un enfant qui remplit la largeur');
  assert.equal(bloc!.layout.sizing.horizontal, 'FIXED');
});
