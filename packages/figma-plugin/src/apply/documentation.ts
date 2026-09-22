/**
 * Page de documentation : la note de passation, a l'interieur du fichier Figma.
 *
 * Elle repond aux questions qu'un developpeur pose toujours en decouvrant une
 * maquette : d'ou vient-elle, a quelle date, que signifient ces pages, ou sont
 * les tokens, et qu'est-ce qui n'a PAS pu etre reproduit fidelement. Le dernier
 * point est le plus important : les limites ecrites evitent des heures perdues.
 */

import type { DesignSpec } from '@sfs/spec';
import type { SyncContext } from '../context.js';
import { ensurePage } from './pages.js';

const PAGE_WIDTH = 900;
const INK: RGB = { r: 0.06, g: 0.09, b: 0.16 };
const MUTED: RGB = { r: 0.42, g: 0.45, b: 0.5 };
const WARN: RGB = { r: 0.72, g: 0.35, b: 0.05 };

interface Typography {
  regular: FontName;
  medium: FontName;
  bold: FontName;
}

/** Trouve une famille lisible reellement installee. */
async function pickTypography(context: SyncContext): Promise<Typography> {
  const available = await figma.listAvailableFontsAsync();
  const families = new Set(available.map((entry) => entry.fontName.family));
  const family = ['Inter', 'Roboto', 'Arial', 'Helvetica'].find((name) => families.has(name));
  if (!family) {
    const first = available[0]?.fontName ?? { family: 'Roboto', style: 'Regular' };
    return { regular: first, medium: first, bold: first };
  }
  const styles = new Set(
    available.filter((entry) => entry.fontName.family === family).map((entry) => entry.fontName.style),
  );
  const pick = (...candidates: string[]): FontName => ({
    family,
    style: candidates.find((style) => styles.has(style)) ?? 'Regular',
  });
  const typography = {
    regular: pick('Regular'),
    medium: pick('Medium', 'Regular'),
    bold: pick('Bold', 'Semi Bold', 'Medium', 'Regular'),
  };
  for (const font of [typography.regular, typography.medium, typography.bold]) {
    try {
      await figma.loadFontAsync(font);
    } catch (error) {
      context.warnings.push(`Police de documentation non chargee : ${String(error)}`);
    }
  }
  return typography;
}

