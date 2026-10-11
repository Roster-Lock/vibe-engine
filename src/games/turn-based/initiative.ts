/**
 * This game's **initiative**: descending `speed`, ties broken by a seeded
 * shuffle.
 *
 * Both pieces used to live in the engine. They are not engine concepts: the
 * engine has no round and no ordering — it dispatches events and runs actions,
 * and *when* a move happens relative to another is a game's decision. A card
 * game orders by priority and the stack; a real-time game orders by frame;
 * this game orders by who is fastest.
 *
 * (`Game` from the engine supplies the round *loop*; the ordering inside a
 * round is supplied here. `LocalGame.runGame` calls `sortBySpeed`.)
 */
import { shuffle, type Decision } from '../../engine/index.js';

/**
 * The speed a character acts at when its definition does not say — 10, the
 * value every character in this game has always had. It lives here rather than
 * in the engine because it is a **balance number**, not a mechanic: the engine
 * defaults `speed` to 0, and this game decides that 10 is normal.
 */
export const DEFAULT_SPEED = 10;

/**
 * Sorts a round's decisions into **initiative order**: the acting characters'
 * speed, descending — fastest first. Characters with the same speed stay
 * grouped together, and the order *within* each group is **randomized** with
 * `rng` (defaults to `Math.random`; pass the engine's seeded PRNG via
 * `engine.random` for reproducible games — see `LocalGame.runGame`). Use this
 * in `runGame` to run each move before the next.
 */
export function sortBySpeed(
  decisions: readonly Decision[],
  rng: () => number = Math.random,
): Decision[] {
  // 1. Descending speed: equal speeds end up adjacent.
  const sorted = [...decisions].sort((a, b) => b.character.speed - a.character.speed);
  // 2. Group the equal speeds and shuffle within each group.
  const groups: Decision[][] = [];
  for (const decision of sorted) {
    const group = groups[groups.length - 1];
    if (group && group[0]!.character.speed === decision.character.speed) group.push(decision);
    else groups.push([decision]);
  }
  const out: Decision[] = [];
  for (const group of groups) {
    shuffle(group, rng);
    out.push(...group);
  }
  return out;
}
