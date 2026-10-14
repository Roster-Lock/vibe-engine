/**
 * The **declarative IR**: abilities, buffs and triggers as plain JSON.
 *
 * This is the layer `src/english/` lowers into and `src/ir/bind/` binds to
 * an engine. Nothing here imports an engine, an action, or a `Character` —
 * the only import is `MathExpression`, which is itself pure data. That
 * constraint is load-bearing: it is what makes a document
 * `JSON.stringify`-able, and therefore shareable (docs/GOAL.md).
 *
 * Naming convention: a slot a player fills with *a choice from a fixed set*
 * is a literal field (`who`, `op`, `gauge`); a slot a player fills with *an
 * arbitrary expression* is a `ValueIR`/`PredicateIR` tree. Where neither is
 * enough, `src/ir/declared-fn/` is the escape hatch the binder can accept —
 * but the English surface deliberately produces only the shapes below, so
 * everything a player writes stays inspectable field-by-field.
 */
import type { MathExpression } from './math-expression.js';

/**
 * Bumped whenever a change to the shapes below is not backward compatible.
 * Imported content carrying a higher version is rejected rather than
 * silently misread.
 */
export const IR_VERSION = 1;

/** Numeric comparison, shared by filters and count checks. */
export type CompareOp = '<' | '<=' | '>' | '>=' | '=' | '!=';

/** What a gauge effect does to its gauge (`damage` is `subtract` on the life gauge). */
export type GaugeOp = 'add' | 'subtract' | 'set';

/**
 * A buff reference: the name as written. Resolved at **bind** time against
 * the document's own `Buff` declarations, the host dictionary, or an import
 * — never embedded as a definition, so a document stays plain data and a
 * missing buff is a diagnostic rather than a dangling object.
 */
export type BuffRefIR = string;

/** A module import (`import Frailty from "./buffs/Frailty.buff"`). */
export interface ImportIR {
  readonly name: string;
  readonly path: string;
}

/* ------------------------------- values ------------------------------- */

/**
 * A number the IR can compute. `const` is the overwhelmingly common case
 * and stays a bare value so simple content reads simply.
 *
 * `count` is why this is a tree and not a number: "the number of creatures
 * that died" is both a *value* an amount can use ("deal damage equal to
 * …") and the thing a trigger's gate compares ("when 2 to 5 … die"). One
 * node type serves both.
 */
export type ValueIR =
  | { readonly kind: 'const'; readonly value: number }
  /**
   * How many entities a query matches. Inside a trigger,
   * `{ kind: 'event', role: 'subject' }` is **the triggering set** — the
   * entities that survived the trigger's filter — so a count phrase is
   * `count(event subjects)` compared against a constant.
   */
  | { readonly kind: 'count'; readonly query: EntityQueryIR }
  /**
   * A gauge's current value. With no `of`, it reads **the entity in
   * scope** — the candidate a filter is testing — which is what makes
   * `with hp < 10` an ordinary comparison rather than its own node kind.
   * With an `of`, it reads the query's **first** match (`of: self` being
   * the common case); zero when the query matches nothing.
   */
  | { readonly kind: 'gauge'; readonly gauge: string; readonly of?: EntityQueryIR }
  /**
   * A **named numeric fact** the game declared on an entity (`Entity.attributes`)
   * — a card's `cost`, a `land` flag, a printed `power`.
   *
   * Not a gauge: a gauge is a value the engine maintains and clamps, while an
   * attribute is a fact the game states once. Keeping them apart is what lets
   * the engine filter an entity it knows nothing about without growing a field
   * per game concept. With no `of`, it reads the entity in scope, like `gauge`.
   * An absent name reads **0**.
   */
  | { readonly kind: 'attribute'; readonly attribute: string; readonly of?: EntityQueryIR }
  /** The formula language (Σ, arithmetic, paths) for anything else. */
  | { readonly kind: 'expr'; readonly expression: MathExpression };

/* ----------------------------- predicates ----------------------------- */

