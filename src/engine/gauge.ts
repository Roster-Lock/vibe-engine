/**
 * A Gauge is a numeric meter on a character (HP, Mana, Stamina, ...).
 *
 * Every gauge knows its **maximum value** and its **current value** — and,
 * since gauges are the things state reacts to, it carries its own
 * **state-based actions** (`sbas`: one-shot death/effect rules) and
 * **conditional buff gates** (`buffGates`: "keep this buff attached exactly
 * while the value matches the condition") — see `GaugeSba` and
 * `GaugeBuffGate`.
 *
 * ```ts
 * const hp = new Gauge('hp', 100);                       // full
 * const mana = new Gauge('mana', 50, { current: 20 });   // partially spent
 * const stamina = new Gauge('stamina', 100, { buffGates: [tiredGate] });
 * ```
 *
 * Unless `clamp` is disabled, the current value is always kept inside
 * `[min, max]`. Clamping happens when the value is *written*, so update
 * functions (see `Action`) can compute intermediate values freely.
 *
 * The **maximum is never set by content** — it is *derived*. `baseMax` is
 * fixed at construction; the engine recomputes the effective `max` from it
 * plus the `maxModifier` contributions of every attached status (see
 * `GameEngine`). Raising the derived max never refills the gauge; lowering
 * it below the current value re-clamps the current value down.
 */
import type { Action } from './actions.js';
import type { Character } from './character.js';
import type { GameEngine } from './engine.js';
import type { BuffDef } from './status/index.js';

export interface GaugeOptions {
  /** Starting current value. Defaults to `max` (a full gauge). */
  current?: number;
  /** Lowest allowed current value. Defaults to `0`. */
  min?: number;
  /** When `false`, writes are not clamped to `[min, max]`. Defaults to `true`. */
  clamp?: boolean;
  /** State-based actions attached to this gauge (see `GaugeSba`). */
  sbas?: readonly GaugeSba[];
  /** Conditional buffs attached to this gauge (see `GaugeBuffGate`). */
  buffGates?: readonly GaugeBuffGate[];
}

/**
 * A gauge **declared as data** rather than pre-constructed — the shape a
 * character (or a serialized content document) names its gauges with.
 *
 * ```ts
 * new Character('Bat', { gauges: [
 *   { id: 'hp', max: 4, sbas: [diesAtZero] },
 *   { id: 'blood', max: 2 },
 * ] });
 * ```
 *
 * The engine deliberately has no opinion about the **ids**: `'hp'`, `'mana'`
 * and `'stamina'` are all just gauges, and the rules that make one of them
 * lethal are ordinary `GaugeSba`s attached to it — a rule whose `when` fires
 * and whose `then` destroys the character (see `GaugeSba`). A pre-built
 * `Gauge` instance is accepted anywhere a `GaugeDef` is, for the cases that
 * need to attach rules after construction.
 */
export interface GaugeDef {
  /** The gauge's id — how content and the engine find it (`character.gauge(id)`). */
  readonly id: string;
  /** The base max. The *effective* max is derived from this plus status contributions. */
  readonly max: number;
  /** Starting current value. Defaults to `max` (a full gauge). */
  readonly current?: number;
  /** Lowest allowed current value. Defaults to `0`. */
  readonly min?: number;
  /** When `false`, writes are not clamped to `[min, max]`. Defaults to `true`. */
  readonly clamp?: boolean;
  /** State-based actions attached to this gauge (see `GaugeSba`). */
  readonly sbas?: readonly GaugeSba[];
  /** Conditional buffs attached to this gauge (see `GaugeBuffGate`). */
  readonly buffGates?: readonly GaugeBuffGate[];
}

/** Whether a declaration is a pre-built gauge instance or plain data. */
export function isGaugeInstance(value: GaugeDef | Gauge): value is Gauge {
  return value instanceof Gauge;
}

/** Builds the gauge a declaration names — an existing instance, or data. */
export function gaugeFrom(def: GaugeDef | Gauge): Gauge {
  return isGaugeInstance(def) ? def : new Gauge(def.id, def.max, def);
}

