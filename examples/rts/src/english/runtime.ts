/**
 * The runtime: where compiled abilities actually run.
 *
 * The important decision in this file is `CastApi` — the small set of verbs
 * an ability body is allowed to use. It exists because there are **two**
 * things that execute an ability:
 *
 * - `AbilityRuntime.runEffects`, which walks the IR node by node;
 * - the TypeScript emitted by `codegen.ts`, which calls the same verbs
 *   directly from a hand-readable `cast(ctx) { … }` body.
 *
 * Both go through `CastApi`, so they cannot drift in behavior — only in how
 * they got there. `test/equivalence.test.ts` runs a whole battle each way
 * and asserts the logs match, which is the guarantee that "English becomes
 * executable code" means something.
 *
 * Nothing here reaches into the sim's internals: the verbs are the same
 * `World` methods a hand-written ability would call.
 */
import type {
  AbilityProgram,
  Allegiance,
  Anchor,
  BuffProgram,
  CompareOp,
  EffectNode,
  EventKind,
  EventRole,
  Program,
  TriggerNode,
  UnitFilter,
  UnitQuery,
  ValueNode,
} from '../ir.js';
import type { SimEvent, World } from '../sim/world.js';
import type { BuffInstance, Unit, UnitDef } from '../sim/unit.js';
import { distance, type Vec2 } from '../sim/vec.js';

/** What an ability is aimed at, decided before the cast begins. */
export interface CastTarget {
  readonly unit?: Unit;
  readonly point?: Vec2;
}

/**
 * The verbs an ability body may use. Deliberately narrow: an ability can
 * find units and change them, and nothing else — no direct field writes, no
 * access to the unit list, no way to stop time. A compiled ability is
 * content, and content runs inside a fence.
 */
export interface CastApi {
  readonly world: World;
  /** The caster — or, inside a buff's trigger or tick, the buff's carrier. */
  readonly self: Unit;
  /** The unit this cast was aimed at, if any. */
  readonly target: Unit | undefined;
  /** The point this cast was aimed at — a unit target's position counts. */
  readonly point: Vec2 | undefined;
  /** The event that fired this trigger, if it is one. */
  readonly event: SimEvent | undefined;

  /**
   * `all [other] <who> units within <radius> range of <from>`.
   *
   * `from` is allowed to be undefined — a target-derived anchor on a cast
   * whose target has since died — and yields no units. Absorbing that here
   * keeps every caller, generated code included, free of anchor guards.
   */
  area(options: { who: Allegiance; radius: number; from: Vec2 | undefined; other?: boolean }): Unit[];
  /** The unit bound to an event noun (`the attacker`), if the event binds one. */
  role(which: EventRole): Unit | undefined;

  damage(unit: Unit, amount: number): void;
  heal(unit: Unit, amount: number): void;
  addBuff(unit: Unit, buffId: string): void;
  removeBuff(unit: Unit, buffId: string): void;
  kill(unit: Unit): void;
  summon(unitId: string, count: number, at: Vec2): void;
  teleport(unit: Unit, to: Vec2): void;
  push(unit: Unit, from: Vec2, amount: number): void;

  /** Runs `body` once, `delay` seconds from now. */
  after(delay: number, body: () => void): void;
  /** Runs `body` every `interval` seconds until `duration` has elapsed. */
  every(interval: number, duration: number, body: () => void): void;
}

/** A generated ability: the metadata as data, the behavior as a closure. */
export interface CompiledAbility {
  readonly id: string;
  readonly name: string;
  readonly targeting: AbilityProgram['targeting'];
  readonly cooldown: number;
  readonly manaCost: number;
  readonly castRange: number;
  readonly cast: (ctx: CastApi) => void;
  /** Passive `whenever …` bodies, keyed by the event that runs them. */
  readonly triggers?: Readonly<Partial<Record<EventKind, (ctx: CastApi) => void>>>;
}

export interface RuntimeOptions {
  /** Unit types `Summon` may create. */
  readonly units?: readonly UnitDef[];
  /**
   * Generated closures to run **instead of** interpreting the IR, keyed by
   * ability id. This is the switch `test/equivalence.test.ts` flips.
   */
  readonly compiled?: readonly CompiledAbility[];
}

