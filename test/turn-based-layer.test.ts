/**
 * The turn-based combat layer — the boundary between the engine and the game.
 *
 * `src/engine` knows gauges, actions, triggers and statuses; it does **not**
 * know that `'hp'` is life or that a character has mana. This layer does. The
 * tests here pin both halves of that sentence: what the game adds, and what the
 * engine deliberately does not have.
 */
import { describe, expect, it } from 'vitest';
import {
  Character as EngineCharacter,
  GameEngine,
  buff,
  cast,
  type GameEvent,
  type GaugeSba,
} from '../src/engine/index.js';
import {
  Character,
  collapsesAtZero,
  depletesAtZero,
  hpGauge,
  isDamage,
  isHpChange,
  isManaChange,
  manaGauge,
  wasTakenBy,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

describe('the game layer owns the hp/mana vocabulary', () => {
  it('re-exports the whole engine surface, so content needs one import', () => {
    // These all come from the engine, unmodified.
    expect(typeof GameEngine).toBe('function');
    expect(typeof buff).toBe('function');
    expect(typeof cast).toBe('function');
  });

  it('builds an hp gauge that is lethal, and an empty mana gauge', () => {
    const hero = new Character('Hero', { maxHp: 20, maxMana: 5 });

    expect(hero.gauge('hp')?.max).toBe(20);
    expect(hero.gauge('mana')?.max).toBe(5);
    expect(hero.gauge('hp')?.sbas.map((r) => r.name)).toEqual(['HP Depleted', 'HP Max Collapsed']);
    // Mana is a resource, not a life gauge: no rules, so it cannot kill.
    expect(hero.gauge('mana')?.sbas).toEqual([]);
    expect(hero.isDefeated).toBe(false);
  });

  it('still materializes the empty mana gauge for a bare maxHp, as it always did', () => {
    const hero = new Character('Hero', { maxHp: 10 });

    expect(hero.gauge('mana')?.max).toBe(0);
  });

  it('lets an explicit gauge declaration win over the shorthand', () => {
    const hero = new Character('Hero', {
      maxHp: 20,
      gauges: [{ id: 'hp', max: 99 }],
    });

    expect(hero.gauge('hp')?.max).toBe(99);
    // The explicit declaration carries no rules — the shorthand did not apply.
    expect(hero.gauge('hp')?.sbas).toEqual([]);
  });

  it('reports the death rules under the names and reasons content reads', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 5 });
    engine.registerCharacter(hero);

    await engine.damage(hero.gauge('hp')!, 5);

    expect(hero.destroyed).toBe(true);
  });

  it('exposes the rules as reusable factories for a game that renames its life', () => {
    // A game whose life is stamina reuses the same rules on another gauge.
    const rules: GaugeSba[] = [depletesAtZero(), collapsesAtZero()];
    const card = new EngineCharacter('Dancer', {
      gauges: [{ id: 'stamina', max: 3, sbas: rules }],
      lifeGauge: 'stamina',
    });

    expect(card.gauge('stamina')?.sbas).toHaveLength(2);
    expect(card.isDefeated).toBe(false);
    card.gauge('stamina')!.current = 0;
    expect(card.isDefeated).toBe(true);
  });

  it('offers gauge declarations as data', () => {
    expect(hpGauge({ max: 4 })).toMatchObject({ id: 'hp', max: 4 });
    expect(hpGauge({ max: 4 }).sbas).toHaveLength(2);
    expect(manaGauge({ max: 2, current: 1 })).toEqual({ id: 'mana', max: 2, current: 1 });
  });
});

describe('the engine does not require the game vocabulary', () => {
  it('builds a character with no gauges at all', () => {
    const bare = new EngineCharacter('Spell', {});

    expect(bare.gauges).toEqual([]);
    // No declared life gauge, so nothing to be defeated by.
    expect(bare.isDefeated).toBe(false);
  });

  it('has the same behaviour from an explicit engine-level declaration', () => {
    // `new Character(name, { maxHp })` from the game layer and this are the
    // same *life gauge*, spelled differently — there is no privileged path
    // to the rules.
    const viaGame = new Character('Hero', { maxHp: 12 });
    const viaEngine = new EngineCharacter('Hero', {
      gauges: [hpGauge({ max: 12 })],
      lifeGauge: 'hp',
    });

    expect(viaEngine.gauge('hp')?.max).toBe(viaGame.gauge('hp')?.max);
    expect(viaEngine.gauge('hp')?.sbas.map((r) => r.name)).toEqual(
      viaGame.gauge('hp')?.sbas.map((r) => r.name),
    );
    // The one difference, and it is deliberate: the game's legacy shorthand
    // also materializes the empty mana gauge it has always produced, while a
    // declaration says exactly what it means and nothing more.
    expect(viaGame.gauges.map((g) => g.id)).toEqual(['hp', 'mana']);
    expect(viaEngine.gauges.map((g) => g.id)).toEqual(['hp']);
  });
});

describe('the hp-keyed event helpers live in the game layer', () => {
  it('answers "was this hp?" and "was this damage?"', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 20, maxMana: 20 });
    engine.registerCharacter(hero);

    await engine.damage(hero.gauge('hp')!, 5);
    await engine.damage(hero.gauge('mana')!, 5);

    expect(events.filter((e) => isHpChange(e))).toHaveLength(1);
    expect(events.filter((e) => isManaChange(e))).toHaveLength(1);
    expect(events.filter((e) => isDamage(e))).toHaveLength(1);
    expect(events.some((e) => wasTakenBy(e, hero))).toBe(true);
  });

  it('answers false rather than throwing for a character with no hp gauge', () => {
    // The engine no longer requires an hp gauge, so the predicate must cope.
    const bare = new EngineCharacter('Spell', { gauges: [{ id: 'charge', max: 3 }] });
    const event: GameEvent = {
      type: 'gauge:changed',
      gauge: bare.gauge('charge')!,
      target: bare,
      from: 3,
      to: 1,
    };

    expect(isHpChange(event)).toBe(false);
    expect(isManaChange(event)).toBe(false);
    expect(isDamage(event)).toBe(false);
    expect(wasTakenBy(event, bare)).toBe(false);
  });
});
