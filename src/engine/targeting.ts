/**
 * The targeting registry — *who counts as an ally?* is a game's question.
 *
 * `TargetWhoMap` (contracts.ts) makes the targeting vocabulary open. The engine
 * answers the two values that need no model of the world — `'self'` and
 * `'any'` — and this registry is how a game answers the rest.
 *
 * It used to be hardcoded: the engine shipped `isAlly`/`isEnemy` over a
 * `team` tag, so every game inherited "two sides" whether it had sides or not,
 * and `validTargets` switched on all four values. A free-for-all, a solo game
 * and a co-op game disagree about what an enemy is, and none of them should
 * have to accept the engine's answer.
 *
 * ```ts
 * declare module 'vibe-engine/contracts.js' {
 *   interface TargetWhoMap { enemy: 'enemy' }
 * }
 * engine.targeting.register('enemy', (self, candidate) =>
 *   candidate.team !== undefined && candidate.team !== self.team,
 * );
 * ```
 *
 * A `who` with no resolver is a **loud error**, not an empty pool: a mistyped
 * or forgotten registration would otherwise look exactly like "nothing is in
 * range".
 */
import type { Character } from './character.js';
import type { GameEngine } from './engine.js';
import type { TargetWho } from './contracts.js';

/**
 * Decides whether `candidate` matches a targeting value, relative to the
 * ability's owner. Must be pure — targeting runs during pattern resolution,
 * including inside deterministic replays.
 */
export type TargetResolver = (
  self: Character,
  candidate: Character,
  engine: GameEngine,
) => boolean;

export class TargetingRegistry {
  readonly #resolvers = new Map<string, TargetResolver>();

  /**
   * Teaches the engine what a targeting value means. Register under a name
   * declared in `TargetWhoMap`, so content using `who: 'enemy'` type-checks.
   */
  register(who: TargetWho, resolve: TargetResolver): this {
    this.#resolvers.set(who, resolve);
    return this;
  }

  /** The resolver for a targeting value, or undefined when none is registered. */
  get(who: string): TargetResolver | undefined {
    return this.#resolvers.get(who);
  }

  /** Every registered targeting value, in registration order. */
  get registered(): readonly string[] {
    return [...this.#resolvers.keys()];
  }
}