/** Which unit owns the triggers that hear an event. */
function ownerOf(event: SimEvent): Unit | undefined {
  switch (event.kind) {
    case 'damaged':
      return event.victim;
    case 'died':
      return event.victim;
    case 'attacks':
      return event.attacker;
    case 'kills':
      return event.killer;
    case 'casts':
      return event.caster;
  }
}

/** Applies one comparison operator — shared by both filter kinds. */
function compare(actual: number, op: CompareOp, threshold: number): boolean {
  switch (op) {
    case '<':
      return actual < threshold;
    case '<=':
      return actual <= threshold;
    case '>':
      return actual > threshold;
    case '>=':
      return actual >= threshold;
    case '=':
      return actual === threshold;
    case '!=':
      return actual !== threshold;
  }
}

export class AbilityRuntime {
  readonly program: Program;
  readonly #buffs = new Map<string, BuffProgram>();
  readonly #abilities = new Map<string, AbilityProgram>();
  readonly #unitDefs = new Map<string, UnitDef>();
  readonly #compiled = new Map<string, CompiledAbility>();

  constructor(program: Program, options: RuntimeOptions = {}) {
    this.program = program;
    for (const buff of program.buffs) this.#buffs.set(buff.id, buff);
    for (const ability of program.abilities) this.#abilities.set(ability.id, ability);
    for (const def of options.units ?? []) this.#unitDefs.set(def.id, def);
    for (const ability of options.compiled ?? []) this.#compiled.set(ability.id, ability);
  }

  ability(id: string): AbilityProgram | undefined {
    return this.#abilities.get(id);
  }

  buff(id: string): BuffProgram | undefined {
    return this.#buffs.get(id);
  }

  /* --------------------------------- casting -------------------------------- */

  /**
   * Whether `caster` could cast `ability` right now, ignoring targets. The
   * AI asks this before looking for something to aim at.
   */
  ready(world: World, caster: Unit, ability: AbilityProgram): boolean {
    if (!caster.alive || !caster.can('cast')) return false;
    if ((caster.cooldowns.get(ability.id) ?? 0) > world.time) return false;
    return caster.mana >= ability.manaCost;
  }

  /** Whether `target` is a legal aim point for `ability` cast by `caster`. */
  validTarget(world: World, caster: Unit, ability: AbilityProgram, target: CastTarget): boolean {
    const at = target.unit?.pos ?? target.point;
    switch (ability.targeting) {
      case 'none':
        return true;
      case 'point':
        if (!target.point) return false;
        break;
      case 'unit':
        if (!target.unit?.alive) return false;
        break;
      case 'enemyUnit':
        if (!target.unit?.alive || !world.isEnemy(caster, target.unit)) return false;
        break;
      case 'allyUnit':
        if (!target.unit?.alive || !world.isAlly(caster, target.unit)) return false;
        break;
    }
    if (ability.castRange > 0 && at && distance(caster.pos, at) > ability.castRange) return false;
    return true;
  }

  /**
   * Casts `ability`. Pays the mana, starts the cooldown, announces the cast
   * (so `whenever this unit casts an ability` can hear it) and then runs the
   * body. Returns false when the cast was not legal — the caller has not
   * spent anything.
   */
  cast(world: World, caster: Unit, ability: AbilityProgram, target: CastTarget = {}): boolean {
    if (!this.ready(world, caster, ability)) return false;
    if (!this.validTarget(world, caster, ability, target)) return false;

    caster.mana -= ability.manaCost;
    caster.cooldowns.set(ability.id, world.time + ability.cooldown);
    world.record(
      `${caster.label} casts ${ability.name}` + (target.unit ? ` on ${target.unit.label}` : ''),
    );
    world.emit({ kind: 'casts', caster, abilityId: ability.id });

    const api = this.api(world, caster, target, undefined);
    const compiled = this.#compiled.get(ability.id);
    if (compiled) compiled.cast(api);
    else this.runEffects(ability.effects, api);
    return true;
  }

  /* ------------------------------- sim hooks -------------------------------- */