/**
 * **The** boolean vocabulary — one type for every condition in the IR: a
 * trigger's gate, a group's `with …` filter, a targeting restriction, a
 * step's `if …`.
 *
 * Nodes come in two scopes, and the difference is which questions make
 * sense where:
 *
 * - **context-scoped** (`compare`, `and`/`or`/`not`, `any`/`every`) ask
 *   about the situation — how many triggered, what the board holds;
 * - **entity-scoped** (`hasBuff`, `relation`, and a `gauge` value with no
 *   `of`) ask about *the entity in scope*: the candidate a group filter is
 *   testing, or each element of an `any`/`every`.
 *
 * An entity-scoped question asked where no entity is in scope is **false**
 * (and a scopeless `gauge` value reads 0) rather than an error — the
 * English surface cannot produce one, and a hand-written IR should degrade
 * rather than throw mid-battle.
 *
 * `any`/`every` are the bridge: they resolve a query and re-enter with each
 * match in scope, so a count gate and a per-entity test compose — "two or
 * more died **and one of them** was a dragon".
 */
export type PredicateIR =
  | { readonly kind: 'always' }
  | { readonly kind: 'compare'; readonly op: CompareOp; readonly left: ValueIR; readonly right: ValueIR }
  | { readonly kind: 'and' | 'or'; readonly clauses: readonly PredicateIR[] }
  | { readonly kind: 'not'; readonly expression: PredicateIR }
  /**
   * `an even number of …` / `an odd number of …`.
   *
   * Its own node rather than a remainder operator, because `%` is reserved
   * for percent — a `%` meaning remainder would be misread as a percentage
   * every time — and because parity is the only thing remainder was ever
   * serving here. It also reads back as words, which a formula does not.
   */
  | { readonly kind: 'parity'; readonly value: ValueIR; readonly parity: 'even' | 'odd' }
  | {
      readonly kind: 'any' | 'every';
      readonly query: EntityQueryIR;
      readonly test: PredicateIR;
    }
  /** `with poison` — the entity in scope currently carries that buff. */
  | { readonly kind: 'hasBuff'; readonly buff: BuffRefIR }
  /**
   * `owned by you` / `controlled by an opponent` — the entity in scope's
   * relationship to the ability's owner. A relation, not a property, which
   * is why it cannot be spelled as a comparison.
   */
  | {
      readonly kind: 'relation';
      /**
       * `self` is the entity in scope **being** the ability's owner — what
       * "this character" means as a trigger subject ("when this character
       * dies"). The others are relations to the owner's controller.
       */
      readonly to: 'self' | 'you' | 'opponent' | 'ally' | 'enemy';
    };

/* ------------------------------- queries ------------------------------ */

/**
 * Which entity an event-bound noun refers to inside a trigger:
 * - `subject` — who the event happened *to* (the character that died, the
 *   gauge's owner);
 * - `source` — who *caused* it (`the attacker`).
 */
export type EventRole = 'subject' | 'source';

/** Who an effect lands on — the noun phrase, lowered. */
export type EntityQueryIR =
  /** `this character` — the ability's owner. */
  | { readonly kind: 'self' }
  /** `target …` — whatever the player picked for this ability. */
  | { readonly kind: 'picked' }
  /** `the victim` — one of the ability's **named** picks (see `TargetBindingIR`). */
  | { readonly kind: 'bound'; readonly name: string }
  /**
   * `the source character` — an entity the triggering event supplies.
   *
   * `sourceType` is **required** for a `source` role, because
   * `EventSource` is a union: the cause of an event may be a character or
   * a buff (`src/engine/events.ts`), and one day a player. An effect aimed
   * at "the source" without saying which would silently do nothing for
   * every kind it cannot act on — so the kind is in the text, where an
   * author can see which causes their card responds to.
   */
  | { readonly kind: 'event'; readonly role: EventRole; readonly sourceType?: 'character' | 'buff' }
  /** `all [other] [enemy|ally] characters [owned by …] [with …]`. */
  | {
      readonly kind: 'all';
      readonly who: 'ally' | 'enemy' | 'any';
      /** `all other …` — excludes the ability's owner. */
      readonly other: boolean;
      /** Evaluated per candidate, with that candidate as the entity in scope. */
      readonly filter?: PredicateIR;
    };

