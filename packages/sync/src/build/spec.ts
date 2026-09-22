/**
 * Orchestration de l'extraction : de la source au `design-spec` complet.
 *
 * Ordre impose par les dependances :
 *   1. visiter toutes les pages a tous les breakpoints (capture brute) ;
 *   2. analyser l'ensemble (couleurs, polices, espacements) — il faut TOUT le
 *      site pour deduire un systeme coherent, pas page par page ;
 *   3. telecharger les assets — les identifiants doivent exister avant l'etape 4 ;
 *   4. construire les arbres `SpecNode` en liant tokens et assets ;
 *   5. detecter les composants sur l'arbre construit.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import type {
  BreakpointSpec, DesignSpec, Diagnostic, PageSpec, SpecNode,
} from '@sfs/spec';
import { hashValue, makeRootSid, normalizeRoute } from '@sfs/spec';
import type { SfsConfig } from '../config.js';
import { compileExcludes } from '../config.js';
import { launchBrowser } from '../browser/launch.js';
import { captureThemeVariables, capturePage, createContext } from '../browser/capture.js';
import type { RawCapture } from '../browser/raw.js';
import { resolveSource } from '../source/resolve.js';
import type { ResolvedSource } from '../source/resolve.js';
import { RouteQueue, discoverRoutesFromDisk } from '../source/crawl.js';
import { AssetCollector } from './assets.js';
import { analyzeCaptures, buildTokens } from './tokens.js';
import { detectComponents } from './components.js';
import { buildNode, finalizeHashes } from './tree.js';
import { pageName } from './naming.js';
import type { Logger } from '../logger.js';

export const EXTRACTOR_VERSION = '0.1.0';

/** Plafond de noeuds par page : garde-fou contre une page pathologique. */
const MAX_NODES_PER_PAGE = 6000;

export interface ExtractResult {
  spec: DesignSpec;
  /** Dossier contenant `design-spec.json` et le sous-dossier `assets/`. */
  outputDir: string;
}

interface CapturedPage {
  route: string;
  title: string;
  captures: Map<string, RawCapture>;
}

