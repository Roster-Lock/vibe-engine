import { describe, expect, it } from 'vitest';
import { Buff, Character, DEFAULT_SPEED, buff, cast, skill } from '../src/games/turn-based/index.js';

describe('Character', () => {
  it('has HP and Mana gauges', () => {
    const hero = new Character('Hero', { maxHp: 100, maxMana: 50, mana: 10 });
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.gauge('hp').current).toBe(100);
    expect(hero.gauge('mana').max).toBe(50);
    expect(hero.gauge('mana').current).toBe(10);
  });

  it('defaults mana to an empty gauge', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    expect(hero.gauge('mana').max).toBe(0);
    expect(hero.gauge('mana').current).toBe(0);
  });

  it('has a speed stat that defaults to DEFAULT_SPEED', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    expect(hero.speed).toBe(DEFAULT_SPEED);
  });

  it('takes its speed from the def', () => {
    const hero = new Character('Hero', { maxHp: 100, speed: 20 });
    expect(hero.speed).toBe(20);
  });

  it('skills sit in the same sorted list as buffs', () => {
    const hero = new Character('Hero', {
      maxHp: 100,
      skills: [skill({ name: 'Skill A', weight: 10 })],
    });
    hero.addBuff(new Buff(buff({ name: 'Buff B', weight: 2 })));
    hero.addBuff(new Buff(buff({ name: 'Buff C', weight: 7 })));
    expect(hero.statuses.map((s) => s.name)).toEqual(['Buff B', 'Buff C', 'Skill A']);
    expect(hero.buffs.map((b) => b.name)).toEqual(['Buff B', 'Buff C']);
    expect(hero.skills.map((s) => s.name)).toEqual(['Skill A']);
  });

  it('unions abilities from all statuses in status order', () => {
    const strike = cast({ name: 'Strike', targeting: { who: 'enemy' }, cast: () => [] });
    const bash = cast({ name: 'Bash', targeting: { who: 'enemy' }, cast: () => [] });
    const hero = new Character('Hero', {
      maxHp: 100,
      skills: [skill({ name: 'Fighter', weight: 2, abilities: [strike] })],
    });
    hero.addBuff(new Buff(buff({ name: 'Rage', weight: 1, abilities: [bash] })));
    expect(hero.abilities.map((a) => a.name)).toEqual(['Bash', 'Strike']);
    expect(hero.manualAbilities.map((a) => a.name)).toEqual(['Bash', 'Strike']);
  });

  it('tracks defeat — the HP gauge is the life gauge', () => {
    const hero = new Character('Hero', { maxHp: 10, hp: 10 });
    expect(hero.isDefeated).toBe(false);
    hero.gauge('hp').current = 0;
    expect(hero.isDefeated).toBe(true);
    // Mana hitting zero does NOT defeat — HP is the life gauge.
    const tough = new Character('Tough', { maxHp: 10, mana: 0 });
    expect(tough.isDefeated).toBe(false);
  });
});
