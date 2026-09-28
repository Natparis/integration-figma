/**
 * Passerelle design-spec → Figma, sans plugin ni machine locale.
 *
 * Le plugin Figma reste la voie normale : il tourne chez l'utilisatrice et sait
 * mettre a jour une maquette existante calque par calque. Cette passerelle-ci
 * repond a un autre besoin — construire la maquette a distance, depuis une
 * session qui a l'acces en ecriture au fichier Figma mais aucune main sur le
 * poste de travail.
 *
 * Elle produit des SCRIPTS : du JavaScript de l'API Plugin, decoupe en morceaux
 * assez petits pour passer par l'outil d'execution. Le decoupage suit l'arbre —
 * un script par section de premier niveau — pour qu'un echec soit rejouable
 * sans reconstruire la page entiere.
 *
 * Choix de cette premiere version : POSITIONNEMENT ABSOLU partout. La geometrie
 * est mesuree, donc exacte ; l'auto-layout, lui, redistribue et accumule les
 * ecarts. La fidelite d'abord ; la structure auto-layout viendra ensuite, une
 * fois la ressemblance acquise.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const TAILLE_MAX = 40000;

/** Arrondi court : deux decimales suffisent, et le JSON pese moins. */
const r = (n) => Math.round(n * 100) / 100;

/** Peinture du spec → peinture Figma, en notation compacte. */
function peinture(p) {
  if (p.type === 'SOLID') {
    return { t: 'S', c: [r(p.color.r), r(p.color.g), r(p.color.b)], o: r(p.opacity ?? 1) };
  }
  if (p.type && p.type.startsWith('GRADIENT')) {
    return {
      t: 'G',
      k: p.type,
      a: r(p.angle ?? 180),
      o: r(p.opacity ?? 1),
      s: (p.stops ?? []).map((s) => ({
        p: r(s.position),
        c: [r(s.color.r), r(s.color.g), r(s.color.b), r(s.color.a ?? 1)],
      })),
    };
  }
  return null;
}

/** Noeud du spec → forme compacte comprise par le constructeur embarque. */
function compacter(node, assets) {
  const out = {
    k: node.kind,
    n: node.name.slice(0, 60),
    b: [r(node.box.x), r(node.box.y), r(Math.max(0.01, node.box.w)), r(Math.max(0.01, node.box.h))],
  };

  const fills = (node.style.fills ?? []).map(peinture).filter(Boolean);
  if (fills.length) out.f = fills;
  const rayons = node.style.cornerRadius ?? [0, 0, 0, 0];
  if (rayons.some((v) => v > 0)) out.r = rayons.map(r);
  if ((node.style.opacity ?? 1) < 1) out.o = r(node.style.opacity);
  if (node.style.visible === false) out.h = 1;
  if (node.layout.clipsContent) out.cl = 1;

  const traits = (node.style.strokes ?? []).map(peinture).filter(Boolean);
  if (traits.length && node.style.strokeWeight > 0) {
    out.st = traits;
    out.sw = r(node.style.strokeWeight);
  }

  if (node.kind === 'TEXT' && node.text) {
    const t = node.text;
    out.t = {
      c: t.characters,
      ff: t.font.family,
      fs: t.font.style,
      sz: r(t.font.size),
      lh: t.font.lineHeight.unit === 'AUTO' ? null : [t.font.lineHeight.unit, r(t.font.lineHeight.value ?? 0)],
      ls: [t.font.letterSpacing.unit, r(t.font.letterSpacing.value ?? 0)],
      al: t.textAlignHorizontal,
      av: t.textAlignVertical,
      cs: t.textCase,
      dc: t.textDecoration,
      f: (t.fills ?? []).map(peinture).filter(Boolean),
    };
  }

  if (node.image && assets.has(node.image.assetId)) {
    out.img = node.image.assetId;
    out.sm = node.image.scaleMode;
  }

  const enfants = (node.children ?? []).map((c) => compacter(c, assets)).filter(Boolean);
  if (enfants.length) out.c = enfants;
  return out;
}

/**
 * Aplatit les conteneurs qui n'apportent rien.
 *
 * Le DOM d'une application React empile des `div` sans fond, sans bordure et
 * sans role visuel, uniquement pour porter une classe utilitaire. Transposees
 * telles quelles, elles donnent une maquette a dix niveaux d'imbrication ou le
 * developpeur ne retrouve rien — et un script trois fois plus lourd.
 *
 * Comme tout est positionne en absolu, remonter les enfants d'un conteneur vide
 * ne change RIEN au rendu. On ne garde donc que les conteneurs qui se voient
 * (fond, bordure, image, ecretage, opacite) ou qui portent un nom parlant.
 */
