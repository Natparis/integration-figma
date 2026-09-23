/**
 * Rapport de comparaison.
 *
 * Produit un fichier HTML autonome montrant, cote a cote, la page telle que le
 * navigateur l'a vue et le rendu de ce que l'extracteur en a compris. Un
 * curseur permet de superposer les deux.
 *
 * Ce rapport existe pour une raison precise : sans lui, diagnostiquer un ecart
 * revient a deviner laquelle des deux moities du logiciel est en cause — la
 * lecture du site, ou l'ecriture dans Figma.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BreakpointSpec, DesignSpec, SpecNode } from '@sfs/spec';
import { rendreFrame } from './render.js';

const echapper = (texte: string): string =>
  texte.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function compterNoeuds(node: SpecNode): number {
  return 1 + node.children.reduce((somme, enfant) => somme + compterNoeuds(enfant), 0);
}

export interface ResultatRapport {
  fichier: string;
  /** Meme releve, en texte brut : se copie dans un message, se lit sans image. */
  fichierTexte: string;
  vues: number;
  avecCapture: number;
}

/**
 * Le releve en texte brut.
 *
 * Une capture d'ecran d'un tableau se lit mal et ne se cherche pas. Un fichier
 * texte court se copie d'un bloc dans un message : c'est la forme la plus sure
 * de transmettre un diagnostic quand on n'a pas la machine sous la main.
 */
function releveTexte(spec: DesignSpec): string {
  const lignes: string[] = [];
  lignes.push(`Releve de lecture — ${spec.source.root}`);
  lignes.push(`revision ${spec.revision} · ${spec.stats.pages} pages · ${spec.stats.nodes} calques`);

  for (const page of spec.pages) {
    for (const bp of page.breakpoints) {
      const r = bp.releve;
      if (!r) continue;
      const sections: string[] = [];

      if (r.ecartes.length > 0) {
        sections.push(
          `  ECARTES (${r.ecartes.length}) — presents dans la page, absents de la maquette`,
        );
        for (const e of r.ecartes.slice(0, 8)) {
          sections.push(
            `    ${e.what}  ${e.w}x${e.h} en (${e.x},${e.y})  — ${e.reason}` +
              (e.text ? `  « ${e.text} »` : ''),
          );
        }
      }
      if (r.decales.length > 0) {
        sections.push(`  DECALES (${r.decales.length}) — mesures pendant une animation`);
        for (const d of r.decales.slice(0, 6)) {
          sections.push(`    ${d.what}  ${d.w}x${d.h} en (${d.x},${d.y})  — decale de ${d.dx},${d.dy} px`);
        }
      }
      if (r.cales.length > 0) {
        sections.push(`  CALES SUR LA FENETRE (${r.cales.length}) — remontes a la racine`);
        for (const c of r.cales.slice(0, 6)) {
          sections.push(`    ${c.name}  ${c.w}x${c.h} en (${c.x},${c.y})`);
        }
      }
      if (r.horsCadre.length > 0) {
        sections.push(`  HORS CADRE (${r.horsCadre.length}) — seront coupes dans Figma`);
        for (const c of r.horsCadre.slice(0, 6)) {
          sections.push(`    ${c.name}  ${c.w}x${c.h} en (${c.x},${c.y})`);
        }
      }
      if (r.chevauchements.length > 0) {
        sections.push(`  CHEVAUCHEMENTS (${r.chevauchements.length}) — lignes qui se recouvrent`);
        for (const c of r.chevauchements.slice(0, 6)) {
          sections.push(`    ${c.name} recouvre ${c.voisin} de ${c.recouvrement} px (y = ${c.y})`);
        }
      }

      if (sections.length === 0) continue;
      lignes.push('');
      lignes.push(`${page.name} — ${bp.name} (${bp.width} px)`);
      lignes.push(...sections);
    }
  }

  const anomalies = spec.diagnostics.filter((d) => d.level !== 'info');
  if (anomalies.length > 0) {
    lignes.push('');
    lignes.push(`ANOMALIES D EXTRACTION (${anomalies.length})`);
    for (const d of anomalies.slice(0, 12)) {
      lignes.push(`  ${d.message}${d.where ? `  [${d.where}]` : ''}`);
    }
  }

  if (lignes.length <= 2) lignes.push('', 'Rien a signaler : aucun element ecarte, decale ou hors cadre.');
  return lignes.join('\n') + '\n';
}

