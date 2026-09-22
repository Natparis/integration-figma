import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFills, buildStrokes, cornerRadii, parseBlur, parseBoxShadow,
  parseGradient, rotationFromTransform, splitTopLevel,
} from './css-map.js';

test('splitTopLevel ignore les virgules a l interieur des parentheses', () => {
  assert.deepEqual(splitTopLevel('rgba(0, 0, 0, 0.1) 0px 4px, rgb(1,2,3) 0px 1px'), [
    'rgba(0, 0, 0, 0.1) 0px 4px',
    'rgb(1,2,3) 0px 1px',
  ]);
});

test('degrade lineaire : angle et arrets', () => {
  const paint = parseGradient('linear-gradient(160deg, rgb(235, 247, 255) 0%, rgb(255, 255, 255) 70%)');
  assert.equal(paint?.type, 'GRADIENT_LINEAR');
  assert.equal(paint && 'angle' in paint ? paint.angle : null, 160);
  assert.equal(paint && 'stops' in paint ? paint.stops.length : 0, 2);
  assert.equal(paint && 'stops' in paint ? paint.stops[1]!.position : 0, 0.7);
});

test('degrade : mot-cle directionnel converti en angle', () => {
  const paint = parseGradient('linear-gradient(to right, red 0%, blue 100%)');
  assert.equal(paint && 'angle' in paint ? paint.angle : null, 90);
});

test('degrade : positions manquantes interpolees comme dans le navigateur', () => {
  const paint = parseGradient('linear-gradient(red, green, blue)');
  const stops = paint && 'stops' in paint ? paint.stops : [];
  assert.deepEqual(stops.map((s) => s.position), [0, 0.5, 1]);
});

test('degrade : un seul arret n est pas un degrade', () => {
  assert.equal(parseGradient('linear-gradient(red)'), null);
});

test('remplissages : l image se peint AU-DESSUS de la couleur', () => {
  // En CSS `background-image` couvre `background-color` ; dans Figma c est le
  // DERNIER remplissage qui est au-dessus. L ordre doit donc etre inverse.
  const fills = buildFills({
    backgroundColor: 'rgb(255, 0, 0)',
    backgroundImage: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)',
  });
  assert.equal(fills.length, 2);
  assert.equal(fills[0]!.type, 'SOLID');
  assert.equal(fills[1]!.type, 'GRADIENT_LINEAR');
});

test('remplissages : fond entierement transparent ignore', () => {
  assert.deepEqual(buildFills({ backgroundColor: 'rgba(0, 0, 0, 0)' }), []);
});

test('remplissages : url() sans asset resolu est omise plutot que vide', () => {
  const fills = buildFills({ backgroundImage: 'url("/fond.png")', imageAssetIds: [] });
  assert.deepEqual(fills, []);
});

const side = (width: number, style = 'solid', color = 'rgb(0, 0, 0)') => ({ width, style, color });

test('contours : bordure uniforme', () => {
  const result = buildStrokes({
    top: side(1), right: side(1), bottom: side(1), left: side(1),
  });
  assert.equal(result.strokeWeight, 1);
  assert.equal(result.individualStrokeWeights, undefined);
  assert.equal(result.strokes.length, 1);
});

test('contours : bordure sur un seul cote conservee exactement', () => {
  // Les separateurs et soulignements sont partout ; Figma sait les representer.
  const result = buildStrokes({
    top: side(0, 'none'), right: side(0, 'none'), bottom: side(2), left: side(0, 'none'),
  });
  assert.deepEqual(result.individualStrokeWeights, { top: 0, right: 0, bottom: 2, left: 0 });
  assert.equal(result.strokeWeight, 2);
});

test('contours : style none ou couleur transparente = pas de contour', () => {
  assert.deepEqual(
    buildStrokes({ top: side(2, 'none'), right: side(0), bottom: side(0), left: side(0) }).strokes,
    [],
  );
  assert.deepEqual(
    buildStrokes({
      top: side(2, 'solid', 'rgba(0,0,0,0)'), right: side(2, 'solid', 'rgba(0,0,0,0)'),
      bottom: side(2, 'solid', 'rgba(0,0,0,0)'), left: side(2, 'solid', 'rgba(0,0,0,0)'),
    }).strokes,
    [],
  );
});

