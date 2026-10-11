/**
 * Units — the things on the map that compiled abilities act on.
 *
 * A `UnitDef` is the stat line a content creator writes (see
 * `src/content/units.ts`); a `Unit` is one live instance of it. The split
 * matters because every Footman shares a def but carries its own hp, mana,
 * cooldowns and buff list.
 *
 * **Stats are derived, never written.** `unit.moveSpeed` is the def's base
 * put through every buff modifier currently on the unit, recomputed on read.
 * Nothing in the sim or in a compiled ability may assign to a stat — a slow
 * is a buff with a `-50% moveSpeed` modifier, and it goes away when the buff
 * does, with no bookkeeping to get wrong. This is the same rule the parent
 * engine enforces for gauge maximums (docs/spec/01-gauge.md).
 */
import type { BuffProgram, Restriction, StatName } from '../ir.js';
import type { Vec2 } from './vec.js';

export interface UnitDef {
  readonly id: string;
  readonly name: string;
  readonly maxHp: number;
  /** Hit points regained per second. */
  readonly hpRegen: number;
  readonly maxMana: number;
  /** Mana regained per second. */
  readonly manaRegen: number;
  /** Warcraft-style armor: each point is diminishing-returns damage reduction. */
  readonly armor: number;
  /** Map units per second. */
  readonly moveSpeed: number;
  readonly attackDamage: number;
  /** How close the unit must be to swing (melee is ~90). */
  readonly attackRange: number;
  /** Seconds between swings. */
  readonly attackCooldown: number;
  /** How far the unit looks for something to fight. */
  readonly acquisitionRange: number;
  /** Physical size — used to keep units from standing inside each other. */
  readonly radius: number;
  /** Ids of compiled abilities this unit knows, in cast-priority order. */
  readonly abilities: readonly string[];
}

/** One buff currently on a unit. */
export interface BuffInstance {
  readonly program: BuffProgram;
  /** World time at which it falls off; `Infinity` for a permanent buff. */
  expiresAt: number;
  stacks: number;
  /** Who applied it — `the attacker` of a retaliation trigger, for instance. */
  readonly source: Unit | undefined;
  /** World time each of the program's periodic entries next fires. */
  readonly nextTick: number[];
}

/**
 * Warcraft 3's armor curve: 6% reduction per point, with diminishing
 * returns, and negative armor amplifies. Kept here (rather than in the
 * damage call) so the tooltip math and the sim math cannot drift.
 */
export function armorMultiplier(armor: number): number {
  if (armor >= 0) return 1 - (0.06 * armor) / (1 + 0.06 * armor);
  return 2 - Math.pow(0.94, -armor);
}

let nextUnitId = 1;

/** Resets the unit-id counter — tests call this so ids are reproducible. */
export function resetUnitIds(): void {
  nextUnitId = 1;
}

export class Unit {
  readonly id: number;
  readonly def: UnitDef;
  /** Team number; units on different teams are hostile. */
  readonly team: number;
  pos: Vec2;
  hp: number;
  mana: number;
  alive = true;
  /** World time at which each ability id comes off cooldown. */
  readonly cooldowns = new Map<string, number>();
  /** World time at which the next auto-attack may land. */
  nextAttackAt = 0;
  readonly buffs: BuffInstance[] = [];
  /** Who this unit is currently fighting. */
  attackTarget: Unit | undefined;

  constructor(def: UnitDef, team: number, pos: Vec2) {
    this.id = nextUnitId++;
    this.def = def;
    this.team = team;
    this.pos = pos;
    this.hp = def.maxHp;
    this.mana = def.maxMana;
  }

  get name(): string {
    return this.def.name;
  }

  /** `"Footman#3"` — stable, readable, and unique within a battle. */
  get label(): string {
    return `${this.def.name}#${this.id}`;
  }

  /* ----------------------------- derived stats ----------------------------- */

  /**
   * Sums this unit's buff modifiers for one stat: flat bonuses first, then
   * percentages applied to that subtotal. Percentages are **additive** with
   * each other (two 50% slows stop a unit, they do not leave it at 25%) —
   * the Warcraft 3 convention, and the one that makes stacked debuffs
   * predictable to a creator.
   */
  #modified(stat: 'moveSpeed' | 'attackDamage' | 'armor' | 'attackSpeed', base: number): number {
    let flat = 0;
    let percent = 0;
    for (const instance of this.buffs) {
      for (const modifier of instance.program.modifiers) {
        if (modifier.stat !== stat) continue;
        const amount = modifier.amount * instance.stacks;
        if (modifier.mode === 'flat') flat += amount;
        else percent += amount;
      }
    }
    return (base + flat) * (1 + percent / 100);
  }

  get maxHp(): number {
    return this.def.maxHp;
  }

  get maxMana(): number {
    return this.def.maxMana;
  }

  get moveSpeed(): number {
    return Math.max(0, this.#modified('moveSpeed', this.def.moveSpeed));
  }

  get attackDamage(): number {
    return Math.max(0, this.#modified('attackDamage', this.def.attackDamage));
  }

  get armor(): number {
    return this.#modified('armor', this.def.armor);
  }

  /** Seconds between swings, shortened by `attackSpeed` buffs. */
  get attackCooldown(): number {
    const haste = this.#modified('attackSpeed', 0);
    return this.def.attackCooldown / Math.max(0.1, 1 + haste / 100);
  }

  /** Reads a stat by its IR name — what `with hp < 200` and `50% of …` compile to. */
  stat(name: StatName): number {
    switch (name) {
      case 'hp':
        return this.hp;
      case 'maxHp':
        return this.maxHp;
      case 'mana':
        return this.mana;
      case 'maxMana':
        return this.maxMana;
      case 'attackDamage':
        return this.attackDamage;
      case 'moveSpeed':
        return this.moveSpeed;
      case 'armor':
        return this.armor;
    }
  }

  /* -------------------------------- buffs --------------------------------- */

  hasBuff(buffId: string): boolean {
    return this.buffs.some((instance) => instance.program.id === buffId);
  }

  buffInstance(buffId: string): BuffInstance | undefined {
    return this.buffs.find((instance) => instance.program.id === buffId);
  }

  /** True when no buff on this unit forbids `what`. */
  can(what: Restriction): boolean {
    return !this.buffs.some((instance) => instance.program.restrictions.includes(what));
  }
}
