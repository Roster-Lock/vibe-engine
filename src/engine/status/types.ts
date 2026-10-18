/**
 * The status types: the shared interface a Buff and a Skill implement, the
 * defs content authors write, and the discriminated `Status` union.
 *
 * Both kinds of status:
 * - have a **weight** used to sort the list (ascending)
 * - carry their **own internal variables** (each instance gets a fresh copy)
 * - **add abilities** to their character — transform hooks, event listeners,
 *   restriction predicates ("cannot be X if Y"), and buff:destroyed
 *   self-listening triggers for when a status ends
 * - know **who created them** (`caster`) and **which character they are
 *   attached to** (`target`)
 *
 * The difference:
 * - a **Buff** can be added to a character at runtime and is **removed when
 *   its wearer (the character it is attached to) is defeated** by default
 *   (`removedOnDefeat: false` opts out). The buff's **creator** being
 *   defeated has no effect — a fallen caster's buffs stick around on their
 *   targets. Removal is also the default for dispels, but a buff may opt
 *   out with `removable: false` — an aura's permanent mark: applied at
 *   runtime, never dispelled, still weighted. Such a mark dies with the
 *   status that **granted** it (see `StatusBase.grantedBy`): when the
 *   granting aura is removed, its marks are destroyed with it — that is
 *   their only way out. A buff's buff:destroyed self-triggers fire on *any*
 *   end (dispelled, wearer destroyed, cascade) — e.g. a bomb that explodes
 *   when it goes away.
 * - a **Skill** is permanent — it is given at character creation and can
 *   never be added or removed
 */
import type { Ability } from '../ability/index.js';
import type { Character } from '../character.js';
import type { Buff } from './buff.js';
import type { Skill } from './skill.js';

/** Fields shared by Buffs and Skills once they sit on a character. */
export interface StatusBase {
  /**
   * The definition id — the **kind** of status this is ('poison',
   * 'corpse-trap', …), shared by every instance of the same buff/skill.
   */
  readonly id: string;
  /**
   * A unique id for this **instance** — distinct from `id` (the kind).
   * Every status instance (each buff application, each skill) gets a fresh,
   * never-reused `uid`, so instances of the same buff can be told apart:
   *
   * - a stacked bomb's own `buff:destroyed` self-trigger matches
   *   `ctx.event.buff.uid === ctx.status.uid` (only the removed copy
   *   detonates, not every copy of the id — the trigger context exposes
   *   the owning `status`);
   * - `removeBuff` / `findBuff` **by instance** match the `uid`, so the
   *   exact instance is removed, not just the first of its kind.
   */
  readonly uid: string;
  readonly name: string;
  /** Discriminator: `'buff'` or `'skill'`. */
  readonly type: 'buff' | 'skill';
  /** Short human-readable description of what the status does. */
  readonly description?: string;
  /** Optional SVG icon (URL or data URI) shown next to the status. */
  readonly icon?: string;
  /** Sort key; the status list is ordered by weight, ascending. */
  readonly weight: number;
  /**
   * Whether the status can be removed at runtime. `true` for ordinary
   * buffs; `false` for skills and for buffs declared `removable: false`
   * (an aura's permanent mark).
   */
  readonly removable: boolean;
  /** This instance's own variables (e.g. `{ stacks: 3 }`). */
  readonly vars: Record<string, unknown>;
  /**
   * Abilities granted to the character while this status is attached. One
   * kind is the **restriction** ability — "cannot be X if Y" rules (see
   * `restriction` in ability/restriction.ts, docs/design/11-restrictions.md).
   * The engine consults them at the targeting, destroy, action-pipeline and
   * win/lose gates. A restriction's `when` sees the would-be target as
   * `ctx.self`.
   */
  readonly abilities: readonly Ability[];
  /**
   * The character that created this status — who applied the buff, cast the
   * skill, etc. `undefined` for innate skills and for buffs applied with no
   * source.
   */
  readonly caster: Character | undefined;
  /**
   * The character this status is attached to. `undefined` until the status
   * is actually put on a character (e.g. a buff instance built by hand).
   */
  readonly target: Character | undefined;
  /**
   * The status that **granted** this one — e.g. an aura buff applying its
   * permanent mark. `undefined` for skills and for buffs applied directly
   * by a character (or with no source). When a status that granted
   * `removable: false` marks is removed, those marks are destroyed with it
   * (see `GameEngine`'s removal cascade).
   */
  readonly grantedBy: Status | undefined;
  /**
   * The status's declared **ordering direction** — `'out to in'` or
   * `'in to out'`. A *declared property of the buff*, never derived from who
   * cast it: a self-cast buff can be `'out to in'`, an enemy-cast one
   * `'in to out'`. Where it matters is the status list's insertion among
   * equal weights: `'out to in'` statuses are inserted **before**
   * `'in to out'` (and direction-less) ones — on the outside of their
   * weight group (the front of the list, where the lightest weights sit);
   * `'in to out'` statuses keep the stable position after same-weight
   * statuses (toward the inside — the back). `undefined` keeps the stable
   * insertion order (after same-weight statuses). See `StatusManager.insert`.
   */
  readonly direction: StatusDirection | undefined;
}