/* ------------------------------- effects ------------------------------ */

/** One effect — the verb of a sentence plus the noun it acts on. */
export type EffectIR =
  /** Damage, healing and direct gauge writes are one node (see actions.ts). */
  | {
      readonly kind: 'gauge';
      readonly query: EntityQueryIR;
      /**
       * Which gauge to write — the same selector `ActionMatchIR.gauge`
       * uses, and for the same reason: `Deal`/`Heal` mean the target's
       * declared life gauge (`{ kind: 'life' }`), not a literal `'hp'`, so
       * the word "damage" means one thing on both sides of the language.
       * A named id (`'mana'`) writes that gauge. Resolved per entity, so
       * one effect hitting a fighter and a planeswalker moves hp on one
       * and loyalty on the other; an entity that has no such gauge is
       * skipped.
       */
      readonly gauge: string | { readonly kind: 'life' };
      readonly op: GaugeOp;
      readonly amount: ValueIR;
    }
  | { readonly kind: 'destroy'; readonly query: EntityQueryIR }
  | { readonly kind: 'addBuff'; readonly query: EntityQueryIR; readonly buff: BuffRefIR }
  | { readonly kind: 'removeBuff'; readonly query: EntityQueryIR; readonly buff: BuffRefIR }
  /**
   * Flips the buff: attached entities lose it, unattached ones gain it.
   *
   * Its own effect rather than two guarded steps, because steps resolve
   * **one at a time with effects landing between them** — so "if it has
   * it, remove it" followed by "if it does not, add it" removes and then
   * immediately re-adds, and the toggle is stuck on. (There is a test for
   * that, so the reason stays visible.) Deciding once, per entity, from
   * the state before anything applies is what makes it a toggle.
   *
   * On/off state lives in the buff, so there is no toggle state anywhere
   * else to keep in sync — and a UI reads the same buff to pick the lit or
   * unlit icon.
   */
  | { readonly kind: 'toggleBuff'; readonly query: EntityQueryIR; readonly buff: BuffRefIR }
  /**
   * **Reveal until a card is worth taking** — Discover, generalised. See
   * `DiscoverAction` for the mechanic and `GameEngine.#discover` for why it is
   * an action rather than a bind-time loop.
   *
   * Zone names here are **abstract** (`library`, `board`) and the host maps
   * them to its own declared zones (`BindOptions.aliases`), because the engine
   * names no game's zones and the IR is the share format: a document must mean
   * the same thing in a game whose library is called `deck`, `library` or
   * `pile`. The `count` and the cost ceiling are ordinary values, so "discover
   * 2" and "discover this card's power" are the same node.
   */
  | {
      readonly kind: 'discover';
      readonly count: ValueIR;
      /** Taken only when the entity's `cost` attribute is at most this. */
      readonly maxCost: ValueIR;
      readonly from: string;
      /**
       * The temporary zone a looked-at card waits in. Its members at the end
       * are what "the rest" means, which is why the IR names it rather than
       * leaving the handler to remember a list.
       */
      readonly revealed: string;
      readonly to: string;
      /** Where the looked-at-but-untaken go, shuffled. */
      readonly rest: string;
      /**
       * Cards this test answers **true** for are passed over: they are revealed
       * and put aside, but never offered. This is the "or a land" half of
       * "reveal until you find a nonland card with cost ≤ 2" — a land has no
       * cost to compare, so the cost ceiling alone cannot exclude it without
       * also excluding every free card.
       */
      readonly skip?: PredicateIR;
    }
  /** `You win the game.` / `All players lose the game.` */
  | { readonly kind: 'result'; readonly players: 'you' | 'all'; readonly win: boolean };

/** True for the effects that act on entities (i.e. carry a `query`). */
export function isEntityEffect(
  effect: EffectIR,
): effect is Extract<EffectIR, { query: EntityQueryIR }> {
  return effect.kind !== 'result';
}

