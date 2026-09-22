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

function candidatePaths(): string[] {
  const out: string[] = [];
  if (process.env.SFS_CHROMIUM_PATH) out.push(process.env.SFS_CHROMIUM_PATH);
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && base !== '0') {
    out.push(path.join(base, 'chromium', 'chrome-linux', 'chrome'));
    out.push(path.join(base, 'chromium'));
  }
  out.push(
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  );
  return out;
}

function resolveExecutable(): string | undefined {
  // Priorite au navigateur gere par Playwright : c'est celui dont la version est
  // garantie compatible avec la bibliotheque.
  try {
    const managed = chromium.executablePath();
    if (managed && existsSync(managed)) return managed;
  } catch {
    /* pas d'installation geree par Playwright */
  }
  for (const candidate of candidatePaths()) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function launchBrowser(): Promise<Browser> {
  const executablePath = resolveExecutable();
  if (!executablePath) {
    throw new BrowserNotFoundError(
      [
        'Aucun Chromium trouve.',
        '',
        'Installez-le une fois pour toutes :',
        '    npx playwright install chromium',
        '',
        'Ou indiquez un navigateur deja present :',
        '    SFS_CHROMIUM_PATH=/chemin/vers/chrome  npm run sfs -- extract',
      ].join('\n'),
    );
  }

  return chromium.launch({
    executablePath,
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
