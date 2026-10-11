import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Character,
  GameEngine,
  cast,
  damage,
  heal,
  skill,
} from '../src/games/turn-based/index.js';
import { RandomAI } from '../src/multiplayer/random-ai.js';
import { createEngine } from '../src/games/turn-based/index.js';

const strike = cast({
  name: 'Strike',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 5, ctx.self)],
});

const cleave = cast({
  name: 'Cleave',
  targeting: { who: 'enemy', count: 2 },
  cast: () => [],
});

const firstAid = cast({
  name: 'First Aid',
  targeting: { who: 'ally', count: 1 },
  cast: () => [],
});

describe('RandomAI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('picks a random manual ability for each living character', async () => {
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      skills: [skill({ name: 'Fighter', weight: 1, abilities: [strike, firstAid] })],
    });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
    const engine = createEngine();
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    const ai = new RandomAI('Hero', [hero], 'party');

    vi.spyOn(Math, 'random').mockReturnValue(0.99); // last ability
    const decisions = await ai.decide(engine);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.character).toBe(hero);
    expect(decisions[0]!.ability.name).toBe('First Aid');
    expect(decisions[0]!.targets).toEqual([hero]); // only ally on the board
  });

  it('picks targets inside the ability targeting pattern', async () => {
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      skills: [skill({ name: 'Fighter', weight: 1, abilities: [strike] })],
    });
    const a = new Character('A', { maxHp: 100, maxMana: 100 });
    const b = new Character('B', { maxHp: 100, maxMana: 100 });
    const engine = createEngine();
    engine.registerCharacter(hero);
    engine.registerCharacter(a);
    engine.registerCharacter(b);
    const ai = new RandomAI('Hero', [hero], 'party');

    vi.spyOn(Math, 'random').mockReturnValue(0); // first option
    const decisions = await ai.decide(engine);

    expect(decisions).toHaveLength(1);
    const targets = decisions[0]!.targets;
    expect(targets).toHaveLength(1);
    expect(['A', 'B']).toContain(targets[0]!.name); // enemies only
  });

  it('respects a multi-target count', async () => {
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      skills: [skill({ name: 'Fighter', weight: 1, abilities: [cleave] })],
    });
    const a = new Character('A', { maxHp: 100, maxMana: 100 });
    const b = new Character('B', { maxHp: 100, maxMana: 100 });
    const engine = createEngine();
    engine.registerCharacter(hero);
    engine.registerCharacter(a);
    engine.registerCharacter(b);
    const ai = new RandomAI('Hero', [hero], 'party');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    const decisions = await ai.decide(engine);

    expect(decisions[0]!.targets).toHaveLength(2);
  });

  it('skips defeated characters', async () => {
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      skills: [skill({ name: 'Fighter', weight: 1, abilities: [strike] })],
    });
    // Defeat is mana-derived now: a character with mana at (or below) min is
    // defeated, so the dead fighter's mana — not just its HP — is at 0.
    const dead = new Character('Dead', { maxHp: 10, hp: 0, maxMana: 10, mana: 0 });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 }); // no team → enemy
    const engine = createEngine();
    engine.registerCharacter(hero);
    engine.registerCharacter(dead);
    engine.registerCharacter(goblin);
    const ai = new RandomAI('Hero', [hero, dead], 'party');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    const decisions = await ai.decide(engine);

    expect(decisions).toHaveLength(1); // only the living hero decides
    expect(decisions[0]!.character).toBe(hero);
    expect(decisions[0]!.targets).toEqual([goblin]);
  });
});
