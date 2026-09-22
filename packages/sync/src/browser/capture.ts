/**
 * Pilotage du navigateur : ouvrir une route a un breakpoint, stabiliser la page,
 * puis executer le collecteur.
 *
 * La stabilisation est la partie qui fait la difference. Un site moderne cache
 * la moitie de son contenu derriere des animations d'apparition au defilement :
 * capturer sans precaution donnerait une maquette a moitie vide.
 */

import type { Browser, BrowserContext, ConsoleMessage, Page } from 'playwright-core';
import type { BreakpointConfig } from '../config.js';
import { collectPage } from './collect.js';
import type { RawCapture } from './raw.js';

export interface CaptureOptions {
  breakpoint: BreakpointConfig;
  settleMs: number;
  maxNodes: number;
  devAnnotations: boolean;
  origin: string;
  /** Emuler `prefers-color-scheme: dark` pour relever le second mode. */
  colorScheme?: 'light' | 'dark';
  /** Attribut de theme a forcer sur `<html>`, ex. `data-theme="dark"`. */
  themeAttribute?: { name: string; value: string } | null;
}

/** Neutralise animations et transitions : on veut l'etat final, tout de suite. */
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`;

/**
 * Injecte avant tout script de la page : force le chargement immediat des images
 * differees et desactive le defilement anime, qui rendrait la mesure instable.
 */
const INIT_SCRIPT = `
  (() => {
    const eager = () => {
      for (const el of document.querySelectorAll('[loading="lazy"]')) {
        el.setAttribute('loading', 'eager');
      }
      for (const el of document.querySelectorAll('[data-src]')) {
        const src = el.getAttribute('data-src');
        if (src && !el.getAttribute('src')) el.setAttribute('src', src);
      }
    };
    document.addEventListener('DOMContentLoaded', eager, { once: true });
    new MutationObserver(eager).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  })();
`;

export async function createContext(
  browser: Browser,
  breakpoint: BreakpointConfig,
  colorScheme: 'light' | 'dark' = 'light',
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: breakpoint.width, height: breakpoint.height },
    deviceScaleFactor: breakpoint.deviceScaleFactor ?? 1,
    colorScheme,
    // `reduce` evite les etats intermediaires d'animation ; combine avec
    // FREEZE_CSS, la page se presente dans son etat de repos.
    reducedMotion: 'reduce',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    // Emule un vrai appareil tactile au breakpoint mobile : certains sites
    // servent une navigation differente selon `pointer: coarse`.
    hasTouch: breakpoint.width <= 640,
    isMobile: false,
    javaScriptEnabled: true,
  });
  await context.addInitScript(INIT_SCRIPT);
  return context;
}

export interface CaptureResult {
  capture: RawCapture;
  /** Erreurs console et requetes en echec : utiles pour diagnostiquer un ecart. */
  pageErrors: string[];
  failedRequests: string[];
}

export async function capturePage(
  context: BrowserContext,
  url: string,
  options: CaptureOptions,
): Promise<CaptureResult> {
  const page: Page = await context.newPage();
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'echec'}`);
  });

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (response && !response.ok() && response.status() !== 304) {
      throw new Error(`${url} a repondu ${response.status()} ${response.statusText()}`);
    }

    if (options.themeAttribute) {
      await page.evaluate(
        ([name, value]) => document.documentElement.setAttribute(name!, value!),
        [options.themeAttribute.name, options.themeAttribute.value] as const,
      );
    }

    await page.addStyleTag({ content: FREEZE_CSS });

    // Le reseau peut ne jamais devenir totalement inactif (sondes analytics,
    // websockets) : on attend, mais on n'en fait pas une condition d'echec.
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await page.evaluate(() => document.fonts.ready).catch(() => undefined);

    await revealAll(page);
    await page.waitForTimeout(options.settleMs);

    const capture = await page.evaluate(collectPage, {
      maxNodes: options.maxNodes,
      devAnnotations: options.devAnnotations,
      origin: options.origin,
    });

    return { capture, pageErrors: dedupe(pageErrors), failedRequests: dedupe(failedRequests) };
  } finally {
    await page.close();
  }
}

/**
 * Parcourt la page de haut en bas puis revient au sommet.
 *
 * Declenche les `IntersectionObserver` (apparitions au defilement) et le
 * chargement differe des images, puis remet la page dans son etat initial pour
 * que les elements `fixed`/`sticky` soient mesures a leur position de repos.
 */
async function revealAll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const step = Math.max(200, window.innerHeight * 0.75);
    const total = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
    );
    // Plafond a 200 pas : une page a defilement infini ne doit pas bloquer.
    const steps = Math.min(200, Math.ceil(total / step) + 1);
    for (let i = 0; i <= steps; i++) {
      window.scrollTo(0, i * step);
      await wait(16);
    }
    window.scrollTo(0, 0);
    await wait(50);
  });
  // Les images devenues visibles pendant le defilement doivent finir de charger.
  await page
    .evaluate(() =>
      Promise.all(
        Array.from(document.images)
          .filter((img) => !img.complete)
          .map(
            (img) =>
              new Promise<void>((resolve) => {
                img.addEventListener('load', () => resolve(), { once: true });
                img.addEventListener('error', () => resolve(), { once: true });
                setTimeout(resolve, 3000);
              }),
          ),
      ),
    )
    .catch(() => undefined);
}

/** Relever le meme message 400 fois n'aide personne. */
function dedupe(list: string[]): string[] {
  return Array.from(new Set(list)).slice(0, 20);
}

/**
 * Relit uniquement les variables CSS de `:root` dans un autre schema de
 * couleurs. Bien moins couteux qu'une seconde capture complete, et suffisant :
 * un site correctement fait n'exprime son theme sombre qu'a travers ses tokens.
 */
export async function captureThemeVariables(
  browser: Browser,
  url: string,
  breakpoint: BreakpointConfig,
  themeAttribute: { name: string; value: string } | null,
): Promise<Record<string, string>> {
  const context = await createContext(browser, breakpoint, 'dark');
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (themeAttribute) {
      await page.evaluate(
        ([name, value]) => document.documentElement.setAttribute(name!, value!),
        [themeAttribute.name, themeAttribute.value] as const,
      );
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    return await page.evaluate(() => {
      const out: Record<string, string> = {};
      const rootStyle = getComputedStyle(document.documentElement);
      const names = new Set<string>();
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        const scan = (list: CSSRuleList): void => {
          for (const rule of Array.from(list)) {
            if (rule instanceof CSSStyleRule) {
              for (const prop of Array.from(rule.style)) {
                if (prop.startsWith('--')) names.add(prop);
              }
            } else if ('cssRules' in rule) {
              scan((rule as unknown as CSSGroupingRule).cssRules);
            }
          }
        };
        scan(rules);
      }
      for (const name of names) {
        const value = rootStyle.getPropertyValue(name).trim();
        if (value) out[name] = value;
      }
      return out;
    });
  } finally {
    await page.close();
    await context.close();
  }
}
