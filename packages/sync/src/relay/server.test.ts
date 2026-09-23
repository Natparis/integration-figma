import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startRelay } from './server.js';
import { Logger } from '../logger.js';

const HOST = '127.0.0.1';

/**
 * Regression : un port occupe faisait echouer `sfs serve` avec une pile d appels,
 * alors que dans la quasi-totalite des cas c'est notre propre relay, laisse
 * ouvert dans une autre fenetre. L extraction venait de reussir : abandonner la
 * perdait.
 */

async function dossierAvecSpec(revision: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sfs-relay-'));
  const spec = {
    version: 1,
    revision,
    generatedAt: new Date().toISOString(),
    pages: [],
    assets: [],
    tokens: { variables: [], collections: [] },
    styles: { paints: [], texts: [], effects: [] },
    components: [],
    diagnostics: [],
    stats: { pages: 0, nodes: 0, assets: 0, components: 0 },
  };
  await writeFile(path.join(dir, 'design-spec.json'), JSON.stringify(spec), 'utf8');
  return dir;
}

/** Port libre : on le prend puis on le rend, l OS ne le reattribue pas aussitot. */
async function portLibre(): Promise<number> {
  const serveur = http.createServer();
  await new Promise<void>((resolve) => serveur.listen(0, HOST, () => resolve()));
  const port = (serveur.address() as { port: number }).port;
  await new Promise<void>((resolve) => serveur.close(() => resolve()));
  return port;
}

const log = new Logger('silent');

test('un relay deja en place sur le port, servant la meme revision, est reutilise', async () => {
  const dir = await dossierAvecSpec('rev-identique');
  const port = await portLibre();

  const premier = await startRelay({ host: HOST, port, outputDir: dir, log });
  assert.equal(premier.reused, undefined);
  assert.equal(premier.url, `http://${HOST}:${port}`);

  const second = await startRelay({ host: HOST, port, outputDir: dir, log });
  assert.equal(second.reused, true, 'le second doit se raccrocher au premier');
  assert.equal(second.url, premier.url, 'la meme adresse reste valable pour le plugin');

  // Fermer le doublon ne doit pas couper le relay qui sert vraiment.
  await second.close();
  const sonde = await fetch(`${premier.url}/health`);
  assert.equal(sonde.ok, true);

  await premier.close();
});

test('un port pris par un programme etranger fait glisser le relay au port suivant', async () => {
  const dir = await dossierAvecSpec('rev-a');
  const port = await portLibre();

  // Un serveur qui n'est pas des notres : /health ne repond pas `ok`.
  const intrus = http.createServer((_req, res) => res.writeHead(200).end('bonjour'));
  await new Promise<void>((resolve) => intrus.listen(port, HOST, () => resolve()));

  const relay = await startRelay({ host: HOST, port, outputDir: dir, log });
  assert.equal(relay.reused, undefined);
  assert.equal(relay.movedFrom, port, 'le port d origine doit etre signale');
  assert.equal(relay.url, `http://${HOST}:${port + 1}`);

  const sonde = await fetch(`${relay.url}/health`);
  assert.equal(sonde.ok, true);

  await relay.close();
  await new Promise<void>((resolve) => intrus.close(() => resolve()));
});

test('un relay d un autre dossier n est pas reutilise', async () => {
  const dossierA = await dossierAvecSpec('rev-a');
  const dossierB = await dossierAvecSpec('rev-b');
  const port = await portLibre();

  const premier = await startRelay({ host: HOST, port, outputDir: dossierA, log });
  const second = await startRelay({ host: HOST, port, outputDir: dossierB, log });

  assert.equal(second.reused, undefined, 'une autre revision n est pas la notre');
  assert.equal(second.url, `http://${HOST}:${port + 1}`);

  await second.close();
  await premier.close();
});
