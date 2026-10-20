/**
 * Card-game **format** mechanics: the zones a player arrives with, and the rules each
 * zone must satisfy (docs/design/15-zones.md).
 *
 * The base card game declares no zones and this file defines no formats: a
 * game supplies its own. A format is data — each `FormatZone` pairs a
 * `ZoneDef` with the constraints its contents must meet — and
 * `validateFormat` checks a player's submitted zones against them before the
 * game starts.
 */
import type { Entity, ZoneDef } from '../../engine/index.js';

export interface FormatZone {
  readonly zone: ZoneDef;
  /** Minimum / maximum number of cards the zone must hold. */
  readonly min?: number;
  readonly max?: number;
  /** Every card in the zone must satisfy this; `describe` names it in errors. */
  readonly accepts?: (card: Entity) => boolean;
  readonly describe?: string;
}

export interface CardFormat {
  readonly id: string;
  readonly zones: readonly FormatZone[];
}

/** Returns human-readable violations; empty means the submission is valid. */
export function validateFormat(
  format: CardFormat,
  submitted: ReadonlyMap<string, readonly Entity[]>,
): string[] {
  const errors: string[] = [];
  const known = new Set(format.zones.map((z) => z.zone.id));
  for (const id of submitted.keys()) {
    if (!known.has(id)) errors.push(`${format.id} has no zone "${id}"`);
  }
  for (const { zone, min = 0, max, accepts, describe } of format.zones) {
    const cards = submitted.get(zone.id) ?? [];
    if (cards.length < min) errors.push(`${zone.id} needs at least ${min} cards, has ${cards.length}`);
    if (max !== undefined && cards.length > max) errors.push(`${zone.id} allows at most ${max} cards, has ${cards.length}`);
    if (accepts) {
      for (const c of cards) if (!accepts(c)) errors.push(`${zone.id} only holds ${describe ?? 'matching cards'}; "${c.name}" is not`);
    }
  }
  return errors;
}
