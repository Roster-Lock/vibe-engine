/**
 * Test harness: a tiny arena, so a test can say "two units, this ability,
 * what happened" without repeating the wiring.
 */
import { compileDocument } from '../src/english/compile.js';
import { AbilityRuntime, type CompiledAbility } from '../src/english/runtime.js';
import type { Program } from '../src/ir.js';
import { combatBehavior } from '../src/sim/ai.js';
import { Unit, resetUnitIds, type UnitDef } from '../src/sim/unit.js';
import { World } from '../src/sim/world.js';
import type { Vec2 } from '../src/sim/vec.js';

/** A plain melee body with no abilities — the thing tests push around. */
export function dummy(overrides: Partial<UnitDef> = {}): UnitDef {
  return {
    id: 'dummy',
    name: 'Dummy',
    maxHp: 500,
    hpRegen: 0,
    maxMana: 200,
    manaRegen: 0,
    armor: 0,
    moveSpeed: 300,
    attackDamage: 10,
    attackRange: 90,
    attackCooldown: 1,
    acquisitionRange: 600,
    radius: 30,
    abilities: [],
    ...overrides,
  };
}

export interface Arena {
  readonly world: World;
  readonly runtime: AbilityRuntime;
  readonly program: Program;
  spawn(def: UnitDef, team: number, pos: Vec2): Unit;
  /** Casts by ability name, failing loudly if the name is unknown. */
  cast(caster: Unit, abilityName: string, target?: { unit?: Unit; point?: Vec2 }): boolean;
}

export interface ArenaOptions {
  readonly units?: readonly UnitDef[];
  readonly compiled?: readonly CompiledAbility[];
  /** Adds the combat AI. Off by default so a test drives casts itself. */
  readonly withAi?: boolean;
}

/** Compiles `source`, asserts it is error-free, and returns a live arena. */
export function arena(source: string, options: ArenaOptions = {}): Arena {
  resetUnitIds();
  const result = compileDocument(source, { units: (options.units ?? []).map((def) => def.id) });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`arena source has errors:\n${errors.map((e) => `  ${e.code}: ${e.message}`).join('\n')}`);
  }

  const runtime = new AbilityRuntime(result.program, { units: options.units, compiled: options.compiled });
  const world = new World({
    seed: 7,
    hooks: {
      onEvent: runtime.onEvent,
      onPeriodic: runtime.onPeriodic,
      ...(options.withAi ? { behavior: combatBehavior(runtime) } : {}),
    },
  });

  return {
    world,
    runtime,
    program: result.program,
    spawn: (def, team, pos) => world.spawn(def, team, pos),
    cast(caster, abilityName, target = {}) {
      const ability = result.program.abilities.find((candidate) => candidate.name === abilityName);
      if (!ability) throw new Error(`no ability named "${abilityName}"`);
      return runtime.cast(world, caster, ability, target);
    },
  };
}