export async function extract(config: SfsConfig, log: Logger): Promise<ExtractResult> {
  const diagnostics: Diagnostic[] = [];
  const outputDir = path.resolve(config.output.dir);
  await mkdir(outputDir, { recursive: true });

  log.step(`Source : ${config.source.path}`);
  const source = await resolveSource({ path: config.source.path });
  let browser: Browser | null = null;

  try {
    log.info(`Origine servie : ${source.origin}`);
    browser = await launchBrowser();

    /* ------------------- 1. visite et capture des pages ------------------- */

    const isExcluded = compileExcludes(config.source.exclude);
    const queue = new RouteQueue({ maxPages: config.source.maxPages, isExcluded });

    const seeds = config.source.entries.length > 0 ? config.source.entries : ['/'];
    if (source.localRoot) {
      // Source locale : le systeme de fichiers donne la liste exhaustive, plus
      // fiable que le parcours des liens.
      const discovered = await discoverRoutesFromDisk(source.localRoot);
      log.info(`${discovered.length} pages trouvees dans l export.`);
      for (const route of discovered) queue.add(route);
    }
    for (const seed of seeds) queue.add(seed);

    const pages: CapturedPage[] = [];
    const allCaptures: RawCapture[] = [];
    const primaryBreakpoint = config.breakpoints[0]!;

    // Un contexte de navigateur par breakpoint, reutilise pour toutes les pages :
    // recreer un contexte a chaque page couterait plusieurs secondes par page.
    const contexts = new Map<string, Awaited<ReturnType<typeof createContext>>>();
    for (const breakpoint of config.breakpoints) {
      contexts.set(breakpoint.name, await createContext(browser, breakpoint, 'light'));
    }

    let route = queue.next();
    while (route !== undefined) {
      const url = source.origin + (route === '/' ? '/' : route);
      const captures = new Map<string, RawCapture>();
      let title = route;
      let failed = false;

      for (const breakpoint of config.breakpoints) {
        const context = contexts.get(breakpoint.name)!;
        try {
          const result = await capturePage(context, url, {
            breakpoint,
            settleMs: config.source.settleMs,
            maxNodes: MAX_NODES_PER_PAGE,
            devAnnotations: config.output.devAnnotations,
            origin: source.origin,
          });
          result.capture.breakpointName = breakpoint.name;
          captures.set(breakpoint.name, result.capture);
          allCaptures.push(result.capture);
          title = result.capture.title || title;

          if (breakpoint.name === primaryBreakpoint.name) {
            for (const link of result.capture.links) queue.add(link);
          }
          for (const warning of result.capture.warnings) {
            diagnostics.push({
              level: 'info',
              code: 'capture-warning',
              message: warning,
              where: `${route} / ${breakpoint.name}`,
            });
          }
          if (result.capture.stats.truncated) {
            diagnostics.push({
              level: 'warn',
              code: 'page-truncated',
              message: `Page tronquee a ${MAX_NODES_PER_PAGE} noeuds.`,
              where: `${route} / ${breakpoint.name}`,
              hint: 'La page est exceptionnellement dense ; le bas de page peut manquer.',
            });
          }
          for (const error of result.pageErrors.slice(0, 3)) {
            diagnostics.push({
              level: 'info',
              code: 'page-script-error',
              message: `Erreur JavaScript pendant la visite : ${error}`,
              where: `${route} / ${breakpoint.name}`,
              hint: 'Peut expliquer un contenu manquant dans la maquette.',
            });
          }
          for (const request of result.failedRequests.slice(0, 5)) {
            diagnostics.push({
              level: 'warn',
              code: 'request-failed',
              message: `Ressource non chargee : ${request}`,
              where: `${route} / ${breakpoint.name}`,
            });
          }
        } catch (error) {
          failed = true;
          diagnostics.push({
            level: 'error',
            code: 'capture-failed',
            message: `Capture impossible : ${error instanceof Error ? error.message : String(error)}`,
            where: `${route} / ${breakpoint.name}`,
          });
        }
      }

      queue.markVisited();
      if (captures.size > 0) {
        pages.push({ route: normalizeRoute(route), title, captures });
        log.info(
          `${failed ? '~' : '✓'} ${route} — ${[...captures.values()].map((c) => `${c.stats.emitted} noeuds`).join(', ')}`,
        );
      } else {
        log.warn(`${route} — aucune capture exploitable, page ignoree.`);
      }
      route = queue.next();
    }

    if (pages.length === 0) {
      throw new Error(
        `Aucune page n a pu etre extraite depuis ${source.describe}. Verifiez que la source contient bien un site (index.html) et qu elle est accessible.`,
      );
    }
    if (queue.overflow.length > 0) {
      diagnostics.push({
        level: 'warn',
        code: 'crawl-limit',
        message: `${queue.overflow.length} pages decouvertes mais non extraites (limite source.maxPages = ${config.source.maxPages}).`,
        hint: `Non extraites : ${queue.overflow.slice(0, 10).join(', ')}${queue.overflow.length > 10 ? '…' : ''}`,
      });
    }

    /* ---------------------- 2. analyse globale du site -------------------- */

    log.step('Analyse du systeme de design…');
    const analysis = analyzeCaptures(allCaptures);

    const lightVariables = mergeVariables(allCaptures, 'rootVariables');
    const declaredVariables = mergeVariables(allCaptures, 'rootVariablesDeclared');
    let darkVariables: Record<string, string> | null = null;
    if (config.tokens.darkMode) {
      const homeRoute = pages[0]!.route;
      const homeUrl = source.origin + (homeRoute === '/' ? '/' : homeRoute);
      try {
        darkVariables = await captureThemeVariables(
          browser,
          homeUrl,
          primaryBreakpoint,
          config.tokens.themeAttribute
            ? { name: config.tokens.themeAttribute, value: 'dark' }
            : null,
        );
      } catch (error) {
        diagnostics.push({
          level: 'info',
          code: 'dark-mode-unavailable',
          message: `Mode sombre non releve : ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const tokens = buildTokens(
      analysis,
      {
        collectionName: config.tokens.collectionName,
        useCssVariables: config.tokens.useCssVariables,
        inferMissing: config.tokens.inferMissing,
        lightVariables,
        darkVariables,
        declaredVariables,
        primaryBreakpoint: primaryBreakpoint.name,
      },
      diagnostics,
    );
    log.info(
      `${tokens.collections[0]?.variables.length ?? 0} variables, ${tokens.textStyles.length} styles de texte, ${tokens.effectStyles.length} styles d effet.`,
    );

    /* ------------------------- 3. assets -------------------------------- */

    log.step('Recuperation des images et des icones…');
    const assets = new AssetCollector(outputDir, diagnostics, source.origin);
    for (const capture of allCaptures) assets.scan(capture);
    const requestContext = contexts.get(primaryBreakpoint.name)!.request;
    await assets.materialize(requestContext);
    log.info(
      `${assets.list().length} assets prets${assets.failureCount > 0 ? ` (${assets.failureCount} en echec)` : ''}.`,
    );

    /* --------------------- 4. construction des arbres -------------------- */

    log.step('Construction de l arbre Figma…');
    const substitutedFonts = new Set<string>();
    const specPages: PageSpec[] = [];

    pages.forEach((page, index) => {
      const breakpoints: BreakpointSpec[] = [];
      for (const breakpoint of config.breakpoints) {
        const capture = page.captures.get(breakpoint.name);
        if (!capture) continue;

        const body = buildNode({
          node: capture.root,
          path: [{ tag: 'body', index: 1 }],
          parentLayout: null,
          context: {
            route: page.route,
            breakpoint: breakpoint.name,
            assets: assets.resolver(),
            tokens: tokens.collections.length > 0 ? tokens.binder : null,
            devAnnotations: config.output.devAnnotations,
            diagnostics,
            substitutedFonts,
          },
        });

        // Frame racine : la fenetre du navigateur. Le `body` y est place en
        // enfant, ce qui reproduit exactement la mise en page du site.
        const root = wrapInPageFrame(body, page, breakpoint.name, capture);
        breakpoints.push({
          name: breakpoint.name,
          width: breakpoint.width,
          height: Math.round(capture.documentHeight),
          root,
        });
      }
      if (breakpoints.length === 0) return;
      specPages.push({
        name: pageName(index, page.route, page.title, config.figma.pagePrefix),
        route: page.route,
        title: page.title,
        breakpoints,
      });
    });

    /* ----------------------- 5. composants ------------------------------- */

    const primaryRoots = specPages
      .map((page) => page.breakpoints.find((bp) => bp.name === primaryBreakpoint.name)?.root)
      .filter((root): root is SpecNode => root !== undefined);
    const components = detectComponents(
      primaryRoots,
      {
        enabled: config.components.enabled,
        minOccurrences: config.components.minOccurrences,
        section: config.figma.componentsPage,
      },
      diagnostics,
    );

    /* ------------------------ 6. assemblage final ------------------------ */

    const stats = countStats(specPages);
    const spec: DesignSpec = {
      specVersion: 1,
      revision: '',
      generatedAt: new Date().toISOString(),
      source: {
        kind: source.kind,
        root: source.describe,
        extractedAt: new Date().toISOString(),
        contentHash: source.contentHash || hashValue(allCaptures.map((c) => c.stats.emitted)),
        extractorVersion: EXTRACTOR_VERSION,
      },
      tokens: tokens.collections,
      paintStyles: tokens.paintStyles,
      textStyles: tokens.textStyles,
      effectStyles: tokens.effectStyles,
      components: components.components,
      pages: specPages,
      assets: assets.list(),
      diagnostics,
      stats: {
        ...stats,
        assets: assets.list().length,
        variables: tokens.collections[0]?.variables.length ?? 0,
        components: components.components.length,
      },
    };
    if (config.figma.fileKey) {
      spec.target = { fileKey: config.figma.fileKey, pagePrefix: config.figma.pagePrefix };
    }

    // La revision est le hash de tout ce qui influe sur le rendu Figma. Les
    // diagnostics et l'horodatage en sont exclus : ils changent a chaque
    // execution et declencheraient une synchro inutile.
    spec.revision = hashValue({
      tokens: spec.tokens,
      paintStyles: spec.paintStyles,
      textStyles: spec.textStyles,
      effectStyles: spec.effectStyles,
      components: spec.components.map((c) => ({ key: c.key, hash: c.node.subtreeHash })),
      pages: spec.pages.map((page) => ({
        name: page.name,
        route: page.route,
        breakpoints: page.breakpoints.map((bp) => ({ name: bp.name, hash: bp.root.subtreeHash })),
      })),
      assets: spec.assets.map((asset) => [asset.id, asset.hash]),
    });

    const specFile = path.join(outputDir, 'design-spec.json');
    // JSON compact : l'indentation multiplie le fichier par 3,6 sans rien
    // apporter, et c'est le plugin qui le telecharge puis l'analyse. `--pretty`
    // reste disponible pour l'inspecter a la main.
    const payload = config.output.pretty
      ? JSON.stringify(spec, null, 2)
      : JSON.stringify(spec);
    await writeFile(specFile, payload, 'utf8');

    const megabytes = Buffer.byteLength(payload) / 1048576;
    if (megabytes > 40) {
      diagnostics.push({
        level: 'warn',
        code: 'spec-large',
        message: `Le design-spec pese ${megabytes.toFixed(0)} Mo : le plugin peut mettre longtemps a le charger.`,
        hint: 'Reduisez `source.maxPages`, retirez un breakpoint, ou passez `output.devAnnotations` a false.',
      });
    }

    for (const context of contexts.values()) await context.close();

    log.success(
      `Revision ${spec.revision} — ${stats.pages} pages, ${stats.breakpoints} frames, ${stats.nodes} noeuds.`,
    );
    return { spec, outputDir };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await source.dispose().catch(() => undefined);
  }
}

/**
 * Enveloppe le `body` dans une frame de page a la largeur du breakpoint.
 *
 * Sans cette enveloppe, une page dont le body est plus etroit que la fenetre
 * (contenu centre) produirait une frame Figma de la largeur du contenu, et non de
 * l'ecran : la maquette ne montrerait plus le cadrage reel.
 */
function wrapInPageFrame(
  body: SpecNode,
  page: { route: string; title: string },
  breakpointName: string,
  capture: RawCapture,
): SpecNode {
  const width = capture.viewport.width;
  const height = Math.max(capture.documentHeight, capture.viewport.height);

  const root: SpecNode = {
    sid: makeRootSid(page.route, breakpointName),
    name: `${breakpointName} · ${width}px`,
    kind: 'FRAME',
    box: { x: 0, y: 0, w: width, h: height },
    layout: {
      mode: 'VERTICAL',
      wrap: false,
      padding: [0, 0, 0, 0],
      itemSpacing: 0,
      counterAxisSpacing: 0,
      primaryAxisAlignItems: 'MIN',
      counterAxisAlignItems: 'MIN',
      sizing: { horizontal: 'FIXED', vertical: 'FIXED' },
      clipsContent: true,
      positioning: 'AUTO',
    },
    style: {
      fills: body.style.fills.length > 0
        ? body.style.fills
        : [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }],
      strokes: [],
      strokeWeight: 0,
      strokeAlign: 'INSIDE',
      cornerRadius: [0, 0, 0, 0],
      effects: [],
      opacity: 1,
      visible: true,
    },
    children: [{ ...body, layout: { ...body.layout, sizing: { horizontal: 'FILL', vertical: 'HUG' } } }],
    hash: '',
    subtreeHash: '',
  };
  return finalizeHashes(root);
}

/** Union des variables `:root` de toutes les pages visitees. */
function mergeVariables(
  captures: RawCapture[],
  field: 'rootVariables' | 'rootVariablesDeclared',
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const capture of captures) {
    for (const [name, value] of Object.entries(capture[field] ?? {})) {
      // La premiere valeur rencontree fait foi : la page d'accueil est visitee
      // en premier et porte le theme de reference.
      if (!(name in out)) out[name] = value;
    }
  }
  return out;
}

function countStats(pages: PageSpec[]): {
  pages: number;
  breakpoints: number;
  nodes: number;
  textNodes: number;
} {
  let breakpoints = 0;
  let nodes = 0;
  let textNodes = 0;
  const walk = (node: SpecNode): void => {
    nodes++;
    if (node.kind === 'TEXT') textNodes++;
    node.children.forEach(walk);
  };
  for (const page of pages) {
    for (const bp of page.breakpoints) {
      breakpoints++;
      walk(bp.root);
    }
  }
  return { pages: pages.length, breakpoints, nodes, textNodes };
}

/** Relit le spec de la synchronisation precedente, pour le diff. */
export async function readPreviousSpec(outputDir: string): Promise<DesignSpec | null> {
  const { readFile } = await import('node:fs/promises');
  try {
    const text = await readFile(path.join(path.resolve(outputDir), 'design-spec.json'), 'utf8');
    return JSON.parse(text) as DesignSpec;
  } catch {
    return null;
  }
}

export { normalizeRoute };
