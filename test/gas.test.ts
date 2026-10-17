/**
 * Gas — a budget of work, so a loop that never ends ends anyway (src/engine/gas.ts).
 *
 * The engine already capped how *deep* a chain of applies may go. These tests are
 * about the loops that are not deep: a trigger that starts two triggers, a formula
 * that sums a million terms, a repeat whose condition never turns false.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer, GreedyAI } from '../examples/card-game/ai.js';
import type { Card } from '../examples/card-game/cards.js';
import { playableCards } from '../examples/card-game/english.js';
import { CardGame } from '../examples/card-game/game.js';
import { compileDocument } from '../src/english/index.js';
import {
  Character,
  GasMeter,
  OutOfGasError,
  createEngine,
  type GameEvent,
} from '../src/games/turn-based/index.js';

describe('the meter', () => {
  it('counts work inside a scope and nothing outside one', async () => {
    const gas = new GasMeter({ limit: 100 });
    gas.spend('action'); // outside: free
    expect(gas.used).toBe(0);
    await gas.scope('s', () => {
      gas.spend('action');
      gas.spend('trigger');
      expect(gas.used).toBe(3); // 1 + 2
      expect(gas.remaining).toBe(97);
    });
    expect(gas.active).toBe(false);
  });

  it('prices each kind of work, and the prices can be changed', async () => {
    const gas = new GasMeter({ limit: 1000, costs: { math: 10, ask: 3 } });
    await gas.scope('s', () => {
      gas.spend('math');
      gas.spend('ask');
      gas.spend('effect', 'x', 4);
      expect(gas.used).toBe(10 + 3 + 4);
    });
  });

  it('gives every top-level scope a fresh budget, and remembers the busiest', async () => {
    const gas = new GasMeter({ limit: 10 });
    await gas.scope('a', () => gas.spend('action', 'x', 8));
    await gas.scope('b', () => gas.spend('action', 'x', 6));
    expect(gas.peak).toBe(8);
    expect(gas.used).toBe(6);
  });

  it('shares the outermost budget with a nested scope', async () => {
    const gas = new GasMeter({ limit: 10 });
    await expect(
      gas.scope('outer', async () => {
        gas.spend('action', 'x', 6);
        await gas.scope('inner', () => gas.spend('action', 'x', 6));
      }),
    ).rejects.toThrow(/Out of gas in "outer"/);
  });

  it('ends its scope even when the work throws', async () => {
    const gas = new GasMeter({ limit: 10 });
    await expect(gas.scope('s', () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(gas.active).toBe(false);
    await gas.scope('t', () => gas.spend('action'));
  });

  it('says where it ran out and what it was doing, collapsing repeats', async () => {
    const gas = new GasMeter({ limit: 20 });
    let caught: unknown;
    try {
      await gas.scope('the move', () => {
        for (let i = 0; i < 100; i += 1) {
          gas.spend('trigger', 'Echo');
          gas.spend('action', 'gauge');
        }
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OutOfGasError);
    const error = caught as OutOfGasError;
    expect(error.label).toBe('the move');
    expect(error.limit).toBe(20);
    expect(error.used).toBeGreaterThan(20);
    expect(error.trail.map((entry) => entry.what)).toContain('trigger:Echo');
    expect(error.message).toMatch(/Out of gas in "the move".*infinite loop.*trigger:Echo.*raise the engine's gas limit/);
  });

  it('is off with an infinite limit', async () => {
    const gas = new GasMeter({ limit: Number.POSITIVE_INFINITY });
    await gas.scope('s', () => gas.spend('action', 'x', 1_000_000));
  });
});

/* ------------------------------ in the engine ----------------------------- */

const ECHO = (name: string) => `Buff ${name}\nwhen this takes damage then deal 1 damage to this character.`;

function arena(options: Parameters<typeof createEngine>[0] = {}) {
  const events: GameEvent[] = [];
  const engine = createEngine({ seed: 's', onEvent: (event: GameEvent) => events.push(event), ...options });
  const hero = new Character('Hero', { gauges: [{ id: 'hp', max: 1_000_000_000 }] });
  engine.registerCharacter(hero);
  return { engine, hero, events };
}

