/**
 * The ability IR — what English *becomes*.
 *
 * This is the pivot of the whole example. `src/english/` parses sentences
 * into an AST and lowers that AST into the plain-data tree below; from here
 * two consumers take over and must agree exactly:
 *
 * - `src/english/runtime.ts` walks the tree and runs it against the sim;
 * - `src/english/codegen.ts` prints the tree as TypeScript source, which the
 *   compiler then checks and which runs through the same `CastContext`.
 *
 * `test/equivalence.test.ts` runs a battle both ways and asserts the same
 * outcome, so "English compiles to executable code" is a fact the suite
 * enforces rather than a claim in a README.
 *
 * Everything here is JSON: no closures, no class instances, no engine
 * references. That is deliberate — an IR that survives `JSON.stringify` is
 * also the share format (docs/GOAL.md, "the language and the share format
 * are the same problem"), so an ability written by one player can travel to
 * another and run identically.
 */

/** How a player (or the AI) picks what an ability is cast on. */
export type TargetingMode =
  /** No target — fires where the caster stands (Thunder Clap). */
  | 'none'
  /** Any single unit (Inner Fire on anyone). */
  | 'unit'
  /** A single hostile unit (Storm Bolt). */
  | 'enemyUnit'
  /** A single friendly unit, the caster included (Holy Light). */
  | 'allyUnit'
  /** A point on the map (Carrion Swarm, Blink). */
  | 'point';

/** Unit statistics a value or a filter may read. */
export type StatName = 'hp' | 'maxHp' | 'mana' | 'maxMana' | 'attackDamage' | 'moveSpeed' | 'armor';

/** Comparison operators of a `with …` filter. */
export type CompareOp = '<' | '<=' | '>' | '>=' | '=' | '!=';

/** Which unit an event-bound noun refers to inside a `whenever …` trigger. */
export type EventRole =
  /** `the attacker` — who dealt the damage. */
  | 'attacker'
  /** `the victim` — who took it. */
  | 'victim'
  /** `the killer` — who landed the killing blow. */
  | 'killer';

/**
 * A number in a sentence. Either a literal, or a percentage of some unit's
 * stat — `deal damage equal to 50% of this unit's attack damage`, the
 * scaling every Warcraft 3 hero ability is built on.
 */
export type ValueNode =
  | { readonly kind: 'const'; readonly value: number }
  | {
      readonly kind: 'stat';
      readonly of: UnitQuery;
      readonly stat: StatName;
      /** `100` means the whole stat; `50` means half of it. */
      readonly percent: number;
    };

/** A position on the map: whatever a `within … range of <anchor>` measures from. */
export type Anchor =
  | { readonly kind: 'self' }
  | { readonly kind: 'target' }
  | { readonly kind: 'targetPoint' }
  | { readonly kind: 'eventUnit'; readonly role: EventRole };

/** A `with …` condition, as a recursive expression so parentheses survive. */
export type UnitFilter =
  /** `with hp < 200` — compared against a fixed amount. */
  | { readonly kind: 'stat'; readonly stat: StatName; readonly op: CompareOp; readonly value: ValueNode }
  /**
   * `with hp below 50%` — compared against a share of the tested unit's own
   * maximum. It needs its own node because the threshold is per-unit: a
   * `ValueNode` is evaluated once for the whole query, which would compare
   * every unit in the area against the *caster's* half health.
   */
  | {
      readonly kind: 'statShare';
      readonly stat: StatName;
      readonly op: CompareOp;
      readonly percent: number;
      /** The maximum the share is taken of — `maxHp` for `hp below 50%`. */
      readonly of: StatName;
    }
  | { readonly kind: 'buff'; readonly buff: string }
  | { readonly kind: 'and' | 'or'; readonly left: UnitFilter; readonly right: UnitFilter }
  | { readonly kind: 'not'; readonly expression: UnitFilter };

/** Relative-to-caster allegiance of an area query. */
export type Allegiance = 'any' | 'enemy' | 'ally';

