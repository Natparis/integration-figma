/**
 * Variables Figma (design tokens).
 *
 * Objectif : que le developpeur retrouve dans Figma exactement les noms de son
 * CSS, et que la cliente puisse changer une couleur a un seul endroit. Les alias
 * du CSS (`--color-text: var(--color-neutral-900)`) sont reproduits comme alias
 * Figma : modifier la cible met a jour tout ce qui en depend.
 */

import type { RGBA, TokenCollection, VariableSpec } from '@sfs/spec';
import type { SyncContext } from '../context.js';

const TYPE_MAP: Record<VariableSpec['type'], VariableResolvedDataType> = {
  COLOR: 'COLOR',
  FLOAT: 'FLOAT',
  STRING: 'STRING',
  BOOLEAN: 'BOOLEAN',
};

export async function applyVariables(
  collections: TokenCollection[],
  context: SyncContext,
): Promise<void> {
  if (collections.length === 0) return;

  const existingCollections = await figma.variables.getLocalVariableCollectionsAsync();
  const existingVariables = await figma.variables.getLocalVariablesAsync();

  for (const spec of collections) {
    let collection =
      existingCollections.find((candidate) => candidate.name === spec.name) ?? null;
    if (!collection) collection = figma.variables.createVariableCollection(spec.name);

    /* ------------------------------- modes -------------------------------- */

    // La collection nait avec un mode par defaut appele « Mode 1 » : on le
    // renomme plutot que d'en creer un, sinon le fichier accumule des modes
    // vides a chaque synchronisation.
    const modeIds = new Map<string, string>();
    const firstMode = collection.modes[0];
    if (firstMode) {
      if (firstMode.name !== spec.defaultMode) {
        try {
          collection.renameMode(firstMode.modeId, spec.defaultMode);
        } catch {
          // Renommage refuse (nom deja pris) : on reutilise le mode tel quel.
        }
      }
      modeIds.set(spec.defaultMode, firstMode.modeId);
    }
    for (const mode of spec.modes) {
      if (modeIds.has(mode)) continue;
      const found = collection.modes.find((candidate) => candidate.name === mode);
      if (found) {
        modeIds.set(mode, found.modeId);
        continue;
      }
      try {
        modeIds.set(mode, collection.addMode(mode));
      } catch (error) {
        // Les modes multiples demandent un abonnement payant : ce n'est pas une
        // raison d'interrompre la synchronisation, seulement d'en informer.
        context.warnings.push(
          `Mode « ${mode} » non cree (${String(error)}). Les modes multiples requierent une offre Figma payante ; seul « ${spec.defaultMode} » sera renseigne.`,
        );
      }
    }

    /* ---------------------- variables : creation/mise a jour --------------- */

    const byName = new Map<string, Variable>();
    for (const variable of existingVariables) {
      if (variable.variableCollectionId === collection.id) byName.set(variable.name, variable);
    }

    // Premiere passe : creer toutes les variables, pour que les alias puissent
    // designer une cible qui existe deja.
    for (const variableSpec of spec.variables) {
      let variable = byName.get(variableSpec.name) ?? null;
      if (variable && variable.resolvedType !== TYPE_MAP[variableSpec.type]) {
        // Le type d'une variable Figma est immuable : il faut la recreer.
        variable.remove();
        variable = null;
        byName.delete(variableSpec.name);
      }
      if (!variable) {
        variable = figma.variables.createVariable(
          variableSpec.name,
          collection,
          TYPE_MAP[variableSpec.type],
        );
      }
      if (variableSpec.description) variable.description = variableSpec.description;
      byName.set(variableSpec.name, variable);
      context.variables.set(variableSpec.name, variable);
    }

    // Seconde passe : valeurs et alias.
    for (const variableSpec of spec.variables) {
      const variable = byName.get(variableSpec.name);
      if (!variable) continue;

      const alias = variableSpec.aliasOf ? byName.get(variableSpec.aliasOf) : undefined;

      for (const mode of spec.modes) {
        const modeId = modeIds.get(mode);
        if (modeId === undefined) continue;

        if (alias) {
          try {
            variable.setValueForMode(modeId, figma.variables.createVariableAlias(alias));
            continue;
          } catch (error) {
            context.warnings.push(
              `Alias « ${variableSpec.name} → ${variableSpec.aliasOf} » refuse (${String(error)}) : valeur copiee a la place.`,
            );
          }
        }

        // Valeur absente pour ce mode : on retombe sur le mode par defaut plutot
        // que de laisser la variable vide.
        const raw =
          variableSpec.valuesByMode[mode] ?? variableSpec.valuesByMode[spec.defaultMode];
        if (raw === undefined) continue;

        try {
          variable.setValueForMode(modeId, toVariableValue(variableSpec.type, raw));
          context.stats.variablesWritten++;
        } catch (error) {
          context.warnings.push(
            `Valeur refusee pour « ${variableSpec.name} » (mode ${mode}) : ${String(error)}`,
          );
        }
      }
    }
  }
}

function toVariableValue(
  type: VariableSpec['type'],
  raw: RGBA | number | string | boolean,
): VariableValue {
  if (type === 'COLOR') {
    const color = raw as RGBA;
    return { r: clamp(color.r), g: clamp(color.g), b: clamp(color.b), a: clamp(color.a) };
  }
  if (type === 'FLOAT') return Number(raw);
  if (type === 'BOOLEAN') return Boolean(raw);
  return String(raw);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
