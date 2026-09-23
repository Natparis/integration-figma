/**
 * Collecteur execute DANS la page par Chromium.
 *
 * Contrainte : la fonction est serialisee vers le navigateur, elle ne peut donc
 * rien capturer de sa portee externe. Tout est defini a l'interieur, et tout
 * passe par l'argument `options`. C'est verbeux, c'est voulu.
 *
 * Ce qu'on mesure ici, c'est le rendu reel (styles calcules, rectangles
 * effectifs), pas le CSS declare : c'est la seule facon d'obtenir une maquette
 * Figma qui correspond a ce que le visiteur voit.
 */

import type {
  RawCapture,
  RawDeclared,
  RawDiscard,
  RawNode,
  RawRect,
  RawSegment,
  RawShift,
  RawTextRun,
} from './raw.js';

export interface CollectOptions {
  /** Plafond de noeuds emis, garde-fou contre une page pathologique. */
  maxNodes: number;
  /** Inclure les styles calcules complets pour les annotations Dev Mode. */
  devAnnotations: boolean;
  /** Origine du site, pour distinguer liens internes et externes. */
  origin: string;
}

/* eslint-disable complexity */
export function collectPage(options: CollectOptions): RawCapture {
  /* ------------------------------------------------------------------ *
   * Proprietes calculees relevees, et leurs valeurs « sans effet ».
   * Omettre les valeurs par defaut divise la taille de la capture par 3
   * a 4, ce qui compte sur un site de plusieurs milliers d'elements.
   * ------------------------------------------------------------------ */
  const PROPS: string[] = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'zIndex',
    'overflowX', 'overflowY', 'boxSizing', 'visibility', 'opacity', 'mixBlendMode',
    'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignContent',
    'alignSelf', 'rowGap', 'columnGap', 'flexGrow', 'flexShrink', 'flexBasis', 'order',
    'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow', 'gridAutoColumns',
    'gridColumnStart', 'gridColumnEnd', 'gridRowStart', 'gridRowEnd',
    'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition',
    'backgroundRepeat', 'backgroundClip',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius',
    'borderBottomLeftRadius',
    'boxShadow', 'filter', 'backdropFilter', 'outlineWidth', 'outlineColor', 'outlineStyle',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
    'textAlign', 'textTransform', 'textDecorationLine', 'color', 'whiteSpace',
    'textOverflow', 'webkitLineClamp', 'verticalAlign', 'textIndent',
    'transform', 'transformOrigin', 'aspectRatio', 'objectFit', 'objectPosition',
    'fill', 'stroke', 'strokeWidth', 'cursor', 'listStyleType',
  ];

  const DEFAULTS: Record<string, string> = {
    position: 'static', top: 'auto', right: 'auto', bottom: 'auto', left: 'auto',
    zIndex: 'auto', overflowX: 'visible', overflowY: 'visible', visibility: 'visible',
    opacity: '1', mixBlendMode: 'normal',
    flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'normal',
    alignItems: 'normal', alignContent: 'normal', alignSelf: 'auto',
    rowGap: 'normal', columnGap: 'normal', flexGrow: '0', flexShrink: '1',
    flexBasis: 'auto', order: '0',
    gridTemplateColumns: 'none', gridTemplateRows: 'none', gridAutoFlow: 'row',
    gridAutoColumns: 'auto', gridColumnStart: 'auto', gridColumnEnd: 'auto',
    gridRowStart: 'auto', gridRowEnd: 'auto',
    minWidth: 'auto', minHeight: 'auto', maxWidth: 'none', maxHeight: 'none',
    marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px',
    paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
    backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none',
    backgroundSize: 'auto', backgroundPosition: '0% 0%', backgroundRepeat: 'repeat',
    backgroundClip: 'border-box',
    borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px',
    borderLeftWidth: '0px',
    borderTopStyle: 'none', borderRightStyle: 'none', borderBottomStyle: 'none',
    borderLeftStyle: 'none',
    borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
    borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px',
    boxShadow: 'none', filter: 'none', backdropFilter: 'none',
    outlineWidth: '0px', outlineStyle: 'none',
    textTransform: 'none', textDecorationLine: 'none', whiteSpace: 'normal',
    textOverflow: 'clip', webkitLineClamp: 'none', verticalAlign: 'baseline',
    textIndent: '0px', letterSpacing: 'normal',
    transform: 'none', aspectRatio: 'auto', objectFit: 'fill',
    objectPosition: '50% 50%', fill: 'rgb(0, 0, 0)', stroke: 'none',
    cursor: 'auto', listStyleType: 'disc',
  };

  /** Elements sans rendu visuel : on ne descend meme pas dedans. */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'TITLE', 'HEAD',
    'BASE', 'PARAM', 'SOURCE', 'TRACK', 'MAP', 'AREA',
  ]);

  /**
   * Classes utilitaires de frameworks : inutiles pour nommer une couche.
   *
   * Chaque prefixe utilitaire DOIT etre suivi d'un tiret. Sans cette exigence, le
   * motif devorait des noms legitimes : `p[xytblr]?` suivi d'un reste libre
   * faisait passer « pastille » pour une classe de padding, et la couche perdait
   * son nom.
   */
  const UTILITY = 'w|h|m|mx|my|mt|mb|ml|mr|p|px|py|pt|pb|pl|pr|gap|text|bg|border|rounded' +
    '|shadow|font|leading|tracking|z|opacity|top|left|right|bottom|order|col|row' +
    '|justify|items|self|content|space|overflow|max|min|transition|duration|ease' +
    '|transform|scale|translate|rotate|cursor|select|pointer|ring|outline|list' +
    '|object|aspect|basis|grow|shrink|divide|placeholder|from|via|to|fill|stroke';
  const NOISY_CLASS = new RegExp(
    '^(?:' +
      // Utilitaires numeriques compacts : p-4, mx-2, gap-8.
      '[a-z]{1,3}-\\d+' +
      // Variantes prefixees : md:flex, hover:bg-blue-500.
      '|(?:sm|md|lg|xl|2xl|hover|focus|focus-visible|active|group|peer|dark|motion|print)[:-].+' +
      // Mots-cles de disposition employes seuls.
      '|(?:flex|grid|block|inline|inline-block|hidden|absolute|relative|static|fixed|sticky|container|sr-only|truncate|antialiased)' +
      // Utilitaire + tiret + valeur : text-sm, bg-white, rounded-lg.
      '|(?:' + UTILITY + ')-[0-9a-z\\[\\]./%-]+' +
    ')$',
  );

  /* ------------------------------------------------------------------ *
   * Regles de dimensionnement declarees par l'auteur.
   *
   * On pre-filtre les selecteurs qui declarent width/height/flex — il y en a
   * une poignee sur un site typique — puis on teste chaque element contre ce
   * petit ensemble. Tester tous les selecteurs contre tous les elements serait
   * trop lent ; celui-ci est instantane et exact.
   * ------------------------------------------------------------------ */
  interface SizingRule {
    selector: string;
    width?: string;
    height?: string;
    maxWidth?: string;
    flex?: string;
    /** Specificite approchee, pour que la derniere regle la plus precise gagne. */
    order: number;
  }

  const sizingRules: SizingRule[] = (() => {
    const rules: SizingRule[] = [];
    let order = 0;
    const consider = (rule: CSSStyleRule, active: boolean): void => {
      order++;
      if (!active) return;
      const width = rule.style.getPropertyValue('width');
      const height = rule.style.getPropertyValue('height');
      const maxWidth = rule.style.getPropertyValue('max-width');
      const flex = rule.style.getPropertyValue('flex') || rule.style.getPropertyValue('flex-grow');
      if (!width && !height && !maxWidth && !flex) return;
      const entry: SizingRule = { selector: rule.selectorText, order };
      if (width) entry.width = width.trim();
      if (height) entry.height = height.trim();
      if (maxWidth) entry.maxWidth = maxWidth.trim();
      if (flex) entry.flex = flex.trim();
      rules.push(entry);
    };
    const scan = (list: CSSRuleList, active: boolean): void => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSStyleRule) {
          consider(rule, active);
          // Les regles imbriquees (CSS nesting) comptent aussi.
          const nested = (rule as unknown as { cssRules?: CSSRuleList }).cssRules;
          if (nested) scan(nested, active);
        } else if (rule instanceof CSSMediaRule) {
          // Une regle dans un @media non satisfait ne s'applique pas a ce
          // breakpoint : la prendre en compte donnerait des tailles fausses.
          let matches = false;
          try {
            matches = window.matchMedia(rule.conditionText).matches;
          } catch {
            matches = false;
          }
          scan(rule.cssRules, active && matches);
        } else if (rule instanceof CSSSupportsRule) {
          scan(rule.cssRules, active && CSS.supports(rule.conditionText));
        } else if ('cssRules' in rule) {
          scan((rule as unknown as CSSGroupingRule).cssRules, active);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        scan(sheet.cssRules, true);
      } catch {
        // Feuille d'une autre origine : illisible. On le signalera plus bas.
      }
    }
    return rules;
  })();

  const INLINE_LEVEL = /^(inline|inline-block|inline-flex|inline-grid|inline-table|contents)$/;

  /** Ne conserve que ce qui decrit du texte : aucune propriete de mise en page. */
  const TEXT_ONLY_PROPS = new Set([
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
    'textAlign', 'textTransform', 'textDecorationLine', 'color', 'whiteSpace',
    'textOverflow', 'webkitLineClamp', 'opacity',
  ]);

  function textOnlyStyle(style: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(style)) {
      if (TEXT_ONLY_PROPS.has(key)) out[key] = value;
    }
    return out;
  }

  function declaredFor(el: Element, cs: CSSStyleDeclaration, rect: RawRect): RawDeclared {
    const out: RawDeclared = {};

    // Le style en ligne a la priorite absolue.
    const inline = (el as HTMLElement).style;
    let width = inline?.width || '';
    let height = inline?.height || '';
    let flex = inline?.flex || inline?.flexGrow || '';

    let maxWidth = inline?.maxWidth || '';
    let bestWidth = -1;
    let bestHeight = -1;
    let bestMaxWidth = -1;
    let bestFlex = -1;
    for (const rule of sizingRules) {
      let hit = false;
      try {
        hit = el.matches(rule.selector);
      } catch {
        continue;
      }
      if (!hit) continue;
      if (rule.width && rule.order > bestWidth && !inline?.width) {
        width = rule.width;
        bestWidth = rule.order;
      }
      if (rule.height && rule.order > bestHeight && !inline?.height) {
        height = rule.height;
        bestHeight = rule.order;
      }
      if (rule.maxWidth && rule.order > bestMaxWidth && !inline?.maxWidth) {
        maxWidth = rule.maxWidth;
        bestMaxWidth = rule.order;
      }
      if (rule.flex && rule.order > bestFlex && !inline?.flex) {
        flex = rule.flex;
        bestFlex = rule.order;
      }
    }

    if (width) out.width = width;
    if (height) out.height = height;
    if (maxWidth) out.maxWidth = maxWidth;
    if (flex) out.flex = flex;
    if (INLINE_LEVEL.test(cs.display)) out.inlineLevel = true;

    const parent = el.parentElement;
    if (parent) {
      const pcs = getComputedStyle(parent);
      const prect = parent.getBoundingClientRect();
      const contentWidth =
        prect.width -
        parseFloat(pcs.paddingLeft || '0') - parseFloat(pcs.paddingRight || '0') -
        parseFloat(pcs.borderLeftWidth || '0') - parseFloat(pcs.borderRightWidth || '0');
      const contentHeight =
        prect.height -
        parseFloat(pcs.paddingTop || '0') - parseFloat(pcs.paddingBottom || '0') -
        parseFloat(pcs.borderTopWidth || '0') - parseFloat(pcs.borderBottomWidth || '0');
      if (Number.isFinite(contentWidth)) out.parentContentWidth = Math.round(contentWidth * 100) / 100;
      if (Number.isFinite(contentHeight)) out.parentContentHeight = Math.round(contentHeight * 100) / 100;
    }
    void rect;
    return out;
  }

  const warnings: string[] = [];
  let shadowRootsVisites = 0;
  let shadowRootsFermes = 0;
  const fontUse = new Map<string, { family: string; weight: string; style: string; count: number }>();
  const links = new Set<string>();
  let visited = 0;
  let emitted = 0;
  let skipped = 0;
  let truncated = false;

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  /* ---------------------------- utilitaires ---------------------------- */

  function docRect(el: Element): RawRect {
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  }

  function unionRects(rects: DOMRectList | DOMRect[]): RawRect | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of Array.from(rects)) {
      if (r.width === 0 && r.height === 0) continue;
      x0 = Math.min(x0, r.left);
      y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right);
      y1 = Math.max(y1, r.bottom);
    }
    if (!Number.isFinite(x0)) return null;
    return { x: x0 + scrollX, y: y0 + scrollY, w: x1 - x0, h: y1 - y0 };
  }

  function pickStyle(cs: CSSStyleDeclaration): Record<string, string> {
    const out: Record<string, string> = {};
    for (const prop of PROPS) {
      const value = cs[prop as unknown as number] as unknown as string | undefined;
      const resolved = typeof value === 'string' ? value : cs.getPropertyValue(dashed(prop));
      if (!resolved) continue;
      if (DEFAULTS[prop] === resolved) continue;
      out[prop] = resolved;
    }
    return out;
  }

  function dashed(prop: string): string {
    return prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()).replace(/^webkit/, '-webkit');
  }

  function significantClass(el: Element): string | undefined {
    const raw = el.getAttribute('class');
    if (!raw) return undefined;
    const candidates = raw
      .trim()
      .split(/\s+/)
      .filter((c) => c.length > 2 && c.length < 40 && !NOISY_CLASS.test(c));
    if (candidates.length === 0) return undefined;
    // La DERNIERE classe, pas la plus longue : la convention universelle place le
    // modificateur specifique en fin d'attribut. `class="conteneur chiffres"`
    // designe des chiffres, pas un conteneur ; `class="bouton bouton-principal"`
    // designe un bouton principal.
    return candidates[candidates.length - 1];
  }

  function segmentOf(el: Element, pseudo?: 'before' | 'after'): RawSegment {
    const tag = el.tagName.toLowerCase();
    const seg: RawSegment = { tag, index: 1 };
    const anchor = el.getAttribute('data-sfs-id') ?? el.getAttribute('id');
    if (anchor && /^[A-Za-z][\w:.-]*$/.test(anchor)) seg.anchor = anchor;
    const cls = significantClass(el);
    if (cls) seg.cls = cls;
    if (pseudo) seg.pseudo = pseudo;

    // Index parmi les freres de meme balise : reproduit `:nth-of-type`.
    let index = 1;
    let sibling = el.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === el.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    seg.index = index;
    return seg;
  }

  /**
   * L'element est-il entierement decoupe par un ancetre qui masque son
   * debordement ?
   *
   * C'est le mecanisme des accordeons et des panneaux repliables : le contenu
   * reste dans le DOM, visible au sens de `display`, mais son conteneur a une
   * hauteur nulle et `overflow: hidden`. Sans ce controle, une page dont tous
   * les accordeons sont fermes arrive dans Figma entierement dépliée — ce qui ne
   * correspond a rien de ce que voit le visiteur.
   */
  function clippedAway(el: Element, cs: CSSStyleDeclaration): boolean {
    // Un element en position fixe est cale sur la fenetre : le debordement de
    // ses ancetres ne le decoupe pas. C'est le cas d'un en-tete colle en haut de
    // page — l'exclure par erreur le ferait disparaitre de la maquette.
    if (cs.position === 'fixed') return false;

    const own = el.getBoundingClientRect();
    if (own.width <= 0 && own.height <= 0) return false;

    let parent = el.parentElement;
    let profondeur = 0;
    while (parent && profondeur++ < 40) {
      const pcs = getComputedStyle(parent);
      const coupeX = pcs.overflowX === 'hidden' || pcs.overflowX === 'clip';
      const coupeY = pcs.overflowY === 'hidden' || pcs.overflowY === 'clip';
      if (coupeX || coupeY) {
        const zone = parent.getBoundingClientRect();
        const largeur = Math.min(own.right, zone.right) - Math.max(own.left, zone.left);
        const hauteur = Math.min(own.bottom, zone.bottom) - Math.max(own.top, zone.top);

        /*
         * Condition volontairement etroite : le conteneur doit etre REPLIE,
         * c'est-a-dire de taille quasi nulle sur l'axe masque.
         *
         * C'est exactement la signature d'un accordeon ferme (`max-height: 0`).
         * Se contenter de « l'element est hors du cadre » serait beaucoup trop
         * large : les bibliotheques de defilement fluide enveloppent toute la
         * page dans un conteneur de la hauteur de l'ecran avec `overflow:
         * hidden`, et tout ce qui se trouve sous la premiere zone visible —
         * y compris le pied de page — disparaitrait de la maquette.
         *
         * Une diapositive hors cadre est donc conservee : Figma la decoupera de
         * toute facon avec la frame. Mieux vaut un element de trop qu'une page
         * amputee.
         */
        if (coupeY && zone.height <= 4 && hauteur <= 0.5) return true;
        if (coupeX && zone.width <= 4 && largeur <= 0.5) return true;
      }
      parent = parent.parentElement;
    }
    return false;
  }

  /**
   * Rend le MOTIF du rejet, ou `null` si l'element doit etre emis.
   *
   * Un booleen suffisait tant qu'on ne demandait pas de comptes. Des lors qu'un
   * element manque dans Figma, la seule question utile est « pourquoi ? » : le
   * motif est donc produit ici, la ou la decision est prise.
   */
  function raisonNonRendu(
    el: Element,
    cs: CSSStyleDeclaration,
    rect: RawRect,
  ): string | null {
    if (cs.display === 'none') return 'display: none';
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'visibility: hidden';
    if (parseFloat(cs.opacity || '1') === 0) return 'opacity: 0';
    if (rect.w <= 0 && rect.h <= 0) {
      // Un conteneur a taille nulle peut malgre tout contenir du contenu
      // deborde (rare mais reel) : on le garde s'il a des enfants rendus.
      return el.children.length > 0 ? null : 'taille nulle';
    }
    // Technique de masquage accessible courante : on ne veut pas de ce texte
    // au milieu de la maquette.
    if (rect.w <= 1 && rect.h <= 1 && (cs.position === 'absolute' || cs.position === 'fixed')) {
      return 'masque accessible (1 px)';
    }
    if (cs.clipPath === 'inset(50%)' || cs.clip === 'rect(0px, 0px, 0px, 0px)') {
      return 'decoupe a zero';
    }
    // `left: -9999px` : l'autre technique de masquage accessible. L'element est
    // entierement a gauche du document, donc invisible — le garder placerait un
    // calque a dix mille pixels du cadre.
    if (rect.x + rect.w <= 0 || rect.y + rect.h <= 0) return 'repousse hors du document';
    // Contenu replié (accordeon, panneau ferme, diapositive hors cadre).
    if (clippedAway(el, cs)) return 'replie dans un parent a debordement masque';
    return null;
  }

  /* --------------------------- texte et runs --------------------------- */

  /**
   * Cet element de niveau ligne fait-il partie du TEXTE, ou est-ce une boite ?
   *
   * `display: inline` est toujours du texte. `inline-block` demande un jugement :
   * un badge ou une puce est une vraie boite visuelle, mais une lettre isolee
   * dans un `<span>` n'est que du texte habille pour etre anime.
   *
   * Le discriminant est la presence visuelle. Sans fond, bordure, ombre ni
   * marge interieure, un `inline-block` ne dessine rien par lui-meme : c'est du
   * texte. Sans cette distinction, un titre decoupe lettre par lettre — procede
   * courant pour les animations d'apparition — produisait un calque par lettre.
   */
  function isInlineForText(el: Element, cs: CSSStyleDeclaration): boolean {
    if (cs.display === 'inline') return true;
    if (cs.display !== 'inline-block' && cs.display !== 'inline-flex') return false;

    const fond = cs.backgroundColor;
    if (fond && fond !== 'rgba(0, 0, 0, 0)' && fond !== 'transparent') return false;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return false;
    if (cs.boxShadow && cs.boxShadow !== 'none') return false;
    for (const cote of ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) {
      if (parseFloat(cs.getPropertyValue(dashed(cote)) || '0') > 0) return false;
    }
    for (const cote of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
      if (parseFloat(cs.getPropertyValue(dashed(cote)) || '0') > 0) return false;
    }
    // Un element de ligne qui porte lui-meme une image ou un vecteur n'est pas
    // du texte.
    if (el.querySelector('img, svg, video, canvas')) return false;
    return true;
  }

  /**
   * Un bloc est « texte seul » si tous ses descendants elements font partie du
   * texte au sens ci-dessus.
   */
  function isTextOnlyBlock(el: Element): boolean {
    if (el.children.length === 0) return (el.textContent ?? '').trim().length > 0;
    let hasText = false;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()) hasText = true;
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    let current = walker.nextNode() as Element | null;
    while (current) {
      const tag = current.tagName;
      if (tag === 'BR' || tag === 'WBR') {
        current = walker.nextNode() as Element | null;
        continue;
      }
      if (SKIP_TAGS.has(tag)) {
        current = walker.nextNode() as Element | null;
        continue;
      }
      if (tag === 'IMG' || tag === 'SVG' || tag === 'svg' || tag === 'VIDEO' || tag === 'CANVAS') {
        return false;
      }
      const cs = getComputedStyle(current);
      if (!isInlineForText(current, cs)) return false;
      current = walker.nextNode() as Element | null;
    }
    return hasText || (el.textContent ?? '').trim().length > 0;
  }

  function normalizeWhitespace(text: string, whiteSpace: string): string {
    if (whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'break-spaces') {
      return text;
    }
    if (whiteSpace === 'pre-line') return text.replace(/[ \t]+/g, ' ');
    return text.replace(/\s+/g, ' ');
  }

  function collectText(el: Element, cs: CSSStyleDeclaration): RawNode['text'] {
    const whiteSpace = cs.whiteSpace || 'normal';
    let characters = '';
    const runs: RawTextRun[] = [];

    const pushRun = (length: number, source: Element): void => {
      if (length === 0) return;
      const scs = getComputedStyle(source);
      const anchor = source.closest('a');
      const run: RawTextRun = {
        start: characters.length - length,
        end: characters.length,
        fontFamily: scs.fontFamily,
        fontSize: scs.fontSize,
        fontWeight: scs.fontWeight,
        fontStyle: scs.fontStyle,
        color: scs.color,
        textDecorationLine: scs.textDecorationLine,
        letterSpacing: scs.letterSpacing,
      };
      const href = anchor?.getAttribute('href');
      if (href) run.href = href;
      // Fusionne avec le run precedent si le style est identique : evite des
      // centaines de plages inutiles sur un paragraphe uniforme.
      const previous = runs[runs.length - 1];
      if (
        previous &&
        previous.end === run.start &&
        previous.fontFamily === run.fontFamily &&
        previous.fontSize === run.fontSize &&
        previous.fontWeight === run.fontWeight &&
        previous.fontStyle === run.fontStyle &&
        previous.color === run.color &&
        previous.textDecorationLine === run.textDecorationLine &&
        previous.letterSpacing === run.letterSpacing &&
        previous.href === run.href
      ) {
        previous.end = run.end;
        return;
      }
      runs.push(run);
    };

    const walk = (parent: Node, styleSource: Element): void => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const piece = normalizeWhitespace(child.textContent ?? '', whiteSpace);
          if (!piece) continue;
          characters += piece;
          pushRun(piece.length, styleSource);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const element = child as Element;
          if (SKIP_TAGS.has(element.tagName)) continue;
          if (element.tagName === 'BR') {
            characters += '\n';
            pushRun(1, styleSource);
            continue;
          }
          walk(element, element);
        }
      }
    };
    walk(el, el);

    if (whiteSpace === 'normal' || whiteSpace === 'nowrap' || whiteSpace === 'pre-line') {
      characters = characters.replace(/^[ \t]+|[ \t]+$/g, '');
    }
    if (!characters) return undefined;

    // Le rectangle de l'element inclut son padding ; celui des lignes de texte
    // est plus juste pour positionner un noeud texte dans Figma.
    const range = document.createRange();
    range.selectNodeContents(el);
    const bounds = unionRects(range.getClientRects());
    range.detach?.();

    const lineHeight = parseFloat(cs.lineHeight);
    const lineCount =
      bounds && Number.isFinite(lineHeight) && lineHeight > 0
        ? Math.max(1, Math.round(bounds.h / lineHeight))
        : 1;

    const family = cs.fontFamily;
    const key = family + '|' + cs.fontWeight + '|' + cs.fontStyle;
    const existing = fontUse.get(key);
    if (existing) existing.count++;
    else fontUse.set(key, { family, weight: cs.fontWeight, style: cs.fontStyle, count: 1 });

    return { characters, runs, bounds, lineCount };
  }

  /* ------------------------------- assets ------------------------------ */

  function backgroundImages(cs: CSSStyleDeclaration, rect: RawRect): RawNode['images'] {
    const out: RawNode['images'] = [];
    const value = cs.backgroundImage;
    if (!value || value === 'none') return out;
    // On ne remonte que les vraies images : les gradients sont traites comme
    // des remplissages vectoriels, pas comme des assets.
    const pattern = /url\((['"]?)([^'")]+)\1\)/g;
    let match = pattern.exec(value);
    while (match) {
      const src = match[2]!;
      if (!src.startsWith('data:image/svg+xml') || src.length < 40000) {
        out.push({
          src: new URL(src, document.baseURI).href,
          naturalWidth: Math.round(rect.w),
          naturalHeight: Math.round(rect.h),
          alt: '',
          origin: 'background',
          objectFit: cs.backgroundSize === 'contain' ? 'contain' : 'cover',
        });
      }
      match = pattern.exec(value);
    }
    return out;
  }

  function cleanSvg(el: SVGElement): string | undefined {
    const clone = el.cloneNode(true) as SVGElement;
    // Les scripts et gestionnaires n'ont aucun sens dans un asset de maquette.
    clone.querySelectorAll('script').forEach((n) => n.remove());
    const strip = (node: Element): void => {
      for (const attr of Array.from(node.attributes)) {
        if (attr.name.startsWith('on')) node.removeAttribute(attr.name);
      }
      Array.from(node.children).forEach(strip);
    };
    strip(clone);

    // Sans viewBox, Figma importe le SVG a une taille arbitraire.
    if (!clone.getAttribute('viewBox')) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        clone.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
      }
    }
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const markup = clone.outerHTML;
    if (markup.length > 500000) {
      warnings.push('Un SVG inline depasse 500 ko et a ete ignore.');
      return undefined;
    }
    return markup;
  }

  /* ------------------------ verifications a11y ------------------------- */

  function a11yIssues(el: Element, cs: CSSStyleDeclaration): string[] | undefined {
    const issues: string[] = [];
    if (el.tagName === 'IMG' && !el.hasAttribute('alt')) {
      issues.push("Image sans attribut alt");
    }
    if (el.tagName === 'A' && !(el.textContent ?? '').trim() && !el.getAttribute('aria-label')) {
      issues.push('Lien sans intitule accessible');
    }
    if (el.tagName === 'BUTTON' && !(el.textContent ?? '').trim() && !el.getAttribute('aria-label')) {
      issues.push('Bouton sans intitule accessible');
    }
    const fontSize = parseFloat(cs.fontSize);
    if (Number.isFinite(fontSize) && fontSize > 0 && fontSize < 12 && (el.textContent ?? '').trim()) {
      issues.push(`Texte a ${cs.fontSize} : sous le seuil de lisibilite`);
    }
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      const id = el.getAttribute('id');
      const labelled =
        el.getAttribute('aria-label') ??
        el.getAttribute('aria-labelledby') ??
        (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null);
      if (!labelled && !el.closest('label')) issues.push('Champ de formulaire sans etiquette');
    }
    return issues.length ? issues : undefined;
  }

  /* ---------------------------- pseudo-elements ------------------------ */

  function pseudoNode(el: Element, which: 'before' | 'after'): RawNode | null {
    const cs = getComputedStyle(el, '::' + which);
    const content = cs.content;
    if (!content || content === 'none' || content === 'normal') return null;
    const hasBox =
      (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') ||
      cs.backgroundImage !== 'none' ||
      parseFloat(cs.borderTopWidth || '0') > 0 ||
      parseFloat(cs.width || '0') > 0;
    const textContent = /^["'](.*)["']$/s.exec(content)?.[1] ?? '';
    if (!hasBox && !textContent) return null;

    // Les pseudo-elements n'ont pas de rectangle mesurable : on les place dans
    // le coin de leur hote et on laisse l'auto-layout Figma faire le reste.
    const host = docRect(el);
    const width = parseFloat(cs.width || '0') || 0;
    const height = parseFloat(cs.height || '0') || parseFloat(cs.fontSize || '0') || 0;
    const node: RawNode = {
      seg: segmentOf(el, which),
      rect: { x: host.x, y: host.y, w: width, h: height },
      style: pickStyle(cs),
      declared: { inlineLevel: true },
      images: backgroundImages(cs, { x: host.x, y: host.y, w: width, h: height }),
      children: [],
    };
    if (textContent) {
      node.text = {
        characters: textContent,
        runs: [
          {
            start: 0,
            end: textContent.length,
            fontFamily: cs.fontFamily,
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            fontStyle: cs.fontStyle,
            color: cs.color,
            textDecorationLine: cs.textDecorationLine,
            letterSpacing: cs.letterSpacing,
          },
        ],
        bounds: null,
        lineCount: 1,
      };
    }
    emitted++;
    return node;
  }

  /* ------------------------------- releves ----------------------------- */

  const rejets: RawDiscard[] = [];
  const decales: RawShift[] = [];

  /** `section.hero` : court, mais suffisant pour retrouver l'element. */
  function decrire(el: Element): string {
    const cls = Array.from(el.classList)
      .filter((c) => !/^(ng|css|sc|jsx|svelte|v)-[a-z0-9]{4,}$/i.test(c))
      .slice(0, 2)
      .join('.');
    return el.tagName.toLowerCase() + (cls ? `.${cls}` : '');
  }

  /**
   * Retient un rejet s'il est SIGNIFICATIF : assez grand pour se voir, ou
   * porteur de texte. Les milliers de pixels d'icones masquees n'apprennent
   * rien ; un heros de 1440x800 disparu, si.
   */
  function noterRejet(el: Element, rect: RawRect, reason: string): void {
    if (rejets.length >= 400) return;
    const texte = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    const grand = rect.w >= 60 && rect.h >= 30;
    if (!grand && texte.length === 0) return;
    rejets.push({
      what: decrire(el),
      rect,
      reason,
      ...(texte ? { text: texte.slice(0, 80) } : {}),
    });
  }

  /**
   * Une transformation encore active au moment de la mesure decale la boite :
   * `getBoundingClientRect` rend la position TRANSFORMEE. Une apparition au
   * defilement pilotee en JavaScript echappe au gel des animations CSS, et la
   * maquette herite alors du decalage. On le releve pour pouvoir le dire.
   */
  function noterDecalage(el: Element, cs: CSSStyleDeclaration, rect: RawRect): void {
    if (decales.length >= 200) return;
    const t = cs.transform;
    if (!t || t === 'none') return;
    const nombres = t.slice(t.indexOf('(') + 1, -1).split(',').map((n) => parseFloat(n));
    // matrix(a,b,c,d,tx,ty) ou matrix3d(...) : la translation est en 5e/6e
    // position, ou en 13e/14e pour la forme 3D.
    const [dx, dy] = nombres.length >= 16 ? [nombres[12], nombres[13]] : [nombres[4], nombres[5]];
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (Math.abs(dx!) < 2 && Math.abs(dy!) < 2) return;
    if (rect.w < 40 && rect.h < 20) return;
    // `translate(-50%, -50%)` et ses variantes sur un seul axe : c'est un
    // centrage, pas une apparition en vol. Le signaler noierait le releve.
    const centreX = Math.abs(dx!) < 1 || Math.abs(dx! + rect.w / 2) < 1;
    const centreY = Math.abs(dy!) < 1 || Math.abs(dy! + rect.h / 2) < 1;
    if (centreX && centreY) return;
    decales.push({
      what: decrire(el),
      rect,
      dx: Math.round(dx! * 10) / 10,
      dy: Math.round(dy! * 10) / 10,
    });
  }

  /* ------------------------------ parcours ----------------------------- */

  function walk(el: Element, depth: number): RawNode | null {
    visited++;
    if (SKIP_TAGS.has(el.tagName)) {
      skipped++;
      return null;
    }
    if (emitted >= options.maxNodes) {
      truncated = true;
      return null;
    }
    if (depth > 120) {
      warnings.push('Profondeur DOM superieure a 120 niveaux : sous-arbre tronque.');
      return null;
    }

    const cs = getComputedStyle(el);
    const rect = docRect(el);
    const raison = raisonNonRendu(el, cs, rect);
    if (raison !== null) {
      skipped++;
      noterRejet(el, rect, raison);
      return null;
    }
    noterDecalage(el, cs, rect);

    const node: RawNode = {
      seg: segmentOf(el),
      rect,
      style: pickStyle(cs),
      declared: declaredFor(el, cs, rect),
      images: [],
      children: [],
    };
    emitted++;

    const role = el.getAttribute('role');
    if (role) node.role = role;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) node.ariaLabel = ariaLabel;
    if (el.getAttribute('aria-hidden') === 'true') node.ariaHidden = true;
    const issues = a11yIssues(el, cs);
    if (issues) node.a11y = issues;

    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowX === 'scroll') {
      node.scrolls = true;
    }

    if (el.tagName === 'A') {
      const href = el.getAttribute('href');
      if (href) {
        node.link = href;
        try {
          const url = new URL(href, document.baseURI);
          if (url.origin === location.origin && /^https?:$/.test(url.protocol)) {
            links.add(url.pathname + url.search);
          }
        } catch {
          /* href non analysable (mailto:, tel:, javascript:) */
        }
      }
    }

    node.images.push(...backgroundImages(cs, rect));

    /* --- feuilles specialisees : image, svg, media, champ de formulaire --- */

    if (el.tagName === 'IMG') {
      const img = el as HTMLImageElement;
      const src = img.currentSrc || img.src;
      if (src) {
        node.images.unshift({
          src,
          naturalWidth: img.naturalWidth || Math.round(rect.w),
          naturalHeight: img.naturalHeight || Math.round(rect.h),
          alt: img.getAttribute('alt') ?? '',
          origin: 'img',
          objectFit: cs.objectFit,
        });
      }
      return node;
    }

    if (el instanceof SVGSVGElement) {
      const svg = cleanSvg(el);
      if (svg) node.svg = svg;
      return node;
    }

    if (el.tagName === 'VIDEO') {
      const video = el as HTMLVideoElement;

      /*
       * Une vidéo de fond ne peut pas entrer dans Figma. Mais laisser un cadre
       * vide est bien pire : sur un site dont l'accueil est une vidéo plein
       * écran, c'est tout le héros qui disparaît et la maquette devient
       * méconnaissable.
       *
       * On capture donc l'image affichée à cet instant précis, en la peignant
       * sur un canvas. C'est exactement ce que voit le visiteur.
       */
      let capturee = false;
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        try {
          const canvas = document.createElement('canvas');
          // 1600 px suffit largement pour une maquette, et borne le poids de
          // l'image encodée en base64.
          const largeur = Math.min(video.videoWidth, 1600);
          canvas.width = largeur;
          canvas.height = Math.max(1, Math.round((largeur * video.videoHeight) / video.videoWidth));
          const contexte = canvas.getContext('2d');
          if (contexte) {
            contexte.drawImage(video, 0, 0, canvas.width, canvas.height);
            // `toDataURL` échoue si la vidéo vient d'une autre origine sans
            // CORS : le canvas est alors « teinté ». D'où le try/catch.
            const donnees = canvas.toDataURL('image/jpeg', 0.85);
            if (donnees.length > 100) {
              node.images.unshift({
                src: donnees,
                naturalWidth: canvas.width,
                naturalHeight: canvas.height,
                alt: 'Image extraite de la video',
                origin: 'poster',
                objectFit: cs.objectFit,
              });
              capturee = true;
              warnings.push(
                'Une video a ete rendue par une image fixe extraite de sa lecture. Le mouvement est a re-implementer en code.',
              );
            }
          }
        } catch {
          warnings.push(
            "Une video d'une autre origine n'a pas pu etre capturee (restriction de securite du navigateur).",
          );
        }
      }

      if (!capturee) {
        const poster = video.getAttribute('poster');
        if (poster) {
          node.images.unshift({
            src: new URL(poster, document.baseURI).href,
            naturalWidth: Math.round(rect.w),
            naturalHeight: Math.round(rect.h),
            alt: 'Affiche de la video',
            origin: 'poster',
          });
        } else {
          warnings.push(
            "Une video sans image d'affiche laisse un cadre vide dans la maquette.",
          );
        }
      }
      return node;
    }

    if (el.tagName === 'CANVAS' || el.tagName === 'IFRAME' || el.tagName === 'OBJECT') {
      // Contenu non extractible : on garde la boite, le developpeur saura.
      warnings.push(`<${el.tagName.toLowerCase()}> rendu comme boite vide (contenu non extractible).`);
      return node;
    }

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const field = el as HTMLInputElement;
      const shown = field.value || field.placeholder || '';
      if (shown) {
        node.text = {
          characters: shown,
          runs: [
            {
              start: 0,
              end: shown.length,
              fontFamily: cs.fontFamily,
              fontSize: cs.fontSize,
              fontWeight: cs.fontWeight,
              fontStyle: cs.fontStyle,
              color: field.value ? cs.color : 'rgb(140, 140, 140)',
              textDecorationLine: 'none',
              letterSpacing: cs.letterSpacing,
            },
          ],
          bounds: null,
          lineCount: 1,
        };
      }
      return node;
    }

    /* --- bloc de texte pur : un seul noeud texte, avec ses plages de style --- */

    if (isTextOnlyBlock(el)) {
      const text = collectText(el, cs);
      if (text) {
        node.text = text;
        const before = pseudoNode(el, 'before');
        const after = pseudoNode(el, 'after');
        if (before) node.children.push(before);
        if (after) node.children.push(after);
        return node;
      }
    }

    /* ----------------------------- descente ----------------------------- */

    const before = pseudoNode(el, 'before');
    if (before) node.children.push(before);

    for (const child of Array.from(el.children)) {
      const built = walk(child, depth + 1);
      if (built) node.children.push(built);
    }

    /*
     * Shadow DOM.
     *
     * Un site construit en Web Components place son contenu dans un arbre
     * parallele, invisible depuis `element.children`. Sans cette descente, un
     * composant `<mon-entete>` ne produit qu'un noeud vide : l'en-tete, le pied
     * de page, voire des pages entieres disparaissent de la maquette sans le
     * moindre message d'erreur.
     *
     * Seuls les arbres ouverts (`mode: 'open'`) sont accessibles ; un arbre
     * ferme reste hors de portee, et on le signale.
     */
    const hote = el as Element & { shadowRoot?: ShadowRoot | null };
    if (hote.shadowRoot) {
      shadowRootsVisites++;
      for (const child of Array.from(hote.shadowRoot.children)) {
        const built = walk(child, depth + 1);
        if (built) node.children.push(built);
      }
    } else if (el.tagName.includes('-') && el.children.length === 0 && !node.text) {
      // Un element personnalise sans enfant ni texte : tres probablement un
      // arbre ferme, dont le contenu est definitivement inaccessible.
      shadowRootsFermes++;
    }

    // Texte nu melange a des blocs (`<div>Bonjour <section>...</section></div>`) :
    // rare, mais il ne faut pas le perdre.
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== Node.TEXT_NODE) continue;
      const piece = normalizeWhitespace(child.textContent ?? '', cs.whiteSpace).trim();
      if (!piece) continue;
      const range = document.createRange();
      range.selectNode(child);
      const bounds = unionRects(range.getClientRects());
      range.detach?.();
      node.children.push({
        seg: { tag: '#text', index: node.children.length + 1 },
        rect: bounds ?? { x: rect.x, y: rect.y, w: rect.w, h: parseFloat(cs.lineHeight) || 20 },
        // Uniquement les proprietes de texte : heriter du style complet du parent
        // donnerait un noeud texte porteur d'un `display: flex`, donc d'un
        // auto-layout absurde dans Figma.
        style: textOnlyStyle(node.style),
        declared: { inlineLevel: true },
        images: [],
        children: [],
        text: {
          characters: piece,
          runs: [
            {
              start: 0,
              end: piece.length,
              fontFamily: cs.fontFamily,
              fontSize: cs.fontSize,
              fontWeight: cs.fontWeight,
              fontStyle: cs.fontStyle,
              color: cs.color,
              textDecorationLine: cs.textDecorationLine,
              letterSpacing: cs.letterSpacing,
            },
          ],
          bounds,
          lineCount: 1,
        },
      });
      emitted++;
    }

    const after = pseudoNode(el, 'after');
    if (after) node.children.push(after);

    reordonnerParProfondeur(node, el);
    return node;
  }

  /**
   * Remet les enfants dans l'ordre de PEINTURE.
   *
   * Figma n'a pas de `z-index` : seul l'ordre des calques decide de ce qui passe
   * devant, le dernier etant au-dessus. En CSS, un element positionne passe
   * devant le contenu dans le flux, quel que soit son rang dans le document.
   *
   * Sans ce reclassement, un en-tete `position: fixed` declare en debut de
   * document se retrouve DERRIERE l'image du heros qui le suit — visible dans
   * l'arborescence des calques, invisible a l'ecran.
   *
   * Seuls les enfants hors flux sont deplaces : reordonner les autres
   * changerait la mise en page, et non son empilement.
   */
  function reordonnerParProfondeur(node: RawNode, el: Element): void {
    if (node.children.length < 2) return;

    const rang = new Map<RawNode, number>();
    let horsFlux = 0;
    for (const enfant of node.children) {
      const position = enfant.style.position ?? 'static';
      const positionne = position !== 'static';
      if (!positionne) {
        rang.set(enfant, 0);
        continue;
      }
      horsFlux++;
      const z = enfant.style.zIndex;
      const valeur = z && z !== 'auto' ? parseInt(z, 10) : 0;
      // Les elements positionnes passent devant le flux normal ; entre eux,
      // c'est le z-index qui tranche.
      rang.set(enfant, Number.isFinite(valeur) ? Math.max(1, valeur + 1) : 1);
    }
    if (horsFlux === 0) return;

    // Tri stable : a rang egal, l'ordre du document est conserve.
    const ordonne = node.children
      .map((enfant, index) => ({ enfant, index }))
      .sort((a, b) => (rang.get(a.enfant)! - rang.get(b.enfant)!) || a.index - b.index)
      .map((entree) => entree.enfant);
    node.children = ordonne;
    void el;
  }

  /* -------------------------- variables CSS :root ---------------------- */

  function readRootVariables(): {
    computed: Record<string, string>;
    declared: Record<string, string>;
  } {
    const out: Record<string, string> = {};
    const declaredValues: Record<string, string> = {};
    const rootStyle = getComputedStyle(document.documentElement);

    // `computedStyleMap` ne liste pas les proprietes personnalisees dans tous
    // les navigateurs : on collecte les noms depuis les feuilles de style, puis
    // on lit la valeur calculee (qui tient compte des surcharges en cascade).
    const names = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        // Feuille d'une autre origine : illisible, on passe.
        continue;
      }
      const scan = (list: CSSRuleList): void => {
        for (const rule of Array.from(list)) {
          if (rule instanceof CSSStyleRule) {
            // La regle s'applique-t-elle vraiment a l'element racine ? Sans ce
            // test, les declarations de `:root[data-theme="dark"]` etaient
            // relevees alors que le theme sombre n'est pas actif — les valeurs
            // sombres se retrouvaient enregistrees comme valeurs claires.
            let applies = false;
            try {
              applies = document.documentElement.matches(rule.selectorText);
            } catch {
              applies = false;
            }
            for (const prop of Array.from(rule.style)) {
              if (!prop.startsWith('--')) continue;
              names.add(prop);
              if (!applies) continue;
              // Valeur telle qu'ecrite : `var(--autre)` est conserve, ce qui
              // permet de reproduire l'alias dans Figma. La derniere regle
              // applicable gagne, comme dans la cascade.
              const raw = rule.style.getPropertyValue(prop).trim();
              if (raw) declaredValues[prop] = raw;
            }
          } else if ('cssRules' in rule) {
            scan((rule as unknown as CSSGroupingRule).cssRules);
          }
        }
      };
      scan(rules);
    }
    for (const attr of Array.from(document.documentElement.style)) {
      if (!attr.startsWith('--')) continue;
      names.add(attr);
      const raw = document.documentElement.style.getPropertyValue(attr).trim();
      if (raw) declaredValues[attr] = raw;
    }

    for (const name of names) {
      const value = rootStyle.getPropertyValue(name).trim();
      if (value) out[name] = value;
    }
    return { computed: out, declared: declaredValues };
  }

  /* ------------------------------ resultat ----------------------------- */

  const rootVariables = readRootVariables();
  const root = walk(document.body, 0);

  // Apres le parcours, pas avant : les compteurs ne sont renseignes que par
  // `walk`. Les placer plus haut les lisait a zero.
  if (shadowRootsFermes > 0) {
    warnings.push(
      `${shadowRootsFermes} composants utilisent un Shadow DOM ferme : leur contenu est inaccessible et manquera dans la maquette.`,
    );
  }
  if (!root) {
    throw new Error("Le <body> de la page n'a produit aucun noeud : page vide ou masquee.");
  }

  // La frame racine couvre toute la page, pas seulement le body (qui peut avoir
  // des marges ou une hauteur inferieure au document).
  const documentHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    root.rect.y + root.rect.h,
  );

  const pageBackground = (() => {
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)') return bodyBg;
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    if (htmlBg && htmlBg !== 'rgba(0, 0, 0, 0)') return htmlBg;
    return 'rgb(255, 255, 255)';
  })();
  root.style.backgroundColor = root.style.backgroundColor ?? pageBackground;

  return {
    route: location.pathname + location.search,
    title: document.title,
    lang: document.documentElement.lang || '',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentHeight,
    root,
    rootVariables: rootVariables.computed,
    rootVariablesDeclared: rootVariables.declared,
    fonts: Array.from(fontUse.values()).sort((a, b) => b.count - a.count),
    links: Array.from(links),
    // Les plus grands d'abord : c'est ce qui manque le plus a l'oeil.
    discards: rejets.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h).slice(0, 40),
    shifted: decales.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h).slice(0, 25),
    stats: { visited, emitted, skipped, truncated, shadowRootsVisites, shadowRootsFermes },
    warnings: Array.from(new Set(warnings)),
  };
}
