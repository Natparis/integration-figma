import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, flatten, hsl, luminance, parseColor, toHex } from './color.js';

/**
 * Les valeurs attendues ne sont pas inventees : elles viennent du rasteriseur de
 * Chromium, releve via `scripts/verify-colors-against-chromium.mjs`. Tolerance
 * de 2/255, la marge d'arrondi de l'espace sRGB 8 bits.
 */
const rgb255 = (css: string): [number, number, number, number] | null => {
  const c = parseColor(css);
  if (!c) return null;
  return [
    Math.round(c.r * 255),
    Math.round(c.g * 255),
    Math.round(c.b * 255),
    Math.round(c.a * 100) / 100,
  ];
};

const near = (css: string, expected: [number, number, number, number], tol = 2): void => {
  const got = rgb255(css);
  assert.ok(got, `« ${css} » n'a pas ete analyse`);
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(got![i]! - expected[i]!) <= tol,
      `« ${css} » canal ${i} : attendu ${expected[i]}, obtenu ${got![i]} (ecart > ${tol})`,
    );
  }
  assert.ok(
    Math.abs(got![3]! - expected[3]!) <= 0.01,
    `« ${css} » alpha : attendu ${expected[3]}, obtenu ${got![3]}`,
  );
};

test('hex : 3, 4, 6 et 8 chiffres', () => {
  near('#abc', [170, 187, 204, 1]);
  near('#abcd', [170, 187, 204, 0.87]);
  near('#1a2b3c', [26, 43, 60, 1]);
  near('#1a2b3c80', [26, 43, 60, 0.5]);
});

test('rgb : syntaxes heritee et moderne, pourcentages', () => {
  near('rgb(10, 20, 30)', [10, 20, 30, 1]);
  near('rgba(10, 20, 30, 0.5)', [10, 20, 30, 0.5]);
  near('rgb(10 20 30 / 25%)', [10, 20, 30, 0.25]);
  near('rgb(50% 25% 10%)', [128, 64, 26, 1]);
});

test('hsl et hwb, avec toutes les unites d angle', () => {
  near('hsl(210, 50%, 40%)', [51, 102, 153, 1]);
  near('hsl(210deg 50% 40% / 0.5)', [51, 102, 153, 0.5]);
  near('hsl(0.5turn 100% 50%)', [0, 255, 255, 1]);
  near('hwb(120 20% 30%)', [51, 179, 51, 1]);
});

test('lab et lch', () => {
  near('lab(52.2% 40.1 59.9)', [198, 93, 7, 1]);
  near('lab(29.2345% 39.3825 20.0664)', [125, 35, 41, 1]);
  near('lch(52.2% 72.2 50)', [205, 86, 26, 1]);
  near('lch(80% 30 200)', [122, 214, 216, 1]);
});

test('oklch : le format des palettes modernes, que Chromium ne normalise pas', () => {
  // Sans ce support, toutes les couleurs d un site Tailwind 4 arriveraient
  // fausses dans Figma. C est le cas qui justifie ce module.
  near('oklch(0.7 0.15 250)', [75, 163, 247, 1]);
  near('oklch(0.55 0.22 29)', [212, 15, 12, 1]);
  near('oklch(0.95 0.02 264)', [232, 239, 252, 1]);
  near('oklch(0.21 0.034 264.665)', [16, 24, 40, 1]);
  near('oklch(70% 0.1 180 / 0.6)', [75, 178, 162, 0.6]);
  near('oklab(0.7 0.1 -0.05)', [200, 132, 188, 1]);
});

test('color() : chaque espace a sa propre fonction de transfert', () => {
  near('color(srgb 0.1 0.5 0.9)', [26, 128, 230, 1]);
  near('color(srgb-linear 0.2 0.4 0.6)', [124, 170, 203, 1]);
  near('color(display-p3 0.2 0.7 0.4)', [0, 182, 93, 1]);
  near('color(rec2020 0.3 0.6 0.2)', [0, 170, 42, 1]);
  near('color(a98-rgb 0.4 0.5 0.6)', [89, 128, 155, 1]);
  near('color(prophoto-rgb 0.4 0.5 0.6)', [69, 151, 173, 1]);
});

test('color() : le 4e argument est un canal, jamais une opacite', () => {
  // Regression : `color(srgb r g b)` avait ete lu comme `rgba(...)`, donc le
  // bleu passait pour l alpha.
  assert.equal(parseColor('color(srgb 0.1 0.5 0.9)')!.a, 1);
  assert.equal(parseColor('color(srgb 0.1 0.5 0.9 / 0.4)')!.a, 0.4);
});

test('couleurs nommees et transparent', () => {
  near('rebeccapurple', [102, 51, 153, 1]);
  near('tomato', [255, 99, 71, 1]);
  near('white', [255, 255, 255, 1]);
  near('transparent', [0, 0, 0, 0]);
});

test('valeurs non colorimetriques : null, pas un noir silencieux', () => {
  // Retourner du noir ferait apparaitre des rectangles noirs dans la maquette
  // la ou le site n a aucun fond.
  for (const input of ['none', 'currentColor', 'inherit', 'url(#grad)', '', undefined, null]) {
    assert.equal(parseColor(input as string), null, `« ${String(input)} » devrait etre null`);
  }
});

test('valeurs hors gamut ramenees dans [0,1]', () => {
  const c = parseColor('oklch(0.9 0.4 140)')!;
  for (const channel of [c.r, c.g, c.b]) {
    assert.ok(channel >= 0 && channel <= 1, `canal hors bornes : ${channel}`);
  }
});

test('toHex', () => {
  assert.equal(toHex(parseColor('rgb(26, 43, 60)')!), '#1a2b3c');
  assert.equal(toHex(parseColor('white')!), '#ffffff');
});

test('luminance et contraste WCAG', () => {
  assert.ok(Math.abs(luminance(parseColor('white')!) - 1) < 0.001);
  assert.ok(Math.abs(luminance(parseColor('black')!)) < 0.001);
  const ratio = contrastRatio(parseColor('white')!, parseColor('black')!);
  assert.ok(Math.abs(ratio - 21) < 0.01, `attendu 21:1, obtenu ${ratio}`);
  // Gris moyen sur blanc : sous le seuil AA de 4,5:1 pour du texte courant.
  assert.ok(contrastRatio(parseColor('#767676')!, parseColor('white')!) > 4.5);
  assert.ok(contrastRatio(parseColor('#999999')!, parseColor('white')!) < 4.5);
});

test('hsl inverse : familles de teintes', () => {
  assert.ok(Math.abs(hsl(parseColor('rgb(255,0,0)')!).h - 0) < 1);
  assert.ok(Math.abs(hsl(parseColor('rgb(0,255,0)')!).h - 120) < 1);
  assert.equal(hsl(parseColor('rgb(128,128,128)')!).s, 0);
});

test('flatten : compose un calque semi-transparent sur son fond', () => {
  const result = flatten(parseColor('rgba(0,0,0,0.5)')!, parseColor('white')!);
  assert.ok(Math.abs(result.r - 0.5) < 0.01);
  assert.equal(result.a, 1);
});
