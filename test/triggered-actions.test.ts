/**
 * Triggered actions — the event/trigger machinery end to end:
 *
 * 1. **One cause → every event** — a single action fires the full event
 *    chain it causes (gauge, survive/destroy, batches), in order.
 * 2. **Multiple causes → every event** — simultaneous causes fire one
 *    event per cause, then the batch events carrying all of them.
 * 3. **Anything that can trigger an event triggers it** — every event
 *    type in the `GameEvent` union reaches a listener, and every kind of
 *    ability (manual, auto) produces its events.
 *
 * Covers the versioned events (see src/engine/events.ts): no optional
 * fields — a `source`/`target`/`maxChanges` is either present on the
 * version or the version without it fired.
 */
import { describe, expect, it } from 'vitest';
import {
  Buff,
  Character,
  GameEngine,
  Player,
  addBuff,
  auto,
  buff,
  cast,
  damage,
  heal,
  maxModifier,
  removeBuff,
  skill,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';

class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

function char(name: string, maxHp: number): Character {
  return new Character(name, { maxHp, maxMana: maxHp });
}

function player(name: string, characters: Character[], team: string): TestPlayer {
  return new TestPlayer(name, characters, team);
}

/** A fresh engine recording every emitted event, in order. */
function recorder(players: TestPlayer[]): { engine: GameEngine; events: GameEvent[]; types: string[] } {
  const events: GameEvent[] = [];
  const types: string[] = [];
  const engine = createEngine({
    onEvent: (e) => {
      events.push(e);
      types.push(e.type);
    },
  });
  engine.registerPlayers(players);
  return { engine, events, types };
}

function isGaugeChanged(e: GameEvent): e is Extract<GameEvent, { type: 'gauge:changed' }> {
  return e.type === 'gauge:changed';
}

/* ----------------------- 1. one cause → all events ----------------------- */

describe('one cause fires every event it causes', () => {
  it('a single damage: gauge:changed (with source) → survived → batch', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const { engine, events, types } = recorder([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);

    await engine.damage(goblin.gauge('hp'), 30, hero);

    expect(types).toEqual([
      'gauge:changed',
      'gauge:changed:batch',
      'character:survived',
      'character:survived:batch',
    ]);
    const gauge = events.find(isGaugeChanged)!;
    expect(gauge.from).toBe(100);
    expect(gauge.to).toBe(70);
    expect('target' in gauge && gauge.target).toBe(goblin);
    expect('source' in gauge && gauge.source).toBe(hero); // the damage version carries the source
    const survived = events.find((e) => e.type === 'character:survived');
    expect(survived?.character).toBe(goblin);
  });

  it('a single kill: gauge:changed → destroyed → batch', async () => {
    const hero = char('Hero', 100);
    const shaman = char('Shaman', 100);
    const goblin = char('Goblin', 20);
    const shaman2 = char('Shaman II', 100); // keeps the monsters team standing
    const { engine, events, types } = recorder([
      player('Hero', [hero, shaman], 'party'),
      player('Goblins', [goblin, shaman2], 'monsters'),
    ]);

    await engine.damage(goblin.gauge('hp'), 999, hero);

    expect(types).toEqual([
      'gauge:changed',
      'gauge:changed:batch',
      // A destroy is a move to the garbage, so it announces the zone
      // change too: the mechanical fact ("left play") before the
      // interpretation ("died, for this reason").
      'zone:changed',
      'zone:changed:batch',
      'character:destroyed',
      'character:destroyed:batch',
    ]);
    const destroyed = events.find((e): e is Extract<GameEvent, { type: 'character:destroyed' }> => e.type === 'character:destroyed')!;
    expect(destroyed.reason).toBe('hp:current-reached-minimum');
    expect('source' in destroyed ? destroyed.source : undefined).toBe(hero);
  });

  it('a heal: gauge:changed (up) with no survived/batch', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 50);
    const { engine, events, types } = recorder([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);
    await engine.damage(goblin.gauge('hp'), 10, hero); // 40, survived
    await engine.heal(goblin.gauge('hp'), 6, hero); // 46, heal-only batch

    const gauges = events.filter(isGaugeChanged);
    expect(gauges[1]!.from).toBe(40);
    expect(gauges[1]!.to).toBe(46);
    // Damage batch: survived + batch. Heal-only batch: just the gauge.
    expect(types).toEqual([
      'gauge:changed',
      'gauge:changed:batch',
      'character:survived',
      'character:survived:batch',
      'gauge:changed',
      'gauge:changed:batch',
    ]);
  });

  it('a buff applied: buff:added fires with the source', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const { engine, events, types } = recorder([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);

    await engine.addBuff(goblin, buff({ name: 'Poison', weight: 1 }), hero);

    expect(types).toEqual(['buff:added']);
    const added = events[0];
    if (added?.type === 'buff:added') {
      expect(added.buff.id).toBe('poison');
      expect('source' in added && added.source).toBe(hero);
    }
  });

  it('a buff removed: buff:destroyed fires with the reason and source', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const { engine, events, types } = recorder([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);
    await engine.addBuff(goblin, buff({ name: 'Poison', weight: 1 }));
    const untilRemoval = types.length;
    types.length = 0;

    await engine.removeBuff(goblin, 'poison', hero);

    expect(types).toEqual(['buff:destroyed', 'buff:destroyed:batch']);
    const destroyed = events[untilRemoval];
    if (destroyed?.type === 'buff:destroyed') {
      expect(destroyed.reason).toBe('removed');
      expect('source' in destroyed && destroyed.source).toBe(hero);
    }
  });

  it('a max change: gauge:maxChanged fires when a maxModifier lands', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const { engine, events, types } = recorder([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin], 'monsters'),
    ]);

    await engine.addBuff(
      hero,
      buff({ name: 'Fortify', weight: 1, abilities: [maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 })] }),
    );

    expect(types).toContain('gauge:maxChanged');
    const maxEvent = events.find((e): e is Extract<GameEvent, { type: 'gauge:maxChanged' }> => e.type === 'gauge:maxChanged')!;
    expect(maxEvent.from).toBe(100);
    expect(maxEvent.to).toBe(150);
  });

  it('a turn: turn:start and turn:end fire', async () => {
    const hero = char('Hero', 100);
    const { engine, types } = recorder([player('Hero', [hero], 'party')]);
    await startTurn(engine);
    await endTurn(engine);
    expect(types).toEqual(['turn:start', 'turn:end']);
  });

  it('a cycle: cycle:detected fires when a status tries to grant its own ancestor', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const { engine, events, types } = recorder([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin], 'monsters'),
    ]);
    const loop = buff({
      name: 'Loop',
      weight: 1,
      abilities: [
        auto({
          name: 'Reapply',
          event: 'buff:added',
          when: (ctx) => ctx.event.buff.id === 'loop',
          targeting: { who: 'self' },
          cast: (ctx) => [addBuff(ctx.self, loop)],
        }),
      ],
    });

    await engine.addBuff(hero, loop);

    expect(types).toContain('cycle:detected');
    const cycle = events.find((e) => e.type === 'cycle:detected');
    if (cycle?.type === 'cycle:detected') {
      expect(cycle.grantor.id).toBe('loop');
      expect(cycle.attemptedId).toBe('loop');
    }
  });
});

