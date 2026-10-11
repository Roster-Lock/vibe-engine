/**
 * The simulation itself: the verbs, the derived stats, and the tick loop.
 * These hold whether or not an ability ever gets compiled.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { armorMultiplier, resetUnitIds } from '../src/sim/unit.js';
import { World } from '../src/sim/world.js';
import { distance, moveToward, normalize } from '../src/sim/vec.js';
import { createRng } from '../src/sim/rng.js';
import { dummy } from './harness.js';

beforeEach(() => resetUnitIds());

describe('vectors', () => {
  it('clamps a step so a unit lands on its destination', () => {
    expect(moveToward({ x: 0, y: 0 }, { x: 10, y: 0 }, 100)).toEqual({ x: 10, y: 0 });
    expect(moveToward({ x: 0, y: 0 }, { x: 10, y: 0 }, 4)).toEqual({ x: 4, y: 0 });
  });

  it('normalizes a zero vector to zero instead of NaN', () => {
    expect(normalize({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('rng', () => {
  it('is a pure function of its seed', () => {
    const a = createRng(99);
    const b = createRng(99);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });
});

describe('damage', () => {
  it('reduces damage by armor on the Warcraft curve', () => {
    expect(armorMultiplier(0)).toBe(1);
    expect(armorMultiplier(5)).toBeCloseTo(0.7692, 3);
    // Negative armor amplifies.
    expect(armorMultiplier(-5)).toBeGreaterThan(1);
  });

  it('applies armor and reports what actually landed', () => {
    const world = new World();
    const target = world.spawn(dummy({ armor: 5 }), 2, { x: 0, y: 0 });
    const dealt = world.dealDamage(target, 100, undefined);
    expect(dealt).toBeCloseTo(76.92, 1);
    expect(target.hp).toBeCloseTo(500 - dealt, 5);
  });

  it('kills exactly once, emitting one death event', () => {
    const deaths: string[] = [];
    const world = new World({ hooks: { onEvent: (event) => event.kind === 'died' && deaths.push(event.victim.label) } });
    const target = world.spawn(dummy({ maxHp: 10 }), 2, { x: 0, y: 0 });
    world.dealDamage(target, 100, undefined);
    world.dealDamage(target, 100, undefined);
    world.kill(target, undefined);
    expect(deaths).toEqual(['Dummy#1']);
    expect(target.alive).toBe(false);
  });

  it('never heals past the maximum', () => {
    const world = new World();
    const unit = world.spawn(dummy(), 1, { x: 0, y: 0 });
    world.dealDamage(unit, 50, undefined);
    expect(world.healUnit(unit, 1000, undefined)).toBe(50);
    expect(unit.hp).toBe(unit.maxHp);
  });
});

describe('buffs', () => {
  const slow = {
    id: 'slowed',
    name: 'Slowed',
    duration: 2,
    stacks: false,
    modifiers: [{ stat: 'moveSpeed', mode: 'percent', amount: -50 }],
    restrictions: [],
    triggers: [],
    periodic: [],
  } as const;

  it('derives a stat rather than writing it, and restores it on expiry', () => {
    const world = new World();
    const unit = world.spawn(dummy({ moveSpeed: 300 }), 1, { x: 0, y: 0 });
    world.applyBuff(unit, slow, undefined);
    expect(unit.moveSpeed).toBe(150);
    world.run(3);
    expect(unit.hasBuff('slowed')).toBe(false);
    expect(unit.moveSpeed).toBe(300);
  });

  it('adds percentages together rather than compounding them', () => {
    const world = new World();
    const unit = world.spawn(dummy({ moveSpeed: 300 }), 1, { x: 0, y: 0 });
    world.applyBuff(unit, slow, undefined);
    world.applyBuff(unit, { ...slow, id: 'chilled', name: 'Chilled' }, undefined);
    // Two 50% slows stop the unit; they do not leave it at 25%.
    expect(unit.moveSpeed).toBe(0);
  });

  it('stacks only when the buff says it stacks', () => {
    const world = new World();
    const unit = world.spawn(dummy(), 1, { x: 0, y: 0 });
    world.applyBuff(unit, slow, undefined);
    world.applyBuff(unit, slow, undefined);
    expect(unit.buffInstance('slowed')!.stacks).toBe(1);

    const poison = { ...slow, id: 'poisoned', name: 'Poisoned', stacks: true };
    world.applyBuff(unit, poison, undefined);
    world.applyBuff(unit, poison, undefined);
    expect(unit.buffInstance('poisoned')!.stacks).toBe(2);
  });

  it('forbids what a restriction forbids', () => {
    const world = new World();
    const unit = world.spawn(dummy(), 1, { x: 0, y: 0 });
    const stun = { ...slow, id: 'stunned', name: 'Stunned', modifiers: [], restrictions: ['move', 'attack'] } as const;
    world.applyBuff(unit, stun, undefined);
    expect(unit.can('move')).toBe(false);
    expect(unit.can('cast')).toBe(true);
    world.moveUnit(unit, { x: 500, y: 0 });
    expect(unit.pos).toEqual({ x: 0, y: 0 });
  });
});

describe('the tick loop', () => {
  it('runs a scheduled callback once, on a later tick', () => {
    const world = new World();
    let fired = 0;
    world.schedule(0.5, () => (fired += 1));
    world.run(0.4);
    expect(fired).toBe(0);
    world.run(0.3);
    expect(fired).toBe(1);
    world.run(5);
    expect(fired).toBe(1);
  });

  it('pushes overlapping units apart', () => {
    const world = new World();
    const a = world.spawn(dummy({ radius: 30 }), 1, { x: 0, y: 0 });
    const b = world.spawn(dummy({ radius: 30 }), 1, { x: 0, y: 0 });
    world.tick();
    expect(distance(a.pos, b.pos)).toBeGreaterThan(0);
  });

  it('reports the teams still standing', () => {
    const world = new World();
    world.spawn(dummy(), 1, { x: 0, y: 0 });
    const enemy = world.spawn(dummy(), 2, { x: 100, y: 0 });
    expect(world.livingTeams()).toEqual([1, 2]);
    world.kill(enemy, undefined);
    expect(world.livingTeams()).toEqual([1]);
  });
});
