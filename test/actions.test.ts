import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  buff,
  gaugeDelta,
  gaugeTransform,
  maxModifier,
  passiveActionModifier,
  replaceAction,
  skill,
} from '../src/games/turn-based/index.js';
import { addBuff, changeGaugeBy, damage, heal, setGauge } from '../src/games/turn-based/index.js';
import type { ActionTransformer, PassiveActionModifier } from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

/** Wraps a transform as an incoming-only passive action modifier. */
function incoming(transform: ActionTransformer): PassiveActionModifier {
  return passiveActionModifier({
    name: 'Incoming',
    transform: (action, ctx) =>
      action.direction !== 'incoming' ? action : transform(action, ctx),
  });
}

/** Wraps a transform as an outgoing-only passive action modifier. */
function outgoing(transform: ActionTransformer): PassiveActionModifier {
  return passiveActionModifier({
    name: 'Outgoing',
    transform: (action, ctx) =>
      action.direction !== 'outgoing' ? action : transform(action, ctx),
  });
}

describe('actions', () => {
  it('deals damage to a character', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    engine.registerCharacter(hero);
    await engine.apply([damage(hero.gauge('hp'), 30)]);
    expect(hero.gauge('hp').current).toBe(70);
  });

  it('heals and clamps at max', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, hp: 40 });
    engine.registerCharacter(hero);
    await engine.apply([heal(hero.gauge('hp'), 100)]);
    expect(hero.gauge('hp').current).toBe(100);
  });

  it('sets and shifts gauge values', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 50, mana: 20 });
    engine.registerCharacter(hero);
    await engine.apply([setGauge(hero.gauge('mana'), 10), changeGaugeBy(hero.gauge('mana'), 5)]);
    expect(hero.gauge('mana').current).toBe(15);
  });

  it('only changes a gauge maximum through a buff (maxModifier)', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    engine.registerCharacter(hero);
    // Max is derived, not written: a buff with a maxModifier raises it…
    await engine.addBuff(hero, buff({ name: 'Fortify', weight: 1, abilities: [maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 })] }));
    expect(hero.gauge('hp').max).toBe(150);
    expect(hero.gauge('hp').current).toBe(100); // raising max does not refill the gauge
    // …and removing the buff reverts it.
    await engine.removeBuff(hero, 'fortify');
    expect(hero.gauge('hp').max).toBe(100);
  });

  it('runs outgoing then incoming transformers, in weight order', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100, hp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    // Goblin has two incoming buffs: flat +10 on the result (weight 1) and a
    // 50 damage cap (weight 2). Lower weight runs first, so for 100 damage:
    // 100 - 100 + 10 = 10, then capped up to 50 -> 50.
    // (If the order were reversed the result would be 40.)
    const armor = gaugeTransform((prev) => (cur, max) => prev(cur, max) + 10);
    const cap = gaugeTransform((prev) => (cur, max) => Math.max(prev(cur, max), cur - 50));
    await engine.addBuff(goblin, buff({ name: 'Armor', weight: 1, abilities: [incoming(armor)] }));
    await engine.addBuff(goblin, buff({ name: 'Damage Cap', weight: 2, abilities: [incoming(cap)] }));

    await engine.damage(goblin.gauge('hp'), 100, hero);
    expect(goblin.gauge('hp').current).toBe(50);

    // Small damage is left alone (the cap only kicks in above 50).
    await engine.heal(goblin.gauge('hp'), 100, hero);
    expect(goblin.gauge('hp').current).toBe(100);
    await engine.damage(goblin.gauge('hp'), 30, hero);
    expect(goblin.gauge('hp').current).toBe(80);
  });

  it('supports the spec example via gaugeTransform', async () => {
    // Math.max(previousUpdate, currentHealth - 50): use the previous update,
    // or deal at most 50 damage.
    const cap50 = gaugeTransform((prev) => (cur, max) => Math.max(prev(cur, max), cur - 50));
    const engine = createEngine();
    const target = new Character('Target', { maxHp: 200, hp: 200 });
    engine.registerCharacter(target);
    await engine.addBuff(
      target,
      buff({ name: 'Iron Hide', weight: 1, abilities: [incoming(cap50)] }),
    );
    await engine.damage(target.gauge('hp'), 1000);
    expect(target.gauge('hp').current).toBe(150);
  });

  it('applies outgoing transformers from the source', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    const powerUp = buff({
      name: 'Power Up',
      weight: 1,
      abilities: [outgoing(gaugeTransform((prev) => (cur, max) => prev(cur, max) - 10))],
    });
    await engine.addBuff(hero, powerUp);

    await engine.damage(goblin.gauge('hp'), 10, hero);
    expect(goblin.gauge('hp').current).toBe(80); // 10 damage became 20
  });

  it('lets a skill transform actions permanently', async () => {
    const engine = createEngine();
    const tank = new Character('Tank', {
      maxHp: 100,
      skills: [
        skill({
          name: 'Fortress',
          weight: 1,
          abilities: [
            incoming(gaugeTransform((prev) => (cur, max) => Math.max(prev(cur, max), cur - 25))),
          ],
        }),
      ],
    });
    engine.registerCharacter(tank);
    await engine.damage(tank.gauge('hp'), 60);
    expect(tank.gauge('hp').current).toBe(75);
  });
});

