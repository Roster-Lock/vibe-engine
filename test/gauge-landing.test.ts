/**
 * `Character.handleDamage` / `Character.handleHeal` — how a change lands on
 * one kind of thing, asked once at the very end.
 *
 * Both hooks run at the gauge-settlement write point, after every passive
 * modifier, the restrictions gate and the `intent` floor. These tests pin
 * that position down: what they see has already been modified, what they
 * return is applied as-is rather than flowing back through the pipeline,
 * and the gauge's own bounds still clamp it afterwards.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  Player,
  createEngine,
  passiveActionModifier,
  type GaugeLanding,
  type GaugeLandingWrite,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';

class Idle extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** A permanent type whose `ward` gauge soaks damage before its life does. */
class Warded extends Character {
  calls = 0;
  override handleDamage(info: GaugeLanding): readonly GaugeLandingWrite[] | undefined {
    this.calls += 1;
    const ward = this.findGauge('ward');
    if (!ward || ward.current <= 0) return undefined;
    const incoming = -info.delta; // positive points of damage
    const soaked = Math.min(ward.current, incoming);
    return [
      { gauge: ward, delta: -soaked },
      { gauge: info.gauge, delta: -(incoming - soaked) },
    ];
  }
}

function board(target: Character, events?: GameEvent[]) {
  const hero = new Character('Hero', { maxHp: 30 });
  hero.team = 'party';
  target.team = 'foes';
  const engine = createEngine({
    seed: 'handle-damage',
    ...(events ? { onEvent: (e: GameEvent) => events.push(e) } : {}),
  });
  engine.registerPlayers([new Idle('You', [hero], 'party'), new Idle('Them', [target], 'foes')]);
  return { engine, hero };
}

function warded(ward: number, life: number): Warded {
  return new Warded('Jace', {
    gauges: [
      { id: 'loyalty', max: life },
      { id: 'ward', max: ward },
    ],
    lifeGauge: 'loyalty',
  });
}

describe('Character.handleDamage', () => {
  it('routes the landing: ward soaks first, life takes the rest', async () => {
    const jace = warded(4, 10);
    const { engine, hero } = board(jace);
    await engine.damage(jace.gauge('loyalty'), 10, hero);
    expect(jace.gauge('ward').current).toBe(0);
    expect(jace.gauge('loyalty').current).toBe(4); // 10 - (10 - 4 soaked)
  });

  it('sees an amount the modifiers already changed', async () => {
    // The hook is the *end* of the pipeline, not a replacement for it: a
    // passive that adds 5 has already run by the time it is asked.
    const jace = warded(4, 20);
    const { engine, hero } = board(jace);
    await engine.addBuff(
      hero,
      {
        name: 'Rage',
        weight: 1,
        abilities: [
          passiveActionModifier({
            name: 'Rage',
            transform: (action) =>
              action.type === 'gauge' && action.direction === 'outgoing'
                ? { ...action, update: (cur, max) => action.update(cur, max) - 5 }
                : action,
          }),
        ],
      },
    );
    await engine.damage(jace.gauge('loyalty'), 10, hero);
    expect(jace.gauge('ward').current).toBe(0);
    expect(jace.gauge('loyalty').current).toBe(9); // 20 - (15 - 4)
  });

  it('takes the default when it returns undefined', async () => {
    const jace = warded(0, 10); // no ward left — the override bows out
    const { engine, hero } = board(jace);
    await engine.damage(jace.gauge('loyalty'), 3, hero);
    expect(jace.gauge('loyalty').current).toBe(7);
  });

  it('is asked once per write, and what it returns does not re-enter', async () => {
    const jace = warded(4, 10);
    const { engine, hero } = board(jace);
    await engine.damage(jace.gauge('loyalty'), 2, hero);
    expect(jace.calls).toBe(1); // not re-entered by its own writes
    expect(jace.gauge('ward').current).toBe(2);
    expect(jace.gauge('loyalty').current).toBe(10);
  });

  it('emits gauge:changed for a gauge the batch never aimed at', async () => {
    const jace = warded(4, 10);
    const events: GameEvent[] = [];
    const { engine, hero } = board(jace, events);
    await engine.damage(jace.gauge('loyalty'), 3, hero);
    const touched = events
      .filter((e): e is Extract<GameEvent, { type: 'gauge:changed' }> => e.type === 'gauge:changed')
      .map((e) => e.gauge.id);
    expect(touched).toContain('ward'); // the hook's own write is a real, reported change
  });

  it('does not route healing to the damage hook', async () => {
    const jace = warded(4, 10);
    const { engine, hero } = board(jace);
    jace.gauge('loyalty').current = 5;
    await engine.heal(jace.gauge('loyalty'), 3, hero);
    expect(jace.calls).toBe(0); // `handleDamage` only sees `intent: 'damage'`
    expect(jace.gauge('loyalty').current).toBe(8);
    expect(jace.gauge('ward').current).toBe(4);
  });

  it('a plain character routes nothing — the default hook is a no-op', async () => {
    const plain = new Character('Plain', { maxHp: 20 });
    const { engine, hero } = board(plain);
    await engine.damage(plain.gauge('hp'), 6, hero);
    expect(plain.gauge('hp').current).toBe(14);
  });
});

/** A permanent type whose healing overflows into its ward instead of being lost. */
class Overflowing extends Character {
  healCalls = 0;
  override handleHeal(info: GaugeLanding): readonly GaugeLandingWrite[] | undefined {
    this.healCalls += 1;
    const ward = this.findGauge('ward');
    if (!ward) return undefined;
    const room = info.gauge.max - info.gauge.current;
    const spill = info.delta - room;
    if (spill <= 0) return undefined; // it all fits — nothing to route
    return [
      { gauge: info.gauge, delta: room },
      { gauge: ward, delta: spill },
    ];
  }
}

function overflowing(ward: number, life: number, current: number): Overflowing {
  return new Overflowing('Oracle', {
    gauges: [
      { id: 'loyalty', max: life, current },
      { id: 'ward', max: ward, current: 0 },
    ],
    lifeGauge: 'loyalty',
  });
}

describe('Character.handleHeal', () => {
  it('routes the overflow: life fills, the rest spills into ward', async () => {
    const oracle = overflowing(5, 10, 8); // 2 short of full
    const { engine, hero } = board(oracle);
    await engine.heal(oracle.gauge('loyalty'), 6, hero);
    expect(oracle.gauge('loyalty').current).toBe(10); // filled
    expect(oracle.gauge('ward').current).toBe(4); // the other 4 kept
  });

  it('takes the default when it all fits', async () => {
    const oracle = overflowing(5, 10, 2);
    const { engine, hero } = board(oracle);
    await engine.heal(oracle.gauge('loyalty'), 3, hero);
    expect(oracle.healCalls).toBe(1); // asked...
    expect(oracle.gauge('loyalty').current).toBe(5); // ...and bowed out
    expect(oracle.gauge('ward').current).toBe(0);
  });

  it('is not asked for damage, and the gauge clamp still applies after it', async () => {
    const oracle = overflowing(5, 10, 8);
    const { engine, hero } = board(oracle);
    await engine.damage(oracle.gauge('loyalty'), 3, hero);
    expect(oracle.healCalls).toBe(0);
    expect(oracle.gauge('loyalty').current).toBe(5);
    // A write the hook returns is still clamped to the gauge's bounds.
    await engine.heal(oracle.gauge('loyalty'), 100, hero);
    expect(oracle.gauge('loyalty').current).toBe(10);
    expect(oracle.gauge('ward').current).toBe(5); // capped at its own max
  });
});