/**
 * A **conditional buff gate** — "keep this buff attached exactly while the
 * gauge's value matches the condition". Unlike a `GaugeSba` (one-shot,
 * destroy-oriented), a gate is **two-way and reversible**: when the
 * condition turns true the buff is applied through the pipeline, and when
 * it turns false the buff is removed — as many times as the value crosses
 * the threshold. Applying an already-attached / removing an absent buff is
 * a no-op, so the pass terminates.
 *
 * ```ts
 * const tired = buff({ name: 'Tired', weight: 1,
 *   abilities: [stat({ name: 'Tired', stat: 'speed', multiply: 0.5 })] });
 * stamina.addBuffGate({
 *   name: 'Tired Gate',
 *   when: (g) => g.current <= g.max * 0.2,   // "low stamina"
 *   buff: tired,                              // attach/keep Tired while low
 * });
 * ```
 *
 * The gate manages its buff **by id**: it applies when the condition holds
 * and the character lacks the buff, and removes it when the condition
 * stops holding. Gates are re-evaluated whenever their gauge is **written**
 * (the settle after a batch that touched it); a condition that also depends
 * on a *derived* max re-evaluates on the next write of that gauge.
 */
export interface GaugeBuffGate {
  /** Gate name — used to remove the gate again. */
  readonly name: string;
  /** Sort key among gates on the same gauge. Defaults to 50. */
  readonly priority?: number;
  /** The condition over the gauge — attach the buff while it holds. */
  readonly when: (gauge: Gauge, character: Character, engine: GameEngine) => boolean;
  /** The buff kept attached exactly while `when` holds. */
  readonly buff: BuffDef;
}

/**
 * A **gauge-attached state-based action** — the reusable death/effect rule.
 * The rule is gauge-agnostic: it never names the gauge it is attached to;
 * it reads the gauge it lives on, and fires when that gauge's value matches
 * its condition. That is what makes the built-in death rules removable and
 * re-attachable — the same definition "destroy when the attached gauge hits
 * its minimum" can sit on an HP gauge (the default), a mana gauge, or any
 * gauge, and be replaced by any condition ("destroy when the gauge is
 * exactly 4"):
 *
 * ```ts
 * character.hp.removeSba('HP Depleted');                   // prevent
 * character.hp.addSba({
 *   name: 'Fragile',
 *   aspect: 'current',
 *   when: (g) => g.current === 4,
 *   then: (c) => [destroy(c)],
 *   reason: 'fragile:hp-exactly-4',
 * });
 * ```
 *
 * When a rule fires, the engine collects a **pending destruction** for the
 * character (resolved simultaneously with every other death of the settle)
 * iff the rule's `then` returns a `destroy` action targeting it — that
 * action's absence means the rule has no destroy effect. `reason` is
 * reported verbatim as `character:destroyed.reason`. The win/lose "dead"
 * predicate consults the same rules, so a character whose state would
 * trigger a destroy rule counts as dead (still destroy-gate aware).
 *
 * Current-aspect rules are checked against the gauges a batch **wrote**
 * (the rule "listens for changes"); max-aspect rules are checked whenever a
 * status change re-derives the gauge's max.
 */
export interface GaugeSba {
  /** Rule name — used to remove the rule again. */
  readonly name: string;
  /**
   * What the rule watches: the gauge's **current** value (checked after
   * every batch that writes the gauge), or its derived **max** (checked
   * after every status-driven re-derivation).
   */
  readonly aspect: 'current' | 'max';
  /** Sort key among rules on the same gauge. Defaults to 50 (the built-ins use 10). */
  readonly priority?: number;
  /** The condition over the gauge — generic, uses `gauge.min`/`max`. */
  readonly when: (gauge: Gauge, character: Character, engine: GameEngine) => boolean;
  /** The actions that resolve this state (usually `[destroy(character)]`). */
  readonly then: (character: Character, engine: GameEngine) => Action[];
  /** Reported verbatim as `character:destroyed.reason` when this rule destroys. */
  readonly reason: string;
}

