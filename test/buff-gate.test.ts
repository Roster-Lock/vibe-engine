/**
 * Conditional buff gates (GaugeBuffGate) — "keep this buff attached exactly
 * while the gauge's value matches the condition". Two-way and reversible:
 * apply when the condition turns true, remove when it turns false, no-op
 * otherwise. Composes with the derived-stat system ("stamina low → Tired →
 * speed halved") and with extra gauges (CharacterDef.gauges).
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  Gauge,
  Player,
  buff,
  stat,
  type Decision,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

/** A player that never acts on its own. */
class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

function player(name: string, characters: Character[], team: string): TestPlayer {
  return new TestPlayer(name, characters, team);
}

/** Two teams, so a single living hero does not end the game on its own. */
function makeEngine(hero: Character): GameEngine {
  const dummy = new Character('Dummy', { maxHp: 50 });
  const engine = createEngine();
  engine.registerPlayers([player('Hero', [hero], 'party'), player('Monsters', [dummy], 'monsters')]);
  return engine;
}

/** The stamina gauge with the Tired gate: attach Tired below 20% stamina. */
const tired = buff({
  name: 'Tired',
  weight: 1,
  abilities: [stat({ name: 'Tired', stat: 'speed', multiply: 0.5 })],
});

function staminaHero(): { hero: Character; stamina: Gauge } {
  const stamina = new Gauge('stamina', 100, {
    buffGates: [{ name: 'Tired Gate', when: (g) => g.current <= g.max * 0.2, buff: tired }],
  });
  const hero = new Character('Hero', { maxHp: 100, gauges: [stamina] });
  return { hero, stamina };
}

describe('buff gates on an extra gauge (stamina)', () => {
  it('attaches the buff when the gauge crosses the threshold, halving derived speed', async () => {
    const { hero, stamina } = staminaHero();
    const engine = makeEngine(hero);
    expect(hero.gauges).toContain(stamina); // the extra gauge is in the collection
    expect(engine.characterOf(stamina)).toBe(hero);

    expect(hero.hasStatus('tired')).toBe(false);
    expect(hero.speed).toBe(10); // DEFAULT_SPEED, unchanged

    await engine.damage(stamina, 85, hero); // 100 -> 15 (≤ 20%): gate opens
    expect(hero.hasStatus('tired')).toBe(true);
    expect(hero.speed).toBe(5); // the Tired stat contribution halved it
  });

  it('removes the buff when the gauge recovers past the threshold', async () => {
    const { hero, stamina } = staminaHero();
    const engine = makeEngine(hero);

    await engine.damage(stamina, 85, hero); // 15: Tired on
    expect(hero.hasStatus('tired')).toBe(true);

    await engine.heal(stamina, 10, hero); // 25 (> 20%): gate closes
    expect(hero.hasStatus('tired')).toBe(false);
    expect(hero.speed).toBe(10);
  });

  it('does not re-apply while the condition keeps holding (no-op transitions)', async () => {
    const { hero, stamina } = staminaHero();
    const engine = makeEngine(hero);

    await engine.damage(stamina, 85, hero); // 15: Tired attaches once
    await engine.damage(stamina, 5, hero); // 10: still low — no re-application
    expect(hero.buffs.filter((b) => b.id === 'tired')).toHaveLength(1);

    // The buff survives being re-written above and below the threshold again.
    await engine.heal(stamina, 10, hero); // 20: exactly at 20% — still holds
    expect(hero.hasStatus('tired')).toBe(true);
    await engine.heal(stamina, 1, hero); // 21: past it — removed
    expect(hero.hasStatus('tired')).toBe(false);
  });

  it('removing the gate stops future transitions (the attached buff stays as-is)', async () => {
    const { hero, stamina } = staminaHero();
    const engine = makeEngine(hero);
    const gate = hero.gauges.find((g) => g.id === 'stamina')!;

    await engine.damage(stamina, 85, hero); // 15: Tired on
    expect(hero.hasStatus('tired')).toBe(true);
    expect(gate.removeBuffGate('Tired Gate')).toBe(true);
    expect(gate.buffGates).toHaveLength(0);

    // Recovers past the threshold — the removed gate does nothing.
    await engine.heal(stamina, 20, hero); // 35
    expect(hero.hasStatus('tired')).toBe(true); // still attached (gate gone)
  });
});

describe('buff gates on a built-in gauge (HP)', () => {
  it('enrages below 30% HP and calms down on recovery', async () => {
    const enraged = buff({
      name: 'Enraged',
      weight: 1,
      abilities: [stat({ name: 'Enraged', stat: 'power', add: 5 })],
    });
    const hero = new Character('Hero', {
      maxHp: 100,
      stats: { power: 2 },
      gauges: [],
    });
    hero.gauge('hp').addBuffGate({ name: 'Berserk Gate', when: (g) => g.current <= g.max * 0.3, buff: enraged });
    const engine = makeEngine(hero);

    expect(hero.stat('power')).toBe(2);
    await engine.damage(hero.gauge('hp'), 75, hero); // hp 25 (≤ 30%): enraged
    expect(hero.hasStatus('enraged')).toBe(true);
    expect(hero.stat('power')).toBe(7);

    await engine.heal(hero.gauge('hp'), 30, hero); // hp 55: calm
    expect(hero.hasStatus('enraged')).toBe(false);
    expect(hero.stat('power')).toBe(2);
  });
});

describe('gauge API', () => {
  it('rejects duplicate gate names and reports unknown removals', () => {
    const stamina = new Gauge('stamina', 100);
    const gate = { name: 'X', when: () => false, buff: buff({ name: 'X', weight: 1 }) };
    stamina.addBuffGate(gate);
    expect(() => stamina.addBuffGate({ ...gate })).toThrow(/already attached/i);
    expect(stamina.removeBuffGate('Nope')).toBe(false);
    expect(stamina.removeBuffGate('X')).toBe(true);
    expect(stamina.buffGates).toHaveLength(0);
  });
});
