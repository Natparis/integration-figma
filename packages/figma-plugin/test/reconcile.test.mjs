/**
 * Tests de la synchronisation, contre un faux moteur Figma.
 *
 * Ce qui est verifie ici est exactement ce qui fait la valeur de l'outil :
 * une seconde synchronisation doit METTRE A JOUR le document, pas le recreer.
 * Sans cette garantie, chaque execution detruirait les commentaires de revue, les
 * liens de prototype et le travail du developpeur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeFigma } from './fake-figma.mjs';

const SPEC_PATH = new URL('./fixtures/design-spec.json', import.meta.url);

function loadSpec() {
  return JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
}

async function synchronise(spec, overrides = {}) {
  const { figma, state } = createFakeFigma();
  globalThis.figma = figma;
  // Import apres l'installation du global : le module capture `figma` a l'appel,
  // mais on reste explicite sur l'ordre.
  const { syncSpec } = await import('../dist/sync.mjs');

  const options = {
    onRemoved: 'archive',
    skipUnchanged: true,
    createComponents: false,
    annotate: true,
    breakpoints: [],
    relayUrl: null,
    ...overrides,
  };
  const outcome = await syncSpec(spec, options, [], 0, () => {}, Date.now());
  return { figma, state, outcome };
}

/** Rejoue une synchronisation sur un document deja synchronise. */
async function synchroniseDeuxFois(spec, second = spec, overrides = {}) {
  const { figma, state } = createFakeFigma();
  globalThis.figma = figma;
  const { syncSpec } = await import('../dist/sync.mjs');
  const options = {
    onRemoved: 'archive',
    skipUnchanged: true,
    createComponents: false,
    annotate: true,
    breakpoints: [],
    relayUrl: null,
    ...overrides,
  };
  const premier = await syncSpec(spec, options, [], 0, () => {}, Date.now());
  const idsApresPremier = collectIds(figma.root);
  const second_ = await syncSpec(second, options, [], 0, () => {}, Date.now());
  return { figma, state, premier, second: second_, idsApresPremier };
}

function collectIds(node, out = new Map()) {
  for (const child of node.children ?? []) {
    const sid = child.getPluginData?.('sfs:sid');
    if (sid) out.set(sid, child.id);
    collectIds(child, out);
  }
  return out;
}

function findBySid(node, sid) {
  for (const child of node.children ?? []) {
    if (child.getPluginData?.('sfs:sid') === sid) return child;
    const found = findBySid(child, sid);
    if (found) return found;
  }
  return null;
}

function countNodes(node) {
  let total = 0;
  for (const child of node.children ?? []) total += 1 + countNodes(child);
  return total;
}

/* ------------------------------- premiere passe ---------------------------- */

test('premiere synchronisation : le document est construit', async () => {
  const { figma, outcome } = await synchronise(loadSpec());
  assert.ok(outcome.stats.created > 100, `seulement ${outcome.stats.created} couches creees`);
  assert.equal(outcome.stats.updated, 0);

  const pages = figma.root.children.map((page) => page.name);
  assert.ok(pages.some((name) => name.includes('Accueil')), pages.join(', '));
  assert.ok(pages.includes('Documentation'), pages.join(', '));
});

test('une page Figma par page du site, une frame par breakpoint', async () => {
  const spec = loadSpec();
  const { figma } = await synchronise(spec);
  for (const pageSpec of spec.pages) {
    const page = figma.root.children.find((candidate) => candidate.name === pageSpec.name);
    assert.ok(page, `page manquante : ${pageSpec.name}`);
    const frames = page.children.filter((child) => child.type === 'FRAME');
    assert.equal(frames.length, pageSpec.breakpoints.length, pageSpec.name);
  }
});

test('les frames de breakpoint sont posees cote a cote, sans chevauchement', async () => {
  const spec = loadSpec();
  const { figma } = await synchronise(spec);
  const page = figma.root.children.find((candidate) => candidate.name === spec.pages[0].name);
  const frames = page.children.filter((child) => child.type === 'FRAME');
  const tries = [...frames].sort((a, b) => a.x - b.x);
  for (let i = 1; i < tries.length; i++) {
    assert.ok(
      tries[i].x >= tries[i - 1].x + tries[i - 1].width,
      `chevauchement entre ${tries[i - 1].name} et ${tries[i].name}`,
    );
  }
});