describe('loops the depth cap does not catch', () => {
  it('a trigger that triggers itself is stopped by gas, not by hanging', async () => {
    // Depth is allowed to be enormous here, so the only thing that can stop it is gas.
    const { engine, hero, events } = arena({ maxActionDepth: 1_000_000, gas: { limit: 2000 } });
    const echo = compileDocument(ECHO('Echo'));
    expect(echo.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    await engine.addBuff(hero, echo.buffs[0]!);
    await expect(engine.damage(hero.gauge('hp'), 1)).rejects.toThrow(OutOfGasError);
    const exhausted = events.filter((e) => e.type === 'gas:exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({ type: 'gas:exhausted', label: 'apply', limit: 2000 });
  });

  it('two triggers that each start two more — wide, not deep — are stopped too', async () => {
    const { engine, hero } = arena({ maxActionDepth: 1_000_000, gas: { limit: 5000 } });
    for (const name of ['Echo A', 'Echo B']) {
      await engine.addBuff(hero, compileDocument(ECHO(name)).buffs[0]!);
    }
    const started = Date.now();
    await expect(engine.damage(hero.gauge('hp'), 1)).rejects.toThrow(OutOfGasError);
    // Without a budget this is 2^depth of work; with one it is over in moments.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('names what was running when the budget ran out', async () => {
    const { engine, hero } = arena({ maxActionDepth: 1_000_000, gas: { limit: 500 } });
    await engine.addBuff(hero, compileDocument(ECHO('Echo')).buffs[0]!);
    const error = await engine.damage(hero.gauge('hp'), 1).catch((e: unknown) => e);
    // The trail shows the cycle itself: an effect, an action, then the same trigger again.
    expect((error as Error).message).toMatch(/trigger:When this takes damage, deal 1 damage to this character\..*trigger:When this takes damage/);
  });

  it('a repeat that cannot reach its end is stopped', async () => {
    const compiled = compileDocument(
      'Ability Spin\nRoll a d6.\nRepeat up to 900 times while that total is 3 or less: Roll a d6.',
    );
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = compiled.abilities[0]!;
    const { engine, hero } = arena({ roller: () => [1], gas: { limit: 300 } });
    const caster = new Character('Caster', { gauges: [{ id: 'hp', max: 5 }], skills: [{ name: 'Spin', weight: 1, abilities: [ability] }] });
    engine.registerCharacter(caster);
    await expect(engine.useAbility(caster, ability, { targets: [] })).rejects.toThrow(OutOfGasError);
    void hero;
  });

  it('a formula that sums a million terms is stopped inside the sum', async () => {
    const compiled = compileDocument('Ability Big\nDeal (Σ(i = 1 to 1000000, i)) damage to this character.');
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = compiled.abilities[0]!;
    const { engine } = arena();
    const caster = new Character('Caster', { gauges: [{ id: 'hp', max: 5 }], skills: [{ name: 'Big', weight: 1, abilities: [ability] }] });
    engine.registerCharacter(caster);
    const started = Date.now();
    await expect(engine.useAbility(caster, ability, { targets: [] })).rejects.toThrow(/Out of gas in "ability Big".*math/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('lets a legitimate formula through', async () => {
    const compiled = compileDocument('Ability Small\nDeal (Σ(i = 1 to 20, i)) damage to this character.');
    const ability = compiled.abilities[0]!;
    const { engine } = arena();
    const caster = new Character('Caster', { gauges: [{ id: 'hp', max: 500 }], skills: [{ name: 'Small', weight: 1, abilities: [ability] }] });
    engine.registerCharacter(caster);
    await engine.useAbility(caster, ability, { targets: [] });
    expect(caster.gauge('hp').current).toBe(500 - 210);
  });
});

describe('budgets in the engine', () => {
  it('gives each top-level apply its own', async () => {
    const { engine, hero } = arena({ gas: { limit: 12 } });
    for (let i = 0; i < 20; i += 1) await engine.damage(hero.gauge('hp'), 1); // 20 applies, each tiny
    expect(engine.gas.peak).toBeLessThanOrEqual(12);
  });

  it('shares one budget across the applies of a scope the host opened', async () => {
    const { engine, hero } = arena({ gas: { limit: 12 } });
    await expect(
      engine.metered('a turn', async () => {
        for (let i = 0; i < 20; i += 1) await engine.damage(hero.gauge('hp'), 1);
      }),
    ).rejects.toThrow(/Out of gas in "a turn"/);
  });

  it('announces exhaustion once, however many scopes it unwinds through', async () => {
    const { engine, hero, events } = arena({ gas: { limit: 5 } });
    await expect(
      engine.metered('outer', () => engine.metered('inner', () => engine.damage(hero.gauge('hp'), 1).then(() => engine.gas.spend('action', 'x', 99)))),
    ).rejects.toThrow(OutOfGasError);
    expect(events.filter((e) => e.type === 'gas:exhausted')).toHaveLength(1);
  });

  it('can be turned off', async () => {
    const { engine, hero } = arena({ gas: false });
    await engine.metered('x', () => engine.gas.spend('action', 'x', 10_000_000));
    await engine.damage(hero.gauge('hp'), 1);
    expect(hero.gauge('hp').current).toBe(1_000_000_000 - 1);
  });

  it('counts a question put to a player', async () => {
    const { engine } = arena({ gas: { limit: 3 } });
    await expect(
      engine.metered('ask', async () => {
        for (let i = 0; i < 10; i += 1) await engine.ask({ kind: 'confirm', prompt: 'again?', chooser: undefined });
      }),
    ).rejects.toThrow(OutOfGasError);
  });
});

describe('a game stuck in a loop it cannot leave is a draw', () => {
  it('ends the match with no winner and says why', async () => {
    const { cards } = playableCards(
      ['Card Test Abyss', 'Cost 0', 'Spell', 'Deal (Σ(i = 1 to 1000000, i)) damage to all enemy characters.'].join('\n'),
    );
    const abyss = cards[0]! as Card;
    const events: GameEvent[] = [];
    const alice = new GreedyAI('Alice', 'a', Array.from({ length: 30 }, () => abyss));
    const bob = new GreedyAI('Bob', 'b', Array.from({ length: 30 }, () => abyss));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3, onEvent: (e) => events.push(e) });
    await game.setup();
    const winners = await game.runLoop();
    expect(winners).toEqual([]);
    expect(events.some((e) => e.type === 'gas:exhausted')).toBe(true);
    void CardPlayer;
  });

  it('does not touch a game that finishes normally', async () => {
    const { STARTER_DECK } = await import('../examples/card-game/cards.js');
    const game = new CardGame([new GreedyAI('A', 'a', STARTER_DECK), new GreedyAI('B', 'b', STARTER_DECK)], {
      log: () => {},
      openingHand: 3,
    });
    await game.setup();
    const winners = await game.runLoop();
    expect(winners.length).toBe(1);
    // Real play uses a sliver of the budget.
    expect(game.engine.gas.peak).toBeLessThan(game.engine.gas.limit / 20);
  });
});

describe('the compiler warns about the loop before it runs', () => {
  const warnings = (text: string) =>
    compileDocument(text).diagnostics.filter((d) => d.severity === 'warning' && d.code === 'trigger-loop');

  it('a trigger on this taking damage that deals damage to this', () => {
    const found = warnings('Buff Echo\nwhen this takes damage then deal 1 damage to this character.');
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toMatch(/sets itself off again every time it runs.*Aim it at "the source character"/);
  });

  it('also when it deals damage to everyone, which includes this', () => {
    expect(warnings('Buff Echo\nwhen this takes damage then deal 1 damage to all characters.')).toHaveLength(1);
  });

  it('and the same for healing', () => {
    expect(warnings('Buff Echo\nwhen this is healed then heal this character for 1.')).toHaveLength(1);
  });

  it('is quiet about the real thing it should not mind: thorns, other targets, other directions', () => {
    expect(warnings('Buff Thorns\nwhen this takes damage then deal 3 damage to the source character.')).toEqual([]);
    expect(warnings('Buff Aura\nwhen this takes damage then deal 1 damage to all enemy characters.')).toEqual([]);
    expect(warnings('Buff Mend\nwhen this takes damage then heal this character for 1.')).toEqual([]);
    expect(warnings('Buff Pain\nwhen this is healed then deal 1 damage to this character.')).toEqual([]);
  });

  it('is only a warning: the document still compiles and runs, and gas is the backstop', async () => {
    const compiled = compileDocument('Buff Echo\nwhen this takes damage then deal 1 damage to this character.');
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(compiled.buffs).toHaveLength(1);
  });
});
