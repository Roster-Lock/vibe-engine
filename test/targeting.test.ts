import { describe, expect, it } from 'vitest';
import {
  Buff,
  Character,
  ScriptedChooser,
  GameEngine,
  auto,
  buff,
  cast,
  damage,
  heal,
  prompt,
  skill,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';

function makeBattle(): {
  engine: GameEngine;
  hero: Character;
  goblin: Character;
  wolf: Character;
} {
  const engine = createEngine();
  const hero = new Character('Hero', { maxHp: 100 });
  const goblin = new Character('Goblin', { maxHp: 100, hp: 100 });
  const wolf = new Character('Wolf', { maxHp: 100, hp: 30 });
  hero.team = 'party';
  goblin.team = 'monsters';
  wolf.team = 'monsters';
  engine.registerCharacter(hero);
  engine.registerCharacter(goblin);
  engine.registerCharacter(wolf);
  return { engine, hero, goblin, wolf };
}

const taunt = buff({ name: 'Taunt', weight: 1 });

describe('custom targeting', () => {
  it('filters the pool with a match condition', () => {
    const { engine, hero } = makeBattle();
    const pool = engine.validTargets(
      { who: 'enemy', match: (ctx, c) => c.gauge('hp').current < c.gauge('hp').max },
      hero,
    );
    expect(pool.map((c) => c.name)).toEqual(['Wolf']); // only the wounded enemy
  });

  it('negate makes a match exclusive instead of inclusive', () => {
    const { engine, hero, goblin, wolf } = makeBattle();
    wolf.addBuff(new Buff(taunt));
    const pool = engine.validTargets(
      { who: 'enemy', match: (ctx, c) => c.hasStatus('taunt'), negate: true },
      hero,
    );
    // every enemy *except* the taunter
    expect(pool).toEqual([goblin]);
  });

  it('negate without a match inverts the who filter', () => {
    const { engine, hero } = makeBattle();
    const pool = engine.validTargets({ who: 'enemy', negate: true }, hero);
    // everyone who is not an enemy: just the hero (no other allies)
    expect(pool.map((c) => c.name)).toEqual(['Hero']);
  });

  it('include marks specific characters as always valid', () => {
    const { engine, hero, goblin, wolf } = makeBattle();
    const pool = engine.validTargets({ who: 'enemy', include: [hero] }, hero);
    expect(pool.map((c) => c.name)).toEqual(['Goblin', 'Wolf', 'Hero']);
  });

  it('ignores include entries that are not registered', () => {
    const { engine, hero } = makeBattle();
    const outsider = new Character('Outsider', { maxHp: 10 });
    const pool = engine.validTargets({ who: 'enemy', include: [outsider] }, hero);
    expect(pool.map((c) => c.name)).toEqual(['Goblin', 'Wolf']);
  });

  it('lets a manual ability be constrained by the pattern', async () => {
    const { engine, hero, goblin } = makeBattle();
    const paladin = new Character('Paladin', { maxHp: 100 });
    paladin.team = 'party';
    engine.registerCharacter(paladin);

    const fireball = cast({
      name: 'Fireball',
      targeting: { who: 'enemy', match: (ctx, c) => c.name === 'Goblin' },
      cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 40, ctx.self)],
    });
    hero.addBuff(new Buff(buff({ name: 'Pyromancer', weight: 1, abilities: [fireball] })));

    // out-of-pattern target: rejected
    await expect(engine.useAbility(hero, fireball, { targets: [paladin] })).rejects.toThrow(
      /outside its targeting pattern/,
    );
    // matching target: works
    await engine.useAbility(hero, fireball, { targets: [goblin] });
    expect(goblin.gauge('hp').current).toBe(60);
  });

  it('accepts manual targets listed in include', async () => {
    const { engine, hero } = makeBattle();
    const paladin = new Character('Paladin', { maxHp: 100 });
    paladin.team = 'party';
    engine.registerCharacter(paladin);

    const cleave = cast({
      name: 'Cleave',
      targeting: { who: 'enemy', include: [paladin] },
      cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 10, ctx.self)],
    });
    hero.addBuff(new Buff(buff({ name: 'Warrior', weight: 1, abilities: [cleave] })));

    await engine.useAbility(hero, cleave, { targets: [paladin] });
    expect(paladin.gauge('hp').current).toBe(90);
  });

  it('only offers matching options to the host for prompt abilities', async () => {
    const { engine, hero, goblin } = makeBattle();
    const paladin = new Character('Paladin', { maxHp: 100, hp: 40 });
    paladin.team = 'party';
    engine.registerCharacter(paladin);

    const warCry = buff({
      name: 'War Cry',
      weight: 1,
      abilities: [
        prompt({
          name: 'Inspire',
          event: 'turn:start',
          prompt: () => ({
            who: 'any',
            count: 1,
            match: (ctx, c) => c.team === 'party' && c !== ctx.self,
          }),
          cast: (ctx, targeting) => [heal(targeting.targets[0]!.gauge('hp'), 20, ctx.self)],
        }),
      ],
    });
    await engine.addBuff(hero, warCry);
    await startTurn(engine);
    expect(paladin.gauge('hp').current).toBe(60); // host could only pick matching characters

    // A host answering with an out-of-pattern character is rejected.
    const sneaky = createEngine({ chooser: ScriptedChooser.selects([goblin]) });
    const hero2 = new Character('Hero', { maxHp: 100 });
    hero2.team = 'party';
    const paladin2 = new Character('Paladin', { maxHp: 100 });
    paladin2.team = 'party';
    const goblin2 = new Character('Goblin', { maxHp: 100 });
    goblin2.team = 'monsters';
    sneaky.registerCharacter(hero2);
    sneaky.registerCharacter(paladin2);
    sneaky.registerCharacter(goblin2);
    await sneaky.addBuff(hero2, warCry);
    await expect(startTurn(sneaky)).rejects.toThrow(/outside its targeting pattern/);
  });

  it('computes auto targets from a pattern with match and negate', async () => {
    const { engine, hero, goblin, wolf } = makeBattle();
    const hits: string[] = [];
    const sniper = buff({
      name: 'Sniper',
      weight: 1,
      abilities: [
        auto({
          name: 'Finish Off',
          event: 'turn:start',
          targeting: {
            who: 'enemy',
            match: (ctx, c) => c.gauge('hp').current < c.gauge('hp').max,
            negate: true,
          },
          cast: (ctx, targeting) => {
            for (const t of targeting?.targets ?? []) hits.push(t.name);
            return targeting?.targets.map((t) => damage(t.gauge('hp'), 5, ctx.self)) ?? [];
          },
        }),
      ],
    });
    await engine.addBuff(hero, sniper);

    await startTurn(engine);
    // wounded enemies excluded (exclusive targeting): only the full-HP goblin
    expect(hits).toEqual(['Goblin']);
    expect(wolf.gauge('hp').current).toBe(30);
    expect(goblin.gauge('hp').current).toBe(95);
  });

  it('rejects auto abilities that declare both targeting and targets', () => {
    expect(() =>
      auto({
        name: 'Confused',
        event: 'turn:start',
        targeting: { who: 'enemy' },
        targets: () => [],
        cast: () => [],
      }),
    ).toThrow(/either "targeting" or "targets"/);
  });

  it('works end to end through the default chooser', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100, hp: 100 });
    const wolf = new Character('Wolf', { maxHp: 100, hp: 30 });
    hero.team = 'party';
    goblin.team = 'monsters';
    wolf.team = 'monsters';
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    engine.registerCharacter(wolf);

    const fireball = cast({
      name: 'Fireball',
      targeting: {
        who: 'enemy',
        match: (ctx, c) => c.gauge('hp').current < c.gauge('hp').max,
        negate: true, // hit the unwounded enemy first
      },
      cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 10, ctx.self)],
    });
    hero.addBuff(new Buff(buff({ name: 'Pyromancer', weight: 1, abilities: [fireball] })));

    await engine.useAbility(hero, fireball, { targets: [goblin] });
    expect(goblin.gauge('hp').current).toBe(90);
  });
});

describe('targeting stays backward compatible', () => {
  it('keeps plain who-only patterns unchanged', () => {
    const { engine, hero } = makeBattle();
    expect(engine.validTargets({ who: 'self' }, hero).map((c) => c.name)).toEqual(['Hero']);
    expect(engine.validTargets({ who: 'ally' }, hero).map((c) => c.name)).toEqual(['Hero']);
    expect(engine.validTargets({ who: 'enemy' }, hero).map((c) => c.name)).toEqual([
      'Goblin',
      'Wolf',
    ]);
    expect(engine.validTargets({ who: 'any' }, hero).length).toBe(3);
  });
});