/* ------------------------------ idempotence -------------------------------- */

test('seconde synchronisation identique : rien n est recree', async () => {
  const spec = loadSpec();
  const { second } = await synchroniseDeuxFois(spec);
  assert.equal(second.stats.created, 0, 'des couches ont ete recreees');
  assert.equal(second.stats.removed, 0, 'des couches ont ete retirees a tort');
  assert.ok(second.stats.skipped > 100, `seulement ${second.stats.skipped} couches sautees`);
});

test('les identifiants Figma survivent : commentaires et liens preserves', async () => {
  // C est la garantie qui justifie tout le mecanisme de sid : un commentaire de
  // revue est attache a un identifiant de noeud. Recreer le noeud le perd.
  const spec = loadSpec();
  const { figma, idsApresPremier } = await synchroniseDeuxFois(spec);
  const apresSecond = collectIds(figma.root);
  let compares = 0;
  for (const [sid, id] of idsApresPremier) {
    const nouveau = apresSecond.get(sid);
    if (nouveau === undefined) continue;
    assert.equal(nouveau, id, `le noeud « ${sid} » a ete recree`);
    compares++;
  }
  assert.ok(compares > 100, `trop peu de noeuds compares (${compares})`);
});

test('le document ne gonfle pas d une synchronisation a l autre', async () => {
  const spec = loadSpec();
  const { figma } = await synchroniseDeuxFois(spec);
  const total = countNodes(figma.root);
  const { figma: figmaUneFois } = await synchronise(spec);
  const reference = countNodes(figmaUneFois.root);
  // Tolerance : la page de documentation est reconstruite a chaque passage.
  assert.ok(
    Math.abs(total - reference) < reference * 0.02,
    `${reference} couches apres une passe, ${total} apres deux`,
  );
});

/* ------------------------- mise a jour differentielle ---------------------- */

test('un texte modifie sur le site : ce noeud seul est mis a jour', async () => {
  const spec = loadSpec();
  const modifie = JSON.parse(JSON.stringify(spec));

  // Modifier le premier noeud texte trouve, et remonter les empreintes.
  const cible = trouverPremierTexte(modifie.pages[0].breakpoints[0].root);
  assert.ok(cible, 'aucun noeud texte dans le spec');
  cible.node.text.characters = 'Texte modifie pour le test';
  invaliderEmpreintes(cible.chemin);

  const { second } = await synchroniseDeuxFois(spec, modifie);
  assert.equal(second.stats.created, 0);
  // Les ancetres changent d empreinte, donc sont revisites : quelques mises a
  // jour sont attendues, mais pas une reecriture complete.
  assert.ok(second.stats.updated > 0, 'aucune mise a jour');
  assert.ok(second.stats.updated < 40, `${second.stats.updated} mises a jour : trop large`);
  assert.ok(second.stats.skipped > 100, 'la synchronisation differentielle n a pas joue');
});

test('le nouveau texte est bien ecrit dans le document', async () => {
  const spec = loadSpec();
  const modifie = JSON.parse(JSON.stringify(spec));
  const cible = trouverPremierTexte(modifie.pages[0].breakpoints[0].root);
  cible.node.text.characters = 'Texte modifie pour le test';
  invaliderEmpreintes(cible.chemin);

  const { figma } = await synchroniseDeuxFois(spec, modifie);
  const noeud = findBySid(figma.root, cible.node.sid);
  assert.ok(noeud, 'noeud introuvable apres synchronisation');
  assert.equal(noeud.characters, 'Texte modifie pour le test');
});

test('une couche disparue du site est archivee, pas supprimee en silence', async () => {
  const spec = loadSpec();
  const reduit = JSON.parse(JSON.stringify(spec));
  const racine = reduit.pages[0].breakpoints[0].root;
  const corps = racine.children[0];
  const retire = corps.children.pop();
  invaliderEmpreintes([racine, corps]);

  const { figma, second } = await synchroniseDeuxFois(spec, reduit);
  assert.ok(second.stats.removed > 0, 'rien n a ete retire');
  const page = figma.root.children.find((candidate) => candidate.name === spec.pages[0].name);
  const archive = page.children.find((child) => child.name === '⚠︎ Retires du site');
  assert.ok(archive, 'frame d archive absente');
  assert.ok(archive.children.length > 0, 'archive vide');
  assert.match(archive.children[0].name, /\(retire\)$/);
  assert.equal(
    archive.children[0].getPluginData('sfs:sid'),
    '',
    'le noeud archive garde son sid : il serait ressuscite a la synchro suivante',
  );
  void retire;
});

