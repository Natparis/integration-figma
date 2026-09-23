/**
 * Format d'echange `design-spec` : la representation intermediaire entre le site
 * web et Figma. L'extracteur le produit, le plugin Figma le consomme.
 *
 * Regle d'or : ce fichier ne depend de rien. Il est importe a la fois par du
 * code Node (extracteur) et par le sandbox du plugin Figma.
 */

export const SPEC_VERSION = 1 as const;

export interface RGB {
  r: number;
  g: number;
  b: number;
}
export interface RGBA extends RGB {
  a: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Reference vers un token : soit une variable Figma, soit un style partage. */
export interface TokenRef {
  /** Nom complet de la variable, ex. `color/brand/600`. */
  variable?: string;
  /** Nom complet du style de peinture, ex. `Surface/Card`. */
  style?: string;
}

export type Paint =
  | ({
      type: 'SOLID';
      color: RGB;
      opacity: number;
    } & TokenRef)
  | {
      type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
      stops: Array<{ position: number; color: RGBA }>;
      /** Angle CSS en degres (0 = vers le haut), converti en transform par le plugin. */
      angle: number;
      opacity: number;
    }
  | {
      type: 'IMAGE';
      assetId: string;
      scaleMode: 'FILL' | 'FIT' | 'TILE' | 'CROP';
      opacity: number;
    };

export interface Effect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  color?: RGBA;
  offset?: { x: number; y: number };
  radius: number;
  spread?: number;
  /** Nom du style d'effet partage a utiliser, ex. `Elevation/md`. */
  style?: string;
}

export type SizingMode = 'FIXED' | 'HUG' | 'FILL';
export type AxisAlign = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
export type CounterAlign = 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';

export interface LayoutSpec {
  mode: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  /** true si le conteneur CSS etait `flex-wrap: wrap` ou une grille. */
  wrap: boolean;
  /** [haut, droite, bas, gauche] */
  padding: [number, number, number, number];
  itemSpacing: number;
  counterAxisSpacing: number;
  primaryAxisAlignItems: AxisAlign;
  counterAxisAlignItems: CounterAlign;
  sizing: { horizontal: SizingMode; vertical: SizingMode };
  clipsContent: boolean;
  /** `ABSOLUTE` reproduit position:absolute / fixed / sticky. */
  positioning: 'AUTO' | 'ABSOLUTE';
  /**
   * L'element etait cale sur la FENETRE (`position: fixed` ou `sticky`).
   *
   * Determinant : un tel element se positionne par rapport a l'ecran, jamais par
   * rapport a son parent DOM. Le placer relativement a son parent — qui peut se
   * trouver des milliers de pixels plus bas — le projette hors du cadre. Il est
   * donc remonte a la racine de la page.
   */
  viewportFixed?: boolean;
  constraints?: {
    horizontal: 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE';
    vertical: 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE';
  };
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** Tokens de spacing lies (padding/gap) pour un fichier pilote par variables. */
  bound?: {
    paddingTop?: string;
    paddingRight?: string;
    paddingBottom?: string;
    paddingLeft?: string;
    itemSpacing?: string;
  };
}

export interface StyleSpec {
  fills: Paint[];
  strokes: Paint[];
  strokeWeight: number;
  strokeAlign: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  /** Bordures asymetriques (ex. seulement border-bottom). */
  individualStrokeWeights?: { top: number; right: number; bottom: number; left: number };
  dashPattern?: number[];
  /** [tl, tr, br, bl] */
  cornerRadius: [number, number, number, number];
  cornerRadiusToken?: string;
  effects: Effect[];
  opacity: number;
  visible: boolean;
  blendMode?: 'NORMAL' | 'MULTIPLY' | 'SCREEN' | 'OVERLAY' | 'DARKEN' | 'LIGHTEN';
}

export interface FontSpec {
  family: string;
  /** Style Figma resolu, ex. `Bold`, `Regular`, `Semi Bold Italic`. */
  style: string;
  /** Graisse CSS d'origine, conservee pour le rapport de substitution. */
  weight: number;
  italic: boolean;
  size: number;
  lineHeight: { unit: 'PIXELS' | 'PERCENT' | 'AUTO'; value?: number };
  letterSpacing: { unit: 'PIXELS' | 'PERCENT'; value: number };
}

export interface TextSpec {
  characters: string;
  /** Nom du style de texte partage, ex. `Heading/H1`. */
  styleName?: string;
  font: FontSpec;
  fills: Paint[];
  textAlignHorizontal: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  textAlignVertical: 'TOP' | 'CENTER' | 'BOTTOM';
  textAutoResize: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  paragraphSpacing: number;
  /** Renseigne quand le texte est un lien, pour la passation dev. */
  href?: string;
}

export type NodeKind =
  | 'FRAME'
  | 'TEXT'
  | 'IMAGE'
  | 'VECTOR'
  | 'ELLIPSE'
  | 'LINE'
  | 'INSTANCE';

export interface DevNotes {
  /** Balise HTML d'origine (`section`, `h1`, `button`...). */
  tag: string;
  /**
   * Classe CSS significative, ex. `carte-metier`.
   *
   * Sert a nommer les composants : le titre d'une carte (« Organisation
   * d'atelier ») nomme bien un calque de page, mais nomme mal un composant qui
   * vaut pour les six cartes. La classe, elle, decrit le motif.
   */
  cls?: string;
  /** Selecteur CSS reconstruit, pour retrouver l'element dans le code. */
  selector: string;
  /** Role ARIA / semantique detectee. */
  role?: string;
  /** Sous-ensemble utile des styles calcules, affiche en annotation Dev Mode. */
  css: Record<string, string>;
  /** Cible d'un lien ou d'un bouton. */
  href?: string;
  /** Texte alternatif d'une image. */
  alt?: string;
  /** Avertissements d'accessibilite detectes a l'extraction. */
  a11y?: string[];
}

