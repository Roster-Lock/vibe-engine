/**
 * Removing buffs — the `buff:destroyed` + `buff:destroyed:batch` event pair.
 *
 * Every buff a single `apply` removes fires its own `buff:destroyed`, and
 * the apply summarizes them in one `buff:destroyed:batch` at its end — even
 * for a single removal. Three content abilities exercise it:
 *
 * - **Purge** — removes every buff from one character;
 * - **Mass Dispell** — removes every buff from all characters;
 * - **Dismiss** — removes a single buff from one character.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  Player,
  buff,
  cast,
  removeBuff,
  skill,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

function char(name: string, maxHp: number): Character {
  // Mana is the life gauge: a character without a positive maxMana is
  // defeated at creation, so default `maxMana` to `maxHp`.
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

function isBuffDestroyed(e: GameEvent): e is Extract<GameEvent, { type: 'buff:destroyed' }> {
  return e.type === 'buff:destroyed';
}

function isBuffBatch(e: GameEvent): e is Extract<GameEvent, { type: 'buff:destroyed:batch' }> {
  return e.type === 'buff:destroyed:batch';
}

// Content: the three dispel abilities, granted through a skill.
const purge = cast({
  name: 'Purge',
  targeting: { who: 'enemy' },
  cast: (ctx, targeting) => {
    const target = targeting.targets[0]!;
    return target.buffs.map((b) => removeBuff(target, b, ctx.self));
  },
});

const massDispell = cast({
  name: 'Mass Dispell',
  targeting: { who: 'any', count: [0, 99] },
  cast: (ctx, targeting) =>
    targeting.targets.flatMap((c) => c.buffs.map((b) => removeBuff(c, b, ctx.self))),
});

const dismiss = cast({
  name: 'Dismiss',
  targeting: { who: 'enemy' },
  cast: (ctx, targeting) => {
    const target = targeting.targets[0]!;
    const first = target.buffs[0];
    return first ? [removeBuff(target, first, ctx.self)] : [];
  },
});

/** A caster who knows one of the dispel abilities. */
function dispeller(ability: typeof purge | typeof massDispell | typeof dismiss): Character {
  return new Character('Mage', {
    maxHp: 100,
    maxMana: 100,
    skills: [skill({ name: 'Dispeller', weight: 1, abilities: [ability] })],
  });
}

describe('removing buffs — buff:destroyed + buff:destroyed:batch', () => {
  it('Purge removes every buff from one character, then fires one batch', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const { engine, events, types } = recorder([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin], 'monsters'),
    ]);
    const mage = dispeller(purge);
    engine.registerCharacter(mage);
    await engine.addBuff(goblin, buff({ name: 'Poison', weight: 1 }), hero);
    await engine.addBuff(goblin, buff({ name: 'Weaken', weight: 2 }), hero);

    types.length = 0;
    await engine.useAbility(mage, purge, { targets: [goblin] });

    // One buff:destroyed per buff, then the summary batch — in event order.
    expect(types.filter((t) => t.startsWith('buff:'))).toEqual([
      'buff:destroyed',
      'buff:destroyed',
      'buff:destroyed:batch',
    ]);
    const destroyed = events.filter(isBuffDestroyed);
    expect(destroyed).toHaveLength(2);
    expect(destroyed.map((e) => e.buff.name)).toEqual(['Poison', 'Weaken']);
    for (const e of destroyed) {
      expect(e.character).toBe(goblin);
      expect(e.reason).toBe('removed');
      expect('source' in e ? e.source : undefined).toBe(mage);
    }
    const batches = events.filter(isBuffBatch);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events.map((e) => e.buff.name)).toEqual(['Poison', 'Weaken']);
    expect(batches[0]!.events).toEqual(destroyed);
    expect(goblin.buffs).toHaveLength(0);
  });

  it('Mass Dispell removes every buff from all characters, then fires one batch', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const ogre = char('Ogre', 100);
    const { engine, events } = recorder([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, ogre], 'monsters'),
    ]);
    const mage = dispeller(massDispell);
    engine.registerCharacter(mage);
    await engine.addBuff(hero, buff({ name: 'Bless', weight: 1 }));
    await engine.addBuff(goblin, buff({ name: 'Poison', weight: 1 }));
    await engine.addBuff(ogre, buff({ name: 'Curse', weight: 2 }));
    await engine.addBuff(ogre, buff({ name: 'Slow', weight: 3 }));

    await engine.useAbility(mage, massDispell, { targets: [hero, goblin, ogre] });

    const destroyed = events.filter(isBuffDestroyed);
    expect(destroyed).toHaveLength(4);
    expect(destroyed.map((e) => `${e.character.name}:${e.buff.name}`)).toEqual([
      'Hero:Bless',
      'Goblin:Poison',
      'Ogre:Curse',
      'Ogre:Slow',
    ]);
    const batches = events.filter(isBuffBatch);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events).toHaveLength(4);
    expect(batches[0]!.events).toEqual(destroyed);
    expect(hero.buffs).toHaveLength(0);
    expect(goblin.buffs).toHaveLength(0);
    expect(ogre.buffs).toHaveLength(0);
  });

  it('Dismiss removes a single buff and still fires the batch with one event', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const { engine, events, types } = recorder([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin], 'monsters'),
    ]);
    const mage = dispeller(dismiss);
    engine.registerCharacter(mage);
    await engine.addBuff(goblin, buff({ name: 'Poison', weight: 1 }), hero);
    await engine.addBuff(goblin, buff({ name: 'Weaken', weight: 2 }), hero);

    types.length = 0;
    await engine.useAbility(mage, dismiss, { targets: [goblin] });

    // Only the first buff (the lightest — Poison) leaves; Weaken stays.
    expect(types.filter((t) => t.startsWith('buff:'))).toEqual([
      'buff:destroyed',
      'buff:destroyed:batch',
    ]);
    expect(goblin.hasStatus('poison')).toBe(false);
    expect(goblin.hasStatus('weaken')).toBe(true);
    const batch = events.find(isBuffBatch)!;
    expect(batch.events.map((e) => e.buff.id)).toEqual(['poison']);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]!.buff.id).toBe('poison');
    expect(batch.events[0]!.reason).toBe('removed');
  });
});
