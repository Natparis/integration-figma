/**
 * Configuration du logiciel (`sfs.config.json`).
 *
 * Toutes les options ont un defaut utilisable : en pratique seule `source.path`
 * et `figma.fileKey` sont necessaires pour demarrer.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface BreakpointConfig {
  name: string;
  width: number;
  /** Hauteur de fenetre. Le document complet est capture quoi qu'il arrive. */
  height: number;
  deviceScaleFactor?: number;
}

export interface SfsConfig {
  source: {
    /** Archive .zip, dossier, ou URL http(s). */
    path: string;
    /** Routes de depart du crawl. `[]` = uniquement la page d'accueil. */
    entries: string[];
    /** Motifs de routes a ignorer (sous-chaine ou expression reguliere /.../). */
    exclude: string[];
    maxPages: number;
    /** Attente supplementaire apres chargement, pour les animations d'entree. */
    settleMs: number;
  };
  breakpoints: BreakpointConfig[];
  figma: {
    /** Cle du fichier cible, lue dans son URL. */
    fileKey: string;
    /** Prefixe des pages Figma gerees : la synchro ne touche a rien d'autre. */
    pagePrefix: string;
    /** Page ou ranger les composants detectes. */
    componentsPage: string;
    /** Page de documentation (tokens, inventaire, notes de passation). */
    documentationPage: string;
  };
  tokens: {
    /** Lire les variables CSS de `:root` comme source de verite des tokens. */
    useCssVariables: boolean;
    /** Deduire des tokens par analyse quand le CSS n'en declare pas. */
    inferMissing: boolean;
    /** Capturer un second mode en emulant `prefers-color-scheme: dark`. */
    darkMode: boolean;
    /** Attribut bascule de theme a tester, ex. `data-theme`. */
    themeAttribute: string | null;
    collectionName: string;
  };
  components: {
    enabled: boolean;
    /** Nombre minimal d'occurrences pour promouvoir un motif en composant. */
    minOccurrences: number;
  };
  output: {
    /** Dossier de travail : spec, assets, revision precedente. */
    dir: string;
    /** Inclure les styles calcules dans le spec, pour les annotations Dev Mode. */
    devAnnotations: boolean;
    /** Ecrire le spec indente. Pratique pour le relire, 3,6x plus lourd. */
    pretty: boolean;
  };
  relay: {
    host: string;
    port: number;
  };
  sync: {
    /** Que faire d'un noeud Figma dont la contrepartie a disparu du site. */
    onRemoved: 'archive' | 'delete' | 'keep';
  };
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
}

export const DEFAULT_CONFIG: SfsConfig = {
  source: { path: '', entries: ['/'], exclude: [], maxPages: 40, settleMs: 400 },
  breakpoints: [
    { name: 'Desktop', width: 1440, height: 1024 },
    { name: 'Tablet', width: 834, height: 1112 },
    { name: 'Mobile', width: 390, height: 844 },
  ],
  figma: {
    fileKey: '',
    pagePrefix: 'Site',
    componentsPage: 'Composants',
    documentationPage: 'Documentation',
  },
  tokens: {
    useCssVariables: true,
    inferMissing: true,
    darkMode: true,
    themeAttribute: 'data-theme',
    collectionName: 'Design Tokens',
  },
  components: { enabled: true, minOccurrences: 3 },
  output: { dir: '.sfs', devAnnotations: true, pretty: false },
  relay: { host: '127.0.0.1', port: 7788 },
  sync: { onRemoved: 'archive' },
  logLevel: 'info',
};

/** Fusion profonde limitee aux objets simples du schema de configuration. */
function merge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override as T;
  if (typeof base !== 'object' || typeof override !== 'object') return override as T;
  const out = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    out[key] = merge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

export class ConfigError extends Error {}

export async function loadConfig(
  file: string | undefined,
  overrides: Partial<SfsConfig> = {},
): Promise<{ config: SfsConfig; file: string | null }> {
  let raw: unknown = {};
  let resolved: string | null = null;

  const candidate = file ?? 'sfs.config.json';
  try {
    const text = await readFile(path.resolve(candidate), 'utf8');
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`« ${candidate} » n'est pas du JSON valide : ${String(error)}`);
    }
    resolved = path.resolve(candidate);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    // Absence de fichier de configuration : acceptable si tout vient des options.
    if (file) throw new ConfigError(`Fichier de configuration introuvable : « ${file} ».`);
  }

  const config = merge(merge(DEFAULT_CONFIG, raw), overrides);
  validate(config);
  return { config, file: resolved };
}

function validate(config: SfsConfig): void {
  if (!config.source.path) {
    throw new ConfigError(
      'Aucune source. Renseignez `source.path` dans sfs.config.json, ou passez --source <zip|dossier|url>.',
    );
  }
  if (config.breakpoints.length === 0) {
    throw new ConfigError('Au moins un breakpoint est necessaire.');
  }
  const names = new Set<string>();
  for (const bp of config.breakpoints) {
    if (!bp.name) throw new ConfigError('Chaque breakpoint doit avoir un `name`.');
    if (names.has(bp.name)) {
      throw new ConfigError(`Breakpoint en doublon : « ${bp.name} ». Les noms doivent etre uniques.`);
    }
    names.add(bp.name);
    if (!Number.isFinite(bp.width) || bp.width < 200 || bp.width > 4000) {
      throw new ConfigError(`Largeur invalide pour « ${bp.name} » : ${bp.width} (attendu 200-4000).`);
    }
  }
  if (config.source.maxPages < 1) throw new ConfigError('`source.maxPages` doit valoir au moins 1.');
  if (config.components.minOccurrences < 2) {
    throw new ConfigError('`components.minOccurrences` doit valoir au moins 2.');
  }
}

/** Compile les motifs d'exclusion : `/regex/` ou simple sous-chaine. */
export function compileExcludes(patterns: string[]): (route: string) => boolean {
  const matchers = patterns.map((pattern) => {
    const re = /^\/(.*)\/([gimsuy]*)$/.exec(pattern);
    if (re) return (route: string) => new RegExp(re[1]!, re[2]).test(route);
    return (route: string) => route.includes(pattern);
  });
  return (route: string) => matchers.some((match) => match(route));
}
