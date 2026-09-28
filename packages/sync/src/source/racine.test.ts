import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findSiteRoot } from './zip.js';
import { serveDirectory } from './static-server.js';

async function dossier(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'sfs-racine-'));
}

test('le dossier unique d une archive est traverse', async () => {
  const base = await dossier();
  await mkdir(path.join(base, 'mon-site'), { recursive: true });
  await writeFile(path.join(base, 'mon-site', 'index.html'), '<h1>ok</h1>', 'utf8');
  assert.equal(await findSiteRoot(base), path.join(base, 'mon-site'));
});

test('l archive telechargee a cote n empeche pas la descente', async () => {
  // Regression : le ZIP du depot etait ecrit dans le dossier d extraction.
  // `LVMH-main/` n etant plus seul, on servait le niveau du dessus — le site
  // repondait sur `/LVMH-main`, sans barre finale, et ses scripts relatifs
  // etaient cherches a la racine. Le moteur de rendu du site ne demarrait pas
  // et la maquette se remplissait de gabarits `{{ ... }}`.
  const base = await dossier();
  await writeFile(path.join(base, 'depot.zip'), 'PK', 'utf8');
  await mkdir(path.join(base, 'LVMH-main'), { recursive: true });
  await writeFile(path.join(base, 'LVMH-main', 'index.html'), '<h1>ok</h1>', 'utf8');
  assert.equal(await findSiteRoot(base), path.join(base, 'LVMH-main'));
});

test('un vrai dossier de site n est pas traverse', async () => {
  const base = await dossier();
  await writeFile(path.join(base, 'index.html'), '<h1>ok</h1>', 'utf8');
  await mkdir(path.join(base, 'assets'), { recursive: true });
  assert.equal(await findSiteRoot(base), base);
});

test('un dossier sans barre finale est redirige', async () => {
  // Le navigateur resout `./support.js` contre le PARENT tant que l URL ne se
  // termine pas par une barre : sans redirection, tous les scripts d un site
  // servi depuis un sous-dossier repondent 404.
  const base = await dossier();
  await mkdir(path.join(base, 'docs'), { recursive: true });
  await writeFile(path.join(base, 'docs', 'index.html'), '<h1>docs</h1>', 'utf8');
  await writeFile(path.join(base, 'docs', 'support.js'), 'export {};', 'utf8');

  const serveur = await serveDirectory(base);
  try {
    const brut = await fetch(`${serveur.origin}/docs`, { redirect: 'manual' });
    assert.equal(brut.status, 301);
    assert.equal(brut.headers.get('location'), '/docs/');

    const suivi = await fetch(`${serveur.origin}/docs`);
    assert.equal(suivi.status, 200);
    assert.match(await suivi.text(), /docs/);

    // Et le script relatif de cette page se resout bien.
    const script = await fetch(new URL('./support.js', `${serveur.origin}/docs/`).href);
    assert.equal(script.status, 200);
  } finally {
    await serveur.close();
  }
});