/** The set of units an effect lands on. */
export type UnitQuery =
  /** `this unit` — the caster. */
  | { readonly kind: 'self' }
  /** `the target` — whatever the cast was aimed at. */
  | { readonly kind: 'target' }
  /** `the attacker` / `the victim` / `the killer`. */
  | { readonly kind: 'eventUnit'; readonly role: EventRole }
  /** `all enemy units within 300 range of this unit`. */
  | {
      readonly kind: 'area';
      readonly who: Allegiance;
      readonly radius: number;
      readonly anchor: Anchor;
      /** `all other ally units` — excludes the caster. */
      readonly other: boolean;
    }
  /**
   * `… with hp below 15%` — narrows any other query.
   *
   * It wraps rather than living on each variant so that a filter works the
   * same everywhere: `Kill the target with hp below 15%` is a conditional
   * effect on one unit, and `Kill all enemy units with hp below 15%` is the
   * same test applied to a group. Folding the filter into the area variant
   * only, as an earlier version did, silently ignored the first one.
   */
  | { readonly kind: 'filtered'; readonly units: UnitQuery; readonly filter: UnitFilter };

/** One executable step of an ability or trigger body. */
export type EffectNode =
  | { readonly kind: 'damage'; readonly amount: ValueNode; readonly units: UnitQuery }
  | { readonly kind: 'heal'; readonly amount: ValueNode; readonly units: UnitQuery }
  | { readonly kind: 'addBuff'; readonly buff: string; readonly units: UnitQuery }
  | { readonly kind: 'removeBuff'; readonly buff: string; readonly units: UnitQuery }
  | { readonly kind: 'kill'; readonly units: UnitQuery }
  | { readonly kind: 'summon'; readonly unit: string; readonly count: number; readonly anchor: Anchor }
  | { readonly kind: 'teleport'; readonly units: UnitQuery; readonly anchor: Anchor }
  | { readonly kind: 'knockback'; readonly units: UnitQuery; readonly distance: number; readonly anchor: Anchor }
  /** `After 2 seconds, …` — the body runs once, later. */
  | { readonly kind: 'after'; readonly delay: number; readonly body: readonly EffectNode[] }
  /** `Every 1 second for 12 seconds, …` — the body runs on a cadence. */
  | {
      readonly kind: 'every';
      readonly interval: number;
      readonly duration: number;
      readonly body: readonly EffectNode[];
    };

/** The events a `whenever …` trigger can subscribe to. */
export type EventKind =
  /** `whenever this unit takes damage` */
  | 'damaged'
  /** `whenever this unit dies` */
  | 'died'
  /** `whenever this unit attacks` */
  | 'attacks'
  /** `whenever this unit kills a unit` */
  | 'kills'
  /** `whenever this unit casts an ability` */
  | 'casts';

export interface TriggerNode {
  readonly event: EventKind;
  readonly effects: readonly EffectNode[];
}

/** A flat or percentage change to one stat, contributed by a buff. */
export interface ModifierNode {
  readonly stat: 'moveSpeed' | 'attackDamage' | 'armor' | 'attackSpeed';
  readonly mode: 'flat' | 'percent';
  /** Signed: `-50` with `percent` on `moveSpeed` is a 50% slow. */
  readonly amount: number;
}

/** What a buff forbids while it is on a unit. */
export type Restriction = 'move' | 'attack' | 'cast';

/** `Every 1 second, deal 5 damage to this unit.` on a buff — bounded by its duration. */
export interface PeriodicNode {
  readonly interval: number;
  readonly effects: readonly EffectNode[];
}

/** A compiled `Buff` section. */
export interface BuffProgram {
  readonly id: string;
  readonly name: string;
  /** Seconds; `0` means it never expires on its own. */
  readonly duration: number;
  readonly stacks: boolean;
  readonly modifiers: readonly ModifierNode[];
  readonly restrictions: readonly Restriction[];
  readonly triggers: readonly TriggerNode[];
  readonly periodic: readonly PeriodicNode[];
}

/** A compiled `Ability` section. */
export interface AbilityProgram {
  readonly id: string;
  readonly name: string;
  readonly targeting: TargetingMode;
  /** Seconds between casts. */
  readonly cooldown: number;
  readonly manaCost: number;
  /** How far the cast may reach; `0` means unlimited (self-centered casts). */
  readonly castRange: number;
  readonly effects: readonly EffectNode[];
  /** `whenever …` sentences written directly on the ability — a passive. */
  readonly triggers: readonly TriggerNode[];
}

/** Everything one document compiles to. */
export interface Program {
  readonly abilities: readonly AbilityProgram[];
  readonly buffs: readonly BuffProgram[];
}

/** `Curse of Frailty` → `curse-of-frailty`. Ids are how effects reference buffs. */
export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
