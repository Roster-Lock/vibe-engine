/**
 * The world: a fixed-timestep, deterministic real-time simulation.
 *
 * Two rules shape everything here, and both are borrowed from the parent
 * engine (docs/spec/):
 *
 * 1. **Every state change goes through a verb on this class.** Compiled
 *    abilities never assign `unit.hp` — they call `dealDamage`, which
 *    applies armor, emits `damaged`, and resolves death exactly once. That
 *    is what lets a thorns buff exist at all: the trigger hangs off the
 *    event the verb emits, not off a number someone happened to change.
 * 2. **No wall clock and no `Math.random`.** Time advances in fixed `dt`
 *    steps and all randomness comes from the seeded `Rng`, so a battle is a
 *    pure function of (seed, unit placement, compiled program).
 *
 * The world knows nothing about English or about the IR's effect nodes — it
 * only knows that a buff carries a `BuffProgram` worth of modifiers and
 * that *somebody* wants to be told when events happen. `src/english/runtime.ts`
 * is that somebody; `src/sim/ai.ts` supplies the per-unit behavior.
 */
import type { BuffProgram } from '../ir.js';
import { createRng, type Rng } from './rng.js';
import { Unit, armorMultiplier, type BuffInstance, type UnitDef } from './unit.js';
import { distance, moveToward, normalize, scale, sub, type Vec2 } from './vec.js';

/** Something that happened, which a `whenever …` trigger may listen for. */
export type SimEvent =
  | { readonly kind: 'damaged'; readonly victim: Unit; readonly attacker: Unit | undefined; readonly amount: number }
  | { readonly kind: 'died'; readonly victim: Unit; readonly killer: Unit | undefined }
  | { readonly kind: 'attacks'; readonly attacker: Unit; readonly victim: Unit }
  | { readonly kind: 'kills'; readonly killer: Unit; readonly victim: Unit }
  | { readonly kind: 'casts'; readonly caster: Unit; readonly abilityId: string };

/** One line of the battle log — the demo prints these, tests assert on them. */
export interface LogEntry {
  readonly time: number;
  readonly text: string;
}

export interface SimHooks {
  /** Called for every event; the ability runtime dispatches `whenever …` triggers here. */
  onEvent?(event: SimEvent, world: World): void;
  /** Called when a buff's `Every <n> seconds, …` entry comes due. */
  onPeriodic?(unit: Unit, instance: BuffInstance, index: number, world: World): void;
  /** Called once per living unit per tick, to decide what it does. */
  behavior?(unit: Unit, world: World): void;
}

export interface WorldOptions {
  readonly seed?: number;
  /** Seconds per tick. 20 Hz by default — fine for melee, cheap to run. */
  readonly dt?: number;
  readonly hooks?: SimHooks;
  /** Caps trigger-inside-trigger recursion (thorns hitting thorns). */
  readonly maxTriggerDepth?: number;
}

export class World {
  time = 0;
  readonly dt: number;
  readonly rng: Rng;
  readonly units: Unit[] = [];
  readonly log: LogEntry[] = [];
  hooks: SimHooks;

  readonly #scheduled: { at: number; run: () => void }[] = [];
  readonly #maxTriggerDepth: number;
  #triggerDepth = 0;

  constructor(options: WorldOptions = {}) {
    this.dt = options.dt ?? 0.05;
    this.rng = createRng(options.seed ?? 1);
    this.hooks = options.hooks ?? {};
    this.#maxTriggerDepth = options.maxTriggerDepth ?? 8;
  }

  /* -------------------------------- queries -------------------------------- */

  livingUnits(): Unit[] {
    return this.units.filter((unit) => unit.alive);
  }

  /** Living units whose center is within `radius` of `center`. */
  unitsWithin(center: Vec2, radius: number, predicate?: (unit: Unit) => boolean): Unit[] {
    return this.units.filter(
      (unit) => unit.alive && distance(unit.pos, center) <= radius && (predicate?.(unit) ?? true),
    );
  }

  isEnemy(a: Unit, b: Unit): boolean {
    return a.team !== b.team;
  }

  isAlly(a: Unit, b: Unit): boolean {
    return a.team === b.team;
  }

  /** The closest living enemy within `range`, or `undefined`. */
  nearestEnemy(unit: Unit, range: number): Unit | undefined {
    let best: Unit | undefined;
    let bestDistance = range;
    for (const other of this.units) {
      if (!other.alive || !this.isEnemy(unit, other)) continue;
      const d = distance(unit.pos, other.pos);
      if (d <= bestDistance) {
        best = other;
        bestDistance = d;
      }
    }
    return best;
  }