/**
 * One sentence's worth of effects.
 *
 * Steps matter because **a multi-sentence ability resolves one sentence at
 * a time** — each step's effects land (gauges flush, deaths resolve, queued
 * triggers run) before the next step's queries are evaluated, so
 * "Add Poison to all enemies. Destroy all enemies with poison." works. A
 * single-step ability keeps the engine's one-shot apply.
 */
/**
 * How a step repeats. Each iteration, in this order:
 *
 * 1. `max` reached → stop;
 * 2. `while` present and false → stop — **and do not ask**;
 * 3. `confirm` present → ask the controller; a no stops;
 * 4. run the effects, and loop.
 *
 * Step 2 before step 3 is the point: the pure check gates the question, so
 * a player is never asked about an iteration that could not have happened.
 * The same ordering the rest of the engine uses — a trigger filters before
 * it counts, `canPut` checks timing before announcing.
 *
 * `while` and `confirm` are separate fields rather than operands of one
 * boolean for the reason `StepIR.optional` gives: asking is not an
 * observation.
 *
 * With neither `confirm` nor `max`, the loop ends only when the effects
 * themselves turn `while` false — which the compiler warns about, and the
 * engine's depth guard catches.
 */
export interface RepeatIR {
  readonly while?: PredicateIR;
  /** Ask the controller before each iteration ("repeat if you choose"). */
  readonly confirm?: boolean;
  /**
   * Iterations that happen **without asking** — the mandatory floor.
   * Defaults to 0, meaning the controller is asked from the very first.
   *
   * This is what separates "you may do this, repeatedly" from "do this,
   * then you may do it again". Magic's Ad Nauseam is the second: the
   * reveal happens, and only the *repeat* is optional. With `min: 0` a
   * first "no" means nothing happens at all, which is a different card.
   *
   * `while` still gates a mandatory iteration — the floor says the player
   * is not consulted, not that the effect applies regardless.
   */
  readonly min?: number;
  /** A hard cap on iterations. */
  readonly max?: number;
}

export interface StepIR {
  readonly effects: readonly EffectIR[];
  /** When present, the step runs more than once — see `RepeatIR`. */
  readonly repeat?: RepeatIR;
  /**
   * `true` for "you **may** …": the controller is asked, and a no skips
   * the step.
   *
   * Separate from `when` rather than a predicate inside it, because asking
   * is **not** an observation — it is async, and it changes what the player
   * knows. `PredicateIR`'s `and` is n-ary and pure, with no promised
   * evaluation order; a side-effecting operand inside it would make order
   * silently observable everywhere, including in targeting filters, which
   * are synchronous and cannot ask anyone at all.
   *
   * Checked **after** `when`, so a player is never asked about a step that
   * could not have run.
   */
  readonly optional?: boolean;
  /**
   * Run this step only when the predicate holds — "if you control a
   * creature, draw a card". Checked immediately before the step, so in a
   * multi-step body it sees the earlier steps' effects. Omitted means
   * unconditional.
   */
  readonly when?: PredicateIR;
}

/* ------------------------------ targeting ----------------------------- */

/**
 * One **named** group of picks: `Target 1 character as victim`.
 *
 * Names rather than positions, because a body that says `the victim`
 * cannot be misread the way "the first targeted character" can — and
 * because an ability may then ask for several *different* things, which a
 * single `TargetingIR` pattern cannot express.
 *
 * The engine takes one pattern per ability, so bindings are bound
 * **positionally** from the one pick list: the first `count` picks are the
 * first binding's, and so on. Each binding's own `who`/`filter` is checked
 * against its slice, so a pick legal for one binding but not for the
 * other is rejected rather than silently accepted.
 */