test('mode suppression : la couche disparait vraiment', async () => {
  const spec = loadSpec();
  const reduit = JSON.parse(JSON.stringify(spec));
  const racine = reduit.pages[0].breakpoints[0].root;
  const corps = racine.children[0];
  corps.children.pop();
  invaliderEmpreintes([racine, corps]);

  const { figma, second } = await synchroniseDeuxFois(spec, reduit, { onRemoved: 'delete' });
  assert.ok(second.stats.removed > 0);
  const page = figma.root.children.find((candidate) => candidate.name === spec.pages[0].name);
  assert.equal(page.children.find((child) => child.name === '⚠︎ Retires du site'), undefined);
});

/* --------------------------- fidelite du rendu ----------------------------- */

test('l auto-layout et les tailles sont appliques sans exception', async () => {
  // Le faux moteur reproduit les regles de Figma : FILL exige un parent en
  // auto-layout, HUG un auto-layout propre. Si le plugin les violait, la
  // synchronisation leverait ici.
  const spec = loadSpec();
  const { outcome } = await synchronise(spec);
  const fautes = outcome.warnings.filter((warning) => /Largeur de|Hauteur de/.test(warning));
  assert.deepEqual(fautes, [], fautes.join('\n'));
});

test('les textes sont ecrits avec une police chargee', async () => {
  const spec = loadSpec();
  const { outcome } = await synchronise(spec);
  const fautes = outcome.warnings.filter((warning) => /Police non appliquee/.test(warning));
  assert.deepEqual(fautes, [], fautes.join('\n'));
});

test('police absente du poste : substitution et avertissement, pas d echec', async () => {
  const spec = loadSpec();
  const { figma } = createFakeFigma({ availableFonts: ['Roboto|Regular', 'Roboto|Bold'] });
  globalThis.figma = figma;
  const { syncSpec } = await import('../dist/sync.mjs');
  const outcome = await syncSpec(
    spec,
    { onRemoved: 'archive', skipUnchanged: true, createComponents: false, annotate: false, breakpoints: [], relayUrl: null },
    [], 0, () => {}, Date.now(),
  );
  assert.ok(outcome.stats.created > 100, 'la synchronisation a echoue');
  assert.ok(
    outcome.warnings.some((warning) => /substituee/.test(warning)),
    'aucune substitution signalee',
  );
});

test('variables et styles ecrits, alias compris', async () => {
  const spec = loadSpec();
  const { state, outcome } = await synchronise(spec);
  assert.ok(outcome.stats.variablesWritten > 0, 'aucune variable ecrite');
  assert.ok(state.collections.length === 1, 'collection de tokens manquante');
  const alias = state.variables.filter((variable) =>
    Object.values(variable.valuesByMode).some(
      (value) => value && value.type === 'VARIABLE_ALIAS',
    ),
  );
  assert.ok(alias.length > 0, 'aucun alias de variable reproduit');
  assert.ok(state.paintStyles.length > 0, 'aucun style de peinture');
  assert.ok(state.textStyles.length > 0, 'aucun style de texte');
});

test('la collection de tokens n accumule pas de modes a chaque passage', async () => {
  const spec = loadSpec();
  const { state } = await synchroniseDeuxFois(spec);
  const collection = state.collections[0];
  assert.equal(collection.modes.length, spec.tokens[0].modes.length, collection.modes.map((m) => m.name).join(', '));
});

test('filtrage par breakpoint', async () => {
  const spec = loadSpec();
  const { figma } = await synchronise(spec, { breakpoints: ['Mobile'] });
  const page = figma.root.children.find((candidate) => candidate.name === spec.pages[0].name);
  const frames = page.children.filter((child) => child.type === 'FRAME');
  assert.equal(frames.length, 1);
  assert.match(frames[0].name, /Mobile/);
});

