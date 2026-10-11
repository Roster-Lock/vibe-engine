/**
 * The sim's seeded PRNG.
 *
 * The RTS is deterministic: the same seed, the same unit placement and the
 * same compiled abilities always produce the same battle, tick for tick.
 * That is what makes `test/battle.test.ts` able to assert on an outcome,
 * and what would let two players replay the same skirmish from a seed.
 *
 * `mulberry32` is used because it is four lines, has no hidden global state,
 * and is stable across JS engines — a `Math.random` anywhere in the sim
 * would quietly break all of the above.
 */
export interface Rng {
  /** Uniform in `[0, 1)`. */
  next(): number;
  /** Uniform integer in `[min, max]`. */
  int(min: number, max: number): number;
  /** Uniform in `[min, max)`. */
  range(min: number, max: number): number;
  /** Picks one element; throws on an empty array. */
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    range: (min, max) => min + next() * (max - min),
    pick: (items) => {
      if (items.length === 0) throw new Error('rng.pick: empty array');
      return items[Math.floor(next() * items.length)]!;
    },
  };
}
