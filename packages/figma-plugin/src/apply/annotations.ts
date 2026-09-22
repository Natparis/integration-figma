/**
 * Annotations Dev Mode.
 *
 * Ce que voit le developpeur en cliquant une couche : le selecteur CSS d'origine
 * et les proprietes calculees qui comptent. C'est le pont entre la maquette et le
 * code existant — sans lui, il doit deviner quelle couche correspond a quel
 * element.
 *
 * On n'annote que les couches structurantes : annoter des milliers de noeuds
 * ralentirait la synchronisation sans rien apporter.
 */

import type { SpecNode } from '@sfs/spec';
import type { SyncContext } from '../context.js';

export const CSS_KEY = 'sfs:css';
export const SELECTOR_KEY = 'sfs:selector';

/**
 * Balises dont l'annotation apporte vraiment quelque chose.
 *
 * Volontairement reduit aux REPERES de structure. Releve sur un vrai site : en
 * y ajoutant les liens, boutons et titres, une page de catalogue produisait des
 * centaines de bulles qui recouvraient entierement le canevas. Une annotation
 * utile est une annotation qu'on remarque ; mille annotations ne sont plus que
 * du bruit, et elles rendaient le fichier illisible.
 *
 * Les donnees complètes restent attachees a CHAQUE couche en `pluginData`
 * (`sfs:selector`, `sfs:css`) : rien n'est perdu, seule la surcharge visuelle
 * disparait.
 */
const WORTH_ANNOTATING = new Set([
  'header', 'nav', 'main', 'footer', 'aside', 'section', 'form', 'dialog', 'table',
]);

/** Plafond par page : au-dela, l'annotation devient contre-productive. */
export const MAX_ANNOTATIONS_PER_PAGE = 40;

export function shouldAnnotate(spec: SpecNode): boolean {
  const notes = spec.devNotes;
  if (!notes) return false;
  if (WORTH_ANNOTATING.has(notes.tag)) return true;
  // Un element porteur d'un `id` est une ancre du code : c'est le point
  // d'accroche le plus sur entre la maquette et le source.
  if (notes.selector.startsWith('#')) return true;
  return false;
}

export function annotate(node: SceneNode, spec: SpecNode, context: SyncContext): void {
  const notes = spec.devNotes;
  if (!notes) return;

  // Toujours stocker : meme sans Dev Mode, ces donnees restent lisibles par
  // l'outillage et par une future version du plugin.
  node.setPluginData(SELECTOR_KEY, notes.selector);
  node.setPluginData(CSS_KEY, JSON.stringify(notes.css));

  const retenu =
    context.options.annotate &&
    shouldAnnotate(spec) &&
    (context.annotationCount ?? 0) < MAX_ANNOTATIONS_PER_PAGE;

  if (!retenu) {
    // Effacer une annotation devenue superflue : sans cela, celles posees par
    // une version precedente resteraient a l'ecran pour toujours.
    clearAnnotations(node);
    return;
  }
  context.annotationCount = (context.annotationCount ?? 0) + 1;

  const lines: string[] = [`<${notes.tag}>  ${notes.selector}`];
  if (notes.href) lines.push(`href : ${notes.href}`);
  if (notes.alt) lines.push(`alt : ${notes.alt}`);
  if (notes.role) lines.push(`role : ${notes.role}`);
  if (notes.a11y?.length) lines.push(`Accessibilite : ${notes.a11y.join(' · ')}`);

  const css = Object.entries(notes.css)
    .filter(([property]) => KEY_PROPERTIES.has(property))
    .map(([property, value]) => `${property}: ${value}`);
  if (css.length > 0) lines.push(css.join('; '));

  try {
    if ('annotations' in node) {
      node.annotations = [{ label: lines.join('\n') }];
    }
  } catch {
    // Annotations indisponibles dans cette version de Figma : les donnees de
    // plugin restent enregistrees, rien n'est perdu.
  }
}

/** Retire les annotations d'un noeud qui n'en merite plus. */
function clearAnnotations(node: SceneNode): void {
  try {
    if ('annotations' in node && node.annotations.length > 0) node.annotations = [];
  } catch {
    // Annotations indisponibles dans cette version de Figma.
  }
}

/** Proprietes reellement utiles a la relecture ; le reste est du bruit. */
const KEY_PROPERTIES = new Set([
  'display', 'flex-direction', 'justify-content', 'align-items',
  'grid-template-columns', 'gap', 'max-width', 'padding', 'font-size',
  'font-weight', 'line-height', 'border-radius', 'aspect-ratio', 'object-fit',
]);
