/**
 * Gauge-attached state-based actions (GaugeSba) — the reusable death/effect
 * rules. Rules live **on the gauge**: every character's HP gauge carries
 * the built-in death rules by default (attached at construction); content
 * can remove them ("prevent"), re-attach the same definitions to another
 * gauge (a mana-death game moves them to mana), or add arbitrary
 * conditions ("destroy when HP is exactly 4"). The engine's SBA pass needs
 * no gauge-kind knowledge — it asks each batch gauge for its own rules.
 * The win/lose dead predicate consults the same rules.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEndInterrupt,
  GameEngine,
  Gauge,
  Player,
  buff,
  destroy,
  damage,
  heal,
  maxModifier,
  restriction,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

/** A player that never acts on its own. */
class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** A living character: HP plus mana (HP is the default life gauge). */
function char(name: string, maxHp: number, hp?: number): Character {
  return new Character(name, { maxHp, maxMana: maxHp, ...(hp !== undefined ? { hp } : {}) });
}

function player(name: string, characters: Character[], team: string): TestPlayer {
  return new TestPlayer(name, characters, team);
}

function makeEngine(players: TestPlayer[], onEvent?: (e: GameEvent) => void): GameEngine {
  const engine = createEngine(onEvent ? { onEvent } : {});
  engine.registerPlayers(players);
  return engine;
}

/** Runs a promise, returning the thrown value (or undefined when it resolves). */
async function capture<T>(fn: () => Promise<T>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The same death definition, attachable to any gauge. */
const depletedRule = {
  name: 'Depleted',
  aspect: 'current' as const,
  when: (gauge: Gauge) => gauge.current <= gauge.min,
  then: (character: Character) => [destroy(character)],
  reason: 'current-reached-minimum',
};

/** Removes the built-in HP death rules from every registered character. */
function preventHpDeaths(engine: GameEngine): void {
  for (const character of engine.registeredCharacters) {
    character.gauge('hp').removeSba('HP Depleted');
    character.gauge('hp').removeSba('HP Max Collapsed');
  }
}

describe('built-in gauge rules', () => {
  it('every HP gauge carries the two death rules by default', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );

    expect(goblin.gauge('hp').sbas.map((r) => r.name)).toEqual(['HP Depleted', 'HP Max Collapsed']);
    expect(hero.gauge('hp').sbas.map((r) => r.name)).toEqual(['HP Depleted', 'HP Max Collapsed']);

    // Removing the current-value rule from one gauge prevents that death.
    goblin.gauge('hp').removeSba('HP Depleted');
    await engine.damage(goblin.gauge('hp'), 20, hero);
    expect(goblin.gauge('hp').current).toBe(0);
    expect(goblin.isDefeated).toBe(true); // the convenience predicate still reads HP
    expect(goblin.destroyed).toBe(false); // but nothing destroyed it
    expect(events.some((e) => e.type === 'character:destroyed')).toBe(false);
  });

  it('an HP kill still reports the built-in reason', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );
    await engine.damage(goblin.gauge('hp'), 20, hero);
    const destroyed = events.find(
      (e): e is Extract<GameEvent, { type: 'character:destroyed' }> => e.type === 'character:destroyed',
    );
    expect(destroyed?.reason).toBe('hp:current-reached-minimum');
  });
});

describe('reusable death rules', () => {
  it('prevents one or all built-in deaths, then adds the same rule to another gauge', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );
    preventHpDeaths(engine);
    goblin.gauge('mana').addSba({ ...depletedRule, name: 'Mana Depleted', reason: 'mana:current-reached-minimum' });

    // HP hits 0: nothing happens (the death rules were removed).
    await engine.damage(goblin.gauge('hp'), 20, hero);
    expect(goblin.destroyed).toBe(false);

    // Mana hits 0: the re-attached rule kills, with its own reason.
    await engine.damage(goblin.gauge('mana'), 20, hero);
    expect(goblin.destroyed).toBe(true);
    expect(engine.garbage).toContain(goblin);
    const destroyed = events.find(
      (e): e is Extract<GameEvent, { type: 'character:destroyed' }> =>
        e.type === 'character:destroyed' && e.character === goblin,
    );
    expect(destroyed?.reason).toBe('mana:current-reached-minimum');
  });

  it('destroys a character when HP is exactly 4 — any condition, not just "reached min"', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );
    goblin.gauge('hp').addSba({
      name: 'Fragile',
      aspect: 'current',
      priority: 50,
      when: (gauge) => gauge.current === 4,
      then: (character) => [destroy(character)],
      reason: 'fragile:hp-exactly-4',
    });

    await engine.damage(goblin.gauge('hp'), 16, hero); // 20 -> 4: exactly the condition
    expect(goblin.destroyed).toBe(true);
    const destroyed = events.find(
      (e): e is Extract<GameEvent, { type: 'character:destroyed' }> => e.type === 'character:destroyed',
    );
    expect(destroyed?.reason).toBe('fragile:hp-exactly-4');

    // A near-miss value does not fire it.
    const wolf = char('Wolf', 20);
    const hound = char('Hound', 30);
    const game2 = makeEngine([player('Party', [hero], 'party'), player('Monsters', [wolf, hound], 'monsters')]);
    wolf.gauge('hp').addSba({
      name: 'Fragile',
      aspect: 'current',
      priority: 50,
      when: (gauge) => gauge.current === 4,
      then: (character) => [destroy(character)],
      reason: 'fragile:hp-exactly-4',
    });
    await game2.damage(wolf.gauge('hp'), 15, hero); // 20 -> 5, not 4
    expect(wolf.destroyed).toBe(false);
  });

  it('the built-in max-aspect rule kills when a status drives the derived max to 0', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );

    await engine.addBuff(goblin, buff({ name: 'Soul Drain', weight: 1, abilities: [maxModifier({ name: 'Soul Drain', gauge: 'hp', add: -20 })] }), hero);

    expect(goblin.gauge('hp').max).toBe(0);
    expect(goblin.destroyed).toBe(true);
    const destroyed = events.find(
      (e): e is Extract<GameEvent, { type: 'character:destroyed' }> => e.type === 'character:destroyed',
    );
    expect(destroyed?.reason).toBe('hp:maximum-reached-0');
    expect(destroyed && 'maxChanges' in destroyed ? destroyed.maxChanges.map((c) => [c.from, c.to]) : undefined).toEqual([[20, 0]]);
  });

  it('a rule whose then does not destroy has no destroy effect', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const engine = makeEngine([player('Hero', [hero], 'party'), player('Goblins', [goblin, shaman], 'monsters')]);
    preventHpDeaths(engine);
    goblin.gauge('hp').addSba({
      name: 'Siphon',
      aspect: 'current',
      when: (gauge) => gauge.current <= gauge.min,
      then: (character) => [heal(character.gauge('hp'), 5)],
      reason: 'siphon',
    });

    await engine.damage(goblin.gauge('hp'), 20, hero); // hp 0, rule fires — but no destroy
    expect(goblin.gauge('hp').current).toBe(0);
    expect(goblin.destroyed).toBe(false);
  });
});

