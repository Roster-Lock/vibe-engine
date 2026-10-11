/**
 * **Team-based targeting** — `'ally'` and `'enemy'`, as this repo's games mean
 * them.
 *
 * The engine used to ship these two values and their meaning (`isAlly` /
 * `isEnemy` over a `team` tag), which quietly asserted that every game has
 * two sides. It does not: a free-for-all has no allies, a co-op game has no
 * enemies, and a solo game has neither. So the engine now answers only
 * `'self'` and `'any'` — the two values that need no model of the world — and
 * this module supplies the pair the round-based games want.
 *
 * The tag it reads, `Character.team`, stays on the engine's `Character`: it is
 * a free-form grouping label like `stats` is a free-form number, and **no
 * engine rule reads it**. What moved is only the *interpretation*.
 */
import type { Character, GameEngine } from '../../engine/index.js';

declare module '../../engine/contracts.js' {
  /**
   * The two values a game with sides needs. Declaring them here — rather than
   * in the engine — is what makes `targeting: { who: 'enemy' }` type-check in
   * content while the engine has no idea what an enemy is.
   */
  interface TargetWhoMap {
    /** The ability owner's own side. Includes the owner themselves. */
    ally: 'ally';
    /** Any other side — a character with a different (or no) `team` tag. */
    enemy: 'enemy';
  }
}

/**
 * Same `team` tag (or the same character) counts as allies.
 *
 * A character with **no** team tag is allied only with itself: an untagged
 * character belongs to no side, so it stands apart rather than joining every
 * other untagged one. (The previous engine behaviour treated two untagged
 * characters as `a.team !== undefined && …` → false, i.e. not allies, which
 * this preserves.)
 */
export function isAlly(a: Character, b: Character): boolean {
  return a === b || (a.team !== undefined && a.team === b.team);
}

/** Anyone who is not an ally, and not `a` itself. */
export function isEnemy(a: Character, b: Character): boolean {
  return a !== b && !isAlly(a, b);
}

/**
 * Registers the pair on an engine. Called by `createEngine`, so a game that
 * takes the batteries-included entry point gets them for free; a game that
 * builds its own `GameEngine` registers whatever targeting it actually means.
 */
export function registerTeamTargeting(engine: GameEngine): void {
  engine.targeting
    .register('ally', (self, candidate) => isAlly(self, candidate))
    .register('enemy', (self, candidate) => isEnemy(self, candidate));
}