export async function writeDocumentation(
  spec: DesignSpec,
  pageName: string,
  context: SyncContext,
): Promise<void> {
  const page = await ensurePage(pageName);
  // La page est reconstruite a chaque synchronisation : elle doit refleter
  // l'etat courant, pas un empilement d'etats successifs.
  for (const child of [...page.children]) child.remove();

  const type = await pickTypography(context);

  const root = figma.createFrame();
  root.name = 'Note de passation';
  page.appendChild(root);
  root.layoutMode = 'VERTICAL';
  root.itemSpacing = 28;
  root.paddingTop = 56;
  root.paddingBottom = 56;
  root.paddingLeft = 56;
  root.paddingRight = 56;
  root.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  root.resize(PAGE_WIDTH, 100);
  root.layoutSizingHorizontal = 'FIXED';
  root.layoutSizingVertical = 'HUG';
  root.x = 0;
  root.y = 0;

  const text = (
    content: string,
    size: number,
    font: FontName,
    color: RGB = INK,
  ): TextNode => {
    const node = figma.createText();
    root.appendChild(node);
    node.fontName = font;
    node.characters = content;
    node.fontSize = size;
    node.fills = [{ type: 'SOLID', color }];
    node.layoutSizingHorizontal = 'FILL';
    node.layoutSizingVertical = 'HUG';
    return node;
  };

  const heading = (content: string): void => {
    const node = text(content, 22, type.bold);
    node.lineHeight = { unit: 'PERCENT', value: 130 };
  };
  const body = (content: string, color: RGB = INK): void => {
    const node = text(content, 14, type.regular, color);
    node.lineHeight = { unit: 'PERCENT', value: 160 };
  };

  /* --------------------------------- en-tete ------------------------------ */

  const title = text('Maquette generee depuis le site', 34, type.bold);
  title.lineHeight = { unit: 'PERCENT', value: 120 };

  body(
    [
      `Source            ${spec.source.root}`,
      `Extrait le        ${formatDate(spec.generatedAt)}`,
      `Revision          ${spec.revision}`,
      `Outil             site-to-figma-sync ${spec.source.extractorVersion}`,
    ].join('\n'),
    MUTED,
  );

  body(
    [
      `${spec.stats.pages} pages · ${spec.stats.breakpoints} frames · ${spec.stats.nodes} couches`,
      `${spec.stats.variables} variables · ${spec.textStyles.length} styles de texte · ${spec.effectStyles.length} styles d'effet`,
      `${spec.stats.components} composants · ${spec.stats.assets} assets`,
    ].join('\n'),
  );

  /* ------------------------------ mode d'emploi --------------------------- */

  heading('Comment lire ce fichier');
  body(
    [
      '• Une page Figma par page du site. Les frames y sont posees cote a cote, une par largeur d ecran.',
      '• Les frames sont en auto-layout : leur direction, leurs espacements et leurs marges viennent du CSS reel du site.',
      '• « Remplir le conteneur » correspond a un element de bloc qui occupe la largeur de son parent ; « Ajuster au contenu » a un element de niveau ligne.',
      '• Les couleurs sont liees aux variables de la collection de tokens : changer une variable met a jour toute la maquette.',
      '• Les noms de couches reprennent la semantique HTML (balise, intitule accessible, titre de section) pour que vous retrouviez vos reperes dans le code.',
      '• Le panneau Dev Mode affiche, pour les couches structurantes, le selecteur CSS d origine et les proprietes calculees.',
    ].join('\n'),
  );

  /* -------------------------------- pages --------------------------------- */

  heading('Pages et largeurs');
  body(
    spec.pages
      .map(
        (page) =>
          `${page.name}\n    ${page.route}  —  ${page.breakpoints
            .map((bp) => `${bp.name} ${bp.width}px`)
            .join(' · ')}`,
      )
      .join('\n'),
  );

  /* -------------------------------- tokens -------------------------------- */

  if (spec.tokens.length > 0) {
    const collection = spec.tokens[0]!;
    heading('Design tokens');
    const fromCss = collection.variables.filter((variable) => variable.cssVariable).length;
    const inferred = collection.variables.length - fromCss;
    const aliases = collection.variables.filter((variable) => variable.aliasOf);
    body(
      [
        `Collection « ${collection.name} » · modes : ${collection.modes.join(', ')}`,
        `${fromCss} variables reprises telles quelles des variables CSS du site (memes noms que dans votre code).`,
        inferred > 0 ? `${inferred} deduites par analyse, faute de declaration dans le CSS.` : '',
        aliases.length > 0
          ? `${aliases.length} alias reproduits : ${aliases
              .slice(0, 6)
              .map((variable) => `${variable.name} → ${variable.aliasOf}`)
              .join(', ')}${aliases.length > 6 ? ' …' : ''}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  /* ------------------------------ composants ------------------------------ */

  if (spec.components.length > 0) {
    heading('Inventaire des composants');
    body(
      'Motifs repetes detectes sur le site, publies comme composants. Les pages restent un rendu litteral : ces composants sont un inventaire, pas une abstraction imposee.\n\n' +
        spec.components
          .map(
            (component) =>
              `• ${component.name} — ${component.occurrences} occurrences${
                component.variants ? ` · ${component.variants.length} variantes` : ''
              }`,
          )
          .join('\n'),
    );
  }

  /* -------------------------- limites et anomalies ------------------------ */

  const warnings = spec.diagnostics.filter((diagnostic) => diagnostic.level !== 'info');
  const notes = spec.diagnostics.filter((diagnostic) => diagnostic.level === 'info');

  heading('A savoir avant de coder');
  if (warnings.length === 0 && context.warnings.length === 0) {
    body('Aucune anomalie relevee pendant l extraction.');
  } else {
    body(
      [
        ...context.warnings.map((warning) => `• ${warning}`),
        ...warnings.map(
          (diagnostic) =>
            `• ${diagnostic.message}${diagnostic.where ? `  [${diagnostic.where}]` : ''}${
              diagnostic.hint ? `\n    → ${diagnostic.hint}` : ''
            }`,
        ),
      ].join('\n'),
      WARN,
    );
  }

  if (notes.length > 0) {
    heading('Notes d extraction');
    const grouped = new Map<string, number>();
    for (const note of notes) grouped.set(note.code, (grouped.get(note.code) ?? 0) + 1);
    body(
      [...grouped.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => {
          const example = notes.find((note) => note.code === code)!;
          return `• ${describeCode(code)} (${count}) — ex. : ${example.message}`;
        })
        .join('\n'),
      MUTED,
    );
  }

  heading('Ce que la maquette ne peut pas montrer');
  body(
    [
      '• Les etats au survol, au focus et actifs : le site n en rend qu un a la fois, la capture est faite au repos.',
      '• Les animations et transitions : neutralisees volontairement pour mesurer l etat final.',
      '• Les elements colles (position: sticky/fixed) : places a leur position de repos, en couche absolue.',
      '• Les grilles CSS a colonnes inegales : rendues en auto-layout avec retour a la ligne ; les largeurs de colonnes sont a redeclarer.',
      '• Les contenus dynamiques (carrousels, onglets, accordeons) : seul l etat initial est capture.',
    ].join('\n'),
    MUTED,
  );

  const footer = text(
    'Cette page est reconstruite a chaque synchronisation. Ne la modifiez pas a la main : vos ajouts seraient perdus.',
    12,
    type.regular,
    MUTED,
  );
  footer.lineHeight = { unit: 'PERCENT', value: 150 };
}

function describeCode(code: string): string {
  const labels: Record<string, string> = {
    'layout-approximation': 'Mise en page approchee',
    'fixed-position': 'Element colle ou fixe',
    'font-substituted': 'Police substituee',
    'transform-partial': 'Transformation partiellement transposee',
    'capture-warning': 'Avertissement de capture',
    'token-alias': 'Token ambigu',
    'tokens-from-css': 'Tokens issus du CSS',
    'components-detected': 'Composants detectes',
    'page-script-error': 'Erreur JavaScript pendant la visite',
    'dark-mode-unavailable': 'Mode sombre non releve',
  };
  return labels[code] ?? code;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} a ${pad(date.getHours())}h${pad(date.getMinutes())}`;
}