export interface TargetBindingIR {
  readonly name: string;
  readonly who: 'self' | 'ally' | 'enemy' | 'any';
  readonly count: number;
  readonly filter?: PredicateIR;
  /**
   * `1 different character` — must not be any earlier binding's pick.
   *
   * Distinctness is **per ability**, not per pair: if any binding asks for
   * it, every pick is distinct. Two bindings is the case that matters and
   * it is exact there; partial distinctness across three or more is not
   * expressible, and would need the engine's pattern to carry more than
   * one rule.
   */
  readonly distinct?: boolean;
}

export interface TargetingIR {
  readonly who: 'self' | 'ally' | 'enemy' | 'any';
  readonly count: number | readonly [number, number];
  /** Conditions a candidate must satisfy to be pickable. */
  readonly filter?: PredicateIR;
}

/* ------------------------------ abilities ----------------------------- */

/**
 * An **activated** ability: the player uses it on demand (the engine's
 * `ManualAbility`). Costs and cooldowns are not represented yet — see the
 * roadmap; when they arrive they are fields here, not a new shape.
 */
export interface AbilityIR {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly targeting: TargetingIR;
  /**
   * Named picks (`Target 1 character as victim and 1 different character
   * as benefactor.`). When present it supersedes `targeting`, which is the
   * older single-`target …` form.
   */
  readonly targets?: readonly TargetBindingIR[];
  /**
   * Whether it can be used right now. Omitted means always.
   *
   * An ability "enabled by a trigger" is written as a **condition**, not a
   * flag something flips: the trigger changes the board (it applies a
   * buff), and the condition mentions that change. Nothing has to stay in
   * sync, no event can be missed, and the answer is the same after a
   * reload or in a replay.
   *
   * It also keeps a **stable binding** for an input-constrained game: the
   * ability never leaves its owner's kit, so one hotkey — or one gamepad
   * button — can hold its slot and merely light up. An ability that
   * appeared and disappeared would shuffle every slot around it.
   */
  readonly available?: PredicateIR;
  readonly steps: readonly StepIR[];
}

/* ------------------------------ triggers ------------------------------ */

/**
 * Whose events a trigger listens to:
 * - `self` — events about the owner (the common case: a buff reacting to
 *   its wearer);
 * - `game` — events anywhere on the board, including the game's own
 *   (`at the start of turn, draw a card`). A game-scoped trigger has no
 *   natural owner, so the binder is what decides where it is registered.
 */
export type TriggerScope = 'self' | 'game';

/**
 * `batch` listens to one of the engine's `:batch` events, which fire once
 * per batch carrying the individual events — the only way to ask "how
 * many?". `single` fires once per matching event.
 */
export type TriggerMode = 'single' | 'batch';

/**
 * A triggered ability. Reading the fields in order spells the sentence:
 *
 * ```
 * when   (count)   (noun) (filter)        (event)      then (steps)
 *         when      ──── filter ────   event + mode          steps
 * ```
 *
 * Note that written order is not evaluation order: `filter` runs per
 * triggering entity *first*, and `when` gates the filtered set *second*.
 */
