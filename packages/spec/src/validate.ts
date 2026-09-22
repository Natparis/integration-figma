/**
 * Validation du `design-spec` a l'execution, sans dependance.
 *
 * Le plugin Figma lit un JSON venu du reseau : il doit refuser proprement un
 * fichier malforme plutot que d'echouer au milieu d'une ecriture dans le
 * document de la cliente. Une synchro a moitie appliquee est le pire cas.
 */

import { SPEC_VERSION } from './types.js';
import type { DesignSpec, SpecNode } from './types.js';

export class SpecValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path} : ${message}`);
    this.name = 'SpecValidationError';
  }
}

function must(condition: unknown, path: string, message: string): void {
  if (!condition) throw new SpecValidationError(message, path);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateNode(value: unknown, path: string, seen: Set<string>, depth: number): number {
  must(isObject(value), path, 'objet attendu');
  const node = value as unknown as SpecNode;
  must(typeof node.sid === 'string' && node.sid.length > 0, path, '`sid` manquant');
  must(!seen.has(node.sid), path, `\`sid\` en doublon : ${node.sid}`);
  seen.add(node.sid);
  must(typeof node.name === 'string', `${path}.name`, 'chaine attendue');
  must(
    ['FRAME', 'TEXT', 'IMAGE', 'VECTOR', 'ELLIPSE', 'LINE', 'INSTANCE'].includes(node.kind),
    `${path}.kind`,
    `type de noeud inconnu : ${String(node.kind)}`,
  );
  must(isObject(node.box), `${path}.box`, 'objet attendu');
  for (const key of ['x', 'y', 'w', 'h'] as const) {
    must(Number.isFinite(node.box[key]), `${path}.box.${key}`, 'nombre fini attendu');
  }
  must(isObject(node.layout), `${path}.layout`, 'objet attendu');
  must(isObject(node.style), `${path}.style`, 'objet attendu');
  must(Array.isArray(node.style.fills), `${path}.style.fills`, 'tableau attendu');
  if (node.kind === 'TEXT') {
    must(isObject(node.text), `${path}.text`, 'un noeud TEXT doit porter `text`');
    must(typeof node.text!.characters === 'string', `${path}.text.characters`, 'chaine attendue');
  }
  if (node.kind === 'IMAGE') {
    must(isObject(node.image), `${path}.image`, 'un noeud IMAGE doit porter `image`');
  }
  if (node.kind === 'INSTANCE') {
    must(
      typeof node.instanceOf === 'string',
      `${path}.instanceOf`,
      'un noeud INSTANCE doit porter `instanceOf`',
    );
  }
  must(Array.isArray(node.children), `${path}.children`, 'tableau attendu');
  // Garde-fou : un DOM pathologique ne doit pas faire exploser la pile du plugin.
  must(depth < 200, path, 'arbre trop profond (> 200 niveaux)');
  let count = 1;
  node.children.forEach((child, i) => {
    count += validateNode(child, `${path}.children[${i}]`, seen, depth + 1);
  });
  return count;
}

export interface ValidationResult {
  spec: DesignSpec;
  nodeCount: number;
  /** Incoherences non bloquantes, remontees a l'utilisateur. */
  warnings: string[];
}

