/**
 * Tests for the AI-vs-AI battle runner in `./ai-vs-ai.ts`: the battles
 * themselves, replayability, round-cap draws, the thorns passive path, and
 * the LLM brain's graceful fallback when the model API is unreachable.
 */
import { describe, expect, it } from 'vitest';
import { Character, cast, damage, skill } from '../src/games/turn-based/index.js';
import { LocalGame } from '../src/multiplayer/local.js';
import { thorns, strike } from '../src/games/turn-based/content/index.js';
import {
  SCENARIOS,
  SeededRandomAI,
  digestOf,
  makeThornGoblin,
  mulberry32,
  parseMoves,
  resolveMove,
  runMatch,
  summarizeBuffs,
} from './ai-vs-ai.js';

describe('ai vs ai battles', () => {
  it('runs a full classic battle between two random AIs', async () => {
    const result = await runMatch({
      scenario: SCENARIOS.classic,
      brainA: 'random',
      brainB: 'random',
      verbose: false,
    });

    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(['victory', 'round-cap', 'mutual-destruction']).toContain(result.endReason);
    if (result.winners.length > 0) {
      expect(result.winners).toEqual(['Radiant Order']);
    } else if (result.endReason === 'round-cap') {
      expect(result.draw).toBe(true);
    }

    // Every engine event must respect the gauges' own bounds.
    expect(result.stats.invariantViolations).toEqual({
      belowMin: 0,
      aboveMax: 0,
      negativeMax: 0,
    });

    // The battle exercised the real event machinery.
    expect(result.stats.eventCounts['turn:start']).toBe(result.rounds);
    expect((result.stats.eventCounts['gauge:changed'] ?? 0)).toBeGreaterThan(0);
    expect(result.stats.eventCounts['character:destroyed'] ?? 0).toBeGreaterThanOrEqual(2);

    // Six fighters, each with a consistent final state. HP is the life
    // gauge — `alive` tracks HP; mana is an ordinary resource.
    const characters = result.final.flatMap((team) => team.characters);
    expect(characters).toHaveLength(6);
    for (const character of characters) {
      expect(character.hp).toBeGreaterThanOrEqual(0);
      expect(character.hp).toBeLessThanOrEqual(character.maxHp);
      expect(character.mana).toBeGreaterThanOrEqual(0);
      expect(character.mana).toBeLessThanOrEqual(character.maxMana);
      expect(character.alive).toBe(character.hp > 0);
    }
  });

  it('replays identically for the same seed', async () => {
    const options = {
      scenario: SCENARIOS.classic,
      brainA: 'seeded' as const,
      brainB: 'seeded' as const,
      seed: 42,
      verbose: false,
    };
    const first = await runMatch(options);
    const second = await runMatch(options);

    expect(second.rounds).toBe(first.rounds);
    expect(second.winners).toEqual(first.winners);
    expect(second.endReason).toBe(first.endReason);
    expect(second.final).toEqual(first.final);
    expect(digestOf(second)).toBe(digestOf(first));
  });

  it('ends as a draw when the round cap is hit', async () => {
    const result = await runMatch({
      scenario: SCENARIOS.classic,
      brainA: 'seeded',
      brainB: 'seeded',
      seed: 42,
      maxRounds: 1,
      verbose: false,
    });

    expect(result.draw).toBe(true);
    expect(result.endReason).toBe('round-cap');
    expect(result.winners).toEqual([]);
  });

  it('runs the thorn scenario', async () => {
    const result = await runMatch({
      scenario: SCENARIOS.thorn,
      brainA: 'seeded',
      brainB: 'seeded',
      seed: 7,
      verbose: false,
    });

    expect(result.endReason).not.toBe('mutual-destruction');
    // The thorn-mail goblin is real roster content via makeThornGoblin().
    const dark = result.final.find((team) => team.team === 'dark')!;
    expect(dark.characters.map((c) => c.name)).toContain('Goblin Thornbreaker');
  });

  it('exercises the thorns passive through the real buff', async () => {
    // A tank whose ONLY ability comes from the thorns buff — any damage it
    // deals must be Retaliation, never a manual skill. HP is the life
    // gauge, so both fighters need a positive maxHp to be alive.
    const tank = new Character('Tank', {
      maxHp: 120,
      maxMana: 120,
      skills: [skill({ name: 'Thorn Mail', weight: 1, abilities: [...(thorns.abilities ?? [])] })],
    });
    // Thorns retaliates against HP damage (wasTakenBy) — so this striker
    // punches HP to exercise the buff.
    const punch = cast({
      name: 'Punch',
      targeting: { who: 'enemy' },
      cast: (ctx, t) => [damage(t.targets[0]!.gauge('hp'), 20, ctx.self)],
    });
    const striker = new Character('Striker', {
      maxHp: 100,
      maxMana: 100,
      skills: [skill({ name: 'Fist', weight: 1, abilities: [punch] })],
    });
    const rng = mulberry32(1);
    const game = new LocalGame(
      [
        new SeededRandomAI('Tank', [tank], 'tanks', { rng }),
        new SeededRandomAI('Striker', [striker], 'strikers', { rng }),
      ],
      { maxRounds: 40 },
    );
    await game.runLoop();

    expect(tank.manualAbilities).toHaveLength(0);
    expect(tank.gauge('hp').current).toBeLessThan(tank.gauge('hp').max); // got hit
    expect(striker.gauge('hp').current).toBeLessThan(striker.gauge('hp').max); // retaliated
    expect(tank.gauge('mana').current).toBe(tank.gauge('mana').max); // HP damage never touches mana
  });

  it('LLM brain falls back to random moves when the API is unreachable', async () => {
    const result = await runMatch({
      scenario: SCENARIOS.classic,
      brainA: 'llm',
      brainB: 'random',
      maxRounds: 20,
      verbose: false,
      // Connection refused instantly — exercises the failure path, not the network.
      llmOptions: { apiKey: 'sk-stub', endpoint: 'http://127.0.0.1:1', model: 'stub' },
    });

    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(result.stats.llm.calls).toBeGreaterThan(0);
    expect(result.stats.llm.failures).toBe(result.stats.llm.calls);
    expect(result.stats.llm.fallbackMoves).toBeGreaterThan(0);
    expect(['victory', 'round-cap']).toContain(result.endReason);
  });
});

