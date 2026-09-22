/**
 * Analyse des couleurs CSS vers sRGB.
 *
 * Pourquoi ce module existe : Chromium ne normalise PAS tout en `rgb()`. Une
 * couleur declaree en `oklch()` (le defaut de Tailwind 4 et des generateurs de
 * palettes recents) ressort telle quelle dans les styles calcules. Sans
 * conversion, toutes les couleurs arriveraient fausses dans Figma — et Figma ne
 * travaille qu'en sRGB.
 *
 * Sont couverts : hex, rgb(), hsl(), hwb(), lab(), lch(), oklab(), oklch(),
 * color(srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020), les couleurs
 * nommees, `transparent` et `currentColor`.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  transparent: '#00000000', black: '#000000', white: '#ffffff', red: '#ff0000',
  lime: '#00ff00', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff',
  aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', silver: '#c0c0c0',
  gray: '#808080', grey: '#808080', maroon: '#800000', olive: '#808000',
  green: '#008000', purple: '#800080', teal: '#008080', navy: '#000080',
  orange: '#ffa500', gold: '#ffd700', pink: '#ffc0cb', brown: '#a52a2a',
  beige: '#f5f5dc', ivory: '#fffff0', khaki: '#f0e68c', coral: '#ff7f50',
  crimson: '#dc143c', indigo: '#4b0082', violet: '#ee82ee', salmon: '#fa8072',
  tomato: '#ff6347', turquoise: '#40e0d0', tan: '#d2b48c', plum: '#dda0dd',
  orchid: '#da70d6', lavender: '#e6e6fa', linen: '#faf0e6', snow: '#fffafa',
  azure: '#f0ffff', wheat: '#f5deb3', thistle: '#d8bfd8', sienna: '#a0522d',
  peru: '#cd853f', chocolate: '#d2691e', firebrick: '#b22222', darkred: '#8b0000',
  darkblue: '#00008b', darkgreen: '#006400', darkcyan: '#008b8b',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', darkorange: '#ff8c00',
  darkviolet: '#9400d3', darkslategray: '#2f4f4f', dimgray: '#696969',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', lightblue: '#add8e6',
  lightgreen: '#90ee90', lightyellow: '#ffffe0', lightpink: '#ffb6c1',
  whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff',
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', seashell: '#fff5ee',
  mintcream: '#f5fffa', honeydew: '#f0fff0', oldlace: '#fdf5e6',
  floralwhite: '#fffaf0', cornsilk: '#fff8dc', papayawhip: '#ffefd5',
  blanchedalmond: '#ffebcd', bisque: '#ffe4c4', peachpuff: '#ffdab9',
  navajowhite: '#ffdead', moccasin: '#ffe4b5', mistyrose: '#ffe4e1',
  lavenderblush: '#fff0f5', slategray: '#708090', lightslategray: '#778899',
  steelblue: '#4682b4', royalblue: '#4169e1', dodgerblue: '#1e90ff',
  deepskyblue: '#00bfff', skyblue: '#87ceeb', cadetblue: '#5f9ea0',
  seagreen: '#2e8b57', forestgreen: '#228b22', limegreen: '#32cd32',
  springgreen: '#00ff7f', yellowgreen: '#9acd32', olivedrab: '#6b8e23',
  goldenrod: '#daa520', darkgoldenrod: '#b8860b', rosybrown: '#bc8f8f',
  indianred: '#cd5c5c', saddlebrown: '#8b4513', slateblue: '#6a5acd',
  mediumpurple: '#9370db', blueviolet: '#8a2be2', mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee', mediumturquoise: '#48d1cc', hotpink: '#ff69b4',
  deeppink: '#ff1493', palegoldenrod: '#eee8aa', palegreen: '#98fb98',
  paleturquoise: '#afeeee', palevioletred: '#db7093', powderblue: '#b0e0e6',
  rebeccapurple: '#663399', aquamarine: '#7fffd4', chartreuse: '#7fff00',
  darkkhaki: '#bdb76b', darkmagenta: '#8b008b', darkolivegreen: '#556b2f',
  darkorchid: '#9932cc', darksalmon: '#e9967a', darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b', darkturquoise: '#00ced1', greenyellow: '#adff2f',
  lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightcoral: '#f08080',
  lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2', lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightsteelblue: '#b0c4de',
  mediumaquamarine: '#66cdaa', mediumblue: '#0000cd', mediumorchid: '#ba55d3',
  mediumspringgreen: '#00fa9a', mediumvioletred: '#c71585', midnightblue: '#191970',
  orangered: '#ff4500', sandybrown: '#f4a460', seagull: '#80ccff',
  burlywood: '#deb887', cornflowerblue: '#6495ed', darkslategrey: '#2f4f4f',
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Decoupe les arguments d'une fonction CSS, en gerant `/` pour l'alpha. */
function splitArgs(input: string): { parts: string[]; alpha: string | null } {
  let alpha: string | null = null;
  let body = input;
  // La barre oblique separe l'alpha dans la syntaxe moderne : rgb(0 0 0 / 50%)
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '/' && depth === 0) {
      alpha = body.slice(i + 1).trim();
      body = body.slice(0, i);
      break;
    }
  }
  const parts = body
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return { parts, alpha };
}

