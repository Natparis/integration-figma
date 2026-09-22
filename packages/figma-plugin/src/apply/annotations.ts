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

/** Balises dont l'annotation apporte vraiment quelque chose. */
const WORTH_ANNOTATING = new Set([
  'header', 'nav', 'main', 'footer', 'aside', 'section', 'article', 'form',
  'button', 'a', 'input', 'select', 'textarea', 'table', 'dialog', 'figure',
  'h1', 'h2', 'h3',
]);

export function shouldAnnotate(spec: SpecNode): boolean {
  const notes = spec.devNotes;
  if (!notes) return false;
  if (WORTH_ANNOTATING.has(notes.tag)) return true;
  // Un element porteur d'un `id` est une ancre du code : toujours utile.
  if (notes.selector.startsWith('#')) return true;
  if (notes.a11y && notes.a11y.length > 0) return true;
  return false;
}

export function annotate(node: SceneNode, spec: SpecNode, context: SyncContext): void {
  const notes = spec.devNotes;
  if (!notes) return;

  // Toujours stocker : meme sans Dev Mode, ces donnees restent lisibles par
  // l'outillage et par une future version du plugin.
  node.setPluginData(SELECTOR_KEY, notes.selector);
  node.setPluginData(CSS_KEY, JSON.stringify(notes.css));

  if (!context.options.annotate || !shouldAnnotate(spec)) return;

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

/** Proprietes reellement utiles a la relecture ; le reste est du bruit. */
const KEY_PROPERTIES = new Set([
  'display', 'flex-direction', 'justify-content', 'align-items',
  'grid-template-columns', 'gap', 'max-width', 'padding', 'font-size',
  'font-weight', 'line-height', 'border-radius', 'aspect-ratio', 'object-fit',
]);
