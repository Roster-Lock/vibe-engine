/**
 * stat — the declarative ability that **derives** a value of its wearer
 * from a function of the game state:
 * `stat({ name: 'Hive Mind', gauge: 'hp', value: (ctx) => ... })`.
 *
 * A contribution derives exactly one thing:
 *
 * - **a gauge's max** — `gauge: 'hp'` (or `'mana'`, or any gauge the
 *   character carries, such as a future `'stamina'`). The derived value
 *   *is* the gauge's effective `max`: it is folded from the gauge's base
 *   max plus every attached contribution, clamped at 0, written to the
 *   gauge (raising max never refills; lowering it re-clamps the current
 *   value down; driving it to 0 can trigger a max-aspect gauge rule — the
 *   built-in death rule). The read is the gauge itself: `character.hp.max`.
 *   A gauge-tied contribution on a wearer that has no gauge with that id
 *   does nothing (it is written for games that carry the gauge).
 * - **a named stat** — `stat: 'speed'` (initiative) or any custom name
 *   like `'power'`, optionally given a base in `CharacterDef.stats`.
 *   Read with `character.stat(name)`.
 *
 * The value is **never written by content — it is derived**. The engine
 * folds the attached contributions over the base in status order (weight
 * ascending, like any transformer):
 *
 * ```ts
 * const hiveMind = buff({
 *   name: 'Hive Mind',
 *   weight: 1,
 *   abilities: [
 *     stat({
 *       name: 'Hive Mind',
 *       gauge: 'hp', // "toughness": the life gauge's max
 *       value: (ctx) =>
 *         ctx.engine.registeredCharacters.filter(
 *           (c) => c.controller === ctx.self.controller && ctx.engine.isInPlay(c),
 *         ).length,
 *     }),
 *   ],
 * });
 * ```
 *
 * While the buff is attached, the wearer's max HP **is** the function's
 * result — the Magic-style "this creature's toughness is equal to the
 * number of creatures you control". A contribution either **replaces** the
 * running value (its `value` function — MTG "equal to"), or **rewrites**
 * it (`value = value * multiply + add`, the static form — a +50 blessing
 * or a −30 curse); a later contribution in weight order sees the earlier
 * one's result, so "equal to X, then +2" is a `value` contribution
 * followed by an `add` one.
 *
 * Because the value is derived, adding a buff applies its contribution and
 * **any removal reverts it automatically** — dispelled, taken by the
 * cascade, or dying with its wearer.
 *
 * ## When derived values update
 *
 * The engine re-derives:
 *
 * - when a status is added or removed (a contribution landing or leaving);
 * - when a form transform lands or reverts (the gauge maxes' base changes);
 * - at registration (a skill's contribution is folded in silently);
 * - **when the world changes** — a `value` function may read anything
 *   (`engine.registeredCharacters`, other gauges, …), so the engine
 *   re-derives every *function-carrying* value at each settle (the apply
 *   tail, before and after the destroy phase) and exposes
 *   `engine.refreshDerivedStats()` for reads between settles (initiative
 *   speed, display stats). Static contributions are unaffected by world
 *   state, so only `value` functions pay for this.
 *
 * A gauge max that changes on re-derivation emits `gauge:maxChanged` and
 * can drive a max-aspect gauge rule (a derived max at 0 destroys the
 * character); a named stat that changes emits `stat:changed` — versions
 * with or without a `source`, see `src/engine/events.ts`. Derivation
 * functions are **read-only queries** — they must not emit actions or
 * mutate state (the same contract as a restriction's `when`), and their
 * result must be a finite number.
 *
 * `maxModifier` (ability/max-modifier.ts) is the same ability — a
 * gauge-tied `stat` with static `multiply`/`add` — kept as a sugar name
 * for the "boost/curse a gauge max" pattern.
 */
import { deriveId } from './types.js';
import type { Character } from '../character.js';
import type { GameEngine } from '../engine.js';
import type { Status } from '../status/index.js';

/** What a derivation function sees while it runs. */
export interface StatContext {
  /** The character whose value is being derived. */
  readonly self: Character;
  readonly engine: GameEngine;
  /** The status (buff or skill) that owns the contribution being applied. */
  readonly status: Status;
}