/** Un composant numerique : nombre, pourcentage, ou `none` (traite comme 0). */
function num(token: string | undefined, scale = 1): number {
  if (token === undefined || token === 'none') return 0;
  if (token.endsWith('%')) return (parseFloat(token) / 100) * scale;
  const value = parseFloat(token);
  return Number.isFinite(value) ? value : 0;
}

function alphaOf(token: string | null | undefined): number {
  if (token === null || token === undefined || token === 'none') return 1;
  if (token.endsWith('%')) return clamp01(parseFloat(token) / 100);
  const value = parseFloat(token);
  return Number.isFinite(value) ? clamp01(value) : 1;
}

/* ------------------------------ espaces lineaires ----------------------- */

function srgbToLinear(c: number): number {
  const sign = c < 0 ? -1 : 1;
  const abs = Math.abs(c);
  return sign * (abs <= 0.04045 ? abs / 12.92 : Math.pow((abs + 0.055) / 1.055, 2.4));
}
function linearToSrgb(c: number): number {
  const sign = c < 0 ? -1 : 1;
  const abs = Math.abs(c);
  return sign * (abs <= 0.0031308 ? abs * 12.92 : 1.055 * Math.pow(abs, 1 / 2.4) - 0.055);
}

/**
 * Chaque espace de couleur a sa propre fonction de transfert. Appliquer la
 * courbe sRGB a tous introduit jusqu'a 37/255 d'erreur sur ProPhoto RGB — verifie
 * contre le rasteriseur de Chromium.
 */
function toLinear(space: string, c: number): number {
  const sign = c < 0 ? -1 : 1;
  const abs = Math.abs(c);
  switch (space) {
    case 'a98-rgb':
      return sign * Math.pow(abs, 563 / 256);
    case 'prophoto-rgb':
      return abs <= 16 / 512 ? c / 16 : sign * Math.pow(abs, 1.8);
    case 'rec2020': {
      const alpha = 1.09929682680944;
      const beta = 0.018053968510807;
      return abs < beta * 4.5
        ? c / 4.5
        : sign * Math.pow((abs + alpha - 1) / alpha, 1 / 0.45);
    }
    default:
      // sRGB et Display P3 partagent la courbe sRGB.
      return srgbToLinear(c);
  }
}

/** Espaces dont la matrice est referencee au blanc D50 et non D65. */
const D50_SPACES = new Set(['prophoto-rgb']);

/** Matrices RGB lineaire -> XYZ D65, par espace de couleur. */
const TO_XYZ: Record<string, number[][]> = {
  srgb: [
    [0.4123907993, 0.3575843394, 0.1804807884],
    [0.2126390059, 0.7151686788, 0.0721923154],
    [0.0193308187, 0.1191947798, 0.9505321522],
  ],
  'display-p3': [
    [0.4865709486, 0.2656676932, 0.1982172852],
    [0.2289745641, 0.6917385218, 0.0792869141],
    [0.0000000000, 0.0451133819, 1.0439443689],
  ],
  'a98-rgb': [
    [0.5766690429, 0.1855582379, 0.1882286462],
    [0.2973449753, 0.6273635663, 0.0752914584],
    [0.0270313614, 0.0706888525, 0.9913375368],
  ],
  'prophoto-rgb': [
    [0.7977604714, 0.1351917115, 0.0313534429],
    [0.2880711436, 0.7118432178, 0.0000856386],
    [0.0000000000, 0.0000000000, 0.8251046025],
  ],
  rec2020: [
    [0.6369580483, 0.1446169036, 0.1688809752],
    [0.2627002120, 0.6779980715, 0.0593017165],
    [0.0000000000, 0.0280726930, 1.0609850577],
  ],
};