/* --------------------- 2. multiple causes → all events -------------------- */

describe('multiple causes fire every event', () => {
  it('two survivors in one batch: one gauge event each, then one batch', async () => {
    const hero = char('Hero', 100);
    const a = char('A', 100);
    const b = char('B', 100);
    const { engine, events, types } = recorder([player('Hero', [hero], 'party'), player('Monsters', [a, b], 'monsters')]);

    await engine.apply([damage(a.gauge('hp'), 10, hero), damage(b.gauge('hp'), 20, hero)]);

    expect(types).toEqual([
      'gauge:changed',
      'gauge:changed',
      'gauge:changed:batch',
      'character:survived',
      'character:survived',
      'character:survived:batch',
    ]);
    const gauges = events.filter(isGaugeChanged);
    expect(gauges.map((g) => ('target' in g ? g.target.name : '?'))).toEqual(['A', 'B']);
    const batch = events.find((e) => e.type === 'character:survived:batch');
    if (batch?.type === 'character:survived:batch') {
      expect(batch.events.map((e) => e.character.name)).toEqual(['A', 'B']);
    }
  });

  it('two kills in one batch: one destroyed each, then one batch, game continues', async () => {
    const hero = char('Hero', 100);
    const shaman = char('Shaman', 100);
    const a = char('A', 10);
    const b = char('B', 10);
    const c = char('C', 100); // survivor keeps the monsters team standing
    const { engine, events, types } = recorder([
      player('Hero', [hero, shaman], 'party'),
      player('Monsters', [a, b, c], 'monsters'),
    ]);

    await engine.apply([damage(a.gauge('hp'), 999, hero), damage(b.gauge('hp'), 999, hero)]);

    expect(types).toEqual([
      'gauge:changed',
      'gauge:changed',
      'gauge:changed:batch',
      'zone:changed',
      'zone:changed',
      'zone:changed:batch',
      'character:destroyed',
      'character:destroyed',
      'character:destroyed:batch',
    ]);
    const batch = events.find((e) => e.type === 'character:destroyed:batch');
    if (batch?.type === 'character:destroyed:batch') {
      expect(batch.events.map((e) => e.character.name)).toEqual(['A', 'B']);
      expect(engine.isInPlay(c)).toBe(true);
    }
  });

  it('a mixed batch: one survives, one dies — both event chains fire', async () => {
    const hero = char('Hero', 100);
    const shaman = char('Shaman', 100);
    const survivor = char('Survivor', 100);
    const victim = char('Victim', 10);
    const { engine, types } = recorder([
      player('Hero', [hero, shaman], 'party'),
      player('Monsters', [survivor, victim], 'monsters'),
    ]);

    await engine.apply([damage(survivor.gauge('hp'), 5, hero), damage(victim.gauge('hp'), 999, hero)]);

    expect(types).toEqual([
      'gauge:changed',
      'gauge:changed',
      'gauge:changed:batch',
      // A destroy is a move to the garbage, so it announces the zone
      // change too: the mechanical fact ("left play") before the
      // interpretation ("died, for this reason").
      'zone:changed',
      'zone:changed:batch',
      'character:destroyed',
      'character:destroyed:batch',
      'character:survived',
      'character:survived:batch',
    ]);
    expect(engine.isInPlay(survivor)).toBe(true);
    expect(engine.isInPlay(victim)).toBe(false);
  });

  it('one batch cause fires a trigger once per cause, and the batch trigger once', async () => {
    const hero = char('Hero', 100);
    const a = char('A', 100);
    const b = char('B', 100);
    const perGauge: string[] = [];
    const perBatch: string[] = [];
    const engine = createEngine();
    engine.registerPlayers([player('Hero', [hero], 'party'), player('Monsters', [a, b], 'monsters')]);
    const watcher = buff({
      name: 'Watcher',
      weight: 1,
      abilities: [
        auto({
          name: 'Watch Gauge',
          event: 'gauge:changed',
          cast: (ctx) => {
            perGauge.push('target' in ctx.event && ctx.event.target ? ctx.event.target.name : '?');
            return [];
          },
        }),
        auto({
          name: 'Watch Batch',
          event: 'character:survived:batch',
          cast: (ctx) => {
            perBatch.push(ctx.event.events.length.toString());
            return [];
          },
        }),
      ],
    });
    await engine.addBuff(hero, watcher);

    await engine.apply([damage(a.gauge('hp'), 10, hero), damage(b.gauge('hp'), 20, hero)]);

    expect(perGauge).toEqual(['A', 'B']); // one trigger per cause
    expect(perBatch).toEqual(['2']); // one batch trigger carrying both
  });
});

