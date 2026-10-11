/**
 * The outcome registry — *when is the game over?* is a game's question, and
 * this is the seam that lets a game answer it.
 *
 * The engine runs a settle cycle: gauge writes land, state-based actions fire,
 * the destroy phase resolves, events are announced. Somewhere in that cycle a
 * game needs to ask "has this ended?" — and the answer is not the engine's to
 * give. A turn-based combat game ends when one team is left standing; a card
 * game ends when a player's library is empty; a sandbox may never end. The
 * engine previously hardcoded the first of those (`TeamRegistry`), which meant
 * every game inherited team-based defeat whether it wanted it or not.
 *
 * A check is just a callback run at each settle boundary. It reports the game
 * is over by **throwing** — conventionally the game layer's `GameEndInterrupt`,
 * which the round loop catches — so a single check can end the game without the
 * engine modelling outcomes at all.
 *
 * ```ts
 * engine.outcomes.add((engine) => {
 *   if (engine.registeredCharacters.every((c) => c.destroyed)) {
 *     throw new GameEndInterrupt([]);
 *   }
 * });
 * ```
 *
 * The registry mirrors `engine.actions` and `engine.zones`: data the game
 * supplies, consulted by the engine at a defined point, with the engine owning
 * no opinion about the content.
 */
import type { GameEngine } from './engine.js';

/** A game-over check, run at every settle boundary. May throw to end the game. */
export type OutcomeCheck = (engine: GameEngine) => void;

export class OutcomeRegistry {
  readonly #checks: OutcomeCheck[] = [];

  /**
   * Adds a check, run in registration order at every settle boundary —
   * after every gauge batch and at the end of every `apply`.
   *
   * A check that throws ends the settle immediately (the error propagates out
   * of `apply`). Registering several is legal: the first to throw wins, which
   * is how "first to X" and "last one standing" can coexist.
   */
  add(check: OutcomeCheck): this {
    this.#checks.push(check);
    return this;
  }

  /** Whether any check is registered (diagnostics, tests). */
  get size(): number {
    return this.#checks.length;
  }

  /** @internal — the engine runs these at each settle boundary. */
  run(engine: GameEngine): void {
    for (const check of this.#checks) check(engine);
  }
}
