/**
 * This game's event vocabulary — the HP-keyed predicates.
 *
 * The engine's own helpers are *gauge*-generic: `isGaugeChange`,
 * `amountOf`, `isZoneChange`, `isDeath`. What they cannot answer is "was this
 * **hp**?" or "was this **damage**?", because the engine has no hp gauge and no
 * damage concept — a gauge losing value is all it knows, which is exactly what
 * makes a stamina-death or loyalty-counter game work.
 *
 * Those questions are this game's, and they live here. The definitions are the
 * ones the engine used to ship, unchanged:
 *
 * - was the gauge **hp**? (`isHpChange`) / **mana**? (`isManaChange`)
 * - did it go **down or up** — damage or healing? (`isDamage` / `isHeal`)
 * - did a given character **deal** it? (`wasDealtBy`)
 * - did a given character **take** it? (`wasTakenBy`)
 *
 * Note the asymmetry this keeps: the `damage`/`heal` *builders* are
 * gauge-generic (they stamp an `intent` and write whatever gauge you hand
 * them), while these *predicates* are hp-specific. That is deliberate — a
 * game that deals "damage" to loyalty counters wants its own predicate.
 */
import {
  isGaugeChange,
  type Character as EngineCharacter,
  type GameEvent,
  type GaugeWrite,
} from '../../engine/index.js';

/**
 * True when the event moved a character's **hp** gauge — the gauge this game's
 * `Character` makes lethal by default. False for a character that has no `hp`
 * gauge, rather than throwing.
 */
export function isHpChange(event: GameEvent): event is GaugeWrite {
  return (
    isGaugeChange(event) && 'target' in event && event.gauge === event.target.findGauge('hp')
  );
}

/** True when the event moved a character's **mana** gauge. */
export function isManaChange(event: GameEvent): event is GaugeWrite {
  return (
    isGaugeChange(event) && 'target' in event && event.gauge === event.target.findGauge('mana')
  );
}

/** True when the hp gauge **lost** value — the target took damage. */
export function isDamage(event: GameEvent): event is GaugeWrite {
  return isHpChange(event) && event.to < event.from;
}

/** True when the hp gauge **gained** value — the target was healed. */
export function isHeal(event: GameEvent): event is GaugeWrite {
  return isHpChange(event) && event.to > event.from;
}

/** Did `who` **deal** this damage? (the source is the character itself). */
export function wasDealtBy(event: GameEvent, who: EngineCharacter): boolean {
  return (
    isDamage(event) &&
    'source' in event &&
    event.source.type === 'character' &&
    event.source === who
  );
}

/** Did `who` **take** this damage? (their own hp gauge dropped). */
export function wasTakenBy(event: GameEvent, who: EngineCharacter): boolean {
  return isDamage(event) && event.target === who;
}
