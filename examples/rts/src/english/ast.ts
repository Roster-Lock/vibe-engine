/**
 * The AST of the RTS Ability Language, and the diagnostic types it shares
 * with the editor.
 *
 * Every node carries a **span** — absolute character offsets into the
 * source. That is the difference between a toy parser and one an editor can
 * sit on: a diagnostic points at the exact bad word, hover help knows what
 * is under the cursor, and "go to definition" on a buff name can jump to
 * its `Buff` line. The parent project's language does the same thing for
 * the same reason (`src/english/ast.ts`).
 *
 * The AST is deliberately *not* the IR (`src/ir.ts`). It keeps source
 * detail the runtime has no use for (spans, the exact spelling of a buff
 * reference, whether the author wrote `when` or `whenever`), and `compile.ts`
 * is where that detail is resolved away.
 */
import type { Allegiance, Anchor, CompareOp, EventKind, Restriction, StatName, TargetingMode } from '../ir.js';

export interface Span {
  /** Absolute character offset of the first character (inclusive). */
  readonly start: number;
  /** Absolute character offset one past the last character (exclusive). */
  readonly end: number;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  readonly severity: Severity;
  readonly message: string;
  readonly start: number;
  readonly end: number;
  /** Stable code (`'unknown-buff'`, `'syntax'`) for tests and UI grouping. */
  readonly code: string;
}

/* -------------------------------- document -------------------------------- */

export interface Doc {
  readonly abilities: AbilitySection[];
  readonly buffs: BuffSection[];
}

/** A `Targeting:` / `Cooldown` / `Cost` / `Range` / `Duration` line. */
export type HeaderEntry =
  | { readonly kind: 'targeting'; readonly span: Span; readonly mode: TargetingMode; readonly modeSpan: Span }
  | { readonly kind: 'cooldown'; readonly span: Span; readonly seconds: number }
  | { readonly kind: 'cost'; readonly span: Span; readonly mana: number }
  | { readonly kind: 'range'; readonly span: Span; readonly range: number }
  | { readonly kind: 'duration'; readonly span: Span; readonly seconds: number };

export interface AbilitySection {
  readonly kind: 'ability';
  /** Grows as sentences are appended, so it always covers the whole section. */
  span: Span;
  readonly name: string;
  readonly nameSpan: Span;
  readonly header: HeaderEntry[];
  readonly sentences: Sentence[];
}

export interface BuffSection {
  readonly kind: 'buff';
  /** Grows as sentences are appended, so it always covers the whole section. */
  span: Span;
  readonly name: string;
  readonly nameSpan: Span;
  /** From `Buff Poisoned (stacks)`. */
  readonly stacks: boolean;
  readonly header: HeaderEntry[];
  readonly sentences: Sentence[];
}

/* -------------------------------- sentences ------------------------------- */

export type Sentence =
  | DamageSentence
  | HealSentence
  | AddBuffSentence
  | RemoveBuffSentence
  | KillSentence
  | SummonSentence
  | TeleportSentence
  | PushSentence
  | AfterSentence
  | EverySentence
  | WheneverSentence
  | ModifierSentence
  | RestrictionSentence;

/** `Deal 100 damage to all enemy units within 300 range of this unit.` */
export interface DamageSentence {
  readonly kind: 'damage';
  readonly span: Span;
  readonly amount: ValueExpr;
  readonly units: UnitPhrase;
}

/** `Heal the target for 200.` */
export interface HealSentence {
  readonly kind: 'heal';
  readonly span: Span;
  readonly amount: ValueExpr;
  readonly units: UnitPhrase;
}

/** `Add Slowed to all enemy units within 300 range of this unit.` */
export interface AddBuffSentence {
  readonly kind: 'addBuff';
  readonly span: Span;
  readonly buffName: string;
  readonly buffSpan: Span;
  readonly units: UnitPhrase;
}

/** `Remove Slowed from the target.` */
export interface RemoveBuffSentence {
  readonly kind: 'removeBuff';
  readonly span: Span;
  readonly buffName: string;
  readonly buffSpan: Span;
  readonly units: UnitPhrase;
}

/** `Kill all enemy units within 200 range of the target point with hp below 20%.` */
export interface KillSentence {
  readonly kind: 'kill';
  readonly span: Span;
  readonly units: UnitPhrase;
}

/** `Summon 2 Skeleton near this unit.` */
export interface SummonSentence {
  readonly kind: 'summon';
  readonly span: Span;
  readonly count: number;
  readonly countSpan: Span;
  readonly unitName: string;
  readonly unitSpan: Span;
  readonly anchor: AnchorPhrase;
}

