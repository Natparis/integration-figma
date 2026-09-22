/**
 * Decouverte des routes a extraire.
 *
 * Deux sources complementaires : le systeme de fichiers quand la source est
 * locale (exhaustif et instantane), et les liens rencontres pendant la visite
 * (seule option pour un site distant).
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { normalizeRoute } from '@sfs/spec';

/** Liste les routes d'un export statique en parcourant les fichiers HTML. */
export async function discoverRoutesFromDisk(root: string): Promise<string[]> {
  const routes = new Set<string>();

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full, `${prefix}${item.name}/`);
        continue;
      }
      if (!/\.html?$/i.test(item.name)) continue;
      // Les pages d'erreur et les fragments ne sont pas des pages du site.
      if (/^(404|500|offline|fragment|partial)\b/i.test(item.name)) continue;
      const route =
        /^index\.html?$/i.test(item.name) ? `/${prefix}` : `/${prefix}${item.name}`;
      routes.add(normalizeRoute(route));
    }
  };
  await walk(root, '');

  // La page d'accueil en premier, puis ordre alphabetique : ordre naturel des
  // pages dans le panneau Figma.
  return [...routes].sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
}

export interface QueueOptions {
  maxPages: number;
  isExcluded(route: string): boolean;
}

/**
 * File de parcours en largeur, dedupliquee sur la route normalisee.
 *
 * Le parcours en largeur garantit que, si `maxPages` coupe, on aura les pages les
 * plus proches de l'accueil — celles qui comptent.
 */
export class RouteQueue {
  private readonly pending: string[] = [];
  private readonly seen = new Set<string>();
  private readonly skipped = new Set<string>();

  constructor(private readonly options: QueueOptions) {}

  add(route: string): boolean {
    const normalized = normalizeRoute(route);
    if (this.seen.has(normalized)) return false;
    if (this.options.isExcluded(normalized)) {
      this.skipped.add(normalized);
      return false;
    }
    // Un fichier telechargeable n'est pas une page a maquetter.
    if (/\.(pdf|zip|docx?|xlsx?|pptx?|csv|jpe?g|png|gif|svg|webp|mp4|webm|mp3|xml|json|txt|ics)$/i.test(normalized)) {
      return false;
    }
    this.seen.add(normalized);
    this.pending.push(normalized);
    return true;
  }

  next(): string | undefined {
    if (this.visitedCount >= this.options.maxPages) return undefined;
    return this.pending.shift();
  }

  private visited = 0;

  markVisited(): void {
    this.visited++;
  }

  get visitedCount(): number {
    return this.visited;
  }

  get remaining(): number {
    return this.pending.length;
  }

  get skippedRoutes(): string[] {
    return [...this.skipped];
  }

  /** Routes decouvertes mais non visitees faute de quota. */
  get overflow(): string[] {
    return [...this.pending];
  }
}
