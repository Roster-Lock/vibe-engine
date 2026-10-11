/**
 * Abilities are how characters *do things*. There are seven kinds, one file
 * each in this folder:
 *
 * - `manual.ts`     — **cast**: the player picks targets, then the ability
 *   fires. `engine.useAbility(owner, ability, targeting)`.
 * - `triggered.ts`  — **auto**: listens to an event, computes its own
 *   targets, fires; **prompt**: listens to an event, *asks the player* for
 *   targets, fires.
 * - `passive-action-modifier.ts` — **passive action modifier**: doesn't
 *   fire at all; it transforms actions flowing past its owner. One
 *   listener — the action itself carries its direction (outgoing/incoming),
 *   so the modifier checks it when it only wants one.
 * - `max-modifier.ts` — **maxModifier**: the sugar name for the classic
 *   gauge-max boost/curse — a `stat` contribution tied to a gauge's max
 *   with static `multiply`/`add` (`max = max * multiply + add`, in weight
 *   order). Produces no Actions: the engine reads it off the status list
 *   when it re-derives the gauge's max.
 * - `stat.ts` — **stat**: the general form — a contribution that re-derives
 *   either a **gauge's max** (by gauge id: `'hp'`, `'mana'`, or any gauge
 *   the wearer carries) or a **named stat** (`speed`, or a custom name with
 *   a `CharacterDef.stats` base) from the base plus the attached
 *   contributions in weight order, where a contribution may be a static
 *   rewrite or a **derivation function** ("this value is equal to …").
 *   Like `maxModifier` it produces no Actions.
 * - `transform-modifier.ts` — **transformModifier**: the declarative tie
 *   between a buff and a transformation — while the status is attached the
 *   wearer's form is the tied form (pushed on attach, popped on removal).
 *   Like `maxModifier` it produces no Actions: the engine reads it off the
 *   status list and applies the tie when the status lands or leaves.
 * - `restriction.ts`— **restriction**: doesn't fire either; it is a pure
 *   "cannot be X if Y" predicate the engine's gates consult when an attempt
 *   is made against its owner (targeting, destroy, gauge writes, buff adds,
 *   win/lose).
 * - `types.ts`      — the shared targeting and context types.
 *
 * A buff that must react to its own end (a bomb that explodes when it dies
 * with its wearer or is dispelled) listens to `buff:destroyed` like any
 * trigger, with a self check: `when: (ctx) => ctx.event.buff.id ===
 * '<id>' && ctx.event.character === ctx.self`.
 *
 * This file is the public surface: the `Ability` union and the re-exports.
 */
import type { ManualAbility } from './manual.js';
import type { AnyTriggeredAbility } from './triggered.js';
import type { PassiveActionModifier } from './passive-action-modifier.js';
import type { RestrictionAbility } from './restriction.js';
import type { StatAbility } from './stat.js';
import type { TransformModifierAbility } from './transform-modifier.js';

export type {
  AbilityContext,
  CastResult,
  TargetCondition,
  TargetPattern,
  TargetWho,
  Targeting,
  TargetingContext,
  TriggerContext,
} from './types.js';

export { cast, type CastDef, type ManualAbility } from './manual.js';
export { auto, prompt, type AnyTriggeredAbility, type AutoDef, type PromptDef, type TriggeredAbility } from './triggered.js';
export {
  passiveActionModifier,
  type PassiveActionModifier,
  type PassiveActionModifierDef,
} from './passive-action-modifier.js';
export {
  maxModifier,
  type MaxModifierAbility,
  type MaxModifierDef,
} from './max-modifier.js';
export {
  stat,
  type StatAbility,
  type StatContext,
  type StatDef,
} from './stat.js';
export {
  transformModifier,
  type TransformModifierAbility,
  type TransformModifierDef,
} from './transform-modifier.js';
export {
  restriction,
  type RestrictionAbility,
  type RestrictionDef,
  type RestrictionKind,
  type RestrictionKindMap,
  type AttemptContext,
} from './restriction.js';

export type Ability =
  | ManualAbility
  | AnyTriggeredAbility
  | StatAbility
  | TransformModifierAbility
  | PassiveActionModifier
  | RestrictionAbility;