const XYZ_TO_SRGB = [
  [3.2409699419, -1.5373831776, -0.4986107603],
  [-0.9692436363, 1.8759675015, 0.0415550574],
  [0.0556300797, -0.2039769589, 1.0569715142],
];

function apply(matrix: number[][], v: [number, number, number]): [number, number, number] {
  return [
    matrix[0]![0]! * v[0] + matrix[0]![1]! * v[1] + matrix[0]![2]! * v[2],
    matrix[1]![0]! * v[0] + matrix[1]![1]! * v[1] + matrix[1]![2]! * v[2],
    matrix[2]![0]! * v[0] + matrix[2]![1]! * v[1] + matrix[2]![2]! * v[2],
  ];
}

function xyzD65ToSrgb(xyz: [number, number, number]): [number, number, number] {
  const linear = apply(XYZ_TO_SRGB, xyz);
  return [linearToSrgb(linear[0]), linearToSrgb(linear[1]), linearToSrgb(linear[2])];
}

/* ------------------------------- OKLab / OKLCh -------------------------- */

function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}

/* --------------------------------- CIE Lab ------------------------------ */

// Blanc de reference D50, utilise par lab() et lch() en CSS.
const D50: [number, number, number] = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

const BRADFORD_D50_TO_D65 = [
  [0.955473421, -0.023098455, 0.063259146],
  [-0.028369553, 1.009995268, 0.021041420],
  [0.012314014, -0.020507696, 1.330365261],
];

function labToSrgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const e = 216 / 24389;
  const k = 24389 / 27;
  const f = (t: number, f0: number): number => (t ** 3 > e ? t ** 3 : (116 * f0 - 16) / k);
  const xyzD50: [number, number, number] = [
    f(fx, fx) * D50[0],
    L > 8 ? fy ** 3 * D50[1] : (L / k) * D50[1],
    f(fz, fz) * D50[2],
  ];
  return xyzD65ToSrgb(apply(BRADFORD_D50_TO_D65, xyzD50));
}

/* ----------------------------------- HSL -------------------------------- */

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(hue / 60) % 6;
  const table: Array<[number, number, number]> = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r, g, b] = table[sector]!;
  return [r + m, g + m, b + m];
}

function hwbToRgb(h: number, w: number, b: number): [number, number, number] {
  if (w + b >= 1) {
    const gray = w / (w + b);
    return [gray, gray, gray];
  }
  const [r, g, bl] = hslToRgb(h, 1, 0.5);
  const mix = (v: number): number => v * (1 - w - b) + w;
  return [mix(r), mix(g), mix(bl)];
}

/* ------------------------------ point d'entree -------------------------- */

/** Angle CSS (deg/grad/rad/turn) en degres. */
function angle(token: string | undefined): number {
  if (!token) return 0;
  const value = parseFloat(token);
  if (!Number.isFinite(value)) return 0;
  if (token.endsWith('turn')) return value * 360;
  if (token.endsWith('rad')) return (value * 180) / Math.PI;
  if (token.endsWith('grad')) return value * 0.9;
  return value;
}

/**
 * Analyse une couleur CSS. Retourne `null` si la valeur n'est pas une couleur
 * (`none`, `currentColor` sans contexte, mot-cle inconnu) : l'appelant decide
 * alors quoi faire, plutot que de se retrouver avec un noir silencieux.
 */
