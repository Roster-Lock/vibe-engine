import { describe, expect, it } from 'vitest';
import {
  Character,
  Game,
  GameEndInterrupt,
  Player,
  cast,
  createPrng,
  skill,
  sortBySpeed,
  type Decision,
} from '../src/games/turn-based/index.js';

/** A manual ability with no effect — only needed to build valid Decisions. */
const strike = cast({ name: 'Strike', targeting: { who: 'enemy' }, cast: () => [] });

function decisionFor(speed: number, tag: string): Decision {
  const character = new Character(tag, {
    maxHp: 100,
    speed,
    skills: [skill({ name: 'Fighter', weight: 1, abilities: [strike] })],
  });
  return { character, ability: character.manualAbilities[0]!, targets: [] };
}

/** A player that never does anything (decides nothing). */
class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** A game whose rounds are scripted; `ending` is thrown when rounds run out. */
class StubGame extends Game {
  constructor(
    private readonly rounds: Decision[][],
    private readonly ending: Error,
    players: Player[] = [],
  ) {
    super(players);
  }

  async collectUserDecisions(): Promise<Decision[]> {
    return this.rounds.shift() ?? [];
  }

  async runGame(): Promise<void> {
    if (this.rounds.length === 0) throw this.ending;
  }
}

describe('Game', () => {
  it('runLoop returns the winning players when a GameEndInterrupt is thrown', async () => {
    const hero = new Character('Hero', { maxHp: 100 });
    const winner = new TestPlayer('Hero', [hero]);
    const game = new StubGame([], new GameEndInterrupt([winner]));
    const winners = await game.runLoop();
    expect(winners).toEqual([winner]);
  });

  it('GameEndInterrupt carries its winners and message', () => {
    const winner = new TestPlayer('Hero', []);
    const interrupt = new GameEndInterrupt([winner], 'party wins');
    expect(interrupt.name).toBe('GameEndInterrupt');
    expect(interrupt.winners).toEqual([winner]);
    expect(interrupt.message).toBe('party wins');
  });

  it('runLoop rethrows errors that are not GameEndInterrupt', async () => {
    const game = new StubGame([], new Error('boom'));
    await expect(game.runLoop()).rejects.toThrow('boom');
  });

  it('loops collect -> run until a GameEndInterrupt ends the game', async () => {
    const winner = new TestPlayer('Hero', []);
    const calls: string[] = [];
    class LoopingGame extends Game {
      #n = 0;
      async collectUserDecisions(): Promise<Decision[]> {
        calls.push(`collect:${++this.#n}`);
        return [];
      }
      async runGame(): Promise<void> {
        calls.push('run');
        throw new GameEndInterrupt([winner]);
      }
    }
    const winners = await new LoopingGame().runLoop();
    expect(calls).toEqual(['collect:1', 'run']);
    expect(winners).toEqual([winner]);
  });

  it('exposes the players passed to the constructor', () => {
    const a = new TestPlayer('A', []);
    const b = new TestPlayer('B', []);
    const game = new StubGame([], new GameEndInterrupt([]), [a, b]);
    expect(game.players).toEqual([a, b]);
  });
});

describe('sortBySpeed', () => {
  it('orders decisions by character speed, fastest first', () => {
    const slow = decisionFor(5, 'Slow');
    const fast = decisionFor(20, 'Fast');
    const mid = decisionFor(10, 'Mid');
    const sorted = sortBySpeed([slow, fast, mid]);
    expect(sorted.map((d) => d.character.name)).toEqual(['Fast', 'Mid', 'Slow']);
  });

  it('groups equal speeds and randomizes within the group', () => {
    const a = decisionFor(10, 'A');
    const b = decisionFor(10, 'B');
    const c = decisionFor(10, 'C');
    const fast = decisionFor(30, 'Fast');

    // rng = () => 0 makes the Fisher–Yates shuffle deterministic: a group
    // [A, B, C] shuffles to [B, C, A] — anything but the stable [A, B, C].
    const sorted = sortBySpeed([a, b, c, fast], () => 0);
    expect(sorted.map((d) => d.character.name)).toEqual(['Fast', 'B', 'C', 'A']);
  });

  it('randomizes tie groups from a seeded rng (reproducible)', () => {
    const tie = [decisionFor(10, 'X'), decisionFor(10, 'Y'), decisionFor(10, 'Z')];
    const rng = () => createPrng(1234)();
    const first = sortBySpeed(tie, rng).map((d) => d.character.name);
    const second = sortBySpeed(tie, rng).map((d) => d.character.name);
    // Same seed ⇒ same tie order; every tie member still appears once.
    expect(second).toEqual(first);
    expect([...first].sort()).toEqual(['X', 'Y', 'Z']);
  });

  it('does not mutate the input array', () => {
    const slow = decisionFor(5, 'Slow');
    const fast = decisionFor(20, 'Fast');
    const input = [slow, fast];
    sortBySpeed(input);
    expect(input.map((d) => d.character.name)).toEqual(['Slow', 'Fast']);
  });
});
