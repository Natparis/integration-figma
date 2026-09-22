/**
 * Construction du plugin.
 *
 * Le bac a sable Figma n'a pas de systeme de modules : tout doit tenir dans un
 * seul fichier. esbuild regroupe le code et l'interface.
 */
import { build, context } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  // Le bac a sable Figma execute un ES2017 sans modules.
  target: 'es2017',
  format: 'iife',
  platform: 'browser',
  logLevel: 'info',
  legalComments: 'none',
};

/**
 * Second point d'entree, en modules ES : permet d'exercer la vraie logique de
 * synchronisation depuis les tests, avec un faux moteur Figma en global.
 */
const testBundle = {
  entryPoints: ['src/sync.ts'],
  bundle: true,
  outfile: 'dist/sync.mjs',
  target: 'es2022',
  format: 'esm',
  platform: 'neutral',
  logLevel: 'warning',
};

await mkdir('dist', { recursive: true });
await copyFile('src/ui.html', 'dist/ui.html');

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Surveillance active. Ctrl+C pour arreter.');
} else {
  await build(options);
  await build(testBundle);
  console.log('Plugin construit dans dist/.');
}
