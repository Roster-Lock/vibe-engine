import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEndInterrupt,
  GameEngine,
  Player,
  amountOf,
  damage,
  heal,
  isDamage,
  isHeal,
  lose,
  wasTakenBy,
  win,
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

/** A character with HP and Mana. Mana is the life gauge, so a living
 * character needs a positive maxMana (defaults to maxHp). */
function char(name: string, maxHp: number, hp?: number): Character {
  return new Character(name, { maxHp, maxMana: maxHp, ...(hp !== undefined ? { hp } : {}) });
}

function player(name: string, characters: Character[], team?: string): TestPlayer {
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

describe('win/lose state-based actions', () => {
  it('ends the game when the last opponent dies', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const heroP = player('Hero', [hero], 'party');
    const goblinP = player('Goblins', [goblin], 'monsters');
    const engine = makeEngine([heroP, goblinP]);

    await engine.damage(goblin.gauge('hp'), 10, hero);
    expect(goblin.isDefeated).toBe(false); // still standing

    const e = await capture(() => engine.damage(goblin.gauge('hp'), 10, hero));
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([heroP]);
    expect(goblin.isDefeated).toBe(true);
    expect(hero.isDefeated).toBe(false);
  });

  it('does not end the game while the controller has another living character', async () => {
    const a = char('A', 20);
    const b = char('B', 20);
    const c = char('C', 20);
    const red = player('Red', [a, b], 'red');
    const blue = player('Blue', [c], 'blue');
    const engine = makeEngine([red, blue]);

    await engine.damage(a.gauge('hp'), 20, c); // A falls, but Red still has B
    expect(a.isDefeated).toBe(true);
    expect(red.isDefeated).toBe(false);

    const e = await capture(() => engine.damage(b.gauge('hp'), 20, c));
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([blue]);
  });

  it('ends the game only when every player on a team has lost', async () => {
    const a = char('A', 20);
    const b = char('B', 20);
    const c = char('C', 20);
    const red1 = player('Red 1', [a], 'red');
    const red2 = player('Red 2', [b], 'red');
    const blue = player('Blue', [c], 'blue');
    const engine = makeEngine([red1, red2, blue]);

    await engine.damage(a.gauge('hp'), 20, c); // Red 1 falls — Red 2 keeps the team alive
    expect(red1.isDefeated).toBe(true);
    expect(red2.isDefeated).toBe(false);

    const e = await capture(() => engine.damage(b.gauge('hp'), 20, c)); // now the whole team is gone
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([blue]);
  });

  it('treats teamless players as their own teams', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const heroP = player('Hero', [hero]); // no team tag
    const goblinP = player('Goblins', [goblin]); // no team tag
    const engine = makeEngine([heroP, goblinP]);

    const e = await capture(() => engine.damage(goblin.gauge('hp'), 20, hero));
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([heroP]);
  });

  it('ends as a draw when both teams fall in the same batch', async () => {
    const a = char('A', 10);
    const b = char('B', 10);
    const red = player('Red', [a], 'red');
    const blue = player('Blue', [b], 'blue');
    const engine = makeEngine([red, blue]);

    // One apply, both kill blows: nobody is left standing.
    const e = await capture(() => engine.apply([damage(a.gauge('hp'), 10), damage(b.gauge('hp'), 10)]));
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([]);
  });

  it('checks game over before emitting events (no events for the killing blow)', async () => {
    const events: GameEvent[] = [];
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const heroP = player('Hero', [hero], 'party');
    const goblinP = player('Goblins', [goblin], 'monsters');
    const engine = makeEngine([heroP, goblinP], (e) => events.push(e));

    await engine.damage(goblin.gauge('hp'), 10, hero);
    expect(events.map((e) => e.type)).toEqual([
      'gauge:changed',
      'gauge:changed:batch',
      'character:survived',
      'character:survived:batch',
    ]);
    events.length = 0;

    await capture(() => engine.damage(goblin.gauge('hp'), 10, hero));
    expect(events).toEqual([]); // the game-over check ran first — nothing emitted
  });

  it('still emits defeated events for kills that do not end the game', async () => {
    const events: GameEvent[] = [];
    const a = char('A', 20);
    const b = char('B', 20);
    const c = char('C', 20);
    const red = player('Red', [a, b], 'red');
    const blue = player('Blue', [c], 'blue');
    const engine = makeEngine([red, blue], (e) => events.push(e));

    await engine.damage(a.gauge('hp'), 20, c);
    expect(events.some((e) => e.type === 'character:destroyed' && e.character === a)).toBe(true);
    expect(events.some((e) => wasTakenBy(e, a))).toBe(true);
  });

  it('does not detect win/lose when no players are registered', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const engine = createEngine();
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    await engine.damage(goblin.gauge('hp'), 20, hero); // kills goblin — but no game over
    expect(goblin.isDefeated).toBe(true);
  });
});

