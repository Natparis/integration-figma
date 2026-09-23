/**
 * Rendu d'un `design-spec` en HTML.
 *
 * Ce n'est pas un rendu du site : c'est un rendu de CE QUE L'EXTRACTEUR A
 * COMPRIS du site, en simulant les regles de Figma. L'auto-layout devient du
 * flexbox — les deux se comportent de la meme facon — et le dimensionnement
 * « fixe / ajuster / remplir » devient `width`, `fit-content` et `flex: 1`.
 *
 * Interet : comparer cette image a une capture reelle de la page separe deux
 * questions qu'on confond sinon. Si elles different, l'extraction est en cause ;
 * si elles se ressemblent mais que Figma differe, c'est l'ecriture qui est en
 * cause. Sans cette distinction, chaque diagnostic est une devinette.
 */

import type { DesignSpec, LayoutSpec, Paint, SpecNode, TextSpec } from '@sfs/spec';

const echapper = (texte: string): string =>
  texte
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const px = (valeur: number): string => `${Math.round(valeur * 100) / 100}px`;

function couleur(paint: Paint): string | null {
  if (paint.type === 'SOLID') {
    const c = paint.color;
    const composante = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
    return `rgba(${composante(c.r)}, ${composante(c.g)}, ${composante(c.b)}, ${paint.opacity})`;
  }
  return null;
}

function fond(fills: Paint[], assets: Map<string, string>): string[] {
  const couches: string[] = [];
  // En CSS le premier plan est en tete ; dans le spec, comme dans Figma, le
  // dernier remplissage est au-dessus. On inverse donc.
  for (const paint of [...fills].reverse()) {
    if (paint.type === 'SOLID') {
      const valeur = couleur(paint);
      if (valeur) couches.push(`linear-gradient(${valeur}, ${valeur})`);
    } else if (paint.type === 'IMAGE') {
      const fichier = assets.get(paint.assetId);
      // Apostrophes et non guillemets : la regle finit dans un attribut
      // `style="..."`, ou un guillemet double refermerait l'attribut et ferait
      // perdre au navigateur tout ce qui suit.
      if (fichier) couches.push(`url('${fichier}')`);
    } else {
      const arrets = paint.stops
        .map((s) => {
          const c = s.color;
          const composante = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
          return `rgba(${composante(c.r)}, ${composante(c.g)}, ${composante(c.b)}, ${c.a}) ${Math.round(s.position * 100)}%`;
        })
        .join(', ');
      const type = paint.type === 'GRADIENT_RADIAL' ? 'radial-gradient(circle, ' : `linear-gradient(${paint.angle}deg, `;
      couches.push(`${type}${arrets})`);
    }
  }
  return couches;
}

const ALIGNEMENT: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
  BASELINE: 'baseline',
};

/** Traduit le dimensionnement Figma en CSS, axe par axe. */
function dimensionner(node: SpecNode, parent: LayoutSpec | null): string[] {
  const regles: string[] = [];
  const { horizontal, vertical } = node.layout.sizing;
  const parentHorizontal = parent?.mode === 'HORIZONTAL';
  const horsFlux = node.layout.positioning === 'ABSOLUTE';

  const appliquer = (axe: 'horizontal' | 'vertical', mode: string): void => {
    const principal = axe === (parentHorizontal ? 'horizontal' : 'vertical');
    const propriete = axe === 'horizontal' ? 'width' : 'height';
    const taille = axe === 'horizontal' ? node.box.w : node.box.h;

    if (horsFlux || !parent || parent.mode === 'NONE') {
      regles.push(`${propriete}: ${px(taille)}`);
      return;
    }
    if (mode === 'FILL') {
      if (principal) regles.push('flex: 1 1 0', `${propriete}: auto`);
      else regles.push('align-self: stretch', `${propriete}: auto`);
      // Conteneur de contenu plafonne (`max-width` + `margin: 0 auto`) : sans
      // marges automatiques, l'element s'etire puis se cale a gauche au lieu de
      // rester centre. C'est le motif de mise en page le plus repandu du web.
      if (
        axe === 'horizontal' &&
        node.layout.maxWidth !== undefined &&
        parent?.counterAxisAlignItems === 'CENTER'
      ) {
        regles.push('margin-left: auto', 'margin-right: auto');
      }
      return;
    }
    if (mode === 'HUG') {
      // `fit-content` n'a de sens que si le noeud dispose lui-meme d'un
      // auto-layout. Sans cela ses enfants sont positionnes en absolu, ne
      // participent a aucun flux, et la boite se reduit a zero — l'image du
      // heros disparaissait ainsi completement. Figma applique la meme regle.
      if (node.layout.mode === 'NONE' && node.children.length > 0) {
        regles.push(`${propriete}: ${px(taille)}`, 'flex: 0 0 auto');
        return;
      }
      regles.push(`${propriete}: fit-content`, 'flex: 0 0 auto');
      return;
    }
    regles.push(`${propriete}: ${px(taille)}`, 'flex: 0 0 auto');
  };

  appliquer('horizontal', horizontal);
  appliquer('vertical', vertical);
  return regles;
}