/** `Teleport this unit to the target point.` */
export interface TeleportSentence {
  readonly kind: 'teleport';
  readonly span: Span;
  readonly units: UnitPhrase;
  readonly anchor: AnchorPhrase;
}

/** `Push all enemy units within 250 range of this unit back 150 units.` */
export interface PushSentence {
  readonly kind: 'push';
  readonly span: Span;
  readonly units: UnitPhrase;
  readonly distance: number;
  /** `from <anchor>`; defaults to the caster when omitted. */
  readonly anchor: AnchorPhrase | undefined;
}

/** `After 2 seconds, deal 300 damage to the target.` */
export interface AfterSentence {
  readonly kind: 'after';
  readonly span: Span;
  readonly delay: number;
  readonly body: Sentence[];
}

/** `Every 1 second for 12 seconds, heal the target for 20.` */
export interface EverySentence {
  readonly kind: 'every';
  readonly span: Span;
  readonly interval: number;
  /** Omitted on a buff, where the buff's own duration bounds the cadence. */
  readonly duration: number | undefined;
  readonly body: Sentence[];
}

/** `Whenever this unit takes damage, deal 25 damage to the attacker.` */
export interface WheneverSentence {
  readonly kind: 'whenever';
  readonly span: Span;
  readonly event: EventKind;
  readonly eventSpan: Span;
  readonly body: Sentence[];
}

/** `Reduce movement speed by 50%.` — buff sections only. */
export interface ModifierSentence {
  readonly kind: 'modifier';
  readonly span: Span;
  readonly stat: 'moveSpeed' | 'attackDamage' | 'armor' | 'attackSpeed';
  readonly mode: 'flat' | 'percent';
  /** Already signed: `Reduce … by 50%` stores `-50`. */
  readonly amount: number;
}

/** `Cannot move.` — buff sections only. */
export interface RestrictionSentence {
  readonly kind: 'restriction';
  readonly span: Span;
  readonly restriction: Restriction;
}

/* ---------------------------------- nouns --------------------------------- */

/** A number, or a percentage of some unit's stat. */
export type ValueExpr =
  | { readonly kind: 'const'; readonly span: Span; readonly value: number }
  | {
      readonly kind: 'statPercent';
      readonly span: Span;
      readonly percent: number;
      readonly of: UnitRef;
      readonly stat: StatName;
      readonly statSpan: Span;
    };

/** A single unit named without a group phrase: the possessive's subject. */
export type UnitRef =
  | { readonly kind: 'self' }
  | { readonly kind: 'target' }
  | { readonly kind: 'eventUnit'; readonly role: 'attacker' | 'victim' | 'killer' };

/** `of this unit` / `of the target point` — where a radius is measured from. */
export interface AnchorPhrase {
  readonly span: Span;
  readonly anchor: Anchor;
}

/** The set of units a sentence acts on. */
export interface UnitPhrase {
  readonly span: Span;
  readonly selector: Selector;
  readonly filter: FilterExpr | undefined;
}

export type Selector =
  | { readonly kind: 'self' }
  | { readonly kind: 'target' }
  | { readonly kind: 'eventUnit'; readonly role: 'attacker' | 'victim' | 'killer' }
  | {
      readonly kind: 'area';
      readonly who: Allegiance;
      /** `all other ally units` — excludes the caster. */
      readonly other: boolean;
      readonly radius: number;
      readonly radiusSpan: Span;
      readonly anchor: AnchorPhrase;
    };

/** A `with …` condition tree; parentheses and `not` survive into the IR. */
export type FilterExpr =
  | {
      readonly kind: 'stat';
      readonly span: Span;
      readonly stat: StatName;
      readonly statSpan: Span;
      readonly op: CompareOp;
      readonly value: number;
      /** `hp below 50%` — compare against a share of the maximum, not a raw number. */
      readonly percentOfMax: boolean;
    }
  | { readonly kind: 'buff'; readonly span: Span; readonly buffName: string; readonly buffSpan: Span }
  | { readonly kind: 'and' | 'or'; readonly span: Span; readonly left: FilterExpr; readonly right: FilterExpr }
  | { readonly kind: 'not'; readonly span: Span; readonly expression: FilterExpr };

/** Joins two spans into the one that covers both. */
export function spanning(from: Span, to: Span): Span {
  return { start: Math.min(from.start, to.start), end: Math.max(from.end, to.end) };
}
