/**
 * Spec « autonome » : les assets sont incorpores en base64.
 *
 * Interet : le plugin fonctionne alors sans serveur local. On depose un seul
 * fichier dans son interface et la synchronisation part. C'est le mode a
 * privilegier pour envoyer la maquette a un tiers, ou quand lancer un terminal
 * n'est pas souhaitable.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DesignSpec } from '@sfs/spec';
import type { Logger } from './logger.js';

/** Au-dela, Figma peine a charger le message et l'interface se fige. */
const MAX_BUNDLE_BYTES = 80 * 1024 * 1024;

export interface BundleResult {
  file: string;
  bytes: number;
  embedded: number;
  skipped: number;
}

export async function bundleSpec(outputDir: string, log: Logger): Promise<BundleResult> {
  const dir = path.resolve(outputDir);
  const spec = JSON.parse(
    await readFile(path.join(dir, 'design-spec.json'), 'utf8'),
  ) as DesignSpec;

  let embedded = 0;
  let skipped = 0;
  let budget = MAX_BUNDLE_BYTES;

  // Les assets les plus petits d'abord : a budget egal, on en incorpore le plus
  // grand nombre, donc on laisse le moins de trous dans la maquette.
  const ordered = [...spec.assets].sort((a, b) => a.bytes - b.bytes);
  const byId = new Map(spec.assets.map((asset) => [asset.id, asset]));

  for (const asset of ordered) {
    const cost = Math.ceil(asset.bytes * 1.37);
    if (cost > budget) {
      skipped++;
      continue;
    }
    const bytes = await readFile(path.join(dir, asset.file)).catch(() => null);
    if (!bytes) {
      skipped++;
      continue;
    }
    byId.get(asset.id)!.data = bytes.toString('base64');
    budget -= cost;
    embedded++;
  }

  const file = path.join(dir, 'design-spec.bundle.json');
  const payload = JSON.stringify(spec);
  await writeFile(file, payload, 'utf8');

  if (skipped > 0) {
    log.warn(
      `${skipped} assets non incorpores (limite de taille atteinte). Utilisez \`sfs serve\` pour une synchronisation complete.`,
    );
  }
  return { file, bytes: Buffer.byteLength(payload), embedded, skipped };
}
