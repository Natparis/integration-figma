/**
 * Conversion des peintures et effets du spec vers les objets Figma.
 */

import type { Effect as SpecEffect, Paint as SpecPaint } from '@sfs/spec';
import type { SyncContext } from '../context.js';

const clamp = (value: number): number =>
  !Number.isFinite(value) ? 0 : value < 0 ? 0 : value > 1 ? 1 : value;

/**
 * Matrice de transformation d'un degrade.
 *
 * Figma decrit un degrade par une transformation appliquee a un vecteur
 * horizontal unitaire. Un angle CSS se compte depuis le haut dans le sens des
 * aiguilles ; celui de Figma depuis la droite. D'ou la rotation de 90°.
 */
function gradientTransform(angleDegrees: number): Transform {
  const radians = ((angleDegrees - 90) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // Centre la rotation sur la boite (0.5, 0.5) en coordonnees normalisees.
  return [
    [cos, -sin, 0.5 - 0.5 * cos + 0.5 * sin],
    [sin, cos, 0.5 - 0.5 * sin - 0.5 * cos],
  ];
}

export function toPaint(spec: SpecPaint, context: SyncContext): Paint | null {
  if (spec.type === 'SOLID') {
    const paint: SolidPaint = {
      type: 'SOLID',
      color: { r: clamp(spec.color.r), g: clamp(spec.color.g), b: clamp(spec.color.b) },
      opacity: clamp(spec.opacity),
    };
    if (!spec.variable) return paint;
    const variable = context.variables.get(spec.variable);
    if (!variable) return paint;
    try {
      // Lier la peinture a la variable : c'est ce qui rend le fichier pilotable
      // par tokens plutot que par couleurs figees.
      return figma.variables.setBoundVariableForPaint(paint, 'color', variable);
    } catch {
      return paint;
    }
  }

  if (spec.type === 'IMAGE') {
    const image = context.images.get(spec.assetId);
    // Asset non recupere : on omet le remplissage plutot que de peindre un
    // rectangle noir a la place de l'image.
    if (!image) return null;
    return {
      type: 'IMAGE',
      imageHash: image.hash,
      scaleMode: spec.scaleMode === 'CROP' ? 'CROP' : spec.scaleMode,
      opacity: clamp(spec.opacity),
    };
  }

  const stops: ColorStop[] = spec.stops.map((stop) => ({
    position: clamp(stop.position),
    color: {
      r: clamp(stop.color.r),
      g: clamp(stop.color.g),
      b: clamp(stop.color.b),
      a: clamp(stop.color.a),
    },
  }));
  if (stops.length < 2) return null;

  return {
    type: spec.type,
    gradientTransform: gradientTransform(spec.angle),
    gradientStops: stops,
    opacity: clamp(spec.opacity),
  } as GradientPaint;
}

export function toPaints(specs: SpecPaint[], context: SyncContext): Paint[] {
  const out: Paint[] = [];
  for (const spec of specs) {
    const paint = toPaint(spec, context);
    if (paint) out.push(paint);
  }
  return out;
}

export function toEffect(spec: SpecEffect): Effect | null {
  const color = spec.color
    ? {
        r: clamp(spec.color.r),
        g: clamp(spec.color.g),
        b: clamp(spec.color.b),
        a: clamp(spec.color.a),
      }
    : { r: 0, g: 0, b: 0, a: 0.25 };

  if (spec.type === 'DROP_SHADOW' || spec.type === 'INNER_SHADOW') {
    return {
      type: spec.type,
      color,
      offset: spec.offset ?? { x: 0, y: 0 },
      radius: Math.max(0, spec.radius),
      spread: spec.spread ?? 0,
      visible: true,
      blendMode: 'NORMAL',
    };
  }
  if (spec.radius <= 0) return null;
  // Les versions recentes de l'API distinguent flou uniforme et flou progressif :
  // `blurType` est obligatoire.
  return { type: spec.type, blurType: 'NORMAL', radius: spec.radius, visible: true };
}

export function toEffects(specs: SpecEffect[]): Effect[] {
  const out: Effect[] = [];
  for (const spec of specs) {
    const effect = toEffect(spec);
    if (effect) out.push(effect);
  }
  return out;
}
