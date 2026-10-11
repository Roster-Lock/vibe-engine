/**
 * The default unit behavior — enough of a Warcraft 3 AI to make a battle
 * readable, and no more.
 *
 * Each tick a unit, in priority order:
 *
 * 1. casts the first ability it can afford that has something worth
 *    aiming at;
 * 2. attacks whatever it is already fighting, if that is still in range;
 * 3. otherwise closes on the nearest enemy.
 *
 * The interesting part is **how a target is chosen**, because the AI does
 * not know what any ability does — abilities are content, written in
 * English by a creator who has never heard of this file. So the AI reads
 * the compiled IR: an ability with a `damage` node is offensive and wants
 * enemies; one with only `heal` nodes is defensive and wants a hurt ally;
 * the radius it aims with is the largest area its own effects mention. A
 * creator gets sensible targeting for free, without registering anything.
 */
import type { AbilityProgram, EffectNode, UnitQuery } from '../ir.js';
import type { AbilityRuntime, CastTarget } from '../english/runtime.js';
import type { Unit } from './unit.js';
import { distance, type Vec2 } from './vec.js';
import type { World } from './world.js';

/** Cast a defensive no-target ability once the caster is this hurt. */
const DEFENSIVE_HP_SHARE = 0.55;
/** Cast a healing ability on an ally missing at least this share of its hp. */
const HEAL_HP_SHARE = 0.75;

/** Builds the per-unit behavior hook a `World` runs each tick. */
export function combatBehavior(runtime: AbilityRuntime): (unit: Unit, world: World) => void {
  return (unit, world) => {
    if (!unit.alive) return;
    if (tryCast(runtime, world, unit)) return;

    const target = acquire(world, unit);
    if (!target) return;
    unit.attackTarget = target;

    const reach = unit.def.attackRange + unit.def.radius + target.def.radius;
    if (distance(unit.pos, target.pos) <= reach) {
      autoAttack(world, unit, target);
      return;
    }
    world.moveUnit(unit, target.pos);
  };
}

/** Swings if the attack cooldown has elapsed and nothing forbids it. */
function autoAttack(world: World, unit: Unit, target: Unit): void {
  if (!unit.can('attack') || world.time < unit.nextAttackAt) return;
  unit.nextAttackAt = world.time + unit.attackCooldown;
  world.emit({ kind: 'attacks', attacker: unit, victim: target });
  world.dealDamage(target, unit.attackDamage, unit, 'attack damage');
}

/** Keeps the current target while it lives; otherwise finds the closest enemy. */
function acquire(world: World, unit: Unit): Unit | undefined {
  const current = unit.attackTarget;
  if (current?.alive) return current;
  // Nothing nearby is still worth walking to: units converge rather than
  // standing idle on opposite sides of the map.
  return world.nearestEnemy(unit, unit.def.acquisitionRange) ?? world.nearestEnemy(unit, Infinity);
}

/** Tries each known ability in order; returns true once one is cast. */
function tryCast(runtime: AbilityRuntime, world: World, unit: Unit): boolean {
  for (const id of unit.def.abilities) {
    const ability = runtime.ability(id);
    if (!ability || ability.targeting === undefined) continue;
    if (ability.effects.length === 0) continue; // a passive — nothing to cast
    if (!runtime.ready(world, unit, ability)) continue;
    const target = pickTarget(world, unit, ability);
    if (!target) continue;
    if (runtime.cast(world, unit, ability, target)) return true;
  }
  return false;
}

/** How far a cast may reach, falling back to what the unit can see. */
function reachOf(unit: Unit, ability: AbilityProgram): number {
  return ability.castRange > 0 ? ability.castRange : unit.def.acquisitionRange;
}

/**
 * Picks something to aim at, or `undefined` when the ability is not worth
 * casting right now.
 */
function pickTarget(world: World, unit: Unit, ability: AbilityProgram): CastTarget | undefined {
  const reach = reachOf(unit, ability);
  switch (ability.targeting) {
    case 'none':
      return worthCastingInPlace(world, unit, ability) ? {} : undefined;
    case 'enemyUnit':
      return wrap(world.nearestEnemy(unit, reach));
    case 'allyUnit':
      return wrap(mostWounded(world, unit, reach));
    case 'unit':
      return isOffensive(ability.effects)
        ? wrap(world.nearestEnemy(unit, reach))
        : wrap(mostWounded(world, unit, reach));
    case 'point': {
      const point = bestCluster(world, unit, reach, areaRadius(ability.effects) || 200);
      return point ? { point } : undefined;
    }
  }
}

function wrap(target: Unit | undefined): CastTarget | undefined {
  return target ? { unit: target } : undefined;
}

/**
 * A no-target ability fires when its own area would catch someone: enemies
 * for an offensive one, a hurt caster for a defensive one.
 */
function worthCastingInPlace(world: World, unit: Unit, ability: AbilityProgram): boolean {
  if (isOffensive(ability.effects)) {
    const radius = areaRadius(ability.effects) || unit.def.attackRange;
    return world.unitsWithin(unit.pos, radius, (other) => world.isEnemy(unit, other)).length > 0;
  }
  return unit.hp < unit.maxHp * DEFENSIVE_HP_SHARE;
}

/** The most hurt ally in range that is actually missing health. */
function mostWounded(world: World, unit: Unit, reach: number): Unit | undefined {
  let best: Unit | undefined;
  let worstShare = HEAL_HP_SHARE;
  for (const other of world.unitsWithin(unit.pos, reach, (candidate) => world.isAlly(unit, candidate))) {
    const share = other.hp / other.maxHp;
    if (share < worstShare) {
      best = other;
      worstShare = share;
    }
  }
  return best;
}

/**
 * The enemy position with the most enemies around it — a cheap "aim at the
 * clump" heuristic that makes a point-targeted area spell look deliberate.
 */
function bestCluster(world: World, unit: Unit, reach: number, radius: number): Vec2 | undefined {
  const candidates = world.unitsWithin(unit.pos, reach, (other) => world.isEnemy(unit, other));
  let best: Vec2 | undefined;
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = world.unitsWithin(candidate.pos, radius, (other) => world.isEnemy(unit, other)).length;
    if (count > bestCount) {
      best = candidate.pos;
      bestCount = count;
    }
  }
  return best;
}

/** True when any effect in the tree hurts something. */
function isOffensive(effects: readonly EffectNode[]): boolean {
  return effects.some((effect) => {
    switch (effect.kind) {
      case 'damage':
      case 'kill':
      case 'knockback':
        return true;
      case 'after':
      case 'every':
        return isOffensive(effect.body);
      default:
        return false;
    }
  });
}

/** The largest area radius mentioned anywhere in the effect tree. */
function areaRadius(effects: readonly EffectNode[]): number {
  let largest = 0;
  const visit = (nodes: readonly EffectNode[]): void => {
    for (const effect of nodes) {
      if ('units' in effect) largest = Math.max(largest, radiusOf(effect.units));
      if (effect.kind === 'after' || effect.kind === 'every') visit(effect.body);
    }
  };
  visit(effects);
  return largest;
}

/** The radius of a query, seeing through any `with …` filter wrapping it. */
function radiusOf(query: UnitQuery): number {
  if (query.kind === 'area') return query.radius;
  if (query.kind === 'filtered') return radiusOf(query.units);
  return 0;
}