const boite = (n: { x: number; y: number; w: number; h: number }): string =>
  `${n.w}\u00d7${n.h} en (${n.x}, ${n.y})`;

/**
 * Le releve, en clair sous la comparaison.
 *
 * Il repond a la seule question que la comparaison laisse ouverte : quand un
 * element manque a droite, qu'est-ce qui l'a ecarte ?
 */
function rendreReleve(bp: BreakpointSpec): string {
  const r = bp.releve;
  if (!r) return '';
  const blocs: string[] = [];

  if (r.ecartes.length > 0) {
    blocs.push(`<div class="bloc">
      <b>Ecartes a la lecture (${r.ecartes.length})</b>
      <p class="piste">Ces elements existent dans la page mais ne sont pas dans la maquette.</p>
      <table>${r.ecartes
        .map(
          (e) =>
            `<tr><td><code>${echapper(e.what)}</code></td><td>${boite(e)}</td><td>${echapper(e.reason)}</td><td class="ou">${echapper(e.text ?? '')}</td></tr>`,
        )
        .join('')}</table>
    </div>`);
  }

  if (r.decales.length > 0) {
    blocs.push(`<div class="bloc">
      <b>Mesures pendant un deplacement (${r.decales.length})</b>
      <p class="piste">Une animation etait encore en vol : la position relevee est decalee d'autant.</p>
      <table>${r.decales
        .map(
          (d) =>
            `<tr><td><code>${echapper(d.what)}</code></td><td>${boite(d)}</td><td>decale de ${d.dx} , ${d.dy} px</td></tr>`,
        )
        .join('')}</table>
    </div>`);
  }

  if (r.cales.length > 0) {
    blocs.push(`<div class="bloc">
      <b>Remontes a la racine, cales sur la fenetre (${r.cales.length})</b>
      <p class="piste">En-tetes et bandeaux fixes : places au-dessus du reste, comme dans le navigateur.</p>
      <table>${r.cales
        .map((c) => `<tr><td><code>${echapper(c.name)}</code></td><td>${boite(c)}</td></tr>`)
        .join('')}</table>
    </div>`);
  }

  if (r.horsCadre.length > 0) {
    blocs.push(`<div class="bloc">
      <b>Hors du cadre de la page (${r.horsCadre.length})</b>
      <p class="piste">Une boite qui commence avant 0 ou depasse a droite sera coupee dans Figma.</p>
      <table>${r.horsCadre
        .map((c) => `<tr><td><code>${echapper(c.name)}</code></td><td>${boite(c)}</td></tr>`)
        .join('')}</table>
    </div>`);
  }

  if (r.chevauchements.length > 0) {
    blocs.push(`<div class="bloc">
      <b>Lignes qui se recouvrent (${r.chevauchements.length})</b>
      <p class="piste">Dans une pile verticale, deux voisins ne devraient jamais se superposer.</p>
      <table>${r.chevauchements
        .map(
          (c) =>
            `<tr><td><code>${echapper(c.name)}</code></td><td>recouvre <code>${echapper(c.voisin)}</code></td><td>${c.recouvrement} px, a y = ${c.y}</td></tr>`,
        )
        .join('')}</table>
    </div>`);
  }

  if (blocs.length === 0) return '';
  return `<details class="releve"><summary>Releve de lecture — ce qui a ete ecarte, decale ou remonte</summary>${blocs.join('')}</details>`;
}