  /**
   * Dispatches an event to the `whenever …` triggers that should hear it:
   * those on the owning unit's buffs, and the passive triggers on the
   * abilities it knows.
   */
  onEvent = (event: SimEvent, world: World): void => {
    const owner = ownerOf(event);
    if (!owner) return;
    const kind = event.kind;

    for (const instance of [...owner.buffs]) {
      for (const trigger of instance.program.triggers) {
        if (trigger.event === kind) this.#runTrigger(trigger, world, owner, event);
      }
    }
    for (const abilityId of owner.def.abilities) {
      const ability = this.#abilities.get(abilityId);
      if (!ability) continue;
      const compiled = this.#compiled.get(abilityId);
      if (compiled?.triggers) {
        const body = compiled.triggers[kind];
        if (body) body(this.api(world, owner, {}, event));
        continue;
      }
      for (const trigger of ability.triggers) {
        if (trigger.event === kind) this.#runTrigger(trigger, world, owner, event);
      }
    }
  };

  /** Runs one entry of a buff's `Every <n> seconds, …` cadence. */
  onPeriodic = (unit: Unit, instance: BuffInstance, index: number, world: World): void => {
    const periodic = instance.program.periodic[index];
    if (!periodic) return;
    this.runEffects(periodic.effects, this.api(world, unit, {}, undefined, instance.source ?? unit));
  };