function texteEnCss(text: TextSpec): string[] {
  const regles = [
    `font-family: '${text.font.family.replace(/'/g, '')}', system-ui, sans-serif`,
    `font-size: ${px(text.font.size)}`,
    `font-weight: ${text.font.weight}`,
  ];
  if (text.font.italic) regles.push('font-style: italic');
  if (text.font.lineHeight.unit === 'PIXELS' && text.font.lineHeight.value !== undefined) {
    regles.push(`line-height: ${px(text.font.lineHeight.value)}`);
  } else if (text.font.lineHeight.unit === 'PERCENT' && text.font.lineHeight.value !== undefined) {
    regles.push(`line-height: ${text.font.lineHeight.value}%`);
  }
  if (text.font.letterSpacing.value !== 0) {
    regles.push(
      text.font.letterSpacing.unit === 'PIXELS'
        ? `letter-spacing: ${px(text.font.letterSpacing.value)}`
        : `letter-spacing: ${text.font.letterSpacing.value / 100}em`,
    );
  }
  const remplissage = text.fills[0];
  if (remplissage) {
    const c = couleur(remplissage);
    if (c) regles.push(`color: ${c}`);
  }
  regles.push(`text-align: ${text.textAlignHorizontal.toLowerCase()}`);
  if (text.textCase === 'UPPER') regles.push('text-transform: uppercase');
  if (text.textCase === 'LOWER') regles.push('text-transform: lowercase');
  if (text.textCase === 'TITLE') regles.push('text-transform: capitalize');
  if (text.textDecoration === 'UNDERLINE') regles.push('text-decoration: underline');
  if (text.textDecoration === 'STRIKETHROUGH') regles.push('text-decoration: line-through');
  regles.push('white-space: pre-wrap', 'margin: 0');
  return regles;
}

/**
 * Assemble les regles en valeur d'attribut `style`.
 *
 * Le remplacement des guillemets doubles est un filet de securite : un seul
 * guillemet oublie refermerait l'attribut et le navigateur abandonnerait
 * silencieusement toutes les regles suivantes — police, taille, image comprises.
 */