test('contours : pointilles traduits en motif de tirets', () => {
  const result = buildStrokes({
    top: side(2, 'dashed'), right: side(2, 'dashed'), bottom: side(2, 'dashed'), left: side(2, 'dashed'),
  });
  assert.deepEqual(result.dashPattern, [6, 4]);
});

test('box-shadow : format calcule de Chromium (couleur en tete)', () => {
  const effects = parseBoxShadow('rgba(16, 24, 40, 0.06) 0px 1px 2px 0px, rgba(16, 24, 40, 0.08) 0px 4px 12px 0px');
  assert.equal(effects.length, 2);
  assert.equal(effects[0]!.type, 'DROP_SHADOW');
  assert.deepEqual(effects[0]!.offset, { x: 0, y: 1 });
  assert.equal(effects[0]!.radius, 2);
  assert.ok(Math.abs(effects[0]!.color!.a - 0.06) < 0.01);
});

test('box-shadow : inset devient une ombre interne', () => {
  const effects = parseBoxShadow('rgba(0, 0, 0, 0.2) 0px 2px 4px 0px inset');
  assert.equal(effects[0]!.type, 'INNER_SHADOW');
});

test('box-shadow : ombre totalement transparente ignoree', () => {
  assert.deepEqual(parseBoxShadow('rgba(0, 0, 0, 0) 0px 4px 8px 0px'), []);
});

test('box-shadow : none', () => {
  assert.deepEqual(parseBoxShadow('none'), []);
  assert.deepEqual(parseBoxShadow(undefined), []);
});

test('filter: blur -> flou de calque, backdrop-filter -> flou d arriere-plan', () => {
  assert.deepEqual(parseBlur('blur(8px)', 'LAYER_BLUR'), [{ type: 'LAYER_BLUR', radius: 8 }]);
  assert.deepEqual(parseBlur('blur(12px)', 'BACKGROUND_BLUR'), [
    { type: 'BACKGROUND_BLUR', radius: 12 },
  ]);
  assert.deepEqual(parseBlur('none', 'LAYER_BLUR'), []);
  assert.deepEqual(parseBlur('grayscale(1)', 'LAYER_BLUR'), []);
});

test('rayons : pourcentage resolu d apres la taille de la boite', () => {
  const radii = cornerRadii(
    {
      borderTopLeftRadius: '50%', borderTopRightRadius: '50%',
      borderBottomRightRadius: '50%', borderBottomLeftRadius: '50%',
    },
    { w: 48, h: 48 },
  );
  assert.deepEqual(radii, [24, 24, 24, 24]);
});

test('rayons : plafonnes a la moitie de la plus petite dimension', () => {
  // `border-radius: 999px` sur une pastille de 50px de haut ne fait pas un rayon
  // de 999 : le navigateur le plafonne, Figma doit faire pareil.
  const radii = cornerRadii(
    {
      borderTopLeftRadius: '999px', borderTopRightRadius: '999px',
      borderBottomRightRadius: '999px', borderBottomLeftRadius: '999px',
    },
    { w: 227, h: 50 },
  );
  assert.deepEqual(radii, [25, 25, 25, 25]);
});

test('rayons : ordre Figma [haut-gauche, haut-droite, bas-droite, bas-gauche]', () => {
  const radii = cornerRadii(
    {
      borderTopLeftRadius: '1px', borderTopRightRadius: '2px',
      borderBottomRightRadius: '3px', borderBottomLeftRadius: '4px',
    },
    { w: 100, h: 100 },
  );
  assert.deepEqual(radii, [1, 2, 3, 4]);
});

test('rotation lue depuis une matrice de transformation', () => {
  // matrix(cos, sin, -sin, cos, 0, 0) pour 45 degres.
  const r = rotationFromTransform('matrix(0.7071, 0.7071, -0.7071, 0.7071, 0, 0)');
  assert.ok(Math.abs(r + 45) < 0.5, `obtenu ${r}`);
  assert.equal(rotationFromTransform('none'), 0);
  assert.equal(rotationFromTransform(undefined), 0);
});
