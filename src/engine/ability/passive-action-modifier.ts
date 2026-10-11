/**
 * Passive action modifiers — they never fire; they only transform actions
 * flowing past their owner (e.g. "incoming damage is capped at 50"). Built
 * with `passiveActionModifier(...)`.
 *
 * A modifier has a **single listener** (`transform`), not separate outgoing
 * and incoming hooks: the engine runs it in both pipeline directions, and
 * every action it sees already carries its own direction
 * (`action.direction` — `'outgoing'` while the owner's actions leave it,
 * `'incoming'` while actions aimed at the owner arrive). A modifier that is
 * only supposed to touch one direction checks it:
 *
 * ```ts
 * // Caps incoming damage at 50; outgoing actions pass through untouched.
 * const ironHide = passiveActionModifier({
 *   name: 'Iron Hide',
 *   transform: (action, ctx) =>
 *     action.direction !== 'incoming'
 *       ? action
 *       : gaugeTransform((prev) => (cur, max) => Math.max(prev(cur, max), cur - 50))(action, ctx),
 * });
 * ```
 *
 * **Turning damage into mana loss** — two spellings, both with the one
 * listener:
 *
 * ```ts
 * // Option 1 — retarget the same action: its update runs against mana.
 * // Simple, but the action still carries HP semantics (its `update` closure
 * // was written for HP's values, and its intent stays 'damage').
 * const shieldByRetarget = passiveActionModifier({
 *   name: 'Mana Shield',
 *   transform: (action, ctx) =>
 *     action.direction !== 'incoming' || action.type !== 'gauge' ||
 *     ctx.target?.hp !== action.target
 *       ? action
 *       : { ...action, target: ctx.target.mana },
 * });
 *
 * // Option 2 — prevent the old action from continuing and create a new one
 * // that does the same thing to mana: a true replacement. `redirectGauge`
 * // (actions.ts) is the ready-made spelling; the generic primitive is
 * // `replaceAction` + `gaugeDelta`.
 * const shieldByReplacement = passiveActionModifier({
 *   name: 'Mana Shield',
 *   transform: redirectGauge((t) => t.hp, (t) => t.mana, {
 *     direction: 'incoming',
 *     intent: 'damage',
 *   }),
 * });
 * ```
 *
 * The difference between the two is where the amount comes from. Retargeting
 * keeps the original `update` closure — a flat damage amount converts
 * cleanly, but a percentage update would now apply to *mana's* values.
 * Replacing reads the damage off the original action first (`gaugeDelta` —
 * the signed change it would make, evaluated against HP) and builds a fresh
 * action from that amount, so "the same thing" means the same absolute
 * effect. A replacement is **not a new cast**: it stays in the pipeline, so
 * it does not re-enter the restrictions gate, and later incoming
 * transformers still see the converted action. The overflow boundary: mana
 * is the new buffer — damage beyond the current mana is lost (the gauge
 * clamps at 0), not spilled onto HP.
 *
 * Attach the modifier to a character through a buff or a skill, like any
 * ability — the engine runs it while that status is attached. For the
 * declarative maximum-changing variant, see `maxModifier` (max-modifier.ts).
 */
import type { ActionTransformer } from '../actions.js';
import { deriveId } from './types.js';

export interface PassiveActionModifier {
  readonly kind: 'passive';
  readonly id: string;
  readonly name: string;
  /** Short human-readable description of what the modifier does. */
  readonly description?: string;
  /**
   * The one listener: transforms every action flowing past the owner —
   * outgoing and incoming alike. Check `action.direction` to only modify
   * one of the two.
   */
  readonly transform: ActionTransformer;
}

export interface PassiveActionModifierDef {
  readonly id?: string;
  readonly name: string;
  /** Short human-readable description of what the modifier does. */
  readonly description?: string;
  readonly transform: ActionTransformer;
}

/** A passive action modifier: never fires, only transforms flowing actions. */
export function passiveActionModifier(def: PassiveActionModifierDef): PassiveActionModifier {
  return {
    kind: 'passive',
    id: def.id ?? deriveId(def.name, 'ability'),
    name: def.name,
    ...(def.description ? { description: def.description } : {}),
    transform: def.transform,
  };
}
