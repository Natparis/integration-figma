/**
 * Etat partage de la synchronisation.
 *
 * Regroupe ce que toutes les etapes doivent connaitre : le spec en cours, les
 * correspondances vers les objets Figma deja crees, et le compteur d'operations
 * qui alimente le compte-rendu.
 */

import type { DesignSpec, SpecNode } from '@sfs/spec';

/** Cle des donnees de plugin portees par chaque noeud synchronise. */
export const SID_KEY = 'sfs:sid';
export const HASH_KEY = 'sfs:subtreeHash';
export const REVISION_KEY = 'sfs:revision';
export const SOURCE_KEY = 'sfs:source';

export interface SyncOptions {
  /** Que faire d'un noeud dont la contrepartie a disparu du site. */
  onRemoved: 'archive' | 'delete' | 'keep';
  /** Sauter les sous-arbres dont l'empreinte n'a pas change. */
  skipUnchanged: boolean;
  /** Publier l'inventaire des composants. */
  createComponents: boolean;
  /** Ecrire les annotations Dev Mode sur les noeuds structurants. */
  annotate: boolean;
  /** Breakpoints a synchroniser ; vide = tous. */
  breakpoints: string[];
  /** Base du relay, pour telecharger les assets. */
  relayUrl: string | null;
}

export interface SyncStats {
  created: number;
  updated: number;
  skipped: number;
  removed: number;
  fontsLoaded: number;
  variablesWritten: number;
  stylesWritten: number;
  componentsWritten: number;
  assetsLoaded: number;
}

export interface SyncContext {
  spec: DesignSpec;
  options: SyncOptions;
  stats: SyncStats;
  warnings: string[];
  /** Polices substituees : nom demande -> nom reellement charge. */
  fontFallbacks: Map<string, FontName>;
  /** Variables Figma par nom du spec. */
  variables: Map<string, Variable>;
  /** Styles par nom du spec. */
  paintStyles: Map<string, PaintStyle>;
  textStyles: Map<string, TextStyle>;
  effectStyles: Map<string, EffectStyle>;
  /** Images deja importees, par identifiant d'asset. */
  images: Map<string, Image>;
  /** Composants publies, par cle du spec. */
  components: Map<string, ComponentNode | ComponentSetNode>;
  /** Progression, remontee a l'interface. */
  report(step: string, progress: number): void;
}

export function emptyStats(): SyncStats {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    removed: 0,
    fontsLoaded: 0,
    variablesWritten: 0,
    stylesWritten: 0,
    componentsWritten: 0,
    assetsLoaded: 0,
  };
}

/** Parcourt un arbre de spec. */
export function walkSpec(node: SpecNode, visit: (node: SpecNode) => void): void {
  visit(node);
  for (const child of node.children) walkSpec(child, visit);
}

/** Limite un texte pour les messages d'interface. */
export function short(input: string, max = 60): string {
  return input.length > max ? input.slice(0, max - 1) + '…' : input;
}