test('la note de passation est reconstruite, pas empilee', async () => {
  const spec = loadSpec();
  const { figma } = await synchroniseDeuxFois(spec);
  const documentation = figma.root.children.find((page) => page.name === 'Documentation');
  assert.ok(documentation);
  assert.equal(documentation.children.length, 1, 'la page de documentation s est dupliquee');
});

/* --------------------------------- outils ---------------------------------- */

function trouverPremierTexte(racine, chemin = []) {
  const pile = [{ node: racine, chemin: [racine] }];
  while (pile.length > 0) {
    const courant = pile.shift();
    if (courant.node.kind === 'TEXT' && courant.node.text) return courant;
    for (const enfant of courant.node.children ?? []) {
      pile.push({ node: enfant, chemin: [...courant.chemin, enfant] });
    }
  }
  void chemin;
  return null;
}

/**
 * Invalide les empreintes le long d un chemin.
 *
 * Reproduit ce que fait l extracteur : modifier un noeud change son empreinte et
 * celle de tous ses ancetres, ce qui rouvre exactement la branche concernee.
 */
function invaliderEmpreintes(chemin) {
  for (const noeud of chemin) {
    noeud.hash = noeud.hash + 'x';
    noeud.subtreeHash = noeud.subtreeHash + 'x';
  }
}

/* ------------------------- mode autonome (bundle) -------------------------- */

test('spec autonome : les assets incorpores sont importes sans serveur', async () => {
  // C est le mode que la cliente utilisera pour envoyer la maquette a un tiers :
  // un seul fichier, aucun terminal a lancer.
  const bundle = JSON.parse(
    readFileSync(new URL('./fixtures/design-spec.bundle.json', import.meta.url), 'utf8'),
  );
  assert.ok(
    bundle.assets.some((asset) => asset.data),
    'le fixture bundle ne contient aucun asset incorpore',
  );

  const { figma, state } = createFakeFigma();
  globalThis.figma = figma;
  const { syncSpec } = await import('../dist/sync.mjs');
  const outcome = await syncSpec(
    bundle,
    {
      onRemoved: 'archive', skipUnchanged: true, createComponents: false,
      annotate: true, breakpoints: [], relayUrl: null,
    },
    [], 0, () => {}, Date.now(),
  );

  const images = bundle.assets.filter((asset) => asset.kind === 'IMAGE').length;
  assert.equal(outcome.stats.assetsLoaded, images, 'toutes les images ne sont pas importees');
  assert.equal(state.createdImages.length, images);
  assert.deepEqual(
    outcome.warnings.filter((warning) => /indisponible|non importee/.test(warning)),
    [],
  );
});

test('sans relay ni assets incorpores : avertissement, jamais d echec', async () => {
  const spec = loadSpec();
  assert.ok(
    spec.assets.every((asset) => !asset.data),
    'le fixture standard ne doit pas contenir d assets incorpores',
  );
  const { outcome } = await synchronise(spec);
  assert.ok(outcome.stats.created > 100, 'la synchronisation aurait du aboutir malgre tout');
  assert.ok(
    outcome.warnings.some((warning) => /indisponible/.test(warning)),
    'aucun avertissement sur les assets manquants',
  );
});

test('les composants sont publies sur leur propre page', async () => {
  const spec = loadSpec();
  const { figma, outcome } = await synchronise(spec, { createComponents: true });
  assert.ok(outcome.stats.componentsWritten > 0, 'aucun composant publie');
  const page = figma.root.children.find((candidate) => candidate.name === 'Composants');
  assert.ok(page, 'page Composants absente');
  assert.ok(page.children.length > 0);
  // Les composants ne doivent pas porter le sid d une occurrence de page, sinon
  // la reconciliation des pages irait les chercher la.
  for (const child of page.children) {
    const sid = child.getPluginData('sfs:sid');
    if (sid) assert.match(sid, /^component:/, `sid inattendu sur un composant : ${sid}`);
  }
});

/* ------------------- noeuds hors auto-layout (cas reel) -------------------- */

/**
 * Construit un spec minimal contenant le cas qui a echoue en production : un
 * conteneur SANS auto-layout (enfants superposes, donc positionnement libre)
 * dont les enfants n'ont pas d'auto-layout non plus.
 *
 * Figma refuse alors toute ecriture de `layoutSizing*`, y compris « fixe » et y
 * compris sur un texte. Le site de demonstration ne produit aucun noeud de ce
 * genre : sans ce test ecrit a la main, la regression repasserait.
 */