function securiser(regles: string[]): string {
  return regles.join('; ').replace(/"/g, "'");
}

function noeudEnHtml(
  node: SpecNode,
  parent: SpecNode | null,
  assets: Map<string, string>,
  profondeur: number,
): string {
  const regles: string[] = ['box-sizing: border-box'];
  const layout = node.layout;

  /* --------------------------- positionnement --------------------------- */

  if (layout.positioning === 'ABSOLUTE' && parent) {
    regles.push(
      'position: absolute',
      `left: ${px(node.box.x - parent.box.x)}`,
      `top: ${px(node.box.y - parent.box.y)}`,
    );
  } else if (parent && parent.layout.mode === 'NONE') {
    // Parent sans auto-layout : les enfants gardent leur position mesuree.
    regles.push(
      'position: absolute',
      `left: ${px(node.box.x - parent.box.x)}`,
      `top: ${px(node.box.y - parent.box.y)}`,
    );
  } else {
    regles.push('position: relative');
  }

  /* ------------------------------ disposition --------------------------- */

  if (layout.mode !== 'NONE') {
    regles.push(
      'display: flex',
      `flex-direction: ${layout.mode === 'HORIZONTAL' ? 'row' : 'column'}`,
      `justify-content: ${ALIGNEMENT[layout.primaryAxisAlignItems] ?? 'flex-start'}`,
      `align-items: ${ALIGNEMENT[layout.counterAxisAlignItems] ?? 'flex-start'}`,
    );
    if (layout.wrap) regles.push('flex-wrap: wrap');
    if (layout.itemSpacing) regles.push(`gap: ${px(layout.itemSpacing)}`);
    if (layout.wrap && layout.counterAxisSpacing) {
      regles.push(`row-gap: ${px(layout.counterAxisSpacing)}`);
    }
  } else if (node.children.length > 0) {
    regles.push('display: block');
  }

  const [haut, droite, bas, gauche] = layout.padding;
  if (haut || droite || bas || gauche) {
    regles.push(`padding: ${px(haut)} ${px(droite)} ${px(bas)} ${px(gauche)}`);
  }
  if (layout.maxWidth !== undefined) regles.push(`max-width: ${px(layout.maxWidth)}`);
  if (layout.minHeight !== undefined) regles.push(`min-height: ${px(layout.minHeight)}`);
  if (layout.clipsContent) regles.push('overflow: hidden');

  regles.push(...dimensionner(node, parent ? parent.layout : null));

  /* -------------------------------- apparence --------------------------- */

  const couches = fond(node.style.fills, assets);
  if (node.image) {
    const fichier = assets.get(node.image.assetId);
    if (fichier) {
      couches.unshift(`url('${fichier}')`);
      regles.push(
        `background-size: ${node.image.scaleMode === 'FIT' ? 'contain' : 'cover'}`,
        'background-position: center',
        'background-repeat: no-repeat',
      );
    }
  }
  if (node.vector) {
    const fichier = assets.get(node.vector.assetId);
    if (fichier) {
      couches.unshift(`url('${fichier}')`);
      regles.push('background-size: contain', 'background-position: center', 'background-repeat: no-repeat');
    }
  }
  if (couches.length > 0) regles.push(`background-image: ${couches.join(', ')}`);

  const contour = node.style.strokes[0];
  if (contour && node.style.strokeWeight > 0) {
    const c = couleur(contour);
    if (c) {
      const individuel = node.style.individualStrokeWeights;
      if (individuel) {
        regles.push(
          `border-top: ${px(individuel.top)} solid ${c}`,
          `border-right: ${px(individuel.right)} solid ${c}`,
          `border-bottom: ${px(individuel.bottom)} solid ${c}`,
          `border-left: ${px(individuel.left)} solid ${c}`,
        );
      } else {
        regles.push(`border: ${px(node.style.strokeWeight)} solid ${c}`);
      }
    }
  }

  const [hg, hd, bd, bg] = node.style.cornerRadius;
  if (hg || hd || bd || bg) {
    regles.push(`border-radius: ${px(hg)} ${px(hd)} ${px(bd)} ${px(bg)}`);
  }

  const ombres = node.style.effects
    .filter((e) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
    .map((e) => {
      const c = e.color
        ? `rgba(${Math.round(e.color.r * 255)}, ${Math.round(e.color.g * 255)}, ${Math.round(e.color.b * 255)}, ${e.color.a})`
        : 'rgba(0,0,0,0.2)';
      const interieur = e.type === 'INNER_SHADOW' ? 'inset ' : '';
      return `${interieur}${px(e.offset?.x ?? 0)} ${px(e.offset?.y ?? 0)} ${px(e.radius)} ${px(e.spread ?? 0)} ${c}`;
    });
  if (ombres.length > 0) regles.push(`box-shadow: ${ombres.join(', ')}`);

  const flou = node.style.effects.find((e) => e.type === 'LAYER_BLUR');
  if (flou) regles.push(`filter: blur(${px(flou.radius)})`);

  if (node.style.opacity < 1) regles.push(`opacity: ${node.style.opacity}`);
  if (!node.style.visible) regles.push('visibility: hidden');

  /* -------------------------------- contenu ----------------------------- */

  const attributs =
    ` data-sid="${echapper(node.sid)}" data-nom="${echapper(node.name)}"` +
    ` data-type="${node.kind}" title="${echapper(node.name)}"`;

  if (node.kind === 'TEXT' && node.text) {
    regles.push(...texteEnCss(node.text));
    return `<div style="${securiser(regles)}"${attributs}>${echapper(node.text.characters)}</div>`;
  }

  const enfants = node.children
    .map((enfant) => noeudEnHtml(enfant, node, assets, profondeur + 1))
    .join('');
  return `<div style="${securiser(regles)}"${attributs}>${enfants}</div>`;
}

/** Rend une frame de breakpoint complete. */
export function rendreFrame(racine: SpecNode, spec: DesignSpec): string {
  const assets = new Map(spec.assets.map((a) => [a.id, a.file]));
  return noeudEnHtml(racine, null, assets, 0);
}