describe('llm brain helpers', () => {
  it('parses moves with code fences and stray prose', () => {
    const reply = 'Sure! Here you go:\n```json\n{"moves":[{"character":"Hero","ability":"Strike","targets":["Vampire Lord"]}]}\n```';
    expect(parseMoves(reply)).toEqual([
      { character: 'Hero', ability: 'Strike', targets: ['Vampire Lord'] },
    ]);
  });

  it('rejects replies without a moves array', () => {
    expect(() => parseMoves('{"nope": true}')).toThrow();
    expect(() => parseMoves('hello world')).toThrow();
  });

  it('accepts legal moves and rejects illegal targets', () => {
    // HP is the life gauge: fighters need a positive maxHp to be alive.
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      skills: [skill({ name: 'Fighter', weight: 1, abilities: [strike] })],
    });
    const goblin = new Character('Goblin', { maxHp: 50, maxMana: 50 });
    const rng = mulberry32(1);
    const game = new LocalGame(
      [
        new SeededRandomAI('Hero', [hero], 'light', { rng }),
        new SeededRandomAI('Goblins', [goblin], 'dark', { rng }),
      ],
      { maxRounds: 1 },
    );
    const engine = game.engine;

    const legal = resolveMove(engine, hero, {
      character: 'Hero',
      ability: 'Strike',
      targets: ['Goblin'],
    });
    expect(legal?.ability.name).toBe('Strike');
    expect(legal?.targets.map((t) => t.name)).toEqual(['Goblin']);

    expect(
      resolveMove(engine, hero, { character: 'Hero', ability: 'Strike', targets: ['Hero'] }),
    ).toBeUndefined();
    expect(
      resolveMove(engine, hero, { character: 'Hero', ability: 'Nope', targets: ['Goblin'] }),
    ).toBeUndefined();
  });
});

describe('content helpers', () => {
  it('summarizes stacked buffs', () => {
    expect(
      summarizeBuffs([{ name: 'Rage' }, { name: 'Rage' }, { name: 'Poison' }]),
    ).toEqual(['Rage ×2', 'Poison']);
  });

  it('makeThornGoblin grants the thorns passive as a skill', () => {
    const goblin = makeThornGoblin();
    expect(goblin.name).toBe('Goblin Thornbreaker');
    expect(goblin.manualAbilities.map((a) => a.name)).toEqual(['Headbutt', 'War Cry']);
    // The retaliation listener lives on the skill-granted abilities.
    expect(goblin.abilities.length).toBe(3);
  });
});
