// Verifie le parseur de couleurs contre le rasteriseur de Chromium :
// on peint la couleur sur un canvas et on relit les octets sRGB reels.
import { chromium } from 'playwright-core';
import { parseColor } from '../dist/build/color.js';

const CASES = [
  '#abc', '#abcd', '#1a2b3c', '#1a2b3c80',
  'rgb(10, 20, 30)', 'rgba(10, 20, 30, 0.5)', 'rgb(10 20 30 / 25%)', 'rgb(50% 25% 10%)',
  'hsl(210, 50%, 40%)', 'hsl(210deg 50% 40% / 0.5)', 'hsl(0.5turn 100% 50%)',
  'hwb(120 20% 30%)',
  'lab(52.2% 40.1 59.9)', 'lab(29.2345% 39.3825 20.0664)',
  'lch(52.2% 72.2 50)', 'lch(80% 30 200)',
  'oklab(0.7 0.1 -0.05)',
  'oklch(0.7 0.15 250)', 'oklch(0.55 0.22 29)', 'oklch(0.95 0.02 264)', 'oklch(0.21 0.034 264.665)',
  'oklch(70% 0.1 180 / 0.6)',
  'color(srgb 0.1 0.5 0.9)', 'color(srgb 0.1 0.5 0.9 / 0.4)',
  'color(display-p3 0.2 0.7 0.4)', 'color(rec2020 0.3 0.6 0.2)',
  'color(a98-rgb 0.4 0.5 0.6)', 'color(prophoto-rgb 0.4 0.5 0.6)',
  'color(srgb-linear 0.2 0.4 0.6)',
  'rebeccapurple', 'tomato', 'transparent', 'white',
];

const { launchBrowser } = await import('../dist/browser/launch.js');
const browser = await launchBrowser();
const page = await browser.newPage();
await page.setContent('<canvas id="c" width="4" height="4"></canvas>');
const truth = await page.evaluate((cases) => {
  const c = document.getElementById('c');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const out = {};
  for (const css of cases) {
    ctx.clearRect(0, 0, 4, 4);
    ctx.fillStyle = '#000000';        // sentinelle : detecte une valeur refusee
    ctx.fillStyle = css;
    if (ctx.fillStyle === '#000000' && !/black|#000/.test(css)) { out[css] = null; continue; }
    ctx.clearRect(0, 0, 4, 4);
    ctx.fillRect(0, 0, 4, 4);
    const d = ctx.getImageData(1, 1, 1, 1).data;
    out[css] = [d[0], d[1], d[2], d[3]];
  }
  return out;
}, CASES);
await browser.close();

let worst = 0, fails = 0, unsupported = 0;
const rows = [];
for (const css of CASES) {
  const t = truth[css];
  if (!t) { unsupported++; rows.push([css, 'REFUSE PAR CHROMIUM', '', '']); continue; }
  // getImageData rend des canaux NON premultiplies : on les compare tels quels.
  const ta = t[3] / 255;
  const expected = [t[0], t[1], t[2]];
  const got = parseColor(css);
  if (!got) { fails++; rows.push([css, `rgb(${expected})a${ta.toFixed(2)}`, 'NULL', 'ECHEC']); continue; }
  const mine = [Math.round(got.r * 255), Math.round(got.g * 255), Math.round(got.b * 255)];
  const dChan = ta === 0 ? 0 : Math.max(...mine.map((v, i) => Math.abs(v - expected[i])));
  const dAlpha = Math.abs(got.a - ta);
  worst = Math.max(worst, dChan);
  const ok = dChan <= 2 && dAlpha <= 0.01;
  if (!ok) fails++;
  rows.push([css, `rgb(${expected}) a=${ta.toFixed(2)}`, `rgb(${mine}) a=${got.a.toFixed(2)}`, ok ? `ok (d=${dChan})` : `ECART ${dChan} / a ${dAlpha.toFixed(3)}`]);
}
for (const r of rows) console.log(r[0].padEnd(34), '|', String(r[1]).padEnd(26), '|', String(r[2]).padEnd(26), '|', r[3]);
console.log(`\nTotal ${CASES.length} | non supporte par Chromium ${unsupported} | ecarts >2/255 : ${fails} | ecart max ${worst}/255`);
process.exit(fails > 0 ? 1 : 0);