export interface SpecNode {
  /** Identifiant stable, cle de la synchronisation idempotente. */
  sid: string;
  name: string;
  kind: NodeKind;
  /** Coordonnees absolues dans la page, en px CSS. */
  box: Box;
  layout: LayoutSpec;
  style: StyleSpec;
  text?: TextSpec;
  image?: { assetId: string; scaleMode: 'FILL' | 'FIT' | 'TILE' | 'CROP' };
  vector?: { assetId: string };
  /** Cle du composant a instancier (voir `DesignSpec.components`). */
  instanceOf?: string;
  /** Proprietes de variante a appliquer sur l'instance. */
  variantProperties?: Record<string, string>;
  devNotes?: DevNotes;
  children: SpecNode[];
  /** Hash du noeud sans ses enfants : permet de sauter les mises a jour inutiles. */
  hash: string;
  /** Hash du noeud et de tout son sous-arbre. */
  subtreeHash: string;
}

export interface BreakpointSpec {
  /** `Desktop`, `Tablet`, `Mobile`... sert de nom de frame racine. */
  name: string;
  width: number;
  /** Hauteur mesuree du document. */
  height: number;
  root: SpecNode;
}

export interface PageSpec {
  /** Nom de page Figma, ex. `01 · Accueil`. */
  name: string;
  /** Chemin source, ex. `/index.html` ou `/nos-metiers/`. */
  route: string;
  title: string;
  breakpoints: BreakpointSpec[];
}

export type VariableType = 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';

export interface VariableSpec {
  /** Nom hierarchique avec `/`, ex. `color/brand/600`. */
  name: string;
  type: VariableType;
  description?: string;
  /** Valeur par mode. Cle = nom du mode de la collection. */
  valuesByMode: Record<string, RGBA | number | string | boolean>;
  /** Variable CSS d'origine, ex. `--color-brand-600`. */
  cssVariable?: string;
  /**
   * Nom d'une autre variable de la meme collection dont celle-ci est un alias.
   *
   * Reproduit l'indirection du CSS (`--color-text: var(--color-neutral-900)`) :
   * dans Figma, changer la variable cible met a jour l'alias. Sans cela, la
   * couleur serait dupliquee et les deux se desynchroniseraient.
   */
  aliasOf?: string;
  /** `true` si le token a ete deduit par analyse plutot que lu dans le CSS. */
  inferred?: boolean;
}

export interface TokenCollection {
  name: string;
  modes: string[];
  defaultMode: string;
  variables: VariableSpec[];
}

export interface PaintStyleSpec {
  name: string;
  description?: string;
  paints: Paint[];
}

export interface TextStyleSpec {
  name: string;
  description?: string;
  font: FontSpec;
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  paragraphSpacing: number;
}

export interface EffectStyleSpec {
  name: string;
  description?: string;
  effects: Effect[];
}

export interface ComponentSpec {
  /** Cle logique referencee par `SpecNode.instanceOf`. */
  key: string;
  /** Nom Figma, ex. `Button/Primary`. */
  name: string;
  description?: string;
  /** Page Figma ou ranger le composant, ex. `Composants`. */
  section: string;
  /** Definition de la variante par defaut. */
  node: SpecNode;
  /** Variantes detectees (etat, taille...). */
  variants?: Array<{ properties: Record<string, string>; node: SpecNode }>;
  /** Nombre d'occurrences trouvees dans le site : justifie la promotion. */
  occurrences: number;
}

export interface AssetSpec {
  id: string;
  kind: 'IMAGE' | 'SVG';
  /** Chemin relatif au dossier d'assets du spec, ex. `assets/img_a1b2c3.png`. */
  file: string;
  /** URL ou chemin source d'origine. */
  source: string;
  mime: string;
  width?: number;
  height?: number;
  bytes: number;
  /** sha256 du contenu, pour ne re-uploader que ce qui a change. */
  hash: string;
  /**
   * Contenu en base64, present uniquement dans un spec « autonome » produit par
   * `sfs bundle`. Permet d'utiliser le plugin sans lancer de serveur local :
   * l'utilisateur depose un seul fichier.
   */
  data?: string;
}

export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  /** Contexte : route, sid, selecteur... */
  where?: string;
  /** Action concrete suggeree a l'utilisateur. */
  hint?: string;
}

export interface SourceInfo {
  kind: 'zip' | 'directory' | 'url';
  /** Racine : URL du site ou chemin du dossier. */
  root: string;
  extractedAt: string;
  /** Hash du contenu source (arbre de fichiers ou reponses HTTP). */
  contentHash: string;
  extractorVersion: string;
}

export interface FigmaTarget {
  /** Cle du fichier Figma cible, extraite de l'URL. */
  fileKey: string;
  /** Prefixe des pages gerees par la synchro, pour ne jamais toucher au reste. */
  pagePrefix: string;
}

export interface DesignSpec {
  specVersion: typeof SPEC_VERSION;
  /** Hash global : change des qu'une seule chose change dans le site. */
  revision: string;
  generatedAt: string;
  source: SourceInfo;
  target?: FigmaTarget;
  tokens: TokenCollection[];
  paintStyles: PaintStyleSpec[];
  textStyles: TextStyleSpec[];
  effectStyles: EffectStyleSpec[];
  components: ComponentSpec[];
  pages: PageSpec[];
  assets: AssetSpec[];
  diagnostics: Diagnostic[];
  /** Compteurs affiches dans l'interface du plugin. */
  stats: {
    pages: number;
    breakpoints: number;
    nodes: number;
    textNodes: number;
    assets: number;
    variables: number;
    components: number;
  };
}
