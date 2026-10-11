/**
 * Wiring: a `World`, an `AbilityRuntime`, and the AI, connected.
 *
 * Worth reading for one line — `compiled`. Pass the generated closures from
 * `src/generated/abilities.gen.ts` and the battle runs those; leave it out
 * and the battle interprets the IR. Everything else is identical, which is
 * what makes the two paths comparable (`test/equivalence.test.ts`).
 */
import { AbilityRuntime, type CompiledAbility } from './english/runtime.js';
import type { Program } from './ir.js';
import { combatBehavior } from './sim/ai.js';
import type { UnitDef } from './sim/unit.js';
import { World } from './sim/world.js';
import { FOOTMAN, GRUNT, HEADHUNTER, MOUNTAIN_GIANT, MOUNTAIN_KING, SHADOW_HUNTER, UNITS } from './content/units.js';

export interface BattleOptions {
  readonly seed?: number;
  /** Unit types available to spawn and to summon. */
  readonly units?: readonly UnitDef[];
  /** Generated ability closures to run instead of interpreting the IR. */
  readonly compiled?: readonly CompiledAbility[];
}

export interface Battle {
  readonly world: World;
  readonly runtime: AbilityRuntime;
}

export function createBattle(program: Program, options: BattleOptions = {}): Battle {
  const runtime = new AbilityRuntime(program, {
    units: options.units ?? UNITS,
    compiled: options.compiled,
  });
  const world = new World({
    seed: options.seed ?? 20250926,
    hooks: {
      onEvent: runtime.onEvent,
      onPeriodic: runtime.onPeriodic,
      behavior: combatBehavior(runtime),
    },
  });
  return { world, runtime };
}

/** Team numbers, so logs and assertions read as sides rather than integers. */
export const ALLIANCE = 1;
export const HORDE = 2;

/**
 * The demo skirmish: a hero and a line of troops per side, facing off
 * across the map. Positions are fixed rather than random — a reader should
 * be able to re-run the demo and see the same battle.
 */
export function deployArmies(battle: Battle): void {
  const { world } = battle;
  const line = (count: number, index: number): number => (index - (count - 1) / 2) * 90;

  world.spawn(MOUNTAIN_KING, ALLIANCE, { x: -640, y: 0 });
  world.spawn(MOUNTAIN_GIANT, ALLIANCE, { x: -540, y: 140 });
  for (let i = 0; i < 4; i += 1) world.spawn(FOOTMAN, ALLIANCE, { x: -480, y: line(4, i) });

  world.spawn(SHADOW_HUNTER, HORDE, { x: 640, y: 0 });
  for (let i = 0; i < 2; i += 1) world.spawn(HEADHUNTER, HORDE, { x: 560, y: line(2, i) - 140 });
  for (let i = 0; i < 3; i += 1) world.spawn(GRUNT, HORDE, { x: 480, y: line(3, i) });
}

export interface BattleResult {
  /** The single surviving team, or `undefined` for a draw or a timeout. */
  readonly winner: number | undefined;
  readonly elapsed: number;
  readonly timedOut: boolean;
  readonly survivors: readonly string[];
}

/** Runs until one team is left standing, or `maxSeconds` of sim time elapse. */
export function runBattle(battle: Battle, maxSeconds = 120): BattleResult {
  const { world } = battle;
  while (world.time < maxSeconds && world.livingTeams().length > 1) world.tick();
  const teams = world.livingTeams();
  return {
    winner: teams.length === 1 ? teams[0] : undefined,
    elapsed: world.time,
    timedOut: world.time >= maxSeconds,
    survivors: world.livingUnits().map((unit) => `${unit.label} (${unit.hp.toFixed(0)}/${unit.maxHp})`),
  };
}