function specSansAutoLayout() {
  const layout = (mode) => ({
    mode,
    wrap: false,
    padding: [0, 0, 0, 0],
    itemSpacing: 0,
    counterAxisSpacing: 0,
    primaryAxisAlignItems: 'MIN',
    counterAxisAlignItems: 'MIN',
    sizing: { horizontal: 'HUG', vertical: 'HUG' },
    clipsContent: false,
    positioning: 'AUTO',
  });
  const style = () => ({
    fills: [], strokes: [], strokeWeight: 0, strokeAlign: 'INSIDE',
    cornerRadius: [0, 0, 0, 0], effects: [], opacity: 1, visible: true,
  });
  const texte = (characters) => ({
    characters,
    font: {
      family: 'Inter', style: 'Regular', weight: 400, italic: false, size: 16,
      lineHeight: { unit: 'PIXELS', value: 24 },
      letterSpacing: { unit: 'PIXELS', value: 0 },
    },
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP', textAutoResize: 'HEIGHT',
    textDecoration: 'NONE', textCase: 'ORIGINAL', paragraphSpacing: 0,
  });
  const noeud = (sid, nom, kind, over = {}) => ({
    sid, name: nom, kind,
    box: { x: 0, y: 0, w: 200, h: 100 },
    layout: layout('NONE'), style: style(), children: [],
    hash: sid, subtreeHash: sid,
    ...over,
  });

  // Conteneur en positionnement libre, avec deux enfants sans auto-layout :
  // ni le parent ni les enfants ne peuvent recevoir de `layoutSizing`.
  const libre = noeud('libre', 'Vitrine', 'FRAME', {
    children: [
      noeud('carte-joaillerie', 'Joaillerie', 'FRAME'),
      noeud('carte-patisserie', 'Pâtisserie', 'FRAME'),
      noeud('texte-libre', 'Légende', 'TEXT', { text: texte('Savoir-faire') }),
    ],
  });

  const racine = noeud('root.desktop', 'Desktop · 1440px', 'FRAME', {
    box: { x: 0, y: 0, w: 1440, h: 900 },
    layout: { ...layout('VERTICAL'), sizing: { horizontal: 'FIXED', vertical: 'FIXED' } },
    children: [libre],
  });

  return {
    specVersion: 1,
    revision: 'sans-auto-layout',
    generatedAt: new Date().toISOString(),
    source: {
      kind: 'url', root: 'https://exemple.test/',
      extractedAt: new Date().toISOString(), contentHash: 'x', extractorVersion: '0.1.0',
    },
    tokens: [], paintStyles: [], textStyles: [], effectStyles: [], components: [],
    pages: [
      {
        name: 'Site / 01 · Test', route: '/', title: 'Test',
        breakpoints: [{ name: 'Desktop', width: 1440, height: 900, root: racine }],
      },
    ],
    assets: [], diagnostics: [],
    stats: { pages: 1, breakpoints: 1, nodes: 5, textNodes: 1, assets: 0, variables: 0, components: 0 },
  };
}

test('un conteneur sans auto-layout ne provoque aucun echec de dimensionnement', async () => {
  // Releve en production : « Largeur de « Joaillerie » : node must be an
  // auto-layout frame or a child of an auto-layout frame ». Figma impose cette
  // condition pour TOUTES les valeurs, « fixe » comprise.
  const { outcome } = await synchronise(specSansAutoLayout());
  const echecs = outcome.warnings.filter((w) => /Largeur de|Hauteur de|dimensionnement/.test(w));
  assert.deepEqual(echecs, [], echecs.join('\n'));
  assert.ok(outcome.stats.created >= 4, `${outcome.stats.created} couches creees`);
});

test('les tailles restent correctes malgre l absence d auto-layout', async () => {
  const { figma } = await synchronise(specSansAutoLayout());
  const carte = findBySid(figma.root, 'carte-joaillerie');
  assert.ok(carte, 'carte introuvable');
  // `resize` a bien pose la taille, meme sans passer par layoutSizing.
  assert.equal(carte.width, 200);
  assert.equal(carte.height, 100);
});
