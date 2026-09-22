/**
 * Logique de synchronisation, isolee du fil de messages de l'interface.
 *
 * Separee de `code.ts` pour une raison precise : `code.ts` appelle `showUI` des
 * son chargement, ce qui la rendrait intestable. Ici, tout passe par des
 * parametres, donc un faux moteur Figma suffit a exercer le vrai code.
 */

import type { DesignSpec } from '@sfs/spec';
import { REVISION_KEY, SOURCE_KEY, emptyStats } from './context.js';
import type { SyncContext, SyncOptions, SyncStats } from './context.js';
import { loadAllFonts } from './apply/fonts.js';
import { applyVariables } from './apply/variables.js';
import { applyStyles } from './apply/styles.js';
import { loadImages } from './apply/assets.js';
import { syncComponents } from './apply/components.js';
import { syncPage } from './apply/pages.js';
import { writeDocumentation } from './apply/documentation.js';

export interface SyncOutcome {
  revision: string;
  stats: SyncStats;
  warnings: string[];
  durationMs: number;
}

export type ProgressReporter = (step: string, progress: number) => void;

export async function syncSpec(
  spec: DesignSpec,
  options: SyncOptions,
  validationWarnings: string[],
  nodeCount: number,
  report: ProgressReporter,
  started: number,
  onProgressMessage: (message: Record<string, unknown>) => void = () => {},
  postReport: (payload: Record<string, unknown>) => Promise<void> = async () => {},
): Promise<SyncOutcome> {
  const context: SyncContext = {
    spec,
    options,
    stats: emptyStats(),
    warnings: [...validationWarnings.slice(0, 20)],
    fontFallbacks: new Map(),
    variables: new Map(),
    paintStyles: new Map(),
    textStyles: new Map(),
    effectStyles: new Map(),
    images: new Map(),
    components: new Map(),
    report,
  };

  await postReport({ status: 'started', revision: spec.revision });

  // En mode « dynamic-page », le contenu des pages n'est pas charge d'office.
  // La reconciliation doit pouvoir lire les pages existantes.
  report('Chargement du document…', 0.05);
  await figma.loadAllPagesAsync();

  report('Polices…', 0.1);
  await loadAllFonts(spec, context);

  report('Variables (design tokens)…', 0.18);
  await applyVariables(spec.tokens, context);

  report('Styles partages…', 0.25);
  await applyStyles(spec, context);

  report('Images…', 0.3);
  await loadImages(spec, context);

  if (options.createComponents) {
    report('Composants…', 0.45);
    await syncComponents(spec, 'Composants', context);
  }

  const pages = spec.pages;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    report(`Page ${i + 1}/${pages.length} — ${page.name}`, 0.5 + (0.45 * i) / pages.length);
    await syncPage(page, spec, context);
  }

  report('Note de passation…', 0.96);
  await writeDocumentation(spec, 'Documentation', context);

  figma.root.setPluginData(REVISION_KEY, spec.revision);
  figma.root.setPluginData(SOURCE_KEY, spec.source.root);

  const durationMs = Date.now() - started;
  const summary = {
    created: context.stats.created,
    updated: context.stats.updated,
    removed: context.stats.removed,
    skipped: context.stats.skipped,
    durationMs,
  };

  onProgressMessage({
    type: 'done',
    revision: spec.revision,
    stats: context.stats,
    warnings: context.warnings,
    nodeCount,
    durationMs,
  });

  await postReport({
    status: 'done',
    revision: spec.revision,
    ...summary,
    warnings: context.warnings,
  });

  figma.notify(
    `Synchronise : ${summary.created} crees, ${summary.updated} mis a jour, ${summary.skipped} inchanges` +
      (summary.removed ? `, ${summary.removed} retires` : '') +
      ` en ${(durationMs / 1000).toFixed(1)} s.`,
    { timeout: 5000 },
  );

  return {
    revision: spec.revision,
    stats: context.stats,
    warnings: context.warnings,
    durationMs,
  };
}