describe('replacement helpers — prevent the old action, emit a new one', () => {
  it('gaugeDelta reads the signed change an action would make right now', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 50, mana: 20 });
    engine.registerCharacter(hero);
    expect(gaugeDelta(damage(hero.gauge('hp'), 30))).toBe(-30);
    expect(gaugeDelta(heal(hero.gauge('hp'), 10))).toBe(10);
    expect(gaugeDelta(setGauge(hero.gauge('mana'), 5))).toBe(-15); // 20 -> 5
    expect(gaugeDelta(changeGaugeBy(hero.gauge('hp'), 0))).toBe(0);
    expect(gaugeDelta({ type: 'destroy', target: hero })).toBe(0); // non-gauge
  });

  it('replaceAction swaps a claimed action and leaves others alone', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 50 });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 50 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    // Incoming HP damage is replaced by an equal loss on the *attacker's*
    // mana (a counter-drain) — a replacement that re-aims the effect at a
    // different character entirely.
    const counterDrain = buff({
      name: 'Counter Drain',
      weight: 1,
      abilities: [
        passiveActionModifier({
          name: 'Counter Drain',
          transform: replaceAction(
            (action, ctx) =>
              action.type === 'gauge' &&
              action.direction === 'incoming' &&
              ctx.target?.gauge('hp') === action.target &&
              action.intent === 'damage' &&
              gaugeDelta(action) < 0,
            (action) => ({
              type: 'gauge',
              target: (action.source as Character).gauge('mana'),
              update: (cur: number) => cur + gaugeDelta(action),
              intent: 'damage',
            }),
          ),
        }),
      ],
    });
    await engine.addBuff(hero, counterDrain);

    // The hero's HP never moves; the goblin loses mana instead.
    await engine.damage(hero.gauge('hp'), 30, goblin);
    expect(hero.gauge('hp').current).toBe(100);
    expect(goblin.gauge('mana').current).toBe(20);

    // A non-damage loss (changeGaugeBy, intent 'other') is not claimed:
    // HP drops, the goblin's mana is untouched.
    await engine.apply([changeGaugeBy(hero.gauge('hp'), -30, goblin)]);
    expect(hero.gauge('hp').current).toBe(70);
    expect(goblin.gauge('mana').current).toBe(20);

    // Heals still heal HP.
    await engine.heal(hero.gauge('hp'), 10, goblin);
    expect(hero.gauge('hp').current).toBe(80);
  });

  it('a replacement can change the action kind — incoming damage becomes a debuff on the attacker', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    const curse = buff({ name: 'Curse', weight: 1 });
    const redirect = buff({
      name: 'Redirect',
      weight: 1,
      abilities: [
        passiveActionModifier({
          name: 'Redirect',
          transform: replaceAction(
            (action, ctx) =>
              action.type === 'gauge' &&
              action.direction === 'incoming' &&
              ctx.target?.gauge('hp') === action.target &&
              gaugeDelta(action) < 0,
            (action) => addBuff(action.source as Character, curse, action.source),
          ),
        }),
      ],
    });
    await engine.addBuff(hero, redirect);

    await engine.damage(hero.gauge('hp'), 10, goblin);
    expect(hero.gauge('hp').current).toBe(100); // no damage taken
    expect(goblin.buffs.some((b) => b.name === 'Curse')).toBe(true);
  });
});
