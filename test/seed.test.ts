import { describe, expect, it } from 'vitest';
import {
  buildSeed,
  commitSecret,
  createPrng,
  createRandomSeed,
  hashString,
  shuffle,
  verifyCommit,
} from '../src/engine/index.js';

describe('seed helpers', () => {
  it('hashString is deterministic and sensitive to input', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('commitSecret/verifyCommit round-trip and reject a wrong secret', () => {
    const commit = commitSecret('secret-1');
    expect(verifyCommit(commit, 'secret-1')).toBe(true);
    expect(verifyCommit(commit, 'secret-2')).toBe(false);
  });

  it('buildSeed sorts contributions by playerId', () => {
    const seed = buildSeed([
      { playerId: 'zulu', secret: 'z' },
      { playerId: 'alpha', secret: 'a' },
    ]);
    expect(seed).toBe('alpha:a|zulu:z');
  });

  it('buildSeed is independent of the reveal order', () => {
    const forward = buildSeed([
      { playerId: 'p1', secret: 'x' },
      { playerId: 'p2', secret: 'y' },
    ]);
    const backward = buildSeed([
      { playerId: 'p2', secret: 'y' },
      { playerId: 'p1', secret: 'x' },
    ]);
    expect(forward).toBe(backward);
  });

  it('createPrng is deterministic per seed', () => {
    const seq = (seed: number): number[] => {
      const rng = createPrng(seed);
      return [rng(), rng(), rng()];
    };
    expect(seq(42)).toEqual(seq(42));
  });

  it('createPrng differs across seeds', () => {
    const seq = (seed: number): number[] => {
      const rng = createPrng(seed);
      return [rng(), rng(), rng()];
    };
    expect(seq(1)).not.toEqual(seq(2));
  });

  it('shuffle is a permutation of its input', () => {
    const items = ['a', 'b', 'c', 'd'];
    shuffle(items, createPrng(7));
    expect([...items].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shuffle with a scripted rng is exact', () => {
    // For a 3-item list, Fisher–Yates draws j = floor(rng()*(i+1)):
    // i=2 → 0.5*3=1.5 → j=1, i=1 → 0*2=0 → j=0.
    const items = ['a', 'b', 'c'];
    let calls = 0;
    shuffle(items, () => (calls++ === 0 ? 0.5 : 0));
    expect(items).toEqual(['c', 'a', 'b']);
  });

  it('createRandomSeed produces distinct strings', () => {
    expect(createRandomSeed()).not.toBe(createRandomSeed());
  });
});
