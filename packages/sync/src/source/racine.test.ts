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

test('le site range dans un sous-dossier est trouve', async () => {
  // Regression : le depot de developpement range le site a cote de ses outils.
  // `LVMH-V2` contient `site/`, `outils/`, `docs/`, un README et un CLAUDE.md :
  // trois dossiers, donc pas de descente par dossier unique. On servait la
  // racine du depot, ou aucune page ne repond, et l extraction ne mesurait
  // rien.
  const base = await dossier();
  await writeFile(path.join(base, 'README.md'), '# depot', 'utf8');
  await writeFile(path.join(base, 'CLAUDE.md'), '# regles', 'utf8');
  await mkdir(path.join(base, 'site'), { recursive: true });
  await writeFile(path.join(base, 'site', 'index.html'), '<h1>ok</h1>', 'utf8');
  await mkdir(path.join(base, 'outils'), { recursive: true });
  await writeFile(path.join(base, 'outils', 'preparer.mjs'), 'export {};', 'utf8');
  await mkdir(path.join(base, 'docs'), { recursive: true });
  await writeFile(path.join(base, 'docs', 'audit.txt'), 'audit', 'utf8');
  assert.equal(await findSiteRoot(base), path.join(base, 'site'));
});

test('le dossier unique d une archive mene au sous-dossier publie', async () => {
  // Le cas reel : archive GitHub, donc un `LVMH-V2-main/` qui enveloppe tout.
  // Les deux descentes doivent s enchainer.
  const base = await dossier();
  const depot = path.join(base, 'LVMH-V2-main');
  await mkdir(path.join(depot, 'site'), { recursive: true });
  await writeFile(path.join(depot, 'README.md'), '# depot', 'utf8');
  await writeFile(path.join(depot, 'site', 'index.html'), '<h1>ok</h1>', 'utf8');
  await mkdir(path.join(depot, 'outils'), { recursive: true });
  assert.equal(await findSiteRoot(base), path.join(depot, 'site'));
});

test('deux sous-dossiers publiables ne sont pas departages au hasard', async () => {
  // `site/` et `maquette/` portent tous deux un index : aucun nom de
  // publication connu ne tranche, on rend la main plutot que de deviner.
  const base = await dossier();
  await writeFile(path.join(base, 'README.md'), '# depot', 'utf8');
  await mkdir(path.join(base, 'maquette-a'), { recursive: true });
  await writeFile(path.join(base, 'maquette-a', 'index.html'), '<h1>a</h1>', 'utf8');
  await mkdir(path.join(base, 'maquette-b'), { recursive: true });
  await writeFile(path.join(base, 'maquette-b', 'index.html'), '<h1>b</h1>', 'utf8');
  assert.equal(await findSiteRoot(base), base);
});

test('un dossier de documentation sans page n attire pas la descente', async () => {
  const base = await dossier();
  await writeFile(path.join(base, 'README.md'), '# depot', 'utf8');
  await mkdir(path.join(base, 'docs'), { recursive: true });
  await writeFile(path.join(base, 'docs', 'audit.txt'), 'audit', 'utf8');
  await mkdir(path.join(base, 'outils'), { recursive: true });
  assert.equal(await findSiteRoot(base), base);
});

test('un dossier local pointe sur le depot sert bien le sous-dossier du site', async () => {
  // Le champ « dossier » de l application invite a designer un depot clone.
  // Sans descente, on servait sa racine : `/` repondait 404 et les pages
  // sortaient en `/site`, `/site/catalogue`.
  const { resolveSource } = await import('./resolve.js');
  const base = await dossier();
  await writeFile(path.join(base, 'README.md'), '# depot', 'utf8');
  await mkdir(path.join(base, 'site'), { recursive: true });
  await writeFile(path.join(base, 'site', 'index.html'), '<h1>accueil</h1>', 'utf8');
  await mkdir(path.join(base, 'outils'), { recursive: true });
  await writeFile(path.join(base, 'outils', 'preparer.mjs'), 'export {};', 'utf8');

  const source = await resolveSource({ path: base });
  try {
    assert.equal(source.localRoot, path.join(base, 'site'));
    const page = await fetch(`${source.origin}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /accueil/);
  } finally {
    await source.dispose();
  }
});
