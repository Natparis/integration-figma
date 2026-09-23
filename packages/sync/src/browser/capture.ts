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
  /** Prendre une capture pleine page, pour le rapport de comparaison. */
  screenshot?: boolean;
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
  /** Capture pleine page, si elle a ete demandee. */
  screenshot?: Buffer;
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
    await prepareVideos(page);
    await page.waitForTimeout(options.settleMs);
    await attendreImmobilite(page);
    await neutraliserRevelations(page);

    const capture = await page.evaluate(collectPage, {
      maxNodes: options.maxNodes,
      devAnnotations: options.devAnnotations,
      origin: options.origin,
    });

    const resultat: CaptureResult = {
      capture,
      pageErrors: dedupe(pageErrors),
      failedRequests: dedupe(failedRequests),
    };

    if (options.screenshot) {
      try {
        // JPEG plutot que PNG : une page de plusieurs milliers de pixels de haut
        // et riche en photos pese dix fois moins en JPEG, pour un usage de
        // comparaison ou la compression ne gene pas.
        resultat.screenshot = await page.screenshot({
          fullPage: true,
          type: 'jpeg',
          quality: 78,
          timeout: 30000,
        });
      } catch {
        // Une page tres haute peut depasser les limites du navigateur : la
        // comparaison se fera sans, plutot que d'echouer l'extraction.
      }
    }

    return resultat;
  } finally {
    await page.close();
  }
}

/**
 * Repose les elements restes en position d'apparition.
 *
 * Une apparition au defilement part d'un decalage (`translateX(-60px)`) que la
 * bibliotheque retire quand l'element entre dans le champ. Si l'observateur ne
 * s'est jamais declenche — element dans un conteneur a defilement horizontal,
 * seuil jamais atteint — le decalage reste. `getBoundingClientRect` rend alors
 * une position fausse : le bloc commence avant le bord gauche et son premier mot
 * est ampute dans la maquette.
 *
 * On ne retire que ce qui ne peut pas etre une mise en page :
 *
 *   · une transformation ECRITE EN LIGNE — le CSS d'auteur est laisse intact ;
 *   · une TRANSLATION PURE — ni rotation, ni echelle, ni inclinaison ;
 *   · sur un element DANS LE FLUX — le centrage par `translate(-50%, -50%)`
 *     exige `position: absolute` ou `fixed`, et reste donc intouche.
 *
 * Le releve de lecture continue de signaler ce qui subsiste apres ce menage.
 */
async function neutraliserRevelations(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      let reposes = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const enLigne = el.style.transform;
        if (!enLigne || enLigne === 'none') continue;
        const cs = getComputedStyle(el);
        if (cs.position === 'absolute' || cs.position === 'fixed') continue;
        const m = cs.transform;
        if (!m || m === 'none') continue;
        const n = m.slice(m.indexOf('(') + 1, -1).split(',').map((v) => parseFloat(v));
        const traduction3d = n.length >= 16;
        // Une translation pure laisse la partie lineaire a l'identite.
        const lineaire = traduction3d
          ? [n[0], n[1], n[4], n[5]]
          : [n[0], n[1], n[2], n[3]];
        const identite =
          Math.abs((lineaire[0] ?? 0) - 1) < 1e-6 &&
          Math.abs(lineaire[1] ?? 0) < 1e-6 &&
          Math.abs(lineaire[2] ?? 0) < 1e-6 &&
          Math.abs((lineaire[3] ?? 0) - 1) < 1e-6;
        if (!identite) continue;
        const [dx, dy] = traduction3d ? [n[12], n[13]] : [n[4], n[5]];
        if (Math.abs(dx ?? 0) < 2 && Math.abs(dy ?? 0) < 2) continue;
        el.style.transform = 'none';
        // L'apparition masque aussi par l'opacite : sans cela l'element reste
        // invisible et serait ecarte a la lecture.
        if (el.style.opacity && parseFloat(el.style.opacity) < 1) el.style.opacity = '1';
        reposes++;
      }
      return reposes;
    })
    .catch(() => undefined);
}

/**
 * Attend que la page cesse de bouger.
 *
 * Le gel CSS ne peut rien contre une bibliotheque d'animation qui ecrit des
 * transformations en JavaScript image par image : au moment de la mesure,
 * l'element peut encore etre en train de glisser vers sa place. On obtient alors
 * une maquette decalee — un bloc entier commence avant le bord gauche et son
 * premier mot est coupe.
 *
 * Plutot que de deviner une duree, on observe : quand deux releves consecutifs
 * des memes boites sont identiques, la page est posee. Un plafond garantit qu'une
 * animation perpetuelle (carrousel, bandeau defilant) ne bloque pas l'extraction.
 */
async function attendreImmobilite(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      // Un echantillon suffit : une animation d'apparition deplace des blocs
      // entiers, jamais un seul element isole au milieu de la page.
      const tous = Array.from(document.querySelectorAll<HTMLElement>('body *'));
      const pas = Math.max(1, Math.ceil(tous.length / 300));
      const echantillon = tous.filter((_, i) => i % pas === 0);
      const releve = (): string =>
        echantillon
          .map((el) => {
            const r = el.getBoundingClientRect();
            return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
          })
          .join('|');

      let precedent = releve();
      // 20 x 120 ms = 2,4 s au maximum, deux releves identiques suffisent.
      for (let i = 0; i < 20; i++) {
        await wait(120);
        const courant = releve();
        if (courant === precedent) return;
        precedent = courant;
      }
    })
    .catch(() => undefined);
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

/**
 * Amene chaque video a l'etat ou une image peut en etre extraite.
 *
 * Sans cela, `readyState` vaut souvent 0 au moment de la mesure : le navigateur
 * n'a pas encore decode la premiere image, et le collecteur ne trouve rien a
 * peindre. On declenche donc la lecture en sourdine et on attend les donnees.
 */
async function prepareVideos(page: Page): Promise<void> {
  await page
    .evaluate(
      () =>
        Promise.all(
          Array.from(document.querySelectorAll('video')).map(
            (video) =>
              new Promise<void>((resolve) => {
                if (video.readyState >= 2) {
                  resolve();
                  return;
                }
                video.addEventListener('loadeddata', () => resolve(), { once: true });
                video.addEventListener('error', () => resolve(), { once: true });
                try {
                  // En sourdine : seule condition pour que les navigateurs
                  // autorisent une lecture non demandee par l'utilisateur.
                  video.muted = true;
                  video.preload = 'auto';
                  void video.play().catch(() => undefined);
                } catch {
                  /* lecture refusee : on s'en remettra a l'image d'affiche */
                }
                // Une video qui ne charge pas ne doit pas bloquer l'extraction.
                setTimeout(resolve, 6000);
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
