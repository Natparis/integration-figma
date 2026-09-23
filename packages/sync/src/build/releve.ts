/**
 * Releve de diagnostic d'une page.
 *
 * Un element absent de la maquette ne laisse aucune trace : on ne peut ni le
 * montrer, ni le nommer, ni savoir quelle regle l'a ecarte. Diagnostiquer « le
 * heros a disparu » revient alors a deviner. Ce module rassemble, pour chaque
 * largeur d'ecran, les quatre faits qui repondent sans deviner :
 *
 *   · ce que la lecture a ECARTE, et sous quel motif ;
 *   · ce qu'elle a mesure DECALE, parce qu'une animation etait encore en vol ;
 *   · ce qui a ete REMONTE a la racine parce que cale sur la fenetre ;
 *   · ce qui sort du CADRE ou CHEVAUCHE son voisin, donc s'affichera de travers.
 */

import type { ReleveSpec, SpecNode } from '@sfs/spec';
import type { RawCapture } from '../browser/raw.js';

/** Sous cette surface, un ecart n'est pas visible a l'oeil : on n'en parle pas. */
const SURFACE_MINIMALE = 2000;

export function construireReleve(
  root: SpecNode,
  capture: RawCapture,
  largeurCadre: number,
): ReleveSpec {
  const ecartes = (capture.discards ?? [])
    .filter((d) => d.rect.w * d.rect.h >= SURFACE_MINIMALE || (d.text?.length ?? 0) > 0)
    .slice(0, 25)
    .map((d) => ({
      what: d.what,
      x: Math.round(d.rect.x),
      y: Math.round(d.rect.y),
      w: Math.round(d.rect.w),
      h: Math.round(d.rect.h),
      reason: d.reason,
      ...(d.text ? { text: d.text } : {}),
    }));

  const decales = (capture.shifted ?? [])
    .filter((d) => d.rect.w * d.rect.h >= SURFACE_MINIMALE)
    .slice(0, 15)
    .map((d) => ({
      what: d.what,
      x: Math.round(d.rect.x),
      y: Math.round(d.rect.y),
      w: Math.round(d.rect.w),
      h: Math.round(d.rect.h),
      dx: d.dx,
      dy: d.dy,
    }));

  const cales: ReleveSpec['cales'] = [];
  const horsCadre: ReleveSpec['horsCadre'] = [];
  const chevauchements: ReleveSpec['chevauchements'] = [];

  // Les noeuds cales sur la fenetre sont, par construction, les enfants directs
  // de la frame racine qui ne sont pas le corps de page.
  for (const enfant of root.children) {
    if (enfant.layout.viewportFixed) {
      cales.push({
        name: enfant.name,
        x: Math.round(enfant.box.x),
        y: Math.round(enfant.box.y),
        w: Math.round(enfant.box.w),
        h: Math.round(enfant.box.h),
      });
    }
  }

  const parcourir = (node: SpecNode): void => {
    if (node.box.x < -1 || node.box.x + node.box.w > largeurCadre + 1) {
      if (node.box.w * node.box.h >= SURFACE_MINIMALE && horsCadre.length < 20) {
        horsCadre.push({
          name: node.name,
          x: Math.round(node.box.x),
          y: Math.round(node.box.y),
          w: Math.round(node.box.w),
          h: Math.round(node.box.h),
        });
      }
    }

    // Dans une pile verticale, deux freres ne peuvent pas se recouvrir : si
    // c'est le cas, une hauteur a ete sous-estimee et le texte se superposera.
    if (node.layout.mode === 'VERTICAL' && !node.layout.wrap) {
      const enFlux = node.children.filter((c) => c.layout.positioning !== 'ABSOLUTE');
      for (let i = 1; i < enFlux.length; i++) {
        const precedent = enFlux[i - 1]!;
        const courant = enFlux[i]!;
        const recouvrement = precedent.box.y + precedent.box.h - courant.box.y;
        if (recouvrement > 2 && chevauchements.length < 20) {
          chevauchements.push({
            name: courant.name,
            voisin: precedent.name,
            y: Math.round(courant.box.y),
            recouvrement: Math.round(recouvrement),
          });
        }
      }
    }

    for (const enfant of node.children) parcourir(enfant);
  };
  parcourir(root);

  return { ecartes, decales, cales, horsCadre, chevauchements };
}

/** Vrai si le releve n'a rien a signaler : inutile de l'attacher au spec. */
export function releveVide(releve: ReleveSpec): boolean {
  return (
    releve.ecartes.length === 0 &&
    releve.decales.length === 0 &&
    releve.cales.length === 0 &&
    releve.horsCadre.length === 0 &&
    releve.chevauchements.length === 0
  );
}
