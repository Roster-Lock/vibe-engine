/**
 * Dice — where a roll's numbers come from (docs/design/20-secret-choices-and-dice.md).
 *
 * A roll is a **result source**, not a decision: nobody is asked to choose
 * anything, and any player may roll for any other. The engine only needs
 * `count` numbers in `1..sides` from *somewhere*, so that somewhere is a
 * replaceable function, a `Roller`:
 *
 * | Source | For |
 * | --- | --- |
 * | `seededRoller` (the default) | solo, hot-seat, AI-vs-AI, tests, replays |
 * | a table roller | physical play — the result of the physical die |
 * | a server roller | online — a secure source whose state never leaves the server |
 *
 * The default draws from **its own stream**, derived from the game seed, so
 * rolling a die does not shift the trigger-order shuffle (and adding a trigger
 * does not shift your dice).
 *
 * The seeded source is **not safe online without a server**: the seed ceremony
 * reveals it, after which every later number is computable. See the design doc.
 */
import type { EventSource } from './events.js';
import { createPrng, hashString } from './seed.js';

/** What a roller is told about the roll it is answering. */
export interface RollContext {
  /** Who is rolling, when the roll has a source. */
  readonly source: EventSource | undefined;
  /** Why, for a table roller to prompt with ("attack roll"). */
  readonly reason: string | undefined;
}

/** Produces `count` results, each in `1..sides`. May be async (a table, a server). */
export type Roller = (
  count: number,
  sides: number,
  context: RollContext,
) => readonly number[] | Promise<readonly number[]>;

/** The PRNG for dice, derived from the game seed and separate from the trigger shuffle's. */
export function createDiceRng(seed: string): () => number {
  return createPrng(hashString(`${seed}:dice`));
}

/** A roller over a PRNG: each die is `1 + floor(rng() * sides)`. */
export function seededRoller(rng: () => number): Roller {
  return (count, sides) => Array.from({ length: count }, () => 1 + Math.floor(rng() * sides));
}

/**
 * Throws if a roller's answer is not `count` whole numbers in `1..sides`. A
 * roller is the one place a bad number can enter (a typo at a table, a buggy
 * server), so every answer is checked before the game uses it.
 */
export function assertValidRoll(results: readonly number[], count: number, sides: number): void {
  if (results.length !== count) {
    throw new Error(`roll: the roller returned ${results.length} result(s) for ${count} dice`);
  }
  for (const value of results) {
    if (!Number.isInteger(value) || value < 1 || value > sides) {
      throw new Error(`roll: ${value} is not a possible result of a d${sides}`);
    }
  }
}
