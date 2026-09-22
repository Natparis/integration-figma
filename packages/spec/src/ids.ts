/**
 * Identifiants stables (`sid`).
 *
 * Un `sid` est la cle de la synchronisation idempotente : le plugin l'ecrit dans
 * les donnees du noeud Figma (`setPluginData`) et le relit a chaque passage. Meme
 * `sid` = meme noeud, donc mise a jour sur place — les commentaires, liens de
 * prototype et selections du developpeur survivent.
 *
 * Strategie de stabilite, du plus fort au plus faible :
 *   1. un `id` HTML ou un `data-sfs-id` : ancre absolue, on arrete de remonter
 *      le DOM (inserer une section ailleurs dans la page ne casse rien) ;
 *   2. sinon, chemin structurel `balise.classe:index` depuis la derniere ancre.
 *
 * La derive residuelle (ajout d'un frere avant un noeud sans `id`) est rattrapee
 * cote plugin par l'appariement de repli sur (type, nom, hash de contenu).
 */

import { hashString } from './hash.js';

/** Un segment de chemin DOM tel que produit par le collecteur in-page. */
export interface PathSegment {
  tag: string;
  /** `id` HTML ou `data-sfs-id` : fait de ce segment une ancre absolue. */
  anchor?: string;
  /** Classe la plus signifiante, utilisee pour la lisibilite du chemin. */
  cls?: string;
  /** Index parmi les freres de meme balise, base 1. */
  index: number;
  /** Pseudo-element materialise (`::before` / `::after`). */
  pseudo?: 'before' | 'after';
}

/** Ne garde de la route que ce qui identifie la page. */
export function normalizeRoute(route: string): string {
  let r = route.trim();
  try {
    if (/^https?:\/\//i.test(r)) r = new URL(r).pathname;
  } catch {
    /* route deja relative */
  }
  r = r.split('?')[0]!.split('#')[0]!;
  // La barre de tete d'abord : sinon `index.html` (sans barre) echappe au
  // retrait de `/index.html` et devient `/index` au lieu de `/`.
  if (!r.startsWith('/')) r = '/' + r;
  r = r.replace(/\/index\.html?$/i, '/');
  r = r.replace(/\.html?$/i, '');
  if (r.length > 1) r = r.replace(/\/+$/, '');
  return r === '' ? '/' : r;
}

/** Rend le chemin lisible dans les logs et les rapports de diff. */
export function formatPath(segments: PathSegment[]): string {
  const out: string[] = [];
  for (const s of segments) {
    if (s.anchor) {
      out.length = 0;
      out.push('#' + s.anchor);
      continue;
    }
    let seg = s.tag;
    if (s.cls) seg += '.' + s.cls;
    if (s.index > 1) seg += ':' + s.index;
    if (s.pseudo) seg += '::' + s.pseudo;
    out.push(seg);
  }
  return out.join('>');
}

/**
 * Construit le `sid`. Le prefixe reste lisible (utile en debug dans Figma), la
 * queue est hachee pour garder une longueur bornee.
 */
export function makeSid(route: string, breakpoint: string, segments: PathSegment[]): string {
  const path = formatPath(segments);
  const key = `${normalizeRoute(route)}|${breakpoint}|${path}`;
  const last = segments[segments.length - 1];
  const label = last?.anchor ?? last?.cls ?? last?.tag ?? 'root';
  return `${slug(breakpoint)}.${slug(label)}.${hashString(key)}`;
}

/** `sid` de la frame racine d'une page a un breakpoint donne. */
export function makeRootSid(route: string, breakpoint: string): string {
  return `root.${slug(breakpoint)}.${hashString(normalizeRoute(route) + '|' + breakpoint)}`;
}

export function slug(input: string): string {
  return (
    input
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'x'
  );
}