describe('win/lose actions', () => {
  it('win ends the game immediately with the named team', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const heroP = player('Hero', [hero], 'party');
    const goblinP = player('Goblins', [goblin], 'monsters');
    const engine = makeEngine([heroP, goblinP]);

    const e = await capture(() => engine.apply([win('party')]));
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([heroP]);
  });

  it('win accepts a specific player (teamless players win alone)', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const heroP = player('Hero', [hero]);
    const goblinP = player('Goblins', [goblin], 'monsters');
    const engine = makeEngine([heroP, goblinP]);

    const e = await capture(() => engine.apply([win(heroP)]));
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([heroP]);
  });

  it('lose marks a team lost and lets the last team standing win', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const heroP = player('Hero', [hero], 'party');
    const goblinP = player('Goblins', [goblin], 'monsters');
    const engine = makeEngine([heroP, goblinP]);

    const e = await capture(() => engine.apply([lose('monsters')]));
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([heroP]);
  });

  it('lose does not end the game while other teams are still standing', async () => {
    const a = char('A', 100);
    const b = char('B', 100);
    const c = char('C', 100);
    const red = player('Red', [a], 'red');
    const blue = player('Blue', [b], 'blue');
    const green = player('Green', [c], 'green');
    const engine = makeEngine([red, blue, green]);

    // Red is out — but blue and green are still fighting.
    const e = await capture(() => engine.apply([lose('red')]));
    expect(e).toBeUndefined();
    expect(engine.players).toHaveLength(3);
  });

  it('two teams winning in the same apply is a draw', async () => {
    const a = char('A', 100);
    const b = char('B', 100);
    const red = player('Red', [a], 'red');
    const blue = player('Blue', [b], 'blue');
    const engine = makeEngine([red, blue]);

    const e = await capture(() => engine.apply([win('red'), win('blue')]));
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([]);
  });

  it('two winners are a draw even while a third team is still standing', async () => {
    const a = char('A', 100);
    const b = char('B', 100);
    const c = char('C', 100);
    const red = player('Red', [a], 'red');
    const blue = player('Blue', [b], 'blue');
    const green = player('Green', [c], 'green');
    const engine = makeEngine([red, blue, green]);

    const e = await capture(() => engine.apply([win('red'), win('blue')]));
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([]);
  });

  it('all teams losing in the same apply is a draw', async () => {
    const a = char('A', 100);
    const b = char('B', 100);
    const red = player('Red', [a], 'red');
    const blue = player('Blue', [b], 'blue');
    const engine = makeEngine([red, blue]);

    const e = await capture(() => engine.apply([lose('red'), lose('blue')]));
    expect(e).toBeInstanceOf(GameEndInterrupt);
    expect((e as GameEndInterrupt).winners).toEqual([]);
  });

  it('rejects win/lose for teams that were never registered', async () => {
    const hero = char('Hero', 100);
    const engine = makeEngine([player('Hero', [hero], 'party')]);

    await expect(engine.apply([win('ghosts')])).rejects.toThrow(/no registered players/i);
    await expect(engine.apply([lose('ghosts')])).rejects.toThrow(/no registered players/i);
  });
});

describe('batched gauge changes', () => {
  it('nets damage and heal within one apply (vampire drain)', async () => {
    const events: GameEvent[] = [];
    const hero = char('Hero', 100);
    const vamp = char('Vampire', 100, 30);
    const heroP = player('Hero', [hero], 'party');
    const vampP = player('Vampires', [vamp], 'monsters');
    const engine = makeEngine([heroP, vampP], (e) => events.push(e));

    // Damage the target and heal the caster in one batch.
    await engine.apply([damage(hero.gauge('hp'), 20, vamp), heal(vamp.gauge('hp'), 20, vamp)]);

    expect(hero.gauge('hp').current).toBe(80);
    expect(vamp.gauge('hp').current).toBe(50);

    const taken = events.filter((e) => isDamage(e) && e.target === hero);
    expect(taken).toHaveLength(1);
    expect(amountOf(taken[0]!)).toBe(20);
    const healed = events.filter((e) => isHeal(e) && e.target === vamp);
    expect(healed).toHaveLength(1);
    expect(amountOf(healed[0]!)).toBe(20);
  });

  it('a character that dips below zero mid-batch survives when the batch nets positive', async () => {
    const hero = char('Hero', 10);
    const goblin = char('Goblin', 50);
    const heroP = player('Hero', [hero], 'party');
    const goblinP = player('Goblins', [goblin], 'monsters');
    const engine = makeEngine([heroP, goblinP]);

    // One batch: take 10 (clamped to 0), then heal 6 — net -4, alive at 6.
    await engine.apply([damage(hero.gauge('hp'), 10), heal(hero.gauge('hp'), 6)]);

    expect(hero.gauge('hp').current).toBe(6);
    expect(hero.isDefeated).toBe(false);
  });

  it('applies writes to several characters before any events run', async () => {
    const events: GameEvent[] = [];
    const a = char('A', 20);
    const b = char('B', 20);
    const c = char('C', 100);
    const red = player('Red', [a], 'red');
    const blue = player('Blue', [b], 'blue');
    const green = player('Green', [c], 'green');
    const engine = makeEngine([red, blue, green], (e) => events.push(e));

    await engine.apply([damage(a.gauge('hp'), 5, c), damage(b.gauge('hp'), 5, c)]);

    expect(a.gauge('hp').current).toBe(15);
    expect(b.gauge('hp').current).toBe(15);
    const taken = events.filter((e) => isDamage(e));
    expect(taken).toHaveLength(2);
    expect(taken.map((e) => e.target)).toEqual([a, b]);
  });

  it('nets multiple hits to the same gauge into a single damage event', async () => {
    const events: GameEvent[] = [];
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const heroP = player('Hero', [hero], 'party');
    const goblinP = player('Goblins', [goblin], 'monsters');
    const engine = makeEngine([heroP, goblinP], (e) => events.push(e));

    await engine.apply([damage(goblin.gauge('hp'), 10, hero), damage(goblin.gauge('hp'), 10, hero)]);

    expect(goblin.gauge('hp').current).toBe(80);
    const taken = events.filter((e) => isDamage(e));
    expect(taken).toHaveLength(1);
    expect(amountOf(taken[0]!)).toBe(20);
  });
});
