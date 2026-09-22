/**
 * Lancement de Chromium.
 *
 * `playwright-core` n'embarque pas de navigateur : on utilise celui deja present
 * sur la machine. L'ordre de recherche couvre le cas normal (installation
 * Playwright standard) et les environnements ou le binaire est fourni autrement.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';

export class BrowserNotFoundError extends Error {}

/** Navigateur utilise, et d'ou il vient : `doctor` l'affiche a l'utilisateur. */
export interface BrowserChoice {
  executablePath: string;
  /** `playwright` = telecharge par Playwright ; `systeme` = deja sur la machine. */
  origine: 'playwright' | 'systeme';
  /** Nom lisible, ex. « Microsoft Edge ». */
  nom: string;
}

/**
 * Navigateurs deja installes, acceptes en remplacement du Chromium de Playwright.
 *
 * Pourquoi c'est important : le telechargement du Chromium de Playwright passe
 * par `cdn.playwright.dev`, que beaucoup de reseaux d'entreprise bloquent — et
 * l'installation echoue alors sans recours. Or Edge est present sur tous les
 * Windows et Chrome sur la plupart des postes : tous deux sont bases sur
 * Chromium et conviennent parfaitement a la mesure d'une page.
 */
function systemBrowsers(): Array<{ nom: string; chemins: string[] }> {
  const env = (nom: string): string => process.env[nom] ?? '';
  const programFiles = env('ProgramFiles') || 'C:\\Program Files';
  const programFilesX86 = env('ProgramFiles(x86)') || 'C:\\Program Files (x86)';
  const localAppData = env('LOCALAPPDATA');

  return [
    {
      nom: 'Google Chrome',
      chemins: [
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
      ],
    },
    {
      nom: 'Microsoft Edge',
      chemins: [
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
      ],
    },
    {
      nom: 'Brave',
      chemins: [
        path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/usr/bin/brave-browser',
      ],
    },
    {
      nom: 'Chromium',
      chemins: [
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ],
    },
  ];
}

/** Emplacements inspectes, pour qu'un echec soit diagnosticable. */
export function inspectedPaths(): string[] {
  const out: string[] = [];
  if (process.env.SFS_CHROMIUM_PATH) out.push(`SFS_CHROMIUM_PATH=${process.env.SFS_CHROMIUM_PATH}`);
  for (const navigateur of systemBrowsers()) {
    for (const chemin of navigateur.chemins) {
      if (chemin) out.push(`${navigateur.nom} : ${chemin}`);
    }
  }
  return out;
}

export function resolveBrowser(): BrowserChoice | undefined {
  // 1. Un chemin impose a la main gagne toujours.
  const impose = process.env.SFS_CHROMIUM_PATH;
  if (impose && existsSync(impose)) {
    return { executablePath: impose, origine: 'systeme', nom: 'navigateur indique (SFS_CHROMIUM_PATH)' };
  }

  // 2. Le navigateur gere par Playwright : sa version est garantie compatible.
  try {
    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) {
      return { executablePath: managed, origine: 'playwright', nom: 'Chromium (Playwright)' };
    }
  } catch {
    /* pas d'installation geree par Playwright */
  }

  // 3. Emplacement d'installation Playwright indique par l'environnement.
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && base !== '0') {
    for (const candidat of [
      path.join(base, 'chromium', 'chrome-linux', 'chrome'),
      path.join(base, 'chromium'),
    ]) {
      if (existsSync(candidat)) {
        return { executablePath: candidat, origine: 'playwright', nom: 'Chromium (Playwright)' };
      }
    }
  }

  // 4. Un navigateur deja installe sur la machine.
  for (const navigateur of systemBrowsers()) {
    for (const chemin of navigateur.chemins) {
      if (chemin && existsSync(chemin)) {
        return { executablePath: chemin, origine: 'systeme', nom: navigateur.nom };
      }
    }
  }
  return undefined;
}

export async function launchBrowser(): Promise<Browser> {
  const choix = resolveBrowser();
  if (!choix) {
    throw new BrowserNotFoundError(
      [
        'Aucun navigateur utilisable trouve.',
        '',
        'Le plus simple : installez Google Chrome ou Microsoft Edge, qui seront',
        'detectes automatiquement.   https://www.google.com/chrome/',
        '',
        'Ou telechargez le Chromium de Playwright :',
        '    node node_modules/playwright-core/cli.js install chromium',
        '',
        'Ou indiquez un navigateur deja present :',
        '    Windows :  set SFS_CHROMIUM_PATH=C:\\chemin\\vers\\msedge.exe',
        '    macOS   :  export SFS_CHROMIUM_PATH=/chemin/vers/Chromium',
      ].join('\n'),
    );
  }

  return chromium.launch({
    executablePath: choix.executablePath,
    // `--no-sandbox` est necessaire dans la plupart des conteneurs ; on ne
    // charge que des pages du site de la cliente, la surface est connue.
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
    ],
  });
}
