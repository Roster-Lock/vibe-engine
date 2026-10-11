/**
 * Restriction abilities — the "cannot be X if Y" rules (docs/design/11-restrictions.md).
 *
 * A restriction is an **ability** like any other: it sits in a status's
 * `abilities` list and is granted to the character wearing that status. The
 * difference from the other kinds is that a restriction never *runs* — it is
 * a pure, synchronous, side-effect-free predicate that the engine's gates
 * consult when *someone else* attempts something **against** its wearer
 * (targeting, destroy, gauge writes, buff adds, win/lose).
 *
 * ```ts
 * buff({
 *   name: 'Indestructible',
 *   weight: 1,
 *   abilities: [restriction({ on: 'destroy' })],
 * });
 * ```
 *
 * Built with `restriction(...)`, like every other ability. The gate
 * machinery lives in `src/engine/restrictions.ts` (see `firstBlockingRestriction`);
 * a restriction's `when` reads an `AttemptContext` whose `self` is the
 * character whose restrictions are being consulted — the gate's subject (the
 * would-be target of a targeting attempt, the would-be victim of a
 * destroy/gauge attempt, …).
 *
 * Resolution rules:
 * - **"Can't beats can"** — a matching restriction blocks the attempt,
 *   period. A blocked attempt is a **no-op, not an error**.
 * - **Named exceptions pierce** — an attempt may name the restriction ids
 *   it beats (`bypasses: ["indestructible:0"]`); a restriction whose id is
 *   named does not block that attempt. Targeting uses `include` as its
 *   exception primitive instead.
 * - Restrictions are **pure predicates** (no RNG), so determinism holds:
 *   same seed + same state ⇒ same outcome.
 */
import type { GaugeIntent } from '../actions.js';
import type { RestrictionKind } from '../contracts.js';
import type { Character } from '../character.js';
import type { GameEngine } from '../engine.js';
import type { EventSource } from '../events.js';
import type { Gauge } from '../gauge.js';
import { deriveId, type TargetPattern } from './types.js';
import type { Ability } from './index.js';

/**
 * What a restriction ability blocks — derived from the open
 * `RestrictionKindMap` in `contracts.ts`, so a game can declare its own kinds.
 *
 * The engine's own kinds are the attempts *it* makes as it runs actions
 * (`target`, `destroy`, `gauge`, `buff`, `transform`, `move`, `activate`).
 * Outcome kinds like "cannot win the game" belong to whichever game has
 * outcomes, and are declared there by augmentation.
 */
export type { RestrictionKind, RestrictionKindMap } from '../contracts.js';

/**
 * Everything a restriction's `when` predicate may read while the engine
 * checks an attempt. `self` is the character whose restrictions are being
 * consulted — the gate's subject (the would-be target of a targeting
 * attempt, the would-be victim of a destroy/gauge attempt, …).
 */
export interface AttemptContext {
  /** The character whose restrictions are being consulted. */
  readonly self: Character;
  /** Who is doing X: a character, a buff, or nothing (state-based attempts). */
  readonly source: EventSource | undefined;
  /** The source's character — the source itself, or a buff's caster. */
  readonly sourceCharacter: Character | undefined;
  /** The gauge a gauge attempt touches (kind `'gauge'`). */
  readonly gauge?: Gauge;
  /** What kind of gauge change: damage, heal, set, or other (kind `'gauge'`). */
  readonly intent?: GaugeIntent;
  /** The targeting pattern of a targeting attempt (kind `'target'`). */
  readonly pattern?: TargetPattern;
  /** The ability making the attempt, when one is known. */
  readonly ability?: Ability;
  readonly engine: GameEngine;
}

/** A restriction ability as declared on a buff/skill declaration. */
export interface RestrictionAbility {
  readonly kind: 'restriction';
  readonly id: string;
  readonly name: string;
  /** Short human-readable description of what the restriction blocks. */
  readonly description?: string;
  /** What is being blocked. */
  readonly on: RestrictionKind;
  /** The "if Y" — absent means always. */
  readonly when?: (ctx: AttemptContext) => boolean;
}

export interface RestrictionDef {
  readonly id?: string;
  /** Optional display name; defaults to the `on` kind (`'destroy'`, …). */
  readonly name?: string;
  /** Short human-readable description of what the restriction blocks. */
  readonly description?: string;
  /** What is being blocked. */
  readonly on: RestrictionKind;
  /** The "if Y" — absent means always. */
  readonly when?: (ctx: AttemptContext) => boolean;
}

/**
 * A restriction ability: "cannot be X if Y". Unlike the other ability kinds
 * it never fires — the engine's gates consult it when an attempt is made
 * against its wearer, and it returns a verdict, not actions.
 */
export function restriction(def: RestrictionDef): RestrictionAbility {
  return {
    kind: 'restriction',
    id: def.id ?? (def.name ? deriveId(def.name, 'restriction') : `restriction:${def.on}`),
    name: def.name ?? def.on,
    on: def.on,
    ...(def.description ? { description: def.description } : {}),
    ...(def.when ? { when: def.when } : {}),
  };
}
