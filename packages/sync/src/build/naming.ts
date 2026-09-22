/**
 * Nommage des couches.
 *
 * Un fichier Figma ou tout s'appelle « Frame 1247 » est inexploitable : le
 * developpeur ne peut pas relier la maquette au code, et personne ne peut
 * commenter precisement. On nomme donc chaque couche d'apres sa semantique HTML,
 * son intitule accessible ou son contenu.
 */

import type { RawNode } from '../browser/raw.js';

/** Reperes HTML : la structure qu'un developpeur reconnait immediatement. */
const LANDMARKS: Record<string, string> = {
  header: 'En-tete',
  nav: 'Navigation',
  main: 'Contenu principal',
  footer: 'Pied de page',
  aside: 'Aside',
  form: 'Formulaire',
  dialog: 'Boite de dialogue',
  figure: 'Figure',
  figcaption: 'Legende',
  table: 'Tableau',
  thead: 'En-tete de tableau',
  tbody: 'Corps de tableau',
  tr: 'Ligne',
  th: 'Cellule d en-tete',
  td: 'Cellule',
  ul: 'Liste',
  ol: 'Liste ordonnee',
  li: 'Element de liste',
  dl: 'Liste de definitions',
  blockquote: 'Citation',
  hr: 'Separateur',
  video: 'Video',
  audio: 'Audio',
  canvas: 'Canvas',
  iframe: 'Cadre integre',
  details: 'Depliant',
  summary: 'Resume',
  label: 'Etiquette',
  fieldset: 'Groupe de champs',
  legend: 'Legende de groupe',
  select: 'Liste deroulante',
  textarea: 'Zone de texte',
  progress: 'Barre de progression',
  picture: 'Image',
  svg: 'Icone',
};

const ROLE_LABELS: Record<string, string> = {
  banner: 'En-tete',
  navigation: 'Navigation',
  main: 'Contenu principal',
  contentinfo: 'Pied de page',
  complementary: 'Complement',
  search: 'Recherche',
  dialog: 'Boite de dialogue',
  alert: 'Alerte',
  status: 'Statut',
  tablist: 'Onglets',
  tab: 'Onglet',
  tabpanel: 'Panneau d onglet',
  list: 'Liste',
  listitem: 'Element de liste',
  button: 'Bouton',
  link: 'Lien',
  article: 'Article',
  region: 'Section',
  menu: 'Menu',
  menuitem: 'Element de menu',
  img: 'Image',
  separator: 'Separateur',
};