  /** Teams that still have a living unit — the win condition. */
  livingTeams(): number[] {
    return [...new Set(this.livingUnits().map((unit) => unit.team))].sort((a, b) => a - b);
  }

  /* ------------------------------- lifecycle ------------------------------- */

  spawn(def: UnitDef, team: number, pos: Vec2): Unit {
    const unit = new Unit(def, team, pos);
    this.units.push(unit);
    this.record(`${unit.label} enters the field for team ${team}`);
    return unit;
  }

  /** Runs one fixed step. */
  tick(): void {
    this.time += this.dt;
    this.#runScheduled();
    for (const unit of this.livingUnits()) this.#upkeep(unit);
    for (const unit of this.livingUnits()) this.hooks.behavior?.(unit, this);
    this.#separate();
  }

  /** Runs until `seconds` have elapsed or `stop` returns true. */
  run(seconds: number, stop?: (world: World) => boolean): void {
    const until = this.time + seconds;
    while (this.time < until) {
      this.tick();
      if (stop?.(this)) return;
    }
  }

  /** Queues `run` to happen `delay` seconds from now — `After 2 seconds, …`. */
  schedule(delay: number, run: () => void): void {
    this.#scheduled.push({ at: this.time + Math.max(0, delay), run });
  }

  #runScheduled(): void {
    // Splice out everything due *before* running any of it, so a callback
    // that schedules more work cannot be run in the same tick it was added.
    const due: (() => void)[] = [];
    for (let i = this.#scheduled.length - 1; i >= 0; i -= 1) {
      const entry = this.#scheduled[i]!;
      if (entry.at <= this.time) {
        due.unshift(entry.run);
        this.#scheduled.splice(i, 1);
      }
    }
    for (const run of due) run();
  }

  /**
   * Per-tick regeneration, periodic buff effects, and buff expiry — **in
   * that order**. A tick that lands on the same instant the buff ends still
   * happens, so a 3-second poison ticking once a second ticks three times
   * rather than two. Doing expiry first silently ate the last tick of every
   * damage-over-time buff whose duration was a multiple of its interval,
   * which is to say: most of them.
   */
  #upkeep(unit: Unit): void {
    unit.hp = Math.min(unit.maxHp, unit.hp + unit.def.hpRegen * this.dt);
    unit.mana = Math.min(unit.maxMana, unit.mana + unit.def.manaRegen * this.dt);

    for (let i = unit.buffs.length - 1; i >= 0; i -= 1) {
      const instance = unit.buffs[i]!;
      for (let p = 0; p < instance.program.periodic.length; p += 1) {
        const periodic = instance.program.periodic[p]!;
        if (this.#reached(instance.nextTick[p] ?? 0)) {
          instance.nextTick[p] = this.time + periodic.interval;
          this.hooks.onPeriodic?.(unit, instance, p, this);
        }
      }
      if (this.#reached(instance.expiresAt)) {
        unit.buffs.splice(i, 1);
        this.record(`${instance.program.name} expires on ${unit.label}`);
      }
    }
  }

  /**
   * Whether the clock has reached `deadline`, with a tolerance.
   *
   * `time` accumulates by repeated addition of `dt`, so after sixty ticks
   * of 0.05 it is 3.0000000000000004 — or 2.9999999999999996, depending on
   * the path. Without the tolerance, whether a buff's last tick fires would
   * depend on floating-point noise.
   */
  #reached(deadline: number): boolean {
    return this.time + 1e-9 >= deadline;
  }

  /**
   * Pushes overlapping units apart. Crude next to real flocking, but it
   * stops a melee blob from collapsing onto a single point, which would
   * make every area ability hit everything.
   */
  #separate(): void {
    const living = this.livingUnits();
    for (let i = 0; i < living.length; i += 1) {
      for (let j = i + 1; j < living.length; j += 1) {
        const a = living[i]!;
        const b = living[j]!;
        const minimum = a.def.radius + b.def.radius;
        const d = distance(a.pos, b.pos);
        if (d >= minimum) continue;
        // Identical positions get a deterministic nudge rather than NaN.
        const away = d === 0 ? { x: 1, y: 0 } : normalize(sub(b.pos, a.pos));
        const push = scale(away, (minimum - d) / 2);
        a.pos = sub(a.pos, push);
        b.pos = { x: b.pos.x + push.x, y: b.pos.y + push.y };
      }
    }
  }

  /* --------------------------------- verbs --------------------------------- */

  /** Moves `unit` toward `to`, at most one tick's worth of its move speed. */
  moveUnit(unit: Unit, to: Vec2): void {
    if (!unit.can('move')) return;
    unit.pos = moveToward(unit.pos, to, unit.moveSpeed * this.dt);
  }

  teleport(unit: Unit, to: Vec2): void {
    unit.pos = to;
    this.record(`${unit.label} blinks to (${to.x.toFixed(0)}, ${to.y.toFixed(0)})`);
  }

  /** Shoves `unit` `away` from `origin` by `amount` map units, ignoring speed. */
  knockback(unit: Unit, origin: Vec2, amount: number): void {
    const away = distance(unit.pos, origin) === 0 ? { x: 1, y: 0 } : normalize(sub(unit.pos, origin));
    unit.pos = { x: unit.pos.x + away.x * amount, y: unit.pos.y + away.y * amount };
  }

  /**
   * The damage verb. Applies armor, clamps at zero, emits `damaged`, and
   * resolves death — the single funnel every source of damage goes through
   * (auto-attacks, abilities, buff ticks, retaliation).
   */
  dealDamage(target: Unit, amount: number, attacker: Unit | undefined, label = 'damage'): number {
    if (!target.alive || amount <= 0) return 0;
    const dealt = Math.max(0, amount * armorMultiplier(target.armor));
    target.hp = Math.max(0, target.hp - dealt);
    this.record(
      `${attacker ? attacker.label : 'something'} deals ${dealt.toFixed(0)} ${label} to ` +
        `${target.label} (${target.hp.toFixed(0)}/${target.maxHp} hp)`,
    );
    this.emit({ kind: 'damaged', victim: target, attacker, amount: dealt });
    if (target.hp <= 0) this.kill(target, attacker);
    return dealt;
  }

  healUnit(target: Unit, amount: number, source: Unit | undefined): number {
    if (!target.alive || amount <= 0) return 0;
    const before = target.hp;
    target.hp = Math.min(target.maxHp, target.hp + amount);
    const healed = target.hp - before;
    if (healed > 0) {
      this.record(
        `${source ? source.label : 'something'} heals ${target.label} for ${healed.toFixed(0)} ` +
          `(${target.hp.toFixed(0)}/${target.maxHp} hp)`,
      );
    }
    return healed;
  }

  kill(target: Unit, killer: Unit | undefined): void {
    if (!target.alive) return;
    target.alive = false;
    target.hp = 0;
    target.attackTarget = undefined;
    this.record(`${target.label} dies${killer ? ` to ${killer.label}` : ''}`);
    this.emit({ kind: 'died', victim: target, killer });
    if (killer && killer.alive) this.emit({ kind: 'kills', killer, victim: target });
  }

  /**
   * Applies a buff. A stacking buff on a unit that already has it adds a
   * stack and refreshes the duration; a non-stacking one just refreshes —
   * the Warcraft 3 behavior, and the one a creator expects from writing
   * `Buff Poisoned (stacks)`.
   */
  applyBuff(target: Unit, program: BuffProgram, source: Unit | undefined): BuffInstance | undefined {
    if (!target.alive) return undefined;
    const expiresAt = program.duration > 0 ? this.time + program.duration : Infinity;
    const existing = target.buffInstance(program.id);
    if (existing) {
      existing.expiresAt = expiresAt;
      if (program.stacks) {
        existing.stacks += 1;
        this.record(`${program.name} stacks to ${existing.stacks} on ${target.label}`);
      } else {
        this.record(`${program.name} refreshes on ${target.label}`);
      }
      return existing;
    }
    const instance: BuffInstance = {
      program,
      expiresAt,
      stacks: 1,
      source,
      nextTick: program.periodic.map((periodic) => this.time + periodic.interval),
    };
    target.buffs.push(instance);
    this.record(`${program.name} is applied to ${target.label}`);
    return instance;
  }

  removeBuff(target: Unit, buffId: string): boolean {
    const index = target.buffs.findIndex((instance) => instance.program.id === buffId);
    if (index === -1) return false;
    const [removed] = target.buffs.splice(index, 1);
    this.record(`${removed!.program.name} is removed from ${target.label}`);
    return true;
  }

  /* -------------------------------- plumbing ------------------------------- */

  /**
   * Publishes an event to the hooks. Depth-limited: a thorns aura on both
   * sides of a fight would otherwise retaliate against retaliation forever.
   */
  emit(event: SimEvent): void {
    if (this.#triggerDepth >= this.#maxTriggerDepth) return;
    this.#triggerDepth += 1;
    try {
      this.hooks.onEvent?.(event, this);
    } finally {
      this.#triggerDepth -= 1;
    }
  }

  record(text: string): void {
    this.log.push({ time: this.time, text });
  }

  /** The log as printable lines, `[  3.15s] …`. */
  formatLog(): string[] {
    return this.log.map((entry) => `[${entry.time.toFixed(2).padStart(6)}s] ${entry.text}`);
  }
}