export class Gauge {
  readonly id: string;
  readonly min: number;
  /**
   * The maximum the gauge was constructed with — the base every derived
   * max is computed from. Never changes once constructed (content cannot
   * rewrite it; only `max` — the effective value — is re-derived by the
   * engine when statuses change).
   */
  readonly baseMax: number;
  private readonly clamp: boolean;
  private _current: number;
  private _max: number;
  /** The state-based actions attached to this gauge, sorted by `priority`. */
  readonly #sbas: GaugeSba[] = [];
  /** The conditional buff gates attached to this gauge, sorted by `priority`. */
  readonly #buffGates: GaugeBuffGate[] = [];

  constructor(id: string, max: number, options: GaugeOptions = {}) {
    if (!Number.isFinite(max) || max < 0) {
      throw new Error(`Gauge "${id}": max must be a finite number >= 0, got ${max}`);
    }
    this.id = id;
    this.baseMax = max;
    this._max = max;
    this.min = options.min ?? 0;
    this.clamp = options.clamp ?? true;
    this._current = options.current ?? max;
    if (this.clamp) this._current = this.clampToBounds(this._current);
    this.#sbas.push(...(options.sbas ?? []));
    this.#sbas.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    this.#buffGates.push(...(options.buffGates ?? []));
    this.#buffGates.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
  }

  /**
   * The state-based actions attached to this gauge, in `priority` order.
   * The engine evaluates them whenever this gauge changes (see `GaugeSba`).
   */
  get sbas(): readonly GaugeSba[] {
    return this.#sbas;
  }

  /** Attaches a state-based action to this gauge. Rejects duplicate names. */
  addSba(rule: GaugeSba): this {
    if (this.#sbas.some((r) => r.name === rule.name)) {
      throw new Error(`Gauge "${this.id}": a rule named "${rule.name}" is already attached`);
    }
    this.#sbas.push(rule);
    this.#sbas.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    return this;
  }

  /** Detaches a state-based action by name. Returns `false` when it was not attached. */
  removeSba(name: string): boolean {
    const index = this.#sbas.findIndex((r) => r.name === name);
    if (index === -1) return false;
    this.#sbas.splice(index, 1);
    return true;
  }

  /**
   * The conditional buff gates attached to this gauge, in `priority` order.
   * The engine evaluates them whenever this gauge is written (see
   * `GaugeBuffGate`).
   */
  get buffGates(): readonly GaugeBuffGate[] {
    return this.#buffGates;
  }

  /** Attaches a conditional buff gate to this gauge. Rejects duplicate names. */
  addBuffGate(gate: GaugeBuffGate): this {
    if (this.#buffGates.some((g) => g.name === gate.name)) {
      throw new Error(`Gauge "${this.id}": a gate named "${gate.name}" is already attached`);
    }
    this.#buffGates.push(gate);
    this.#buffGates.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    return this;
  }

  /** Detaches a conditional buff gate by name. Returns `false` when it was not attached. */
  removeBuffGate(name: string): boolean {
    const index = this.#buffGates.findIndex((g) => g.name === name);
    if (index === -1) return false;
    this.#buffGates.splice(index, 1);
    return true;
  }

  /** The current value of the gauge. */
  get current(): number {
    return this._current;
  }

  /** Writes a new current value (clamped to `[min, max]` unless clamping is off). */
  set current(value: number) {
    this._current = this.clampToBounds(value);
  }

  /** The maximum value of the gauge. */
  get max(): number {
    return this._max;
  }

  /**
   * The effective maximum value of the gauge — re-derived by the engine
   * from `baseMax` plus the attached statuses' `maxModifier` contributions.
   * Writing it (the engine's re-derivation) re-clamps the current value if
   * needed.
   */
  set max(value: number) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Gauge "${this.id}": max must be a finite number >= 0, got ${value}`);
    }
    this._max = value;
    if (this.clamp) this._current = this.clampToBounds(this._current);
  }

  /** True when the current value is at (or above) `max`. */
  get isFull(): boolean {
    return this._current >= this._max;
  }

  /** True when the current value is at (or below) `min`. */
  get isEmpty(): boolean {
    return this._current <= this.min;
  }

  private clampToBounds(value: number): number {
    return this.clamp ? Math.min(this._max, Math.max(this.min, value)) : value;
  }

  toString(): string {
    return `${this.id} ${this._current}/${this._max}`;
  }
}