/** The declared ordering direction of a status among same weights — see `StatusBase.direction`. */
export type StatusDirection = 'out to in' | 'in to out';

/**
 * A status on a character: a `Buff` or a `Skill`. A **discriminated union**
 * on `type` — so content can narrow by the lowercase English discriminant:
 *
 * ```ts
 * if (status.type === 'buff') {
 *   // status is a Buff here: stacks, removedOnDefeat, … are visible
 * }
 * ```
 */
export type Status = Buff | Skill;

export type Statuses = Status[];

/** How a status is described by a content creator. */
export interface StatusDef {
  readonly id?: string;
  readonly name: string;
  /** Short human-readable description of what the status does. */
  readonly description?: string;
  /** Optional SVG icon (URL or data URI) shown next to the status. */
  readonly icon?: string;
  readonly weight: number;
  /** Fresh variables for every new instance. Defaults to `() => ({})`. */
  readonly variables?: () => Record<string, unknown>;
  /**
   * Abilities granted to the character while this status is attached —
   * including **restriction** abilities ("cannot be X if Y" rules, built
   * with `restriction(...)`). Defaults to none (the engine's default
   * behavior is unchanged without them).
   */
  readonly abilities?: readonly Ability[];
  /**
   * Declared ordering direction among same-weight statuses: `'out to in'`
   * statuses are inserted before `'in to out'` (and direction-less) ones —
   * see `StatusBase.direction`. Defaults to `undefined` (stable insertion).
   */
  readonly direction?: StatusDirection;
}

/* ------------------------------- Buff ------------------------------- */

export interface BuffDef extends StatusDef {
  /**
   * Whether the buff can be removed once applied. When `false` the buff can
   * still be **added** at runtime (e.g. by an aura), but any removal is a
   * no-op — it is permanent, like a skill, while keeping its `weight`,
   * variables and abilities. Defaults to `true`.
   */
  readonly removable?: boolean;
  /**
   * When `true`, the buff **dies with its wearer**: the moment the character
   * it is **attached to** is destroyed, the buff is destroyed in the same
   * batch — a bomb that goes off when its wearer dies. The death is
   * announced as `buff:destroyed` with `reason: 'wearer-destroyed'` (a
   * dispelled buff carries `reason: 'removed'` and its `source`), and the
   * death's triggers were also collected before the buffs die (the same-batch
   * principle; see `GameEngine.#destroyPhase`). **Defaults to `true`** —
   * every buff dies with its wearer; set `false` to let it survive the
   * wearer's death.
   *
   * This is strictly about the **wearer**: the buff's **creator** (the
   * character that applied it) being destroyed has no effect — a bomb
   * planted by a fallen mage stays armed on its target. (The one nuance:
   * an aura's marks are destroyed when the aura's own wearer falls, because
   * the aura — a buff attached to that character — dies by this rule, and
   * the cascade follows. That is the aura's death, not the marks' creator
   * dying.)
   */
  readonly removedOnDefeat?: boolean;
}

/* ------------------------------ Skill ------------------------------- */

export interface SkillDef extends StatusDef {}