function aplatir(noeud) {
  if (!noeud.c) return [noeud];

  const enfants = noeud.c.flatMap(aplatir);
  const seVoit =
    noeud.f || noeud.st || noeud.img || noeud.cl || noeud.o !== undefined || noeud.k !== 'FRAME';
  // « Div », « Div 3 », « Span 2 » : noms de repli, aucun sens pour la lecture.
  const nomDeRepli = /^(Div|Span|Conteneur|Element)( \d+)?$/i.test(noeud.n);

  if (!seVoit && nomDeRepli) return enfants;
  noeud.c = enfants;
  return [noeud];
}

/** Le constructeur, embarque dans chaque script. */
const CONSTRUCTEUR = `
const P = (p) => {
  if (p.t === 'S') return { type: 'SOLID', color: { r: p.c[0], g: p.c[1], b: p.c[2] }, opacity: p.o };
  const a = ((p.a - 90) * Math.PI) / 180;
  const co = Math.cos(a), si = Math.sin(a);
  return {
    type: p.k,
    gradientTransform: [[co, si, 0.5 - (co + si) / 2], [-si, co, 0.5 - (co - si) / 2]],
    gradientStops: p.s.map((s) => ({ position: s.p, color: { r: s.c[0], g: s.c[1], b: s.c[2], a: s.c[3] } })),
    opacity: p.o,
  };
};
const polices = new Map();
async function police(f, s) {
  const cle = f + '|' + s;
  if (polices.has(cle)) return polices.get(cle);
  let choix = { family: f, style: s };
  try { await figma.loadFontAsync(choix); }
  catch (e) {
    choix = { family: 'Inter', style: /Bold/i.test(s) ? 'Bold' : 'Regular' };
    try { await figma.loadFontAsync(choix); } catch (e2) { choix = { family: 'Inter', style: 'Regular' }; await figma.loadFontAsync(choix); }
  }
  polices.set(cle, choix);
  return choix;
}
const aImage = [];
async function batir(d, parent, ox, oy) {
  let n;
  if (d.k === 'TEXT' && d.t) {
    n = figma.createText();
    const pf = await police(d.t.ff, d.t.fs);
    n.fontName = pf;
    n.fontSize = Math.max(1, d.t.sz);
    n.textAlignHorizontal = d.t.al;
    n.textAlignVertical = d.t.av;
    if (d.t.cs && d.t.cs !== 'ORIGINAL') n.textCase = d.t.cs;
    if (d.t.dc && d.t.dc !== 'NONE') n.textDecoration = d.t.dc;
    if (d.t.lh) n.lineHeight = { unit: d.t.lh[0], value: d.t.lh[1] };
    if (d.t.ls) n.letterSpacing = { unit: d.t.ls[0], value: d.t.ls[1] };
    n.characters = d.t.c;
    if (d.t.f && d.t.f.length) n.fills = d.t.f.map(P);
    n.textAutoResize = 'NONE';
  } else if (d.k === 'ELLIPSE') {
    n = figma.createEllipse();
  } else {
    n = figma.createFrame();
    n.clipsContent = !!d.cl;
    n.fills = d.f ? d.f.map(P) : [];
  }
  n.name = d.n;
  parent.appendChild(n);
  n.resize(Math.max(0.01, d.b[2]), Math.max(0.01, d.b[3]));
  n.x = d.b[0] - ox;
  n.y = d.b[1] - oy;
  if (d.o !== undefined) n.opacity = d.o;
  if (d.h) n.visible = false;
  if (d.r && 'topLeftRadius' in n) {
    n.topLeftRadius = d.r[0]; n.topRightRadius = d.r[1];
    n.bottomRightRadius = d.r[2]; n.bottomLeftRadius = d.r[3];
  }
  if (d.st && 'strokes' in n) { n.strokes = d.st.map(P); n.strokeWeight = d.sw; n.strokeAlign = 'INSIDE'; }
  if (d.img) aImage.push({ id: n.id, asset: d.img, mode: d.sm });
  if (d.c) for (const e of d.c) await batir(e, n, d.b[0], d.b[1]);
  return n;
}
`;

