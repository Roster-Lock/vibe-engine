/**
 * Abilities, end to end: an English sentence, cast in a real arena, with an
 * assertion about what happened on the map.
 *
 * This is the layer that catches a compiler that produced plausible-looking
 * IR meaning the wrong thing — `language.test.ts` only says the IR has the
 * shape the grammar promised.
 */
import { describe, expect, it } from 'vitest';
import { arena, dummy } from './harness.js';

describe('targeting and areas', () => {
  it('hits only enemies inside the radius', () => {
    const a = arena(`
      Ability Thunder Clap
      Deal 100 damage to all enemy units within 300 range of this unit.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const near = a.spawn(dummy(), 2, { x: 200, y: 0 });
    const far = a.spawn(dummy(), 2, { x: 400, y: 0 });
    const ally = a.spawn(dummy(), 1, { x: 100, y: 0 });

    a.cast(caster, 'Thunder Clap');
    expect(near.hp).toBe(400);
    expect(far.hp).toBe(500);
    expect(ally.hp).toBe(500);
    expect(caster.hp).toBe(500);
  });

  it('excludes the caster from "all other ally units"', () => {
    const a = arena(`
      Ability Rally
      Targeting: no target
      Heal all other ally units within 500 range of this unit for 50.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const ally = a.spawn(dummy(), 1, { x: 100, y: 0 });
    a.world.dealDamage(caster, 100, undefined);
    a.world.dealDamage(ally, 100, undefined);

    a.cast(caster, 'Rally');
    expect(caster.hp).toBe(400);
    expect(ally.hp).toBe(450);
  });

  it('measures an area from the target point, not the caster', () => {
    const a = arena(`
      Ability Carrion Swarm
      Targeting: target point
      Range 900
      Deal 90 damage to all enemy units within 200 range of the target point.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const nearCaster = a.spawn(dummy(), 2, { x: 50, y: 0 });
    const atPoint = a.spawn(dummy(), 2, { x: 800, y: 0 });

    a.cast(caster, 'Carrion Swarm', { point: { x: 800, y: 0 } });
    expect(nearCaster.hp).toBe(500);
    expect(atPoint.hp).toBe(410);
  });

  it('refuses a cast beyond its range, spending nothing', () => {
    const a = arena(`
      Ability Storm Bolt
      Targeting: target enemy unit
      Cost 75 mana
      Range 300
      Deal 180 damage to the target.
    `);
    const caster = a.spawn(dummy({ maxMana: 200 }), 1, { x: 0, y: 0 });
    const target = a.spawn(dummy(), 2, { x: 900, y: 0 });

    expect(a.cast(caster, 'Storm Bolt', { unit: target })).toBe(false);
    expect(caster.mana).toBe(200);
    expect(target.hp).toBe(500);
  });

  it('refuses a cast on the wrong allegiance', () => {
    const a = arena(`
      Ability Storm Bolt
      Targeting: target enemy unit
      Range 900
      Deal 180 damage to the target.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const ally = a.spawn(dummy(), 1, { x: 100, y: 0 });
    expect(a.cast(caster, 'Storm Bolt', { unit: ally })).toBe(false);
  });
});

describe('costs and cooldowns', () => {
  it('pays mana and starts the cooldown, then refuses until it elapses', () => {
    const a = arena(`
      Ability Storm Bolt
      Targeting: target enemy unit
      Cooldown 5 seconds
      Cost 75 mana
      Range 900
      Deal 180 damage to the target.
    `);
    const caster = a.spawn(dummy({ maxMana: 200 }), 1, { x: 0, y: 0 });
    const target = a.spawn(dummy({ maxHp: 5000 }), 2, { x: 100, y: 0 });

    expect(a.cast(caster, 'Storm Bolt', { unit: target })).toBe(true);
    expect(caster.mana).toBe(125);
    expect(a.cast(caster, 'Storm Bolt', { unit: target })).toBe(false);

    a.world.run(5.1);
    expect(a.cast(caster, 'Storm Bolt', { unit: target })).toBe(true);
    expect(caster.mana).toBe(50);
    // Out of mana now, cooldown or not.
    a.world.run(5.1);
    expect(a.cast(caster, 'Storm Bolt', { unit: target })).toBe(false);
  });

  it('cannot cast while a buff forbids casting', () => {
    const a = arena(`
      Ability Zap
      Targeting: target enemy unit
      Range 900
      Deal 10 damage to the target.

      Ability Silence
      Add Silenced to this unit.

      Buff Silenced
      Duration 5 seconds
      Cannot cast.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const target = a.spawn(dummy(), 2, { x: 100, y: 0 });
    a.cast(caster, 'Silence');
    expect(a.cast(caster, 'Zap', { unit: target })).toBe(false);
  });
});

describe('filters', () => {
  it('measures a percentage threshold against each unit, not the caster', () => {
    const a = arena(`
      Ability Cull
      Kill all enemy units within 500 range of this unit with hp below 50%.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const hurt = a.spawn(dummy({ maxHp: 1000 }), 2, { x: 100, y: 0 });
    const healthy = a.spawn(dummy({ maxHp: 100 }), 2, { x: 100, y: 0 });
    a.world.dealDamage(hurt, 600, undefined); // 400/1000 — under half

    a.cast(caster, 'Cull');
    expect(hurt.alive).toBe(false);
    expect(healthy.alive).toBe(true);
  });

  it('applies a filter to a single named unit', () => {
    const a = arena(`
      Ability Execute
      Targeting: target enemy unit
      Range 900
      Kill the target with hp below 20%.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const healthy = a.spawn(dummy(), 2, { x: 100, y: 0 });

    a.cast(caster, 'Execute', { unit: healthy });
    expect(healthy.alive).toBe(true);

    a.world.dealDamage(healthy, 450, undefined); // 50/500 — under a fifth
    a.cast(caster, 'Execute', { unit: healthy });
    expect(healthy.alive).toBe(false);
  });

  it('filters on a buff the target carries', () => {
    const a = arena(`
      Ability Detonate
      Deal 100 damage to all enemy units within 500 range of this unit with marked.

      Ability Mark
      Targeting: target enemy unit
      Range 900
      Add Marked to the target.

      Buff Marked
      Duration 10 seconds
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const marked = a.spawn(dummy(), 2, { x: 100, y: 0 });
    const plain = a.spawn(dummy(), 2, { x: 100, y: 0 });

    a.cast(caster, 'Mark', { unit: marked });
    a.cast(caster, 'Detonate');
    expect(marked.hp).toBe(400);
    expect(plain.hp).toBe(500);
  });
});

describe('scaling amounts', () => {
  it('reads a percentage of the caster’s stat at cast time', () => {
    const a = arena(`
      Ability Smite
      Targeting: target enemy unit
      Range 900
      Deal damage equal to 50% of this unit's attack damage to the target.
    `);
    const caster = a.spawn(dummy({ attackDamage: 80 }), 1, { x: 0, y: 0 });
    const target = a.spawn(dummy(), 2, { x: 100, y: 0 });
    a.cast(caster, 'Smite', { unit: target });
    expect(target.hp).toBe(460);
  });

  it('sees a buff that changed the stat', () => {
    const a = arena(`
      Ability Smite
      Targeting: target enemy unit
      Range 900
      Deal damage equal to 50% of this unit's attack damage to the target.

      Ability Empower
      Add Empowered to this unit.

      Buff Empowered
      Duration 10 seconds
      Increase attack damage by 20.
    `);
    const caster = a.spawn(dummy({ attackDamage: 80 }), 1, { x: 0, y: 0 });
    const target = a.spawn(dummy(), 2, { x: 100, y: 0 });
    a.cast(caster, 'Empower');
    a.cast(caster, 'Smite', { unit: target });
    expect(target.hp).toBe(450); // 50% of 100
  });
});

describe('triggers', () => {
  it('retaliates against the attacker, and only the attacker', () => {
    const a = arena(`
      Ability Thorns Aura
      Whenever this unit takes damage, deal 25 damage to the attacker.
    `);
    const thorny = a.spawn(dummy({ abilities: ['thorns-aura'] }), 1, { x: 0, y: 0 });
    const attacker = a.spawn(dummy(), 2, { x: 100, y: 0 });
    const bystander = a.spawn(dummy(), 2, { x: 110, y: 0 });

    a.world.dealDamage(thorny, 30, attacker);
    expect(attacker.hp).toBe(475);
    expect(bystander.hp).toBe(500);
  });

  it('does not recurse forever when both sides retaliate', () => {
    const a = arena(`
      Ability Thorns Aura
      Whenever this unit takes damage, deal 25 damage to the attacker.
    `);
    const one = a.spawn(dummy({ abilities: ['thorns-aura'], maxHp: 10000 }), 1, { x: 0, y: 0 });
    const two = a.spawn(dummy({ abilities: ['thorns-aura'], maxHp: 10000 }), 2, { x: 100, y: 0 });
    a.world.dealDamage(one, 30, two);
    // Bounded by the world's trigger depth rather than blowing the stack.
    expect(one.alive && two.alive).toBe(true);
  });

  it('fires a kill trigger and heals only the hurt', () => {
    const a = arena(`
      Ability Feast
      Whenever this unit kills a unit, heal all ally units within 400 range of this unit with hp below 60% for 60.
    `);
    const hunter = a.spawn(dummy({ abilities: ['feast'] }), 1, { x: 0, y: 0 });
    const hurtAlly = a.spawn(dummy({ maxHp: 1000 }), 1, { x: 100, y: 0 });
    const healthyAlly = a.spawn(dummy(), 1, { x: 100, y: 0 });
    const prey = a.spawn(dummy({ maxHp: 10 }), 2, { x: 100, y: 0 });
    a.world.dealDamage(hurtAlly, 600, undefined);

    a.world.dealDamage(prey, 50, hunter);
    expect(hurtAlly.hp).toBe(460);
    expect(healthyAlly.hp).toBe(500);
  });
});

describe('time', () => {
  it('delays an effect by the stated seconds', () => {
    const a = arena(`
      Ability Delayed Blast
      Targeting: target point
      Range 900
      After 2 seconds, deal 260 damage to all enemy units within 180 range of the target point.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const target = a.spawn(dummy({ maxHp: 1000 }), 2, { x: 100, y: 0 });

    a.cast(caster, 'Delayed Blast', { point: { x: 100, y: 0 } });
    a.world.run(1.5);
    expect(target.hp).toBe(1000);
    a.world.run(1);
    expect(target.hp).toBe(740);
  });

  it('repeats an ability cadence for exactly its duration', () => {
    const a = arena(`
      Ability Regrowth
      Targeting: target ally unit
      Range 900
      Every 1 second for 5 seconds, heal the target for 10.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const ally = a.spawn(dummy({ maxHp: 1000 }), 1, { x: 100, y: 0 });
    a.world.dealDamage(ally, 500, undefined);

    a.cast(caster, 'Regrowth', { unit: ally });
    a.world.run(10);
    expect(ally.hp).toBe(550); // five ticks of 10
  });

  it('runs a buff cadence for the buff’s duration and credits its source', () => {
    const a = arena(`
      Ability Poison Sting
      Targeting: target enemy unit
      Range 900
      Add Poisoned to the target.

      Buff Poisoned (stacks)
      Duration 3 seconds
      Every 1 second, deal 10 damage to this unit.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const target = a.spawn(dummy(), 2, { x: 100, y: 0 });

    a.cast(caster, 'Poison Sting', { unit: target });
    a.world.run(10);
    expect(target.hp).toBe(470); // three ticks before it expires
    // The tick is credited to whoever applied the poison, not the victim.
    expect(a.world.log.some((entry) => entry.text.startsWith('Dummy#1 deals 10 spell damage to Dummy#2'))).toBe(true);
  });

  it('stops a cadence when the caster dies', () => {
    const a = arena(`
      Ability Regrowth
      Targeting: target ally unit
      Range 900
      Every 1 second for 10 seconds, heal the target for 10.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const ally = a.spawn(dummy({ maxHp: 1000 }), 1, { x: 100, y: 0 });
    a.world.dealDamage(ally, 500, undefined);

    a.cast(caster, 'Regrowth', { unit: ally });
    a.world.run(2.5);
    const healedSoFar = ally.hp;
    a.world.kill(caster, undefined);
    a.world.run(10);
    expect(ally.hp).toBe(healedSoFar);
  });
});

describe('movement effects', () => {
  it('summons on the caster’s team near an anchor', () => {
    const skeleton = dummy({ id: 'skeleton-warrior', name: 'Skeleton Warrior', maxHp: 180 });
    const a = arena(
      `
      Ability Raise Dead
      Summon 2 Skeleton Warrior near this unit.
      `,
      { units: [skeleton] },
    );
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    a.cast(caster, 'Raise Dead');

    const summoned = a.world.livingUnits().filter((unit) => unit.def.id === 'skeleton-warrior');
    expect(summoned).toHaveLength(2);
    expect(summoned.every((unit) => unit.team === 1)).toBe(true);
    expect(summoned[0]!.pos).not.toEqual(summoned[1]!.pos);
  });

  it('teleports the caster to the target point', () => {
    const a = arena(`
      Ability Blink
      Targeting: target point
      Range 900
      Teleport this unit to the target point.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    a.cast(caster, 'Blink', { point: { x: 600, y: 0 } });
    expect(caster.pos).toEqual({ x: 600, y: 0 });
  });

  it('pushes units away from the caster', () => {
    const a = arena(`
      Ability War Stomp
      Push all enemy units within 250 range of this unit back 100 units.
    `);
    const caster = a.spawn(dummy(), 1, { x: 0, y: 0 });
    const victim = a.spawn(dummy(), 2, { x: 100, y: 0 });
    a.cast(caster, 'War Stomp');
    expect(victim.pos.x).toBeCloseTo(200, 5);
  });
});
