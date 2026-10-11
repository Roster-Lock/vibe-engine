import { describe, expect, it } from 'vitest';
import {
  Character,
  Game,
  GameEndInterrupt,
  GameEngine,
  Player,
  auto,
  buff,
  buildSeed,
  commitSecret,
  createPrng,
  damage,
  hashString,
  removeBuff,
  shuffle,
  type Decision,
} from '../src/games/turn-based/index.js';
import { LocalGame, ScriptedPlayer } from '../src/multiplayer/local.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';

/**
 * Builds an engine whose turn:end event is heard by four triggers, added in
 * the order A, B, C, D — the same order their listener ids are assigned.
 * Returns the order in which the triggers fired (by owner name).
 */
async function runFourTriggers(seed: string): Promise<string[]> {
  const engine = createEngine({ seed });
  const seen: string[] = [];
  for (const name of ['A', 'B', 'C', 'D']) {
    const character = new Character(name, { maxHp: 100 });
    engine.registerCharacter(character);
    const tick = buff({
      name: `Tick ${name}`,
      weight: 1,
      abilities: [
        auto({
          name: `Tick ${name}`,
          event: 'turn:end',
          cast: (ctx) => {
            seen.push(ctx.self.name);
            return [];
          },
        }),
      ],
    });
    await engine.addBuff(character, tick);
  }
  await endTurn(engine);
  return seen;
}