export function parseColor(input: string | undefined | null): Rgba | null {
  if (!input) return null;
  let value = input.trim();
  if (!value || value === 'none' || value === 'currentcolor' || value === 'currentColor') return null;

  const lower = value.toLowerCase();
  if (lower in NAMED) value = NAMED[lower]!;

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16) / 255;
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0]!), g: expand(hex[1]!), b: expand(hex[2]!),
        a: hex.length === 4 ? expand(hex[3]!) : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  const fn = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(value);
  if (!fn) return null;
  const name = fn[1]!.toLowerCase();
  const { parts, alpha: alphaToken } = splitArgs(fn[2]!);
  // Syntaxe heritee `rgba(r, g, b, a)` : l'alpha est le 4e argument. Reserve aux
  // fonctions qui ont reellement cette forme — dans `color(srgb r g b)` le 4e
  // argument est le canal bleu, pas une opacite.
  const LEGACY_ALPHA_FNS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);
  const legacyAlpha =
    LEGACY_ALPHA_FNS.has(name) && parts.length === 4 ? parts[3] : null;
  const a = alphaOf(alphaToken ?? legacyAlpha);

  const finish = ([r, g, b]: [number, number, number]): Rgba => ({
    r: clamp01(r), g: clamp01(g), b: clamp01(b), a,
  });

  switch (name) {
    case 'rgb':
    case 'rgba': {
      const channel = (token: string | undefined): number =>
        token?.endsWith('%') ? num(token, 1) : num(token) / 255;
      return finish([channel(parts[0]), channel(parts[1]), channel(parts[2])]);
    }
    case 'hsl':
    case 'hsla':
      return finish(hslToRgb(angle(parts[0]), num(parts[1], 1), num(parts[2], 1)));
    case 'hwb':
      return finish(hwbToRgb(angle(parts[0]), num(parts[1], 1), num(parts[2], 1)));
    case 'lab':
      return finish(labToSrgb(num(parts[0], 100), num(parts[1], 125), num(parts[2], 125)));
    case 'lch': {
      const c = num(parts[1], 150);
      const h = (angle(parts[2]) * Math.PI) / 180;
      return finish(labToSrgb(num(parts[0], 100), c * Math.cos(h), c * Math.sin(h)));
    }
    case 'oklab':
      return finish(oklabToSrgb(num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4)));
    case 'oklch': {
      const c = num(parts[1], 0.4);
      const h = (angle(parts[2]) * Math.PI) / 180;
      return finish(oklabToSrgb(num(parts[0], 1), c * Math.cos(h), c * Math.sin(h)));
    }
    case 'color': {
      const space = (parts[0] ?? 'srgb').toLowerCase();
      const channels: [number, number, number] = [
        num(parts[1], 1), num(parts[2], 1), num(parts[3], 1),
      ];
      const out = ((): [number, number, number] => {
        if (space === 'srgb') return channels;
        if (space === 'srgb-linear') {
          return [linearToSrgb(channels[0]), linearToSrgb(channels[1]), linearToSrgb(channels[2])];
        }
        if (space === 'xyz' || space === 'xyz-d65') return xyzD65ToSrgb(channels);
        if (space === 'xyz-d50') return xyzD65ToSrgb(apply(BRADFORD_D50_TO_D65, channels));
        const matrix = TO_XYZ[space];
        // Espace inconnu : on traite les canaux comme du sRGB plutot que de
        // renvoyer du noir. Approximatif, mais jamais absurde.
        if (!matrix) return channels;
        const linear: [number, number, number] = [
          toLinear(space, channels[0]),
          toLinear(space, channels[1]),
          toLinear(space, channels[2]),
        ];
        const xyz = apply(matrix, linear);
        return xyzD65ToSrgb(D50_SPACES.has(space) ? apply(BRADFORD_D50_TO_D65, xyz) : xyz);
      })();
      return { r: clamp01(out[0]), g: clamp01(out[1]), b: clamp01(out[2]), a };
    }
    default:
      return null;
  }
}

/** `#rrggbb` (l'alpha est porte separement dans Figma). */
export function toHex({ r, g, b }: Rgba): string {
  const part = (v: number): string =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Luminance relative WCAG, pour nommer les nuances et verifier les contrastes. */
export function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** Ratio de contraste WCAG 2.x entre deux couleurs opaques. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Teinte et saturation approchees, pour regrouper les couleurs en familles. */
export function hsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: ((h * 60) % 360 + 360) % 360, s, l };
}

/** Compose une couleur semi-transparente sur un fond opaque. */
export function flatten(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}
