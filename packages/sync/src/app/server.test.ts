import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../config.js';
import { Logger } from '../logger.js';
import { demarrerApp, extraireCleFigma, resumerRapportPlugin } from './server.js';

test('un lien Figma colle depuis la barre d adresse donne la cle du fichier', () => {
  assert.equal(
    extraireCleFigma(
      'https://www.figma.com/design/eC38nDRYtHJszgE6SWFoy6/ATELIERS?node-id=0-1&t=abc',
    ),
    'eC38nDRYtHJszgE6SWFoy6',
  );
  assert.equal(extraireCleFigma('eC38nDRYtHJszgE6SWFoy6'), 'eC38nDRYtHJszgE6SWFoy6');
  assert.equal(extraireCleFigma('https://www.figma.com/'), null);
  assert.equal(extraireCleFigma(''), null);
});

test('le compte-rendu du plugin est rendu en francais lisible', () => {
  assert.match(resumerRapportPlugin({ status: 'started' }), /en cours/);
  assert.match(resumerRapportPlugin({ status: 'error', message: 'quota' }), /quota/);
  const fini = resumerRapportPlugin({ status: 'done', created: 3, updated: 12, removed: 1 });
  assert.match(fini, /3 calques crees|3 calques créés/);
  assert.match(fini, /12 mis a jour|12 mis à jour/);
});

async function app(dossier: string, port: number) {
  return demarrerApp({
    racine: dossier,
    cheminConfig: path.join(dossier, 'sfs.config.json'),
    config: { ...DEFAULT_CONFIG, output: { ...DEFAULT_CONFIG.output, dir: dossier } },
    host: '127.0.0.1',
    port,
    log: new Logger('silent'),
    extraire: async () => {},
  });
}

async function portLibre(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test('le rapport ne laisse pas remonter hors du dossier de sortie', async () => {
  // La page demande ses fichiers par leur nom. Sans verification, un « .. »
  // dans l URL servirait n importe quel fichier de la machine.
  const dossier = await mkdtemp(path.join(tmpdir(), 'sfs-app-'));
  await writeFile(path.join(dossier, 'comparaison.html'), '<p>rapport</p>', 'utf8');
  const port = await portLibre();
  const serveur = await app(dossier, port);
  try {
    const legitime = await fetch(`${serveur.url}/rapport`);
    assert.equal(legitime.status, 200);
    assert.match(await legitime.text(), /rapport/);

    for (const chemin of ['/rapport/../../etc/passwd', '/rapport/..%2f..%2fetc%2fpasswd']) {
      const reponse = await fetch(`${serveur.url}${chemin}`, { redirect: 'manual' });
      assert.ok(
        reponse.status === 403 || reponse.status === 404,
        `${chemin} a repondu ${reponse.status}`,
      );
    }
  } finally {
    await serveur.fermer();
  }
});

test('la page et l etat repondent avant toute lecture de site', async () => {
  // Au tout premier lancement il n existe ni maquette ni configuration : la
  // page doit tout de meme s afficher, sinon l utilisatrice est bloquee devant
  // une erreur des la premiere seconde.
  const dossier = await mkdtemp(path.join(tmpdir(), 'sfs-app-'));
  const port = await portLibre();
  const serveur = await app(dossier, port);
  try {
    const page = await fetch(serveur.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Votre site, en maquette Figma/);

    const etat = (await (await fetch(`${serveur.url}/etat`)).json()) as Record<string, unknown>;
    assert.equal(etat.revision, undefined, 'aucune maquette ne doit etre annoncee');
    assert.equal(etat.relais, `http://127.0.0.1:${port}`);
  } finally {
    await serveur.fermer();
  }
});

test('le lien Figma saisi dans la page est enregistre dans la configuration', async () => {
  const dossier = await mkdtemp(path.join(tmpdir(), 'sfs-app-'));
  const port = await portLibre();
  const serveur = await app(dossier, port);
  try {
    const reponse = await fetch(`${serveur.url}/lancer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'https://github.com/acme/site',
        figma: 'https://www.figma.com/design/eC38nDRYtHJszgE6SWFoy6/ATELIERS',
      }),
    });
    const corps = (await reponse.json()) as { ok: boolean; etat: Record<string, string> };
    assert.equal(corps.ok, true);
    assert.equal(corps.etat.source, 'https://github.com/acme/site');
    assert.match(corps.etat.figma!, /eC38nDRYtHJszgE6SWFoy6/);
  } finally {
    await serveur.fermer();
  }
});
