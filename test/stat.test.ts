import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  Gauge,
  Player,
  buff,
  cast,
  damage,
  destroy,
  maxModifier,
  skill,
  stat,
  type Decision,
  type GaugeMaxChangedEvent,
  type StatChangedEvent,
  type StatContext,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

/** A player that never decides — the tests drive the engine directly. */
class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** MTG-style "creatures you control" — every in-play character with the same controller. */
const creaturesYouControl = (ctx: StatContext): number =>
  ctx.engine.registeredCharacters.filter(
    (c) => c.controller === ctx.self.controller && ctx.engine.isInPlay(c),
  ).length;

describe('derived stats', () => {
  it('reads named stats by name and leaves unknown names undefined', () => {
    const goblin = new Character('Goblin', { maxHp: 20, stats: { power: 2, toughness: 3 } });
    expect(goblin.stat('power')).toBe(2);
    expect(goblin.stat('toughness')).toBe(3);
    expect(goblin.stat('speed')).toBe(10); // built-in: DEFAULT_SPEED
    expect(goblin.stat('nope')).toBeUndefined();
    // Gauge maxes are not named stats — they are read from the gauge.
    expect(goblin.stat('maxHp')).toBeUndefined();
    expect(goblin.gauge('hp').max).toBe(20);
  });

  it('rejects built-in names and non-finite values in CharacterDef.stats', () => {
    expect(() => new Character('H', { maxHp: 10, stats: { maxHp: 5 } })).toThrow(/built-in stat/);
    expect(() => new Character('H', { maxHp: 10, stats: { speed: 5 } })).toThrow(/built-in stat/);
    expect(() => new Character('H', { maxHp: 10, stats: { power: Number.NaN } })).toThrow(/finite number/);
  });

  it('derives a gauge max from a function — "toughness equals creatures you control"', async () => {
    const hiveMind = buff({
      name: 'Hive Mind',
      weight: 1,
      abilities: [
        stat({
          name: 'Hive Mind',
          gauge: 'mana', // the derived max of the mana gauge
          value: (ctx) => creaturesYouControl(ctx),
        }),
      ],
    });
    const queen = new Character('Ant Queen', { maxHp: 30, maxMana: 1 });
    const droneA = new Character('Drone A', { maxHp: 5 });
    const droneB = new Character('Drone B', { maxHp: 5 });
    const enemy = new Character('Wolf', { maxHp: 8 });
    const queenPlayer = new TestPlayer('Queen', [queen, droneA, droneB], 'hive');

    const maxChanges: GaugeMaxChangedEvent[] = [];
    const engine = createEngine({
      onEvent: (e) => {
        if (e.type === 'gauge:maxChanged') maxChanges.push(e);
      },
    });
    // Characters are registered directly (no player registration, so the
    // game never ends) — the controllers are stamped by hand.
    for (const character of [queen, droneA, droneB]) {
      character.controller = queenPlayer;
      engine.registerCharacter(character);
    }
    engine.registerCharacter(enemy); // a different side — no controller

    await engine.addBuff(queen, hiveMind);
    expect(queen.gauge('mana').max).toBe(3); // queen + both drones
    expect(maxChanges.at(-1)).toMatchObject({ from: 1, to: 3 });

    // A drone leaves play → the derived max drops (a world change, not a
    // status change — the settle's refresh picks it up).
    await engine.apply([destroy(droneA)]);
    expect(queen.gauge('mana').max).toBe(2);
    expect(maxChanges.at(-1)).toMatchObject({ from: 3, to: 2 });

    // Removal reverts the derivation automatically.
    await engine.removeBuff(queen, 'hive-mind');
    expect(queen.gauge('mana').max).toBe(1);
  });

  it('ignores a gauge-tied contribution when the wearer has no such gauge', async () => {
    const staminaDrain = buff({
      name: 'Stamina Drain',
      weight: 1,
      abilities: [stat({ name: 'Stamina Drain', gauge: 'stamina', add: -10 })],
    });
    const hero = new Character('Hero', { maxHp: 30 });
    const engine = createEngine();
    engine.registerCharacter(hero);

    await engine.addBuff(hero, staminaDrain);
    expect(hero.gauge('hp').max).toBe(30); // no stamina gauge on this — nothing to derive
    expect(hero.gauge('mana').max).toBe(0);
  });

  it('derives any gauge the character carries — a stamina gauge', async () => {
    const stamina = new Gauge('stamina', 100);
    const hero = new Character('Hero', { maxHp: 30, gauges: [stamina] });
    const engine = createEngine();
    engine.registerCharacter(hero);

    const secondWind = buff({
      name: 'Second Wind',
      weight: 1,
      abilities: [
        stat({
          name: 'Second Wind',
          gauge: 'stamina',
          value: (ctx) => ctx.self.gauge('hp').current, // stamina max = current HP
        }),
      ],
    });
    await engine.addBuff(hero, secondWind);
    expect(stamina.max).toBe(30); // full HP

    await engine.damage(hero.gauge('hp'), 10, hero);
    expect(stamina.max).toBe(20); // the damage settle re-derived the stamina max
    expect(stamina.current).toBe(20); // the shrink re-clamped the current value

    await engine.removeBuff(hero, 'second-wind');
    expect(stamina.max).toBe(100); // back to the gauge's own base max
  });

  it('kills a character whose derived max collapses to 0 — same settle for status changes, next settle for world changes', async () => {
    // "max HP is equal to the number of OTHER creatures you control" — a
    // glass cannon that dies when its swarm is gone.
    const glassCannon = buff({
      name: 'Glass Cannon',
      weight: 1,
      abilities: [
        stat({
          name: 'Glass Cannon',
          gauge: 'hp',
          value: (ctx) =>
            ctx.engine.registeredCharacters.filter(
              (c) =>
                c !== ctx.self &&
                c.controller === ctx.self.controller &&
                ctx.engine.isInPlay(c),
            ).length,
        }),
      ],
    });
    const queen = new Character('Queen', { maxHp: 30 });
    const droneA = new Character('Drone A', { maxHp: 5 });
    const droneB = new Character('Drone B', { maxHp: 5 });
    const queenPlayer = new TestPlayer('Queen', [queen, droneA, droneB], 'hive');

    const engine = createEngine();
    for (const character of [queen, droneA, droneB]) {
      character.controller = queenPlayer;
      engine.registerCharacter(character);
    }

    await engine.addBuff(queen, glassCannon);
    expect(queen.gauge('hp').max).toBe(2);

    await engine.apply([destroy(droneA)]);
    expect(queen.gauge('hp').max).toBe(1);
    expect(engine.isInPlay(queen)).toBe(true);

    await engine.apply([destroy(droneB)]);
    expect(queen.gauge('hp').max).toBe(0);

    // The collapse was discovered after the destroy phase of the same
    // settle — the death resolves at the next settle's destroy phase.
    await engine.apply([]);
    expect(engine.isInPlay(queen)).toBe(false);
    expect(engine.garbage).toContain(queen);
  });

  it('replaces then chains: a value function runs in weight order with static rewrites', async () => {
    const hero = new Character('Hero', { maxHp: 10, stats: { power: 5 } });
    const engine = createEngine();
    engine.registerCharacter(hero);

    const replace = buff({
      name: 'Transform',
      weight: 1,
      abilities: [stat({ name: 'Transform', stat: 'power', value: () => 100 })],
    });
    const boost = buff({
      name: 'Boost',
      weight: 2,
      abilities: [stat({ name: 'Boost', stat: 'power', add: 7 })],
    });
    await engine.addBuff(hero, replace);
    await engine.addBuff(hero, boost);
    // Replace first (weight 1), then the static +7 (weight 2).
    expect(hero.stat('power')).toBe(107);

    // Swapped weights: the +7 runs first, then the replacement discards it.
    await engine.removeBuff(hero, 'boost');
    await engine.removeBuff(hero, 'transform');
    const boostFirst = buff({
      name: 'Boost First',
      weight: 1,
      abilities: [stat({ name: 'Boost First', stat: 'power', add: 7 })],
    });
    const replaceLast = buff({
      name: 'Transform Last',
      weight: 2,
      abilities: [stat({ name: 'Transform Last', stat: 'power', value: () => 100 })],
    });
    await engine.addBuff(hero, boostFirst);
    await engine.addBuff(hero, replaceLast);
    expect(hero.stat('power')).toBe(100);
  });

  it('derives speed (initiative) from a contribution and reverts on removal', async () => {
    const hero = new Character('Hero', { maxHp: 10, speed: 3 });
    const engine = createEngine();
    engine.registerCharacter(hero);
    expect(hero.speed).toBe(3);

    const swift = buff({
      name: 'Swift',
      weight: 1,
      abilities: [stat({ name: 'Swift', stat: 'speed', add: 5 })],
    });
    await engine.addBuff(hero, swift);
    expect(hero.speed).toBe(8);

    const sloth = buff({
      name: 'Sloth',
      weight: 2,
      abilities: [stat({ name: 'Sloth', stat: 'speed', value: () => 1 })],
    });
    await engine.addBuff(hero, sloth);
    expect(hero.speed).toBe(1); // the heavier replacement pins speed at 1

    await engine.removeBuff(hero, 'sloth');
    expect(hero.speed).toBe(8);
    await engine.removeBuff(hero, 'swift');
    expect(hero.speed).toBe(3);
  });

  it('derives a custom stat from a buff, and a cast body reads it', async () => {
    const hero = new Character('Hero', {
      maxHp: 30,
      stats: { power: 2 },
      skills: [
        skill({
          name: 'Fighting',
          weight: 1,
          abilities: [
            cast({
              name: 'Power Strike',
              targeting: { who: 'enemy', count: 1 },
              cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), ctx.self.stat('power') ?? 0, ctx.self)],
            }),
          ],
        }),
      ],
    });
    const goblin = new Character('Goblin', { maxHp: 30 });
    const engine = createEngine();
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    expect(hero.stat('power')).toBe(2);

    const rage = buff({
      name: 'Rage',
      weight: 1,
      abilities: [stat({ name: 'Rage', stat: 'power', add: 3 })],
    });
    await engine.addBuff(hero, rage);
    expect(hero.stat('power')).toBe(5);

    const strike = hero.manualAbilities[0]!;
    await engine.useAbility(hero, strike, { targets: [goblin] });
    expect(goblin.gauge('hp').current).toBe(25); // 5 damage

    await engine.removeBuff(hero, 'rage');
    expect(hero.stat('power')).toBe(2); // back to the base
  });

  it('folds a skill-provided contribution silently at registration', () => {
    const scout = new Character('Scout', {
      maxHp: 10,
      skills: [
        skill({
          name: 'Scouting',
          weight: 1,
          abilities: [stat({ name: 'Scouting', stat: 'speed', add: 4 })],
        }),
      ],
    });
    expect(scout.speed).toBe(10); // base, unregistered

    let events = 0;
    const engine = createEngine({ onEvent: () => (events += 1) });
    engine.registerCharacter(scout);
    expect(scout.speed).toBe(14); // folded in as part of setup
    expect(events).toBe(0); // silent: no events at registration
  });

  it('derives a gauge max from maxModifier (the gauge-tied sugar)', async () => {
    const hiveMind = buff({
      name: 'Hive Mind',
      weight: 1,
      abilities: [
        maxModifier({
          name: 'Hive Mind',
          gauge: 'hp',
          value: (ctx) => creaturesYouControl(ctx),
        }),
      ],
    });
    const queen = new Character('Queen', { maxHp: 100 });
    const drone = new Character('Drone', { maxHp: 5 });
    const queenPlayer = new TestPlayer('Queen', [queen, drone], 'hive');
    const engine = createEngine();
    for (const character of [queen, drone]) {
      character.controller = queenPlayer;
      engine.registerCharacter(character);
    }

    await engine.addBuff(queen, hiveMind);
    expect(queen.gauge('hp').max).toBe(2);
    await engine.removeBuff(queen, 'hive-mind');
    expect(queen.gauge('hp').max).toBe(100);
  });

  it('re-derives a function stat after another character’s gauge changes (world refresh)', async () => {
    const bloodlet = buff({
      name: 'Bloodlet',
      weight: 1,
      abilities: [
        stat({
          name: 'Bloodlet',
          stat: 'power',
          value: (ctx) => ctx.self.gauge('hp').current,
        }),
      ],
    });
    const hero = new Character('Hero', { maxHp: 10, stats: { power: 0 } });
    const goblin = new Character('Goblin', { maxHp: 10 });
    const engine = createEngine();
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    await engine.addBuff(hero, bloodlet);
    expect(hero.stat('power')).toBe(10);

    await engine.damage(hero.gauge('hp'), 4, goblin);
    expect(hero.stat('power')).toBe(6); // the damage settle re-derived it
  });

  it('validates the stat builder', () => {
    expect(() => stat({ name: 'Empty', stat: 'power' })).toThrow(/derives nothing/);
    expect(() => stat({ name: 'Neither', value: () => 1 })).toThrow(/exactly one/);
    expect(() => stat({ name: 'Both', stat: 'power', gauge: 'hp', value: () => 1 })).toThrow(/exactly one/);
    expect(() => stat({ name: 'No Name', stat: '' })).toThrow(/non-empty/);
    expect(() => stat({ name: 'Bad Multiply', stat: 'power', multiply: -1 })).toThrow(/multiply/);
  });

  it('rejects a value function that returns a non-finite number', async () => {
    const bad = buff({
      name: 'Bad',
      weight: 1,
      abilities: [stat({ name: 'Bad', stat: 'speed', value: () => Number.NaN })],
    });
    const hero = new Character('Hero', { maxHp: 10 });
    const engine = createEngine();
    engine.registerCharacter(hero);
    await expect(engine.addBuff(hero, bad)).rejects.toThrow(/non-finite/);
  });

  it('emits stat:changed when a contribution lands and leaves — from/to with the change\'s source', async () => {
    const hero = new Character('Hero', { maxHp: 10, speed: 3 });
    const caster = new Character('Caster', { maxHp: 10 });
    const statChanges: StatChangedEvent[] = [];
    const engine = createEngine({
      onEvent: (e) => {
        if (e.type === 'stat:changed') statChanges.push(e);
      },
    });
    engine.registerCharacter(hero);
    engine.registerCharacter(caster);

    const swift = buff({
      name: 'Swift',
      weight: 1,
      abilities: [stat({ name: 'Swift', stat: 'speed', add: 5 })],
    });
    await engine.addBuff(hero, swift, caster);
    expect(hero.speed).toBe(8);
    expect(statChanges).toHaveLength(1);
    expect(statChanges[0]).toMatchObject({
      type: 'stat:changed',
      character: hero,
      stat: 'speed',
      from: 3,
      to: 8,
      source: caster,
    });

    // Removal reverts to the base — and announces it, with the remover's source.
    await engine.removeBuff(hero, 'swift', caster);
    expect(hero.speed).toBe(3);
    expect(statChanges).toHaveLength(2);
    expect(statChanges[1]).toMatchObject({ character: hero, stat: 'speed', from: 8, to: 3, source: caster });
  });

  it('emits stat:changed without a source when a world change re-derives a function stat', async () => {
    const bloodlet = buff({
      name: 'Bloodlet',
      weight: 1,
      abilities: [
        stat({
          name: 'Bloodlet',
          stat: 'power',
          value: (ctx) => ctx.self.gauge('hp').current,
        }),
      ],
    });
    const hero = new Character('Hero', { maxHp: 10, stats: { power: 0 } });
    const goblin = new Character('Goblin', { maxHp: 10 });
    const statChanges: StatChangedEvent[] = [];
    const engine = createEngine({
      onEvent: (e) => {
        if (e.type === 'stat:changed') statChanges.push(e);
      },
    });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    await engine.addBuff(hero, bloodlet);
    expect(hero.stat('power')).toBe(10);
    expect(statChanges).toHaveLength(1); // the status landing — no source
    expect(statChanges[0]).toMatchObject({ stat: 'power', from: 0, to: 10 });
    expect(statChanges[0]).not.toHaveProperty('source');

    await engine.damage(hero.gauge('hp'), 4, goblin);
    expect(hero.stat('power')).toBe(6);
    expect(statChanges).toHaveLength(2); // the settle's world refresh — no source
    expect(statChanges[1]).toMatchObject({ stat: 'power', from: 10, to: 6 });
    expect(statChanges[1]).not.toHaveProperty('source');
  });

  it('keeps registration, destroyed characters, and base-less births/deaths silent', async () => {
    const statChanges: StatChangedEvent[] = [];
    const engine = createEngine({
      onEvent: (e) => {
        if (e.type === 'stat:changed') statChanges.push(e);
      },
    });

    // Registration folds a skill's contribution in silently (setup semantics).
    const scout = new Character('Scout', {
      maxHp: 10,
      skills: [
        skill({
          name: 'Scouting',
          weight: 1,
          abilities: [stat({ name: 'Scouting', stat: 'speed', add: 4 })],
        }),
      ],
    });
    engine.registerCharacter(scout);
    expect(scout.speed).toBe(14);
    expect(statChanges).toHaveLength(0);

    // A custom stat with no base: coming into existence (buff added) and
    // going out of it (buff removed) are both transitions to/from undefined —
    // the buff's own buff:added / buff:destroyed covers them.
    const hero = new Character('Hero', { maxHp: 10 });
    engine.registerCharacter(hero);
    const manifest = buff({
      name: 'Manifest',
      weight: 1,
      abilities: [stat({ name: 'Manifest', stat: 'power', value: () => 5 })],
    });
    await engine.addBuff(hero, manifest);
    expect(hero.stat('power')).toBe(5);
    expect(statChanges).toHaveLength(0);
    await engine.removeBuff(hero, 'manifest');
    expect(hero.stat('power')).toBeUndefined();
    expect(statChanges).toHaveLength(0);

    // A dying character's on-defeat buff removals announce nothing for it.
    const swift = buff({
      name: 'Swift',
      weight: 1,
      abilities: [stat({ name: 'Swift', stat: 'speed', add: 5 })],
    });
    const doomed = new Character('Doomed', { maxHp: 10, speed: 3 });
    engine.registerCharacter(doomed);
    await engine.addBuff(doomed, swift);
    expect(doomed.speed).toBe(8);
    expect(statChanges).toHaveLength(1); // 3 → 8 while alive
    statChanges.length = 0;
    await engine.destroy(doomed);
    expect(engine.isInPlay(doomed)).toBe(false);
    expect(statChanges).toHaveLength(0); // the garbage guard keeps it quiet
  });
});
