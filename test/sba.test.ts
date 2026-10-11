/**
 * Content state-based rules (docs/design/04-sba.md, slice 4):
 *
 * - `addStateBasedRule({ name, priority?, when, then })` — continuous
 *   conditions over the whole game state, checked at the SBA pass, not
 *   event-driven;
 * - each rule fires at most once per pass iteration; the pass loops while
 *   the state changed and stops on the first no-change iteration;
 * - `win`/`lose` from a rule resolve at the win/lose layer — the game ends
 *   before any further rule or event;
 * - a rule whose effect never stops changing state hits the depth guard.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEndInterrupt,
  GameEngine,
  Player,
  buff,
  damage,
  heal,
  setGauge,
  win,
  type Decision,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

function char(name: string, maxHp: number, mana?: number): Character {
  // Mana is the life gauge: a character without a positive maxMana is
  // defeated at creation, so default `maxMana` to `maxHp`. The optional
  // `mana` argument sets the starting mana (below max = a drained well).
  return new Character(name, { maxHp, maxMana: maxHp, ...(mana !== undefined ? { mana } : {}) });
}

function player(name: string, characters: Character[], team?: string): TestPlayer {
  return new TestPlayer(name, characters, team);
}

function makeEngine(players: TestPlayer[]): GameEngine {
  const engine = createEngine();
  engine.registerPlayers(players);
  return engine;
}

describe('content state-based rules', () => {
  it('Overbuff: total buff count > 4 wins the buff-heavy team', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const heroP = player('Hero', [hero], 'party');
    const goblinP = player('Goblins', [goblin], 'monsters');
    const engine = makeEngine([heroP, goblinP]);

    // Buffs first (no rule yet), then the rule — the next settle ends the game.
    const marker = buff({ name: 'Marker', weight: 1 });
    await engine.addBuff(hero, marker);
    await engine.addBuff(hero, { ...marker, name: 'Marker2' });
    await engine.addBuff(hero, { ...marker, name: 'Marker3' });
    await engine.addBuff(goblin, marker);
    await engine.addBuff(goblin, { ...marker, name: 'Marker4' });

    engine.addStateBasedRule({
      name: 'Overbuff',
      when: (e) => e.registeredCharacters.reduce((n, c) => n + c.buffs.length, 0) > 4,
      then: () => [win('party')],
    });

    let winners: unknown;
    await engine.damage(goblin.gauge('hp'), 1, hero).catch((error) => {
      if (error instanceof GameEndInterrupt) winners = error.winners;
    });
    expect(winners).toEqual([heroP]);
  });

  it('Empty Mana Well: while total mana is 0, refill everyone — terminates once full', async () => {
    const a = new Character('A', { maxHp: 100, maxMana: 10, mana: 0 });
    const b = new Character('B', { maxHp: 100, maxMana: 10, mana: 0 });
    const goblin = char('Goblin', 50, 0);
    const engine = makeEngine([
      player('Party', [a, b], 'party'),
      player('Goblins', [goblin], 'monsters'),
    ]);

    let fires = 0;
    engine.addStateBasedRule({
      name: 'Empty Mana Well',
      when: (e) => e.registeredCharacters.every((c) => c.gauge('mana').current === 0),
      then: (e) => {
        fires += 1;
        // Mana is the life gauge — the rule keeps everyone alive by
        // refilling the empty wells.
        return e.registeredCharacters.map((c) => setGauge(c.gauge('mana'), c.gauge('mana').max));
      },
    });

    // Mana is the life gauge, so everyone starts defeated (mana 0): a gauge
    // batch would end the game at its game-over check before any rule could
    // run. A non-gauge settle runs the SBA pass first: the rule refills
    // every empty well to full in one pass, and the no-change probe
    // iteration stops the loop.
    await engine.addBuff(goblin, buff({ name: 'Marker', weight: 1 }));

    expect(a.gauge('mana').current).toBe(10);
    expect(b.gauge('mana').current).toBe(10);
    expect(goblin.gauge('mana').current).toBe(50);
    // One productive iteration (everything back to full) plus one final
    // no-change probe iteration that stopped the loop.
    expect(fires).toBe(1);
  });

  it('stops on the first no-change pass (a rule whose effect changes nothing)', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin], 'monsters'),
    ]);

    let fires = 0;
    engine.addStateBasedRule({
      name: 'Always Heal Full',
      when: () => true,
      then: () => {
        fires += 1;
        return [heal(hero.gauge('hp'), 1)]; // hero is already full — a clamped no-op
      },
    });

    await engine.damage(goblin.gauge('hp'), 1, hero); // settles; the rule fires once, changes nothing, loop stops
    expect(fires).toBe(1);
  });

  it('rules run in ascending priority order within a pass', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin], 'monsters'),
    ]);

    const order: string[] = [];
    engine.addStateBasedRule({
      name: 'High',
      priority: 90,
      when: () => true,
      then: () => {
        order.push('high');
        return [];
      },
    });
    engine.addStateBasedRule({
      name: 'Low',
      priority: 10,
      when: () => true,
      then: () => {
        order.push('low');
        return [];
      },
    });

    await engine.damage(goblin.gauge('hp'), 1, hero);
    expect(order).toEqual(['low', 'high']);
  });

  it('a rule whose effect never stops changing state hits the depth guard', async () => {
    const hero = char('Hero', 100000);
    const goblin = char('Goblin', 100000);
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin], 'monsters'),
    ]);

    engine.addStateBasedRule({
      name: 'Unstoppable',
      when: () => true,
      then: (e) => [damage(e.registeredCharacters[0]!.gauge('hp'), 1)],
    });

    await expect(engine.damage(goblin.gauge('hp'), 1, hero)).rejects.toThrow(/max depth/i);
  });
});
