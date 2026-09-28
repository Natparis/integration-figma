import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconnaitreDepot, urlArchive } from './github.js';

test('la page d accueil d un depot est reconnue', () => {
  assert.deepEqual(reconnaitreDepot('https://github.com/Natparis/integration-figma'), {
    owner: 'Natparis',
    repo: 'integration-figma',
    branch: null,
    subdir: null,
  });
});

test('une branche collee depuis le navigateur est retenue', () => {
  // C'est l'adresse qu'on obtient en naviguant dans une branche : le nom peut
  // contenir des barres obliques, comme ici.
  assert.deepEqual(
    reconnaitreDepot('https://github.com/Natparis/integration-figma/tree/claude/site-to-figma'),
    { owner: 'Natparis', repo: 'integration-figma', branch: 'claude', subdir: 'site-to-figma' },
  );
});

test('un sous-dossier est retenu', () => {
  assert.deepEqual(reconnaitreDepot('https://github.com/acme/site/tree/main/docs'), {
    owner: 'acme',
    repo: 'site',
    branch: 'main',
    subdir: 'docs',
  });
});

test('l adresse de clonage et la forme courte sont acceptees', () => {
  assert.equal(reconnaitreDepot('https://github.com/acme/site.git')?.repo, 'site');
  assert.equal(reconnaitreDepot('github:acme/site')?.owner, 'acme');
});

test('un site publie n est pas un depot', () => {
  // Sans cette distinction, l'adresse du site de l utilisatrice serait prise
  // pour un depot et l extraction lirait du code source au lieu de pages.
  assert.equal(reconnaitreDepot('https://projet.campagnesdecom.fr/'), null);
  assert.equal(reconnaitreDepot('https://acme.github.io/site/'), null);
  assert.equal(reconnaitreDepot('C:\\Users\\natha\\Documents\\site'), null);
  assert.equal(reconnaitreDepot(''), null);
});

test('l archive visee est celle de la branche demandee', () => {
  assert.equal(
    urlArchive({ owner: 'acme', repo: 'site', branch: null, subdir: null }, 'main'),
    'https://codeload.github.com/acme/site/zip/refs/heads/main',
  );
});