export interface TriggerIR {
  readonly id: string;
  readonly name: string;
  readonly scope: TriggerScope;
  /** The engine event type, e.g. `'character:destroyed:batch'`. */
  readonly event: string;
  readonly mode: TriggerMode;
  /**
   * The gate. Evaluated once per event, after `filter` has reduced the
   * batch to the triggering set, with that set in scope — so a count
   * phrase is `count(event subjects) >= 2 and <= 5`.
   *
   * Omitted means "at least one triggering entity", the default a bare
   * `when … then …` implies. It is a full `PredicateIR` rather than a count
   * range because the interesting gates are not all ranges: an even number,
   * a range *plus* a property of one of the triggers, a board state check.
   */
  readonly when?: PredicateIR;
  /** The adjectives — applied per triggering entity, before `when`. */
  readonly filter?: PredicateIR;
  /**
   * For a `gauge:changed` trigger: which gauge, and which direction.
   *
   * The engine has no "was damaged" event — damage is a gauge going down
   * (see events.ts) — so "takes damage" is `gauge:changed` plus these two.
   * They match the **event**, not an entity, which is why they are not
   * part of `filter`.
   *
   * Same selector as `ActionMatchIR.gauge`: a named id, or
   * `{ kind: 'life' }` for the gauge the *triggering entity* declares as
   * its life — resolved per event, so "takes damage" fires on hp for a
   * fighter and `loyalty` for a planeswalker. One meaning of "damage"
   * across triggers, effects and modifiers alike.
   */
  readonly gauge?: string | { readonly kind: 'life' };
  readonly change?: 'damage' | 'heal';
  /**
   * For a `zone:changed` trigger: which end of the move the phrase names.
   *
   * `{ verb: 'enters', id: 'play' }` is "enters play" — the entity arrived
   * in `play`. `verb: 'leaves'` names the origin instead. `opposite` is the
   * optional other end (`from active` / `to graveyard`); omitted, the
   * trigger fires wherever the entity came from or went, which is the
   * game-agnostic half that makes "enters play" usable without naming a
   * path.
   *
   * Zone ids are the game's own (`docs/design/15-zones.md`) — the language
   * never assumes `play`/`graveyard` beyond the engine shipping them.
   */
  readonly zone?: TriggerZoneIR;
  readonly steps: readonly StepIR[];
}

/** The `enters <zone> [from <zone>]` / `leaves <zone> [to <zone>]` phrase. */
export interface TriggerZoneIR {
  readonly verb: 'enters' | 'leaves';
  readonly id: string;
  readonly opposite?: string;
}

/* ------------------------------ documents ----------------------------- */

/**
 * What one editor document compiles to, and what travels between players.
 *
 * `triggers` holds the document's **game-scoped** triggers — the ones that
 * belong to no character or buff. A buff's own triggers live on the buff.
 */
export interface DocumentIR {
  readonly version: number;
  readonly imports: readonly ImportIR[];
  readonly abilities: readonly AbilityIR[];
  readonly buffs: readonly BuffIR[];
  readonly triggers: readonly TriggerIR[];
}

/**
 * How long a buff lasts.
 *
 * A duration is **not** a field the engine reads — the engine has no clock
 * and no notion of expiry. It is lowered into an ordinary triggered
 * ability on the buff that removes the buff when its time is up, which is
 * why "until end of turn" needs no engine change at all: a buff already
 * *is* a bundle of abilities, and one of them can take the buff off.
 *
 * Each **instance** expires on its own, so every stack of a duration buff
 * goes at the same turn's end rather than one stack per turn.
 */
export type DurationIR =
  /** Gone when the current turn ends. */
  | { readonly kind: 'endOfTurn' }
  /**
   * Gone after this many turn-ends. `{ count: 1 }` is `endOfTurn`; the
   * general form is for "for 3 turns".
   */
  | { readonly kind: 'turns'; readonly count: number };

/* ----------------------------- modifiers ------------------------------ */

/**
 * Which actions a modifier claims.
 *
 * A modifier is the one piece of content that is a **function of an
 * action** rather than a thing that happens, so representing it as data
 * comes down to splitting that function in two: a *match* (which actions)
 * and a *rewrite* (what changes about them). Everything below is the
 * match.
 */
