/**
 * Hachage deterministe, en TypeScript pur.
 *
 * Volontairement sans `node:crypto` ni `crypto.subtle` : ce module tourne aussi
 * dans le sandbox du plugin Figma. Ce n'est pas du hachage cryptographique,
 * seulement de la detection de changement — cyrb53 double graine, 13 caracteres
 * hexadecimaux, collisions negligeables a notre echelle.
 */

function cyrb53(input: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Hash court et stable d'une chaine. */
export function hashString(input: string): string {
  const a = cyrb53(input, 0).toString(16).padStart(14, '0');
  const b = cyrb53(input, 0x9e3779b9).toString(16);
  return (a + b).slice(0, 13);
}

/**
 * Serialisation canonique : cles triees a toutes les profondeurs, nombres
 * arrondis. Deux objets equivalents produisent la meme chaine, donc le meme
 * hash, meme si l'ordre des cles differe.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) return 'null';
    // 3 decimales : absorbe le bruit sous-pixel des styles calcules du
    // navigateur, qui sinon ferait re-synchroniser des noeuds identiques.
    return String(Math.round(n * 1000) / 1000);
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/** Hash d'une valeur structuree quelconque. */
export function hashValue(value: unknown): string {
  return hashString(canonicalize(value));
}