/** Tronque sans couper un mot en deux. */
export function truncate(input: string, max = 42): string {
  const clean = input.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/** « carte-metier », « carteMetier », « carte_metier » -> « Carte metier ». */
export function humanize(input: string): string {
  const words = input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Premier titre trouve dans le sous-arbre : sert a nommer une section. */
function findHeading(node: RawNode, depth = 0): string | null {
  if (depth > 6) return null;
  if (/^h[1-6]$/.test(node.seg.tag) && node.text?.characters) return node.text.characters;
  for (const child of node.children) {
    const found = findHeading(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Premier texte du sous-arbre : intitule d'un lien ou d'un bouton composite. */
function findText(node: RawNode, depth = 0): string | null {
  if (depth > 4) return null;
  const own = node.text?.characters?.trim();
  if (own) return own;
  for (const child of node.children) {
    const found = findText(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export interface NameContext {
  /** Nom du parent : evite « Navigation / Navigation ». */
  parentName?: string;
  /** Index parmi les freres de meme nom, pour desambiguiser. */
  siblingIndex?: number;
}

export function nameNode(node: RawNode, context: NameContext = {}): string {
  const tag = node.seg.tag;
  const label = node.ariaLabel?.trim();
  const textContent = node.text?.characters?.trim();

  /* --- textes : le contenu EST le nom, c'est ce qu'attend un designer --- */

  if (/^h([1-6])$/.test(tag) && textContent) {
    return `${tag.toUpperCase()} · ${truncate(textContent, 36)}`;
  }
  if (tag === '#text' && textContent) return truncate(textContent, 40);

  /* --- elements interactifs : le role puis l'intitule --- */

  if (tag === 'button' || node.role === 'button') {
    // Un bouton contient souvent une icone ET un libelle dans des elements
    // distincts : on va chercher le texte dans le sous-arbre.
    const name = label ?? textContent ?? findText(node);
    return `Bouton · ${truncate(name ?? 'sans intitule', 28)}`;
  }
  if (tag === 'a') {
    const name = label ?? textContent ?? findText(node);
    if (!name) return node.children.some((c) => c.svg) ? 'Lien · icone' : 'Lien';
    return `Lien · ${truncate(name, 28)}`;
  }
  if (tag === 'input') {
    const type = node.style.type ?? '';
    return `Champ${type ? ' ' + type : ''}${label ? ' · ' + truncate(label, 24) : ''}`;
  }

  /* --- medias --- */

  if (tag === 'img' || tag === 'picture') {
    const alt = node.images[0]?.alt?.trim();
    return alt ? `Image · ${truncate(alt, 32)}` : 'Image';
  }
  if (tag === 'svg' || node.svg) {
    return label ? `Icone · ${truncate(label, 28)}` : 'Icone';
  }

  /* --- pseudo-elements : identifies comme tels, ce sont des artefacts CSS --- */

  if (node.seg.pseudo) {
    return `${node.seg.pseudo === 'before' ? '::before' : '::after'}${
      textContent ? ' · ' + truncate(textContent, 20) : ''
    }`;
  }

  /* --- reperes et sections --- */

  if (label) return truncate(label, 40);

  if (node.role && ROLE_LABELS[node.role]) {
    const base = ROLE_LABELS[node.role]!;
    return context.parentName === base ? `${base} ${context.siblingIndex ?? ''}`.trim() : base;
  }

  if (tag === 'section' || tag === 'article') {
    // Une section est mieux nommee par son titre que par sa classe CSS : c'est
    // ainsi qu'on en parle en reunion (« la section Nos metiers »). Limite aux
    // vraies sections : applique aux `div`, le meme titre se propageait sur
    // quatre niveaux d'imbrication.
    const heading = findHeading(node);
    if (heading && heading !== context.parentName) return truncate(heading, 40);
    if (node.seg.cls) {
      const humanized = humanize(node.seg.cls);
      if (humanized) return humanized;
    }
    return tag === 'section' ? 'Section' : 'Article';
  }
  if (tag === 'div') {
    if (node.seg.cls) {
      const humanized = humanize(node.seg.cls);
      if (humanized) return humanized;
    }
    // `div` sans classe : un titre proche le decrit bien mieux que « Div ».
    // Recherche volontairement peu profonde — au-dela, le meme titre se
    // propagerait sur plusieurs niveaux d'imbrication.
    const heading = findHeading(node, 4);
    if (heading && heading !== context.parentName) return truncate(heading, 36);
    const text = findText(node, 3);
    if (text) return truncate(text, 36);
  }

  if (LANDMARKS[tag]) {
    const base = LANDMARKS[tag]!;
    if (node.seg.cls) {
      const humanized = humanize(node.seg.cls);
      // « Navigation principale » vaut mieux que « Navigation » seul.
      if (humanized && humanized.toLowerCase() !== base.toLowerCase()) {
        return `${base} · ${humanized}`;
      }
    }
    return base;
  }

  if (textContent) return truncate(textContent, 40);

  if (node.seg.cls) {
    const humanized = humanize(node.seg.cls);
    if (humanized) return humanized;
  }
  if (node.seg.anchor) {
    const humanized = humanize(node.seg.anchor);
    if (humanized) return humanized;
  }

  const fallback = humanize(tag) || 'Groupe';
  // Repeter le nom du parent n'aide personne a s'orienter dans le calque.
  return fallback === context.parentName ? `${fallback} interne` : fallback;
}

/** Ajoute un suffixe numerique aux noms en doublon parmi les freres. */
export function disambiguate(names: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return names.map((name) => {
    if ((counts.get(name) ?? 0) <= 1) return name;
    const index = (seen.get(name) ?? 0) + 1;
    seen.set(name, index);
    return `${name} ${index}`;
  });
}

/** Nom de page Figma : numerote pour garder l'ordre du site dans le panneau. */
export function pageName(index: number, route: string, title: string, prefix: string): string {
  const order = String(index + 1).padStart(2, '0');
  const readable =
    route === '/' ? 'Accueil' : truncate(humanize(route.replace(/^\//, '').replace(/\//g, ' ')), 30);
  const base = readable || truncate(title, 30) || route;
  return `${prefix} / ${order} · ${base}`;
}