export interface ActionMatchIR {
  /**
   * Which pipeline phase. `outgoing` is the owner acting on something
   * else, `incoming` is something acting on the owner. Omitted matches
   * both.
   *
   * `outgoing` additionally excludes actions aimed at the owner's **own**
   * gauges, so "damage you deal" does not catch a self-inflicted cost.
   */
  readonly direction?: 'outgoing' | 'incoming';
  /**
   * `damage` claims a change that **loses** value, `heal` one that gains
   * it — decided from the action's signed delta at the moment it flows
   * past, not from its declared intent, so a heal rewritten into a loss by
   * an earlier modifier is seen as damage. Omitted matches either.
   */
  readonly change?: 'damage' | 'heal';
  /**
   * Which gauge the change has to be on.
   *
   * - a **string** — that exact gauge id (`'mana'`), what `mana loss`
   *   claims;
   * - **`{ kind: 'life' }`** — whatever gauge the thing being changed
   *   declared as its *life* (`Character.lifeGauge`), which is what
   *   `damage`/`healing` claim. Written this way rather than as the id
   *   `'hp'` so the one word keeps working across entity kinds — hp on a
   *   fighter, `'loyalty'` on a card game's planeswalker — and because
   *   the engine puts no meaning on any id, so a literal `'hp'` here
   *   would be the language inventing one. An entity that declares no
   *   life gauge has nothing for these to claim.
   * - **omitted** — any gauge at all. The English surface never produces
   *   this (its subjects always name one or the other); hand-written IR
   *   can.
   */
  readonly gauge?: string | { readonly kind: 'life' };
  /**
   * The entity on the **other side** of the action from its owner must
   * satisfy this — who an `outgoing` action is aimed at, or who an
   * `incoming` one came from. An incoming action whose source is not a
   * character (a buff ticking with no caster, say) never satisfies this.
   */
  readonly target?: PredicateIR;
}

/**
 * What a modifier does to a claimed action.
 *
 * Every arithmetic rewrite operates on the **magnitude** of the change,
 * never on the resulting value — "increase damage by 5" is 5 more damage
 * whichever way the gauge happens to move. That keeps authors out of sign
 * arithmetic, and it means a rewrite composes with other modifiers instead
 * of fighting them over whose subtraction wins.
 *
 * The magnitude is read by evaluating the action's own `update` against the
 * gauge's real values and then rescaling, so an amount computed from the
 * gauge (half its maximum, say) is rescaled correctly rather than replaced
 * by a flat number. It may go negative partway through a chain of several
 * modifiers — "reduced by 10" then "increased by 5" on 8 damage is `8 - 10
 * + 5 = 3`, not 0 — the binder floors it at zero only once, where the
 * change actually lands (`src/ir/bind/ability.ts`, `src/engine/engine.ts`
 * `#applyGaugeBatch`), not after every step.
 */
export type ActionRewriteIR =
  | { readonly kind: 'amount'; readonly op: 'add' | 'subtract' | 'multiply'; readonly by: ValueIR }
  /** "at most n" — a ceiling on the magnitude. */
  | { readonly kind: 'cap'; readonly at: ValueIR }
  /** The action lands, changing nothing. */
  | { readonly kind: 'prevent' }
  /**
   * The realized change lands on a **different gauge of the same
   * character** instead — "incoming damage is dealt to your mana
   * instead." A no-op when the character has no gauge by this id, or
   * when it's the same gauge the action already targets.
   */
  | { readonly kind: 'redirect'; readonly gauge: string };

/**
 * A passive action modifier: it never fires, it only rewrites actions
 * flowing past its owner.
 *
 * **Stacking needs no arithmetic here.** The engine runs *every* attached
 * instance's modifier in turn, so a stacking buff carrying "increase
 * outgoing damage by 5" gives +15 at three stacks on its own — there is no
 * per-stack multiplier to write, and none to get wrong.
 */
export interface ModifierIR {
  readonly id: string;
  readonly name: string;
  readonly match: ActionMatchIR;
  readonly rewrite: ActionRewriteIR;
  /**
   * A percentage chance the rewrite happens at all. Omitted means always.
   *
   * Rolled **per action**, from the engine's seeded PRNG, so a replay of
   * the same seed produces the same rolls. Note that draws come from the
   * same stream as the trigger shuffle: adding a chance modifier shifts
   * every later draw, which is a property of having one stream rather than
   * a bug in either user of it.
   */
  readonly chance?: ValueIR;
}

/** A buff definition: a marker plus whatever abilities it grants. */
export interface BuffIR {
  readonly id: string;
  readonly name: string;
  readonly weight: number;
  readonly stacks: boolean;
  /** Omitted means permanent — it lasts until something removes it. */
  readonly duration?: DurationIR;
  readonly triggers: readonly TriggerIR[];
  /** Action modifiers the buff grants while attached. */
  readonly modifiers?: readonly ModifierIR[];
}