async function principal() {
  const dossier = process.argv[2] ?? '.sfs-lvmh';
  const sortie = process.argv[3] ?? '.figma-scripts';
  const spec = JSON.parse(await readFile(path.join(dossier, 'design-spec.json'), 'utf8'));
  const assets = new Map(spec.assets.map((a) => [a.id, a]));
  await mkdir(sortie, { recursive: true });

  /**
   * Decoupe l'arbre en taches executables.
   *
   * Une tache = un lot de noeuds a batir sous un meme parent, designe par son
   * CHEMIN D'INDEX depuis la frame racine. Le chemin suffit : les enfants sont
   * bâtis dans l'ordre, donc leur position dans le parent est connue d'avance,
   * et aucune tache n'a besoin de connaitre les identifiants Figma des autres.
   *
   * Quand un noeud depasse a lui seul la taille limite, on l'emet en COQUILLE —
   * sans ses enfants — et l'on recurse : ses enfants deviennent des taches qui
   * le designent par son chemin. Une section de mille calques se construit ainsi
   * en plusieurs appels, sans jamais reconstruire ce qui tient deja.
   */
  const taches = [];

  function decouper(noeuds, chemin, origine) {
    let lot = [];
    let poids = 0;
    const vider = () => {
      if (lot.length) taches.push({ chemin, origine, noeuds: lot });
      lot = [];
      poids = 0;
    };

    noeuds.forEach((noeud, index) => {
      const taille = JSON.stringify(noeud).length;
      if (taille <= TAILLE_MAX) {
        if (poids + taille > TAILLE_MAX) vider();
        lot.push(noeud);
        poids += taille;
        return;
      }
      // Trop gros : coquille ici, enfants dans des taches suivantes.
      const enfants = noeud.c ?? [];
      const coquille = { ...noeud };
      delete coquille.c;
      const tailleCoquille = JSON.stringify(coquille).length;
      if (poids + tailleCoquille > TAILLE_MAX) vider();
      lot.push(coquille);
      poids += tailleCoquille;
      vider();
      decouper(enfants, [...chemin, index], [noeud.b[0], noeud.b[1]]);
    });
    vider();
  }

  const vues = [];
  for (const page of spec.pages) {
    for (const bp of page.breakpoints) {
      const racine = compacter(bp.root, assets);
      racine.c = (racine.c ?? []).flatMap(aplatir);
      const sections = racine.c ?? [];
      delete racine.c;
      taches.length = 0;
      decouper(sections, [], [0, 0]);
      vues.push({
        page: page.name,
        breakpoint: bp.name,
        largeur: bp.width,
        hauteur: bp.height,
        racine,
        taches: taches.map((t) => ({ ...t })),
      });
    }
  }

  const fichiers = [];
  for (const [i, vue] of vues.entries()) {
    const nom = `vue-${String(i).padStart(2, '0')}`;
    await writeFile(path.join(sortie, `${nom}.json`), JSON.stringify(vue), 'utf8');
    fichiers.push({
      nom,
      page: vue.page,
      breakpoint: vue.breakpoint,
      taches: vue.taches.length,
      poids: vue.taches.map((t) => JSON.stringify(t.noeuds).length),
    });
  }

  // Scripts prets a executer : un fichier par tache.
  for (const [i, vue] of vues.entries()) {
    for (const [j, tache] of vue.taches.entries()) {
      const premier = j === 0;
      const entete = premier
        ? `
const NOM = ${JSON.stringify(vue.page + ' — ' + vue.breakpoint)};
let page = figma.root.children.find((p) => p.name === NOM);
if (!page) { page = figma.createPage(); page.name = NOM; }
await figma.setCurrentPageAsync(page);
for (const enfant of [...page.children]) enfant.remove();
const D = ${JSON.stringify(vue.racine)};
const cible = figma.createFrame();
cible.name = D.n;
cible.resize(${vue.largeur}, ${Math.round(vue.hauteur)});
cible.x = 0; cible.y = 0;
cible.fills = D.f ? D.f.map(P) : [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
cible.clipsContent = true;
page.appendChild(cible);`
        : `
const NOM = ${JSON.stringify(vue.page + ' — ' + vue.breakpoint)};
const page = figma.root.children.find((p) => p.name === NOM);
await figma.setCurrentPageAsync(page);
let cible = page.children[0];
for (const index of ${JSON.stringify(tache.chemin)}) cible = cible.children[index];`;

      const script =
        CONSTRUCTEUR +
        entete +
        `
const T = ${JSON.stringify(tache.noeuds)};
for (const d of T) await batir(d, cible, ${tache.origine[0]}, ${tache.origine[1]});
return { cible: cible.id, createdNodeIds: [cible.id], mutatedNodeIds: [], images: aImage, poses: T.length };
`;
      await writeFile(
        path.join(sortie, `vue-${String(i).padStart(2, '0')}-t${String(j).padStart(2, '0')}.js`),
        script,
        'utf8',
      );
    }
  }

  await writeFile(path.join(sortie, 'constructeur.js'), CONSTRUCTEUR, 'utf8');
  await writeFile(path.join(sortie, 'plan.json'), JSON.stringify(fichiers, null, 1), 'utf8');
  console.log(JSON.stringify(fichiers, null, 1));
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
