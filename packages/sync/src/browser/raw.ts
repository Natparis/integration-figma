/**
 * Types de la capture brute produite dans la page par `collect.ts`.
 *
 * Volontairement proche du DOM : aucune decision Figma n'est prise ici. La
 * traduction vers le `design-spec` se fait dans `build/`, ou l'on peut la
 * tester, la relire et la corriger sans relancer un navigateur.
 */

export interface RawRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RawSegment {
  tag: string;
  anchor?: string;
  cls?: string;
  index: number;
  pseudo?: 'before' | 'after';
}

/** Un fragment de texte homogene dans un bloc de texte. */
export interface RawTextRun {
  start: number;
  end: number;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  color: string;
  textDecorationLine: string;
  letterSpacing: string;
  /** Renseigne si le fragment est dans un `<a>`. */
  href?: string;
}

export interface RawText {
  characters: string;
  runs: RawTextRun[];
  /** Union des rectangles de lignes : borne le noeud texte au plus juste. */
  bounds: RawRect | null;
  lineCount: number;
}

export interface RawImage {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  alt: string;
  /** `img`, `background`, `video-poster` : d'ou vient l'image. */
  origin: 'img' | 'background' | 'poster';
  objectFit?: string;
}

/**
 * Dimensions REELLEMENT declarees par l'auteur, lues dans les feuilles de style.
 *
 * Indispensable : un style calcule ne distingue pas `width: 300px` ecrit par
 * l'auteur d'une largeur simplement occupee par un element de bloc — les deux
 * ressortent en pixels. Sans cette information, tout arriverait en taille fixe
 * dans Figma et la maquette ne s'adapterait plus.
 */
export interface RawDeclared {
  width?: string;
  height?: string;
  /** `max-width` declare : un conteneur qui l'atteint remplit, il n'ajuste pas. */
  maxWidth?: string;
  flex?: string;
  /** L'element est-il de niveau ligne (donc ajuste a son contenu) ? */
  inlineLevel?: boolean;
  /** Largeur du contenu du parent, pour detecter un element qui remplit. */
  parentContentWidth?: number;
  /** Hauteur du contenu du parent. */
  parentContentHeight?: number;
}

export interface RawNode {
  seg: RawSegment;
  rect: RawRect;
  /** Styles calcules, valeurs par defaut omises pour limiter la charge utile. */
  style: Record<string, string>;
  declared: RawDeclared;
  text?: RawText;
  images: RawImage[];
  /** `outerHTML` du SVG inline, deja nettoye. */
  svg?: string;
  link?: string;
  role?: string;
  ariaLabel?: string;
  ariaHidden?: boolean;
  /** Signale un conteneur defilable : devient un frame ecrete dans Figma. */
  scrolls?: boolean;
  /** Avertissements d'accessibilite releves sur cet element. */
  a11y?: string[];
  children: RawNode[];
}

export interface RawFontUse {
  family: string;
  weight: string;
  style: string;
  count: number;
}

export interface RawCapture {
  route: string;
  /**
   * Nom du breakpoint, renseigne par le pilote apres la capture.
   *
   * Sert au nommage des styles de texte : un titre a 52 px en desktop et 32 px en
   * mobile est le meme role, pas deux styles anonymes.
   */
  breakpointName?: string;
  title: string;
  lang: string;
  viewport: { width: number; height: number };
  documentHeight: number;
  root: RawNode;
  /** Variables CSS de `:root`, valeurs calculees (var() deja resolus). */
  rootVariables: Record<string, string>;
  /**
   * Valeurs DECLAREES des memes variables, `var(...)` compris.
   *
   * Permet de reconnaitre les alias (`--color-text: var(--color-neutral-900)`) et
   * de les reproduire comme alias de variables Figma, au lieu de dupliquer la
   * couleur. Le developpeur retrouve alors la meme indirection que dans le CSS.
   */
  rootVariablesDeclared: Record<string, string>;
  fonts: RawFontUse[];
  /** Liens sortants dans la meme origine, pour alimenter le crawl. */
  links: string[];
  stats: {
    visited: number;
    emitted: number;
    skipped: number;
    truncated: boolean;
    /** Arbres Shadow DOM ouverts et parcourus. */
    shadowRootsVisites?: number;
    /** Composants dont l'arbre est ferme, donc inaccessible. */
    shadowRootsFermes?: number;
  };
  warnings: string[];
}
