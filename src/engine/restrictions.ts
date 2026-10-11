/**
 * The restrictions gate — the engine side of the "cannot be X if Y" system
 * (docs/design/11-restrictions.md). The rules themselves are **restriction
 * abilities**: a kind of ability (see `ability/restriction.ts`) declared
 * inside a status's `abilities` list and granted to the status's wearer.
 * This file is where the engine *consults* them.
 *
 * A restriction ability declares *what* is blocked (`on`) and *under what
 * condition* (`when`, the "if Y" — absent means always). The engine consults
 * them at each gate:
 *
 * - targeting (`validTargets` / `useAbility`) — `on: 'target'`;
 * - the destroy phase and `destroy` actions — `on: 'destroy'`;
 * - the action pipeline, before transformers — `on: 'gauge'`, `'buff'`,
 *   `'transform'` (`'control'` / `'revive'` are defined but not wired:
 *   those actions do not exist yet);
 * - win/lose resolution — `on: 'lose'` / `on: 'win'`.
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
import type { RestrictionAbility, RestrictionKind, AttemptContext } from './ability/index.js';
import type { Character } from './character.js';

export type { RestrictionKind, AttemptContext, RestrictionAbility } from './ability/index.js';

/**
 * A restriction ability attached to a status instance, stamped with its
 * stable id: `"{statusId}:{index}"` — e.g. `hexproof:0`, `indestructible:0`.
 * The index counts the status's restriction abilities in declaration order.
 * Named exceptions (`bypasses`) reference these ids.
 */
export interface RestrictionInstance extends RestrictionAbility {
  readonly id: string;
}

/** The shape `GameEngine.attemptBlocked` accepts (see there). */
export interface BlockedAttempt {
  /** What is being attempted. */
  readonly kind: RestrictionKind;
  /** The character whose restrictions are consulted (the gate's subject). */
  readonly target: Character;
  /**
   * Named exceptions — restriction ids (`"{statusId}:{index}"`) this
   * attempt pierces. Absent = no exceptions ("can't beats can").
   */
  readonly bypasses?: readonly string[];
  /** Everything a restriction's `when` predicate may read. */
  readonly ctx: AttemptContext;
}

/**
 * Returns the first restriction ability of `kind` blocking `target`, or
 * `undefined` when nothing does. Deterministic order: the target's statuses
 * in weight order (ascending), then each status's restriction abilities in
 * declaration order (non-restriction abilities are skipped). A restriction
 * whose id is listed in `bypasses` is skipped — that is how an effect names
 * the rule it beats.
 */
export function firstBlockingRestriction(
  target: Character,
  kind: RestrictionKind,
  ctx: AttemptContext,
  bypasses?: readonly string[],
): RestrictionInstance | undefined {
  for (const status of target.statuses) {
    let restrictionIndex = 0;
    for (const ability of status.abilities) {
      if (ability.kind !== 'restriction') continue;
      const id = `${status.id}:${restrictionIndex}`;
      restrictionIndex += 1;
      if (ability.on !== kind) continue;
      if (bypasses?.includes(id)) continue;
      if (ability.when && !ability.when(ctx)) continue;
      return { ...ability, id };
    }
  }
  return undefined;
}
