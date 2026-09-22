import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableAssetKey } from './assets.js';

/**
 * Regression : l'identifiant venait de l'URL complete, qui contient le port
 * ephemere du serveur statique local. Deux extractions du MEME site produisaient
 * donc deux revisions differentes, et Figma reecrivait tous les noeuds image
 * pour rien.
 */
test('le port ephemere du serveur local ne change pas l identite d une image', () => {
  const a = stableAssetKey('http://127.0.0.1:34619/assets/equipe.png', 'http://127.0.0.1:34619');
  const b = stableAssetKey('http://127.0.0.1:51204/assets/equipe.png', 'http://127.0.0.1:51204');
  assert.equal(a, b);
  assert.equal(a, '/assets/equipe.png');
});

test('deux chemins differents restent distincts', () => {
  const origin = 'http://127.0.0.1:8080';
  assert.notEqual(
    stableAssetKey(`${origin}/a.png`, origin),
    stableAssetKey(`${origin}/b.png`, origin),
  );
});

test('la chaine de requete fait partie de l identite', () => {
  // Un service d'images redimensionne selon ses parametres : ce sont deux
  // fichiers distincts.
  const origin = 'https://exemple.fr';
  assert.notEqual(
    stableAssetKey(`${origin}/img.png?w=800`, origin),
    stableAssetKey(`${origin}/img.png?w=1600`, origin),
  );
});

test('un asset externe garde son URL complete', () => {
  assert.equal(
    stableAssetKey('https://cdn.exemple.com/logo.svg', 'http://127.0.0.1:8080'),
    'https://cdn.exemple.com/logo.svg',
  );
});

test('une URL de donnees est identifiee par son contenu', () => {
  const key = stableAssetKey('data:image/png;base64,AAAA', '');
  assert.match(key, /^data:[0-9a-f]{12}$/);
  assert.equal(key, stableAssetKey('data:image/png;base64,AAAA', 'http://autre'));
  assert.notEqual(key, stableAssetKey('data:image/png;base64,BBBB', ''));
});

test('une valeur non analysable est renvoyee telle quelle', () => {
  assert.equal(stableAssetKey('pas-une-url', 'http://127.0.0.1:8080'), 'pas-une-url');
});
