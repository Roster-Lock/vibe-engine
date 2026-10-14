/**
 * **Cast speed** — *instant* vs *sorcery* — as a symbol any castable thing
 * can carry.
 *
 * A card and an activated ability are different kinds of object: one is data
 * the deck builder instantiates, the other an engine `cast(...)` closure.
 * What they have in common is the question "may this be used at any time, or
 * only in my own main phase?" — and answering it with a name (`speed:
 * 'instant'`) means every producer of either kind has to remember to set it,
 * and every consumer has to know which field to read.
 *
 * A **symbol** fixes both: `instant(card)` and `instant(ability)` mark the
 * object itself, the mark is invisible to `JSON.stringify` (so it never
 * leaks into the share format, where speed belongs to the game's data, not
 * to the language's), and one `isInstant(value)` answers for either. The
 * stack reads it in `speedOf`, so a marked object is instant wherever it
 * ends up.
 *
 * `Symbol.for` rather than a bare `Symbol()`: the registry makes the key
 * equal across module instances and realms, which is what a *shared*
 * vocabulary needs. A unique symbol would silently stop matching if a build
 * ever loaded two copies of this module — the marker would be present and
 * unreadable, which is the worst of both.
 */
export const INSTANT: unique symbol = Symbol.for('tinyquest.cards.instant');

/** What a castable object looks like once `instant` has marked it. */
export interface InstantSpeed {
  /** `true` when the object may be used at instant speed. Absent otherwise. */
  readonly [INSTANT]?: true;
}

/** The two speeds. A sorcery is the restrictive one, so it is the default. */
export type CastSpeed = 'instant' | 'sorcery';

/**
 * Marks a card, an ability, or any castable object as instant-speed.
 *
 * Non-enumerable on purpose: the marker is identity, not data. An object
 * that travels (`JSON.stringify`, a spread into a plain record) should not
 * suddenly claim to be instant because it was marked once — a game that
 * shares cards says so in its own data and re-marks on import.
 */
export function instant<T extends object>(value: T): T & InstantSpeed {
  Object.defineProperty(value, INSTANT, { value: true, enumerable: false, configurable: true });
  return value as T & InstantSpeed;
}

/** True when `value` carries the instant marker — a card, an ability, anything. */
export function isInstant(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    (value as InstantSpeed)[INSTANT] === true
  );
}

/**
 * An object's speed: the marker decides, `fallback` covers everything else.
 *
 * Kept separate from the stack so a host that reads speed *before* an object
 * is on the stack — an editor greying out a card, an AI deciding what to
 * hold up — answers exactly as the stack will.
 */
export function castSpeedOf(value: unknown, fallback: CastSpeed = 'sorcery'): CastSpeed {
  return isInstant(value) ? 'instant' : fallback;
}