  #runTrigger(trigger: TriggerNode, world: World, owner: Unit, event: SimEvent): void {
    this.runEffects(trigger.effects, this.api(world, owner, {}, event));
  }

  /* ------------------------------ the interpreter ---------------------------- */

  /**
   * Builds the fenced verb set an ability body runs against.
   *
   * `credit` is who the damage and healing are attributed to, and it is not
   * always `self`: a poison tick runs with the *poisoned unit* as `self`
   * (that is what `this unit` means inside a buff) but should be credited
   * to whoever applied the poison, so the battle log reads correctly and a
   * kill counts for the right side.
   */
  api(world: World, self: Unit, target: CastTarget, event: SimEvent | undefined, credit: Unit | undefined = self): CastApi {
    const runtime = this;
    return {
      world,
      self,
      target: target.unit,
      point: target.point ?? target.unit?.pos,
      event,

      area({ who, radius, from, other }) {
        if (!from) return [];
        return world.unitsWithin(from, radius, (unit) => {
          if (other && unit === self) return false;
          if (who === 'enemy') return world.isEnemy(self, unit);
          if (who === 'ally') return world.isAlly(self, unit);
          return true;
        });
      },

      role(which) {
        if (!event) return undefined;
        switch (which) {
          case 'attacker':
            return event.kind === 'damaged' ? event.attacker : event.kind === 'attacks' ? event.attacker : undefined;
          case 'victim':
            return event.kind === 'damaged' || event.kind === 'died' || event.kind === 'attacks' || event.kind === 'kills'
              ? event.victim
              : undefined;
          case 'killer':
            return event.kind === 'died' ? event.killer : event.kind === 'kills' ? event.killer : undefined;
        }
      },

      damage(unit, amount) {
        world.dealDamage(unit, amount, credit, 'spell damage');
      },
      heal(unit, amount) {
        world.healUnit(unit, amount, credit);
      },
      addBuff(unit, buffId) {
        const program = runtime.#buffs.get(buffId);
        if (program) world.applyBuff(unit, program, credit);
      },
      removeBuff(unit, buffId) {
        world.removeBuff(unit, buffId);
      },
      kill(unit) {
        world.kill(unit, credit);
      },
      summon(unitId, count, at) {
        const def = runtime.#unitDefs.get(unitId);
        if (!def) return;
        for (let i = 0; i < count; i += 1) {
          // Fan the summons around the anchor so they do not all spawn in
          // one spot and immediately shove each other apart.
          const angle = (i / Math.max(1, count)) * Math.PI * 2;
          const spread = def.radius * 3;
          world.spawn(def, self.team, { x: at.x + Math.cos(angle) * spread, y: at.y + Math.sin(angle) * spread });
        }
      },
      teleport(unit, to) {
        world.teleport(unit, to);
      },
      push(unit, from, amount) {
        world.knockback(unit, from, amount);
      },
      after(delay, body) {
        world.schedule(delay, () => {
          if (self.alive) body();
        });
      },
      every(interval, duration, body) {
        const ticks = Math.floor(duration / interval + 1e-9);
        for (let i = 1; i <= ticks; i += 1) {
          world.schedule(interval * i, () => {
            // A dead caster's spell stops — the Warcraft 3 rule for
            // channels, and the one that keeps a corpse from healing.
            if (self.alive) body();
          });
        }
      },
    };
  }

  /** Walks IR effect nodes, calling the same verbs generated code calls. */
  runEffects(effects: readonly EffectNode[], ctx: CastApi): void {
    for (const effect of effects) this.runEffect(effect, ctx);
  }

  runEffect(effect: EffectNode, ctx: CastApi): void {
    switch (effect.kind) {
      case 'damage': {
        const amount = this.value(effect.amount, ctx);
        for (const unit of this.units(effect.units, ctx)) ctx.damage(unit, amount);
        return;
      }
      case 'heal': {
        const amount = this.value(effect.amount, ctx);
        for (const unit of this.units(effect.units, ctx)) ctx.heal(unit, amount);
        return;
      }
      case 'addBuff':
        for (const unit of this.units(effect.units, ctx)) ctx.addBuff(unit, effect.buff);
        return;
      case 'removeBuff':
        for (const unit of this.units(effect.units, ctx)) ctx.removeBuff(unit, effect.buff);
        return;
      case 'kill':
        for (const unit of this.units(effect.units, ctx)) ctx.kill(unit);
        return;
      case 'summon': {
        const at = this.anchor(effect.anchor, ctx);
        if (at) ctx.summon(effect.unit, effect.count, at);
        return;
      }
      case 'teleport': {
        const to = this.anchor(effect.anchor, ctx);
        if (!to) return;
        for (const unit of this.units(effect.units, ctx)) ctx.teleport(unit, to);
        return;
      }
      case 'knockback': {
        const from = this.anchor(effect.anchor, ctx);
        if (!from) return;
        for (const unit of this.units(effect.units, ctx)) ctx.push(unit, from, effect.distance);
        return;
      }
      case 'after':
        ctx.after(effect.delay, () => this.runEffects(effect.body, ctx));
        return;
      case 'every':
        ctx.every(effect.interval, effect.duration, () => this.runEffects(effect.body, ctx));
        return;
    }
  }

  /** Resolves a unit query to the living units it names, in a stable order. */
  units(query: UnitQuery, ctx: CastApi): Unit[] {
    switch (query.kind) {
      case 'self':
        return ctx.self.alive ? [ctx.self] : [];
      case 'target': {
        const target = ctx.target;
        return target?.alive ? [target] : [];
      }
      case 'eventUnit': {
        const unit = ctx.role(query.role);
        return unit?.alive ? [unit] : [];
      }
      case 'area':
        return ctx.area({
          who: query.who,
          radius: query.radius,
          from: this.anchor(query.anchor, ctx),
          other: query.other,
        });
      case 'filtered':
        return this.units(query.units, ctx).filter((unit) => this.matches(query.filter, unit, ctx));
    }
  }

  anchor(anchor: Anchor, ctx: CastApi): Vec2 | undefined {
    switch (anchor.kind) {
      case 'self':
        return ctx.self.pos;
      case 'target':
        return ctx.target?.pos;
      case 'targetPoint':
        return ctx.point;
      case 'eventUnit':
        return ctx.role(anchor.role)?.pos;
    }
  }

  value(node: ValueNode, ctx: CastApi): number {
    if (node.kind === 'const') return node.value;
    const [source] = this.units(node.of, ctx);
    if (!source) return 0;
    return (source.stat(node.stat) * node.percent) / 100;
  }

  matches(filter: UnitFilter, unit: Unit, ctx: CastApi): boolean {
    switch (filter.kind) {
      case 'stat':
        return compare(unit.stat(filter.stat), filter.op, this.value(filter.value, ctx));
      case 'statShare':
        // The share is of the *tested* unit's maximum, so every unit in an
        // area is measured against its own half health, not the caster's.
        return compare(unit.stat(filter.stat), filter.op, (unit.stat(filter.of) * filter.percent) / 100);
      case 'buff':
        return unit.hasBuff(filter.buff);
      case 'and':
        return this.matches(filter.left, unit, ctx) && this.matches(filter.right, unit, ctx);
      case 'or':
        return this.matches(filter.left, unit, ctx) || this.matches(filter.right, unit, ctx);
      case 'not':
        return !this.matches(filter.expression, unit, ctx);
    }
  }
}