/* ------------ 3. anything that can trigger an event triggers it ----------- */

describe('anything that can trigger an event triggers it', () => {
  /** Every event type in the GameEvent union, with a way to cause it. */
  const causes: Array<{
    event: GameEvent['type'];
    why: string;
    cause: (engine: GameEngine, hero: Character, goblin: Character) => Promise<void>;
  }> = [
    { event: 'turn:start', why: 'a turn starts', cause: (e) => startTurn(e) },
    { event: 'turn:end', why: 'a turn ends', cause: (e) => endTurn(e) },
    {
      event: 'gauge:changed',
      why: 'a character is damaged',
      cause: (e, hero, goblin) => e.damage(goblin.gauge('hp'), 10, hero),
    },
    {
      event: 'gauge:maxChanged',
      why: 'a maxModifier buff lands',
      cause: (e, hero) =>
        e.addBuff(hero, buff({ name: 'Fortify', weight: 1, abilities: [maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 })] })),
    },
    {
      event: 'buff:added',
      why: 'a buff is applied',
      cause: (e, hero, goblin) => e.addBuff(goblin, buff({ name: 'Poison', weight: 1 }), hero),
    },
    {
      event: 'buff:destroyed',
      why: 'a buff is removed',
      cause: async (e, hero, goblin) => {
        await e.addBuff(goblin, buff({ name: 'Poison', weight: 1 }));
        await e.removeBuff(goblin, 'poison', hero);
      },
    },
    {
      event: 'cycle:detected',
      why: 'a status tries to grant its own ancestor',
      cause: (e, hero) => {
        const loop = buff({
          name: 'Loop',
          weight: 1,
          abilities: [
            auto({
              name: 'Reapply',
              event: 'buff:added',
              when: (ctx) => ctx.event.buff.id === 'loop',
              targeting: { who: 'self' },
              cast: (ctx) => [addBuff(ctx.self, loop)],
            }),
          ],
        });
        return e.addBuff(hero, loop);
      },
    },
    {
      event: 'character:destroyed',
      why: 'a character is destroyed',
      cause: (e, hero, goblin) => e.damage(goblin.gauge('hp'), 999, hero),
    },
    {
      event: 'character:survived',
      why: 'a character survives a hit',
      cause: (e, hero, goblin) => e.damage(goblin.gauge('hp'), 10, hero),
    },
    {
      event: 'character:destroyed:batch',
      why: 'a character is destroyed (the batch variant)',
      cause: (e, hero, goblin) => e.damage(goblin.gauge('hp'), 999, hero),
    },
    {
      event: 'character:survived:batch',
      why: 'a character survives a hit (the batch variant)',
      cause: (e, hero, goblin) => e.damage(goblin.gauge('hp'), 10, hero),
    },
    {
      event: 'ability:used',
      why: 'a character uses a manual ability',
      cause: (e, hero, goblin) => {
        const strike = cast({
          name: 'Strike',
          targeting: { who: 'enemy' },
          cast: (ctx, t) => [damage(t.targets[0]!.gauge('hp'), 10, ctx.self)],
        });
        hero.addBuff(new Buff(buff({ name: 'Fighter', weight: 1, abilities: [strike] })));
        return e.useAbility(hero, strike, { targets: [goblin] });
      },
    },
  ];

  for (const { event, why, cause } of causes) {
    it(`a listener on '${event}' fires when ${why}`, async () => {
      const seen: string[] = [];
      const hero = new Character('Hero', {
        maxHp: 100,
        maxMana: 100,
        // A skill carrying the listener — armed at registration, before the
        // cause runs, so it hears the very event the cause produces.
        skills: [
          skill({
            name: 'Listener',
            weight: 1,
            abilities: [
              auto({
                name: `Listen ${event}`,
                event,
                cast: () => {
                  seen.push(event);
                  return [];
                },
              }),
            ],
          }),
        ],
      });
      const goblin = char('Goblin', 100);
      const shaman = char('Shaman', 100); // keeps the monsters team standing on kills
      const engine = createEngine();
      engine.registerPlayers([
        player('Hero', [hero], 'party'),
        player('Monsters', [goblin, shaman], 'monsters'),
      ]);

      await cause(engine, hero, goblin);

      expect(seen).toEqual([event]);
    });
  }

  it("a character's manual ability produces ability:used and its damage events", async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const { engine, types } = recorder([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);
    const strike = cast({
      name: 'Strike',
      targeting: { who: 'enemy' },
      cast: (ctx, t) => [damage(t.targets[0]!.gauge('hp'), 10, ctx.self)],
    });
    hero.addBuff(new Buff(buff({ name: 'Fighter', weight: 1, abilities: [strike] })));

    await engine.useAbility(hero, strike, { targets: [goblin] });

    expect(types).toEqual([
      'ability:used',
      'gauge:changed',
      'gauge:changed:batch',
      'character:survived',
      'character:survived:batch',
    ]);
    expect(goblin.gauge('hp').current).toBe(90);
  });

  it("a buff's triggered ability fires on its event and its own actions re-trigger", async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const { engine, events, types } = recorder([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);
    const chain = buff({
      name: 'Chain',
      weight: 1,
      abilities: [
        auto({
          name: 'Revenge',
          event: 'gauge:changed',
          when: (ctx) => 'target' in ctx.event && ctx.event.target === ctx.self && ctx.event.to < ctx.event.from,
          cast: (ctx) => {
            const source = 'source' in ctx.event ? ctx.event.source : undefined;
            // Hit whoever caused it back, or ourselves when nothing did.
            const victim = source && source.type === 'character' ? source : ctx.self;
            return [damage(victim.gauge('hp'), 5, ctx.self)];
          },
        }),
      ],
    });
    await engine.addBuff(goblin, chain);

    await engine.damage(goblin.gauge('hp'), 10, hero);

    // The buff's trigger fired (hero lost 5), and its own damage re-emitted
    // a gauge:changed — the queue drained the whole chain.
    expect(hero.gauge('hp').current).toBe(95);
    expect(goblin.gauge('hp').current).toBe(90);
    const gauges = events.filter(isGaugeChanged);
    expect(gauges.length).toBeGreaterThanOrEqual(2);
    expect(types.filter((t) => t === 'gauge:changed').length).toBeGreaterThanOrEqual(2);
  });

  it("a skill's triggered ability fires for the lifetime of the character", async () => {
    const seen: string[] = [];
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      hp: 96, // wounded, so each Drink actually heals
      skills: [
        skill({
          name: 'Drinker',
          weight: 1,
          abilities: [
            auto({
              name: 'Drink',
              event: 'turn:start',
              cast: (ctx) => {
                seen.push('drink');
                return [heal(ctx.self.gauge('hp'), 2)];
              },
            }),
          ],
        }),
      ],
    });
    const engine = createEngine();
    engine.registerCharacter(hero);

    await startTurn(engine);
    await startTurn(engine);

    expect(seen).toEqual(['drink', 'drink']);
    expect(hero.gauge('hp').current).toBe(100);
  });
});