/**
 * A stat contribution: while its status is attached, the derived value is
 * re-derived through it. A `value` function **replaces** the running value
 * (MTG "equal to"); `multiply`/`add` **rewrite** it as
 * `value = value * multiply + add`. Both may be combined — replace, then
 * rewrite. Exactly one of `gauge`/`stat` is set (see the file doc).
 */
export interface StatAbility {
  readonly kind: 'stat';
  readonly id: string;
  readonly name: string;
  /** Short human-readable description of what the derivation does. */
  readonly description?: string;
  /**
   * The gauge whose **max** this contribution derives — by id (`'hp'`,
   * `'mana'`, or any gauge the wearer carries). Mutually exclusive with
   * `stat`.
   */
  readonly gauge?: string;
  /**
   * The named stat this contribution derives (`'speed'`, or any custom
   * name — with a base from `CharacterDef.stats`, or derived entirely by
   * this function). Mutually exclusive with `gauge`.
   */
  readonly stat?: string;
  /**
   * The derivation function: while attached, the derived value is this
   * function's result. Read-only — see the file doc — and must return a
   * finite number.
   */
  readonly value?: (ctx: StatContext) => number;
  /**
   * Multiplicative factor applied to the running value after `value` (or
   * to the base when there is no `value`). Defaults to `1` (no scaling).
   */
  readonly multiply: number;
  /**
   * Flat amount added after multiplying. Defaults to `0` — negative for a
   * reducing contribution.
   */
  readonly add: number;
}

export interface StatDef {
  readonly id?: string;
  readonly name: string;
  /** Short human-readable description of what the derivation does. */
  readonly description?: string;
  /**
   * The gauge whose **max** this contribution derives — by id. Mutually
   * exclusive with `stat`.
   */
  readonly gauge?: string;
  /**
   * The named stat this contribution derives (`'speed'` or any custom
   * name). Mutually exclusive with `gauge`.
   */
  readonly stat?: string;
  /** The derivation function (see `StatAbility.value`). */
  readonly value?: (ctx: StatContext) => number;
  /** Multiplicative factor on the running value. Defaults to `1`. */
  readonly multiply?: number;
  /** Flat amount added after multiplying — negative to reduce. Defaults to `0`. */
  readonly add?: number;
}

/** A stat contribution: while its status is attached, the value is re-derived. */
export function stat(def: StatDef): StatAbility {
  const hasGauge = def.gauge !== undefined;
  const hasStat = def.stat !== undefined;
  if (hasGauge === hasStat) {
    throw new Error(
      `stat "${def.name}": give it exactly one of "gauge" (a gauge id whose max it derives) or "stat" (a named stat on the character)`,
    );
  }
  if (hasGauge && (typeof def.gauge !== 'string' || def.gauge.trim() === '')) {
    throw new Error(`stat "${def.name}": "gauge" must be a non-empty gauge id (got ${JSON.stringify(def.gauge)})`);
  }
  if (hasStat && (typeof def.stat !== 'string' || def.stat.trim() === '')) {
    throw new Error(`stat "${def.name}": "stat" must be a non-empty name (got ${JSON.stringify(def.stat)})`);
  }
  const multiply = def.multiply ?? 1;
  const add = def.add ?? 0;
  if (def.value !== undefined && typeof def.value !== 'function') {
    throw new Error(`stat "${def.name}": "value" must be a function (got ${typeof def.value})`);
  }
  if (!Number.isFinite(multiply) || multiply < 0) {
    throw new Error(`stat "${def.name}": multiply must be a finite number >= 0, got ${multiply}`);
  }
  if (!Number.isFinite(add)) {
    throw new Error(`stat "${def.name}": add must be a finite number, got ${add}`);
  }
  if (!def.value && multiply === 1 && add === 0) {
    throw new Error(
      `stat "${def.name}": it derives nothing — give it a "value" function, or a multiply/add rewrite`,
    );
  }
  return {
    kind: 'stat',
    id: def.id ?? deriveId(def.name, 'ability'),
    name: def.name,
    ...(def.description ? { description: def.description } : {}),
    ...(def.gauge !== undefined ? { gauge: def.gauge } : { stat: def.stat! }),
    ...(def.value ? { value: def.value } : {}),
    multiply,
    add,
  };
}