export async function ecrireRapport(dossierSortie: string): Promise<ResultatRapport> {
  const dossier = path.resolve(dossierSortie);
  const spec = JSON.parse(
    await readFile(path.join(dossier, 'design-spec.json'), 'utf8'),
  ) as DesignSpec;

  const vues: string[] = [];
  const options: string[] = [];
  let avecCapture = 0;

  spec.pages.forEach((page, indexPage) => {
    page.breakpoints.forEach((bp, indexBp) => {
      const cle = `v${indexPage}_${indexBp}`;
      const etiquette = `${page.name} — ${bp.name} (${bp.width}px)`;
      options.push(`<option value="${cle}">${echapper(etiquette)}</option>`);
      if (bp.screenshot) avecCapture++;

      const capture = bp.screenshot
        ? `<img src="${echapper(bp.screenshot)}" alt="Capture du site">`
        : `<div class="absente">Aucune capture.<br><small>Relancez l'extraction avec <code>output.screenshots</code> actif.</small></div>`;

      // Le rendu est mis a l'echelle de la capture : les deux colonnes ont la
      // meme largeur affichee, donc les ecarts sautent aux yeux.
      vues.push(`
<section class="vue" id="${cle}" style="--largeur: ${bp.width}px" hidden>
  <div class="chiffres">
    <span><b>${compterNoeuds(bp.root)}</b> calques</span>
    <span><b>${bp.width}</b> × <b>${bp.height}</b> px</span>
    <span>route <code>${echapper(page.route)}</code></span>
  </div>
  <div class="paire">
    <figure class="cote">
      <figcaption>Le site, vu par le navigateur</figcaption>
      <div class="cadre">${capture}</div>
    </figure>
    <figure class="cote">
      <figcaption>Ce que l'extracteur a compris</figcaption>
      <div class="cadre"><div class="rendu">${rendreFrame(bp.root, spec)}</div></div>
    </figure>
  </div>
  <div class="superpose">
    <figcaption>Superposition — glissez pour comparer</figcaption>
    <div class="cadre empile">
      <div class="calque-bas">${capture}</div>
      <div class="calque-haut" data-haut><div class="rendu">${rendreFrame(bp.root, spec)}</div></div>
    </div>
    <input type="range" min="0" max="100" value="50" class="curseur" data-curseur>
  </div>
  ${rendreReleve(bp)}
</section>`);
    });
  });

  const avertissements = spec.diagnostics.filter((d) => d.level !== 'info');
  const listeAvertissements = avertissements.length
    ? avertissements
        .slice(0, 40)
        .map(
          (d) =>
            `<li><b>${echapper(d.message)}</b>${d.where ? ` <span class="ou">${echapper(d.where)}</span>` : ''}${d.hint ? `<br><span class="piste">→ ${echapper(d.hint)}</span>` : ''}</li>`,
        )
        .join('')
    : '<li class="rien">Aucune anomalie relevee.</li>';

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comparaison — ${echapper(spec.source.root)}</title>
<style>
  :root {
    --encre: #101828; --doux: #667085; --bord: #e4e7ec;
    --fond: #f9fafb; --accent: #0072d5;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
         color: var(--encre); background: var(--fond); }
  header { position: sticky; top: 0; z-index: 10; background: #fff;
           border-bottom: 1px solid var(--bord); padding: 16px 24px; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  .meta { color: var(--doux); font-size: 13px; }
  .barre { display: flex; gap: 16px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
  select { font: inherit; padding: 7px 10px; border: 1px solid var(--bord); border-radius: 6px; }
  main { padding: 24px; }
  .chiffres { display: flex; gap: 20px; color: var(--doux); margin-bottom: 12px; flex-wrap: wrap; }
  .paire { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  /* min-width: 0 est indispensable : sans lui, une colonne 1fr refuse de
     descendre sous la largeur de son contenu. Le rendu faisant 1440 px de
     large, la colonne en faisait autant et la mise a l'echelle ne servait
     a rien. */
  .cote, .superpose { min-width: 0; }
  figure { margin: 0; }
  figcaption { font-weight: 600; margin-bottom: 8px; }
  .cadre { border: 1px solid var(--bord); background: #fff; border-radius: 8px;
           overflow: hidden; }
  .cadre img { display: block; width: 100%; height: auto; }
  /* Le rendu est produit a la largeur reelle du breakpoint, puis reduit pour
     tenir dans la colonne : les proportions restent exactes. */
  .rendu { width: var(--largeur); transform-origin: top left; }
  .absente { padding: 40px; text-align: center; color: var(--doux); }
  .superpose { margin-top: 32px; }
  .empile { position: relative; }
  .calque-bas img { width: 100%; }
  .calque-haut { position: absolute; inset: 0; overflow: hidden; }
  .curseur { width: 100%; margin-top: 12px; }
  .avertissements { margin-top: 32px; background: #fff; border: 1px solid var(--bord);
                    border-radius: 8px; padding: 16px 20px; }
  .avertissements ul { margin: 8px 0 0; padding-left: 20px; }
  .avertissements li { margin-bottom: 10px; }
  .ou { color: var(--doux); font-size: 12px; }
  .piste { color: var(--doux); }
  .rien { color: var(--doux); list-style: none; margin-left: -20px; }
  code { background: var(--fond); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .note { margin-top: 24px; color: var(--doux); font-size: 13px; max-width: 70ch; }
  .releve { margin-top: 16px; border: 1px solid var(--bord); border-radius: 8px; padding: 10px 14px; }
  .releve summary { cursor: pointer; font-weight: 600; font-size: 13px; }
  .releve .bloc { margin-top: 14px; }
  .releve p { margin: 2px 0 6px; font-size: 12px; }
  .releve table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .releve td { padding: 3px 8px 3px 0; border-top: 1px solid var(--bord); vertical-align: top; }
  .releve td:first-child { white-space: nowrap; }
</style>
</head>
<body>
<header>
  <h1>Comparaison — ce que l'extracteur a compris de votre site</h1>
  <div class="meta">
    ${echapper(spec.source.root)} · revision <code>${echapper(spec.revision)}</code> ·
    ${spec.stats.pages} pages · ${spec.stats.nodes} calques
  </div>
  <div class="barre">
    <label>Page et largeur <select data-choix>${options.join('')}</select></label>
  </div>
</header>
<main>
  ${vues.join('')}

  <div class="avertissements">
    <b>Anomalies relevees pendant l'extraction (${avertissements.length})</b>
    <ul>${listeAvertissements}</ul>
  </div>

  <p class="note">
    La colonne de droite n'est pas une capture : c'est le <b>design-spec redessine</b>,
    en appliquant les memes regles que Figma — l'auto-layout devient du flexbox, et
    « remplir / ajuster / fixe » devient <code>flex</code>, <code>fit-content</code> et
    une largeur en pixels. Si les deux colonnes se ressemblent, la lecture du site est
    juste et un eventuel ecart dans Figma vient de l'ecriture. Si elles different, c'est
    la lecture qu'il faut corriger.
  </p>
  <p class="note">
    Les polices du site ne sont pas chargees ici : la typographie peut differer sans que
    ce soit un defaut d'extraction. Figma a exactement la meme limite.
  </p>
</main>
<script>
  (function () {
    var choix = document.querySelector('[data-choix]');
    var vues = Array.prototype.slice.call(document.querySelectorAll('.vue'));

    function ajuster(vue) {
      // Reduit le rendu pour qu'il occupe exactement la largeur de sa colonne.
      vue.querySelectorAll('.rendu').forEach(function (rendu) {
        var cadre = rendu.parentElement;
        var largeur = parseFloat(getComputedStyle(rendu).width);
        if (!largeur) return;
        var echelle = cadre.clientWidth / largeur;
        rendu.style.transform = 'scale(' + echelle + ')';
        cadre.style.height = rendu.scrollHeight * echelle + 'px';
      });
    }

    function montrer(cle) {
      vues.forEach(function (vue) { vue.hidden = vue.id !== cle; });
      var active = document.getElementById(cle);
      if (active) requestAnimationFrame(function () { ajuster(active); });
    }

    choix.addEventListener('change', function () { montrer(choix.value); });
    window.addEventListener('resize', function () {
      var active = vues.filter(function (v) { return !v.hidden; })[0];
      if (active) ajuster(active);
    });

    document.querySelectorAll('[data-curseur]').forEach(function (curseur) {
      curseur.addEventListener('input', function () {
        var haut = curseur.closest('.superpose').querySelector('[data-haut]');
        haut.style.width = curseur.value + '%';
      });
    });

    if (vues.length > 0) montrer(vues[0].id);
  })();
</script>
</body>
</html>`;

  const fichier = path.join(dossier, 'comparaison.html');
  await writeFile(fichier, html, 'utf8');
  const fichierTexte = path.join(dossier, 'releve.txt');
  await writeFile(fichierTexte, releveTexte(spec), 'utf8');
  return { fichier, fichierTexte, vues: vues.length, avecCapture };
}
