/**
 * maxModifier — the sugar name for the classic **gauge-max boost/curse**:
 * `maxModifier({ name: 'Giant Blood', multiply: 1.5, add: 50 })`.
 *
 * It is exactly the `stat` ability (ability/stat.ts) tied to a gauge's
 * **max**: while its status is attached, the wearer's gauge max is
 * re-derived from the gauge's base max plus every attached contribution,
 * in ascending `weight` order (the status's own weight, like any ability):
 *
 * ```ts
 * const fortify = buff({
 *   name: 'Fortify',
 *   weight: 1,
 *   abilities: [maxModifier({ name: 'Fortify', add: 50 })],
 * });
 *
 * const giant = buff({
 *   name: 'Giant Blood',
 *   weight: 2,
 *   abilities: [maxModifier({ name: 'Giant Blood', multiply: 1.5, add: 50 })],
 * });
 * ```
 *
 * With both buffs on a 100-max character, the derived max starts at 100 and
 * each modifier rewrites it as `max = max * multiply + add` in weight order:
 * Fortify first gives `(100) + 50 = 150`, then `150 * 1.5 + 50 = 275` — swap
 * the weights and the total changes, exactly like any transformer. The
 * result is the new effective **max**, clamped at 0 (raising max never
 * refills the gauge; lowering it below the current value re-clamps the
 * current value down; driving it to 0 destroys the character).
 *
 * Because the max is derived, adding a buff applies its contribution and
 * **any removal reverts it automatically** — dispelled, taken by the
 * cascade, or dying with its wearer. A max-modifying buff is therefore a
 * *blessing* ("Fortify: +50 max HP") or a *curse* ("Frail: −30 max HP")
 * depending on the sign of `add`/`multiply`.
 *
 * `gauge` picks which gauge the contribution applies to — `'hp'` (default),
 * `'mana'`, or any gauge the wearer carries. Like every `stat`, a
 * maxModifier can also carry a **derivation function** that *replaces* the
 * running max with its result while the status is attached:
 *
 * ```ts
 * // "while attached, your max HP is the number of creatures you control"
 * maxModifier({
 *   name: 'Hive Mind',
 *   gauge: 'hp',
 *   value: (ctx) => creaturesYouControl(ctx).length,
 * })
 * ```
 */
import { stat, type StatAbility, type StatContext } from './stat.js';

/** A max modifier is a gauge-tied `stat` contribution. */
export type MaxModifierAbility = StatAbility;

export interface MaxModifierDef {
  readonly id?: string;
  readonly name: string;
  /** Short human-readable description of what the modifier does. */
  readonly description?: string;
  /**
   * Which gauge this contribution applies to, **by id** — any gauge the wearer
   * carries (`'stamina'`, `'loyalty'`, …). Required: the engine has no
   * built-in gauge, so there is no sensible default to fall back to. (This
   * used to default to `'hp'`, which quietly assumed a gauge the engine does
   * not require.)
   */
  readonly gauge: string;
  /**
   * Derivation function (see `StatAbility.value`). While attached, the
   * gauge's max is this function's result.
   */
  readonly value?: (ctx: StatContext) => number;
  /**
   * Multiplicative factor on the running derived max. Defaults to `1` (no
   * scaling).
   */
  readonly multiply?: number;
  /**
   * Flat amount added after multiplying — negative for a max-reducing curse.
   * Defaults to `0`.
   */
  readonly add?: number;
}

/** A max modifier: while its status is attached, the wearer's gauge max is re-derived. */
export function maxModifier(def: MaxModifierDef): StatAbility {
  return stat({
    id: def.id,
    name: def.name,
    ...(def.description ? { description: def.description } : {}),
    gauge: def.gauge,
    ...(def.value ? { value: def.value } : {}),
    multiply: def.multiply,
    add: def.add,
  });
}