describe('the trigger stack', () => {
  it('collects every matching trigger into the stack and runs each exactly once', async () => {
    const seen = await runFourTriggers('any-seed');
    expect([...seen].sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(new Set(seen).size).toBe(4);
  });

  it('orders triggers deterministically for a given seed', async () => {
    const first = await runFourTriggers('same-seed');
    const second = await runFourTriggers('same-seed');
    expect(first).toEqual(second);
  });

  it('sorts by listener id, then shuffles with the seeded PRNG', async () => {
    // Registration order == listener-id order (monotonic ids), so the
    // engine's pipeline is: sort ascending id (A,B,C,D), then Fisher–Yates
    // with createPrng(hashString(seed)). Pin the exact expected order.
    const seed = 'pinned-order';
    const expected = ['A', 'B', 'C', 'D'];
    shuffle(expected, createPrng(hashString(seed)));
    expect(await runFourTriggers(seed)).toEqual(expected);
  });

  it('different seeds can produce a different order', async () => {
    const orders = new Set<string>();
    for (let i = 0; i < 12; i++) orders.add((await runFourTriggers(`seed-${i}`)).join(''));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('the prestack filter (when) gates what joins the prepare stack', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    engine.registerCharacter(hero);
    const seen: string[] = [];

    const gated = buff({
      name: 'Gated',
      weight: 1,
      abilities: [
        auto({
          name: 'Gated Tick',
          event: 'turn:end',
          when: () => false,
          cast: () => {
            seen.push('gated');
            return [];
          },
        }),
      ],
    });
    const open = buff({
      name: 'Open',
      weight: 1,
      abilities: [
        auto({
          name: 'Open Tick',
          event: 'turn:end',
          cast: () => {
            seen.push('open');
            return [];
          },
        }),
      ],
    });
    await engine.addBuff(hero, gated);
    await engine.addBuff(hero, open);
    await endTurn(engine);
    expect(seen).toEqual(['open']);
  });

  it('a when-guard can filter on the event payload', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    const seen: string[] = [];

    const retaliate = buff({
      name: 'Retaliate',
      weight: 1,
      abilities: [
        auto({
          name: 'Retaliate',
          event: 'gauge:changed',
          when: (ctx) => 'target' in ctx.event && ctx.event.target === ctx.self,
          cast: () => {
            seen.push('retaliated');
            return [];
          },
        }),
      ],
    });
    await engine.addBuff(goblin, retaliate);
    await engine.damage(hero.gauge('hp'), 5, goblin); // hero's gauge changed, not goblin's
    expect(seen).toEqual([]);
    await engine.damage(goblin.gauge('hp'), 5, hero); // goblin took damage -> trigger
    expect(seen).toEqual(['retaliated']);
  });

  it('identical triggers on different characters each get their own listener', async () => {
    const engine = createEngine();
    const a = new Character('A', { maxHp: 100 });
    const b = new Character('B', { maxHp: 100 });
    engine.registerCharacter(a);
    engine.registerCharacter(b);
    const twin = buff({
      name: 'Twin',
      weight: 1,
      abilities: [
        auto({ name: 'Twin Tick', event: 'turn:end', cast: (ctx) => [damage(ctx.self.gauge('hp'), 1)] }),
      ],
    });
    await engine.addBuff(a, twin);
    await engine.addBuff(b, twin);
    await endTurn(engine);
    expect(a.gauge('hp').current).toBe(99);
    expect(b.gauge('hp').current).toBe(99);
  });

  it('a trigger already on the stack resolves even if its source is removed first', async () => {
    const engine = createEngine({ seed: 'stack-capture' });
    const hero = new Character('Hero', { maxHp: 100 });
    engine.registerCharacter(hero);
    const seen: string[] = [];

    const sweeper = buff({
      name: 'Sweeper',
      weight: 1,
      abilities: [
        auto({
          name: 'Sweep',
          event: 'turn:end',
          cast: (ctx) => [removeBuff(ctx.self, 'tick')],
        }),
      ],
    });
    const tick = buff({
      name: 'Tick',
      weight: 1,
      abilities: [
        auto({
          name: 'Tick',
          event: 'turn:end',
          cast: () => {
            seen.push('tick');
            return [];
          },
        }),
      ],
    });
    await engine.addBuff(hero, sweeper);
    await engine.addBuff(hero, tick);
    await endTurn(engine);
    // Whichever runs first, the tick was captured at collection time.
    expect(seen).toEqual(['tick']);
    expect(hero.hasStatus('tick')).toBe(false);
  });

  it('exposes the seed option and setSeed', () => {
    const engine = createEngine({ seed: 'fixed' });
    expect(engine.seed).toBe('fixed');
    engine.setSeed('changed');
    expect(engine.seed).toBe('changed');
  });
});

describe('the seed ceremony', () => {
  /** A game whose rounds do nothing but end immediately (draw). */
  class EmptyGame extends Game {
    async collectUserDecisions(): Promise<Decision[]> {
      return [];
    }
    async runGame(): Promise<void> {
      throw new GameEndInterrupt([]);
    }
  }

  /** A player without seed hooks — never participates in the ceremony. */
  class SilentPlayer extends Player {
    async decide(): Promise<Decision[]> {
      return [];
    }
  }

  /** A player with a fixed secret and an explicit id. */
  class SecretPlayer extends Player {
    constructor(name: string, id: string, private readonly secret: string) {
      super(name, [], undefined, id);
    }
    async decide(): Promise<Decision[]> {
      return [];
    }
    override commitSeed(): string {
      return commitSecret(this.secret);
    }
    override revealSeed(): string {
      return this.secret;
    }
  }

  it('defaults player ids to a slug of the name', () => {
    expect(new ScriptedPlayer('Hero', []).id).toBe('hero');
    expect(new SilentPlayer('Two Words', []).id).toBe('two-words');
  });

  it('returns undefined when no player contributes', async () => {
    const game = new EmptyGame([new SilentPlayer('A', [])]);
    expect(await game.collectSeed()).toBeUndefined();
  });

  it('builds the seed from revealed secrets, sorted by playerId', async () => {
    const game = new EmptyGame([
      new SecretPlayer('Zed', 'z2', 'zzz'),
      new SecretPlayer('Alpha', 'a1', 'aaa'),
    ]);
    expect(await game.collectSeed()).toBe('a1:aaa|z2:zzz');
  });

  it('commits all secrets before revealing any', async () => {
    const order: string[] = [];
    class OrderlyPlayer extends Player {
      constructor(name: string, secret: string) {
        super(name, [], undefined, name);
        this.secret = secret;
      }
      private readonly secret: string;
      async decide(): Promise<Decision[]> {
        return [];
      }
      override commitSeed(): string {
        order.push(`commit:${this.name}`);
        return commitSecret(this.secret);
      }
      override revealSeed(): string {
        order.push(`reveal:${this.name}`);
        return this.secret;
      }
    }
    const game = new EmptyGame([
      new OrderlyPlayer('first', 's1'),
      new OrderlyPlayer('second', 's2'),
    ]);
    await game.collectSeed();
    // All commits happen before the first reveal.
    expect(order.indexOf('reveal:first')).toBeGreaterThan(order.indexOf('commit:second'));
    expect(order.filter((s) => s.startsWith('commit:'))).toHaveLength(2);
    expect(order.filter((s) => s.startsWith('reveal:'))).toHaveLength(2);
  });

  it('rejects a reveal that does not match its commit', async () => {
    class Cheater extends Player {
      constructor() {
        super('Cheater', []);
      }
      async decide(): Promise<Decision[]> {
        return [];
      }
      override commitSeed(): string {
        return commitSecret('committed');
      }
      override revealSeed(): string {
        return 'different';
      }
    }
    const game = new EmptyGame([new Cheater()]);
    await expect(game.collectSeed()).rejects.toThrow(/does not match its commit/);
  });

  it('LocalGame forwards the ceremony seed to its engine before round 1', async () => {
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    const game = new LocalGame(
      [
        new ScriptedPlayer('Hero', [hero], 'party'),
        new ScriptedPlayer('Goblins', [goblin], 'monsters'),
      ],
      { maxRounds: 1 },
    );
    await game.runLoop();
    const expected = buildSeed([
      { playerId: 'goblins', secret: 'scripted:goblins' },
      { playerId: 'hero', secret: 'scripted:hero' },
    ]);
    expect(game.engine.seed).toBe(expected);
  });
});
