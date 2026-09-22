/**
 * Fil principal du plugin : orchestre la synchronisation.
 *
 * Ordre impose par les dependances :
 *   1. polices     — Figma refuse d'ecrire du texte dans une police non chargee,
 *                    et un echec au milieu laisserait le document a moitie ecrit ;
 *   2. variables   — les peintures s'y lient ;
 *   3. styles      — ils referencent les variables ;
 *   4. images      — les remplissages les referencent ;
 *   5. composants  — les pages peuvent les instancier ;
 *   6. pages       — le gros du travail ;
 *   7. documentation — recapitule ce qui precede, avertissements compris.
 */

import { validateSpec } from '@sfs/spec';
import { REVISION_KEY, SOURCE_KEY } from './context.js';
import type { SyncOptions } from './context.js';
import { syncSpec } from './sync.js';

const DEFAULT_RELAY = 'http://127.0.0.1:7788';
const SETTINGS_KEY = 'sfs:settings';

interface UiSettings {
  relayUrl: string;
  onRemoved: SyncOptions['onRemoved'];
  skipUnchanged: boolean;
  createComponents: boolean;
  annotate: boolean;
}

const DEFAULT_SETTINGS: UiSettings = {
  relayUrl: DEFAULT_RELAY,
  onRemoved: 'archive',
  skipUnchanged: true,
  createComponents: true,
  // Desactive par defaut : sur un vrai site, les annotations visibles
  // recouvraient le canevas au point de le rendre illisible. Les donnees
  // restent attachees a chaque couche, annotation ou non.
  annotate: false,
};

figma.showUI(__html__, { width: 460, height: 620, themeColors: true });

void (async () => {
  const stored = await figma.clientStorage.getAsync(SETTINGS_KEY).catch(() => null);
  const settings: UiSettings = { ...DEFAULT_SETTINGS, ...(stored as UiSettings | null) };
  figma.ui.postMessage({
    type: 'ready',
    settings,
    document: {
      name: figma.root.name,
      revision: figma.root.getPluginData(REVISION_KEY) || null,
      source: figma.root.getPluginData(SOURCE_KEY) || null,
    },
  });
})();

figma.ui.onmessage = (message: unknown): void => {
  const payload = message as { type: string; [key: string]: unknown };
  if (payload.type === 'close') {
    figma.closePlugin();
    return;
  }
  if (payload.type === 'check') {
    void checkRelay(String(payload.relayUrl ?? DEFAULT_RELAY));
    return;
  }
  if (payload.type === 'sync') {
    void runSync(payload as unknown as SyncRequest);
    return;
  }
};

interface SyncRequest {
  type: 'sync';
  /** Adresse du relay, ou `null` si le spec est fourni directement. */
  relayUrl: string | null;
  /** Spec colle ou depose dans l'interface (mode autonome). */
  inlineSpec: string | null;
  settings: UiSettings;
  breakpoints: string[];
}

async function checkRelay(relayUrl: string): Promise<void> {
  try {
    const response = await fetch(`${relayUrl.replace(/\/$/, '')}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = (await response.json()) as {
      revision: string | null;
      pages: number;
      assets: number;
      generatedAt: string | null;
    };
    figma.ui.postMessage({ type: 'health', ok: true, health });
  } catch (error) {
    figma.ui.postMessage({
      type: 'health',
      ok: false,
      message: describeNetworkError(error, relayUrl),
    });
  }
}

/**
 * Traduit une erreur reseau en message actionnable.
 *
 * Un « Failed to fetch » brut n'aide personne : dans ce contexte, il signifie
 * presque toujours que le CLI n'est pas lance, ou que le port du manifeste ne
 * correspond pas.
 */
function describeNetworkError(error: unknown, relayUrl: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return [
      `Relay injoignable sur ${relayUrl}.`,
      '',
      '1. Le CLI tourne-t-il ?   npx sfs serve',
      "2. Le port correspond-il a celui declare dans manifest.json (networkAccess) ?",
      "3. Sinon, utilisez le mode autonome : npx sfs bundle, puis deposez le fichier ci-dessous.",
    ].join('\n');
  }
  return raw;
}

async function runSync(request: SyncRequest): Promise<void> {
  const started = Date.now();
  const settings = { ...DEFAULT_SETTINGS, ...request.settings };
  void figma.clientStorage.setAsync(SETTINGS_KEY, settings).catch(() => undefined);

  const report = (step: string, progress: number): void => {
    figma.ui.postMessage({ type: 'progress', step, progress });
  };

  try {
    report('Lecture du design-spec…', 0.02);

    let raw: unknown;
    if (request.inlineSpec) {
      raw = JSON.parse(request.inlineSpec);
    } else if (request.relayUrl) {
      const response = await fetch(`${request.relayUrl.replace(/\/$/, '')}/spec`);
      if (!response.ok) throw new Error(`Le relay a repondu ${response.status}.`);
      raw = await response.json();
    } else {
      throw new Error('Aucune source : indiquez un relay ou deposez un fichier de spec.');
    }

    // Valider AVANT d'ecrire quoi que ce soit : une synchronisation interrompue
    // au milieu laisserait le fichier de la cliente dans un etat incoherent.
    const { spec, warnings: validationWarnings, nodeCount } = validateSpec(raw);

    const options: SyncOptions = {
      onRemoved: settings.onRemoved,
      skipUnchanged: settings.skipUnchanged,
      createComponents: settings.createComponents,
      annotate: settings.annotate,
      breakpoints: request.breakpoints,
      relayUrl: request.relayUrl,
    };
    await syncSpec(
      spec,
      options,
      validationWarnings,
      nodeCount,
      report,
      started,
      (payload) => figma.ui.postMessage(payload),
      (payload) => postReport(request.relayUrl, payload),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    figma.ui.postMessage({ type: 'error', message });
    void postReport(request.relayUrl, { status: 'error', revision: '', message });
    figma.notify(`Synchronisation interrompue : ${message}`, { error: true, timeout: 6000 });
  }
}

/** Renvoie un compte-rendu au CLI, pour que le terminal affiche le resultat. */
async function postReport(relayUrl: string | null, payload: Record<string, unknown>): Promise<void> {
  if (!relayUrl) return;
  try {
    await fetch(`${relayUrl.replace(/\/$/, '')}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Le relay a pu s'arreter entre-temps : sans consequence sur la synchro.
  }
}