export function validateSpec(value: unknown): ValidationResult {
  must(isObject(value), '$', 'le spec doit etre un objet JSON');
  const spec = value as unknown as DesignSpec;
  must(
    spec.specVersion === SPEC_VERSION,
    '$.specVersion',
    `version ${SPEC_VERSION} attendue, recu ${String(spec.specVersion)} — mettez a jour le plugin ou le CLI`,
  );
  must(typeof spec.revision === 'string' && spec.revision.length > 0, '$.revision', 'manquante');
  must(Array.isArray(spec.pages), '$.pages', 'tableau attendu');
  must(spec.pages.length > 0, '$.pages', 'aucune page extraite');
  for (const key of ['tokens', 'paintStyles', 'textStyles', 'effectStyles', 'components', 'assets', 'diagnostics'] as const) {
    must(Array.isArray(spec[key]), `$.${key}`, 'tableau attendu');
  }

  const seen = new Set<string>();
  let nodeCount = 0;
  spec.pages.forEach((page, pi) => {
    const p = `$.pages[${pi}]`;
    must(typeof page.name === 'string' && page.name.length > 0, `${p}.name`, 'manquant');
    must(Array.isArray(page.breakpoints), `${p}.breakpoints`, 'tableau attendu');
    must(page.breakpoints.length > 0, `${p}.breakpoints`, 'au moins un breakpoint attendu');
    page.breakpoints.forEach((bp, bi) => {
      const b = `${p}.breakpoints[${bi}]`;
      must(typeof bp.name === 'string' && bp.name.length > 0, `${b}.name`, 'manquant');
      must(Number.isFinite(bp.width) && bp.width > 0, `${b}.width`, 'largeur positive attendue');
      nodeCount += validateNode(bp.root, `${b}.root`, seen, 0);
    });
  });

  const warnings: string[] = [];

  // Integrite referentielle : un `assetId` ou un `instanceOf` orphelin ferait
  // echouer le plugin en pleine ecriture. Mieux vaut le savoir avant.
  const assetIds = new Set(spec.assets.map((a) => a.id));
  const componentKeys = new Set(spec.components.map((c) => c.key));
  const variableNames = new Set(
    spec.tokens.flatMap((collection) => collection.variables.map((v) => v.name)),
  );
  const styleNames = new Set([
    ...spec.paintStyles.map((s) => s.name),
    ...spec.textStyles.map((s) => s.name),
    ...spec.effectStyles.map((s) => s.name),
  ]);

  const checkNode = (node: SpecNode): void => {
    if (node.image && !assetIds.has(node.image.assetId)) {
      warnings.push(`${node.sid} : asset introuvable « ${node.image.assetId} » (image ignoree)`);
    }
    if (node.vector && !assetIds.has(node.vector.assetId)) {
      warnings.push(`${node.sid} : asset introuvable « ${node.vector.assetId} » (vecteur ignore)`);
    }
    if (node.instanceOf && !componentKeys.has(node.instanceOf)) {
      warnings.push(`${node.sid} : composant introuvable « ${node.instanceOf} » (rendu a plat)`);
    }
    for (const paint of [...node.style.fills, ...node.style.strokes]) {
      if (paint.type === 'SOLID') {
        if (paint.variable && !variableNames.has(paint.variable)) {
          warnings.push(`${node.sid} : variable introuvable « ${paint.variable} »`);
        }
        if (paint.style && !styleNames.has(paint.style)) {
          warnings.push(`${node.sid} : style introuvable « ${paint.style} »`);
        }
      }
      if (paint.type === 'IMAGE' && !assetIds.has(paint.assetId)) {
        warnings.push(`${node.sid} : asset de remplissage introuvable « ${paint.assetId} »`);
      }
    }
    if (node.text?.styleName && !styleNames.has(node.text.styleName)) {
      warnings.push(`${node.sid} : style de texte introuvable « ${node.text.styleName} »`);
    }
    node.children.forEach(checkNode);
  };
  for (const page of spec.pages) for (const bp of page.breakpoints) checkNode(bp.root);

  for (const collection of spec.tokens) {
    must(collection.modes.length > 0, `$.tokens`, `collection « ${collection.name} » sans mode`);
    must(
      collection.modes.includes(collection.defaultMode),
      `$.tokens`,
      `collection « ${collection.name} » : mode par defaut « ${collection.defaultMode} » absent de ${collection.modes.join(', ')}`,
    );
    for (const variable of collection.variables) {
      for (const mode of collection.modes) {
        if (!(mode in variable.valuesByMode)) {
          warnings.push(
            `token « ${variable.name} » : pas de valeur pour le mode « ${mode} » (le mode par defaut sera reutilise)`,
          );
        }
      }
    }
  }

  return { spec, nodeCount, warnings };
}