describe('win/lose follows the attached rules', () => {
  it('the game ends when the last enemy falls to a death rule moved to mana', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const heroP = player('Hero', [hero], 'party');
    const goblinP = player('Goblins', [goblin], 'monsters');
    const engine = makeEngine([heroP, goblinP]);
    preventHpDeaths(engine);
    goblin.gauge('mana').addSba({ ...depletedRule, name: 'Mana Depleted', reason: 'mana:current-reached-minimum' });

    await engine.damage(goblin.gauge('mana'), 10, hero); // still standing
    const e = await capture(() => engine.damage(goblin.gauge('mana'), 10, hero)); // killing blow
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([heroP]);
  });

  it('an indestructible character is not dead for win/lose at the rule condition', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const heroP = player('Hero', [hero], 'party');
    const goblinP = player('Goblins', [goblin], 'monsters');
    const engine = makeEngine([heroP, goblinP]);

    const indestructible = buff({ name: 'Indestructible', weight: 1, abilities: [restriction({ on: 'destroy' })] });
    await engine.addBuff(goblin, indestructible);

    // HP hits 0, but the HP→destroy rule is gated: not destroyed, no game
    // end, and the owner does not lose. A heal saves it.
    await engine.damage(goblin.gauge('hp'), 20, hero); // does not throw
    expect(goblin.gauge('hp').current).toBe(0);
    expect(goblin.destroyed).toBe(false);
    expect(engine.isInPlay(goblin)).toBe(true);

    await engine.heal(goblin.gauge('hp'), 10, hero);
    expect(goblin.gauge('hp').current).toBe(10);
    expect(goblin.destroyed).toBe(false);
  });
});

describe('gauge rule behavior', () => {
  it('first firing rule wins — priority order decides the reason', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );
    preventHpDeaths(engine);
    goblin.gauge('hp').addSba({
      name: 'Low',
      aspect: 'current',
      priority: 10,
      when: (gauge) => gauge.current <= 10,
      then: (character) => [destroy(character)],
      reason: 'low-priority-wins',
    });
    goblin.gauge('hp').addSba({
      name: 'High',
      aspect: 'current',
      priority: 20,
      when: (gauge) => gauge.current <= 10,
      then: (character) => [destroy(character)],
      reason: 'high-priority-loses',
    });

    await engine.damage(goblin.gauge('hp'), 15, hero); // hp 5: both rules fire
    expect(goblin.destroyed).toBe(true);
    const destroyed = events.find(
      (e): e is Extract<GameEvent, { type: 'character:destroyed' }> => e.type === 'character:destroyed',
    );
    expect(destroyed?.reason).toBe('low-priority-wins');
  });

  it('rejects duplicate names and reports unknown removals', () => {
    const hero = char('Hero', 100);
    hero.gauge('hp').addSba({ name: 'X', aspect: 'current', when: () => false, then: () => [], reason: 'x' });
    expect(() =>
      hero.gauge('hp').addSba({ name: 'X', aspect: 'current', when: () => false, then: () => [], reason: 'x' }),
    ).toThrow(/already attached/i);
    expect(hero.gauge('hp').removeSba('Nope')).toBe(false);
    expect(hero.gauge('hp').removeSba('X')).toBe(true);
    // The built-ins are still attached; removing them empties the gauge.
    expect(hero.gauge('hp').removeSba('HP Depleted')).toBe(true);
    expect(hero.gauge('hp').removeSba('HP Max Collapsed')).toBe(true);
    expect(hero.gauge('hp').sbas).toHaveLength(0);
  });
});
