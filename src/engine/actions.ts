/**
 * Actions are the *only* way the game state changes.
 *
 * An Action is a small, declarative description of one change:
 *
 * - `gauge`     — compute a new **current** value for a gauge
 * - `addBuff`   — add a buff to a character
 * - `removeBuff`— remove a buff from a character
 * - `destroy`   — destroy a character (deferred to the SBA pass)
 * - `transform` — swap a character's form (skills, gauge maxes, name, icon)
 * - `popTransform` — pop the current effective transformation (undo a form)
 * - `win`       — declare a team (or player) the winner: the game ends
 * - `lose`      — mark a team (or player) as lost
 *
 * Everything else (abilities, buffs, skills) produces Actions, and the
 * engine pushes each Action through the transformation pipeline before
 * applying it (see `ActionTransformer`).
 *
 * A gauge's **maximum** is deliberately *not* an Action: it is derived
 * from the wearer's attached statuses (`maxModifier` contributions — see
 * `GameEngine`), so the only way to change a max is to add or remove a
 * buff.
 *
 * Consecutive `gauge` actions aimed at the same batch are **netted**: the
 * engine applies every write first, checks whether the game is over (a
 * state-based action, run *before* events are emitted), and only then
 * reports the net change per gauge. So a vampire that damages a target and
 * heals itself in one `apply` is judged on the net result, not one change
 * at a time.
 */
import type { Character } from './character.js';
import type { Action, ActionMap } from './contracts.js';
import type { Entity, Zone, ZonePosition } from './zone.js';
import type { EventSource } from './events.js';
import type { Player } from './player.js';
import type { GameEngine } from './engine.js';
import { Gauge } from './gauge.js';
import type { Buff, BuffDef, SkillDef, Status } from './status/index.js';

/** Computes a new current value for a gauge: `newCurrent = update(current, max)`. */
export type GaugeUpdate = (current: number, max: number) => number;

/**
 * Which pipeline phase an Action is flowing through. The engine stamps this
 * onto every Action it pushes through a character: `'outgoing'` while the
 * source's transformers run, `'incoming'` while the target's do.
 *
 * Content never sets it — an Action produced by `damage(...)` etc. has no
 * direction until the engine fills it in, which is how a single transformer
 * can tell the two apart (see `ActionTransformer`).
 */
export type ActionDirection = 'outgoing' | 'incoming';

/**
 * What kind of change a gauge action makes — the "why" restrictions read
 * to tell "cannot be damaged" from "cannot be healed" (see
 * docs/design/11-restrictions.md). The sugar builders stamp it; raw
 * `{ type: 'gauge', update }` actions normalize to `'other'` at the gate.
 */
export type GaugeIntent = 'damage' | 'heal' | 'set' | 'other';

export interface GaugeAction {
  readonly type: 'gauge';
  readonly target: Gauge;
  readonly update: GaugeUpdate;
  /** What kind of change this is — see `GaugeIntent`. */
  readonly intent?: GaugeIntent;
  /**
   * Named exceptions — restriction ids (e.g. `"spell-ward:0"`) this action
   * pierces at the restrictions gate (docs/design/11-restrictions.md).
   */
  readonly bypasses?: readonly string[];
  /**
   * Who is responsible for this action (used by the outgoing pipeline and
   * the events it produces): a character, or a buff doing its thing.
   */
  readonly source?: EventSource;
  /**
   * Stamped by the engine: `'outgoing'` in the source's pipeline phase,
   * `'incoming'` in the target's. Never set by content.
   */
  readonly direction?: ActionDirection;
}

export interface AddBuffAction {
  readonly type: 'addBuff';
  readonly target: Character;
  readonly buff: BuffDef;
  /** Named exceptions — restriction ids this action pierces at the gate. */
  readonly bypasses?: readonly string[];
  readonly source?: EventSource;
  readonly direction?: ActionDirection;
}

export interface RemoveBuffAction {
  readonly type: 'removeBuff';
  readonly target: Character;
  /**
   * A buff instance, or the id of a buff currently on the target. Buffs
   * declared `removable: false` (an aura's permanent mark) are never
   * removed — the action is a no-op.
   */
  readonly buff: Buff | string;
  /** Named exceptions — restriction ids this action pierces at the gate. */
  readonly bypasses?: readonly string[];
  readonly source?: EventSource;
  readonly direction?: ActionDirection;
}

/**
 * Destroys a character — the one sink for every removal: board wipes,
 * summon timers, "destroy target", kill-effects.
 *
 * Destruction is **deferred to the SBA pass**: the action records a
 * pending-destroy marker and the pass resolves it together with every other
 * pending destruction (HP ≤ 0 deaths from the same batch, other `destroy`
 * actions) — so a "destroy all" spell's victims all land in the garbage
 * at the same time. Characters that "cannot be destroyed" (see
 * `GameEngine.canDestroy` / restrictions) are skipped: the marker is
 * consumed and the character stays.
 */
export interface DestroyAction {
  readonly type: 'destroy';
  readonly target: Character;
  /**
   * Named exceptions — restriction ids (e.g. `"indestructible:0"`) this
   * destruction pierces at the destroy gate (docs/design/11-restrictions.md).
   */
  readonly bypasses?: readonly string[];
  readonly source?: EventSource;
  readonly direction?: ActionDirection;
}

/**
 * A **form** to swap onto a character — the target-model `transform` action
 * (docs/spec/03-actions.md §2.5, docs/spec/04-character-status.md §6). Each
 * present field replaces the corresponding aspect of the character's current
 * form; absent fields keep their current value. The character's **identity**
 * (the object everyone references) never changes — only the form does.
 *
 * ```ts
 * transform(hero, { name: 'Dire Wolf', gauges: { hp: 50 }, skills: [wolfPack] })
 * ```
 */
export interface TransformForm {
  /** Replaces the character's name. */
  readonly name?: string;
  /** Replaces the character's icon. */
  readonly icon?: string;
  /**
   * Replaces the character's permanent skills — the arriving set's instances
   * are attached (a set the character wore before gets its **same instances
   * back**, `vars` intact; a never-seen set gets fresh instances), and the
   * previous effective skills leave. Skills carried by *buffs* are
   * untouched: buffs persist across the swap.
   */
  readonly skills?: readonly SkillDef[];
  /**
   * Replaces the character's **base maxes**, keyed by gauge id — the value
   * the engine derives each gauge's effective max from (before `maxModifier`
   * status contributions), clamped at 0. A gauge's current value clamps down
   * to its new max (raising it never refills the gauge).
   *
   * ```ts
   * transform(hero, { gauges: { hp: 50, stamina: 3 } })
   * ```
   *
   * Any gauge the character carries can be named; a form may transform some,
   * all or none of them. An id the character has no gauge for is ignored.
   */
  readonly gauges?: Readonly<Record<string, number>>;
}

/**
 * Pushes a **form** onto the target's transform stack (docs/spec/03-actions.md
 * §2.5, docs/spec/04-character-status.md §6). The stack is keyed by
 * **source**:
 *
 * - a **Buff** source (a werewolf curse whose ability transforms its wearer)
 *   pops its entry — reverting the form — when that buff is removed
 *   (dispelled, dies with its wearer, taken by the cascade);
 * - a **Character** source, or no source, is a permanent transform: nothing
 *   pops it (the cast itself defines the new form for good).
 *
 * The form's maxes apply with clamping (`Math.min(current, newMax)`), buffs
 * persist across the swap, and the character's abilities re-derive from the
 * new skill list.
 */
export interface TransformAction {
  readonly type: 'transform';
  readonly target: Character;
  readonly form: TransformForm;
  /** Named exceptions — restriction ids this action pierces at the gate. */
  readonly bypasses?: readonly string[];
  readonly source?: EventSource;
  readonly direction?: ActionDirection;
}

/**
 * Pops a character's **current effective transformation** directly,
 * returning them to the previous state (docs/spec/03-actions.md §2.5,
 * docs/spec/04-character-status.md §6). A **live tie pins the form**: while
 * a buff-tied form is active (a `transformModifier` hex), the pop is
 * refused — the state-based rule re-asserts the buff's transformation, and
 * the buff itself is only removed by a removal action. Otherwise the **top**
 * entry of the form stack pops (a character-keyed or sourceless transform),
 * revealing the entry below or the base form.
 *
 * Gated by the same `on: 'transform'` restriction as `transform` ("cannot
 * be transformed" locks the form against both directions).
 */
export interface PopTransformAction {
  readonly type: 'popTransform';
  readonly target: Character;
  /** Named exceptions — restriction ids this action pierces at the gate. */
  readonly bypasses?: readonly string[];
  readonly source?: EventSource;
  readonly direction?: ActionDirection;
}

/**
 * The action map — the extension seam — is declared in `contracts.ts` and
 * re-exported here so this file stays the place actions are *described*.
 * Augment `ActionMap` (from `contracts.js`) to add a game's own actions, then
 * register a handler with `engine.actions.register(...)`.
 */
export type { Action, ActionBase, ActionMap } from './contracts.js';
export type Actions = Action[];

/**
 * Moves an entity to another zone (zone.ts).
 *
 * Movement is an **Action** rather than a method because that is what makes
 * replacement effects possible: *"if a card would go to your garbage, exile
 * it instead"* is an `ActionTransformer` rewriting this action's `to`, which
 * is the single most common effect class in a card game. It also means a
 * move is gated by restrictions (`cannot be discarded`), announces events,
 * and batches like every other action.
 *
 * `destroy` is the special case that keeps its own phase: it is deferred to
 * the settle so simultaneous deaths resolve together, and the garbage
 * move it performs is this same transition.
 */
export interface MoveAction {
  readonly type: 'move';
  /**
   * The entity being moved. Also the subject of the restriction gate and
   * the transformer pass — but only when it is a `Character`: a
   * non-character entity (an ability on the stack) carries no statuses, so
   * there is nothing to gate or transform through.
   */
  readonly target: Entity;
  /** Where it is going. A transformer may rewrite this. */
  readonly to: Zone;
  /** Where in an ordered zone. Defaults to the bottom. */
  readonly position?: ZonePosition;
  /**
   * Why, for the event and for content to read — `'discard'`, `'draw'`,
   * `'bounce'`, `'fizzle'`. Free-form, like a destroy `reason`.
   */
  readonly reason?: string;
  readonly source?: EventSource;
  readonly direction?: ActionDirection;
  readonly bypasses?: readonly string[];
}

/**
 * **Reveal from the top of an ordered zone until a card is worth taking** — the
 * shape Magic calls Discover and any costed card game can generalise.
 *
 * An *Action* rather than a bind-time loop on purpose. Binding is a pure
 * function from an `EffectIR` to `Action[]`, and this mechanic is neither pure
 * nor a single action: it reveals, **asks the player mid-resolution**, and then
 * moves cards. Those are exactly the properties an action handler has
 * (`ActionHandler` may be async, and `ctx.engine.ask` is the same route
 * "you may …" already takes), so the loop lives here and the ability's compiled
 * body stays a declarative list.
 *
 * ## Why there is a `revealed` zone
 *
 * The loop **moves** each card it looks at into a temporary zone rather than
 * peeking at the top of the library. That is not an implementation detail:
 * peeking changes nothing, so it announces no `zone:changed` and no trigger can
 * see that a card was revealed. A reveal *is* a fact about the game — "when a
 * card is revealed, …" has to be answerable — so the card genuinely leaves the
 * library, sits somewhere visible for the rest of the resolution, and leaves
 * that place when the resolution ends. It is the same holding-zone idea `active`
 * already uses for a resolving spell.
 *
 * The ordering then falls out for free: every card that was looked at is already
 * in one place, so "put the rest on the bottom in a random order" is a move of
 * that zone's members rather than a list the handler has to remember.
 *
 * `maxCost` reads the entity's **`attributes`** — the game's own number, not an
 * engine field. A card with no such fact reads 0, which matches; a game that
 * needs to exclude uncosted cards declares a companion fact (a `land` flag) and
 * tests it with a predicate.
 */
export interface DiscoverAction {
  readonly type: 'discover';
  /** The ordered zone revealed from (`'deck'`, `'library'`). */
  readonly from: string;
  /**
   * The **temporary zone** a looked-at card waits in while the rest of the
   * reveal resolves. Its members are what "the rest" means at the end, so it
   * must be empty when a reveal begins.
   */
  readonly revealed: string;
  /** How many to reveal before giving up — Magic's Discover number. */
  readonly count: number;
  /** An entity may be taken when its `cost` attribute is at most this. */
  readonly maxCost: number;
  /**
   * A tested fact whose presence passes a card over — a `land` flag. Declared
   * as a predicate over the revealed card's own `attributes`, so the engine
   * gains no idea what a land is. A card that matches is revealed and put
   * aside, never offered.
   */
  readonly skip?: ReadonlyMap<string, number | boolean>;
  /** Where a taken entity goes. */
  readonly to: string;
  /** Where revealed-but-untaken entities go, shuffled. */
  readonly rest: string;
  /** Whose zones these are. Also the player asked to take. */
  readonly owner?: Player;
  readonly source?: EventSource;
  readonly reason?: string;
  /**
   * The pipeline fields every action declares, so the engine's transformer pass
   * can stamp them (`DeclaresActionBase` in `contracts.ts` enforces their
   * *presence*, even where they are optional). Discover is initiated by its
   * content rather than by a character, so it carries all three without
   * pretending to be a targeted action.
   */
  readonly direction?: ActionDirection;
  readonly bypasses?: readonly string[];
}

/**
 * **Roll dice** — `count` dice with `sides` faces each. An action, not a bare
 * function call, so it flows through the pipeline: a transformer can change the
 * dice ("roll an extra die"), add to the outcome (`adjust`), or reroll; a
 * `roll:made` event announces it ("whenever an opponent rolls"); and the
 * `source` records who rolled, since that attribution is what those triggers read.
 *
 * Where the numbers come from is the engine's `Roller`, not the action's
 * business — see `src/engine/dice.ts`.
 */
export interface RollAction {
  readonly type: 'roll';
  readonly count: number;
  readonly sides: number;
  /** Why, for a table roller to prompt with and content to read. */
  readonly reason?: string;
  /**
   * Post-processing of the results, applied in order after the roller answers:
   * "add 1 to each", "reroll ones". A transformer adds to this list rather than
   * replacing it, so two of them compose. `reroll` rolls the same dice again
   * through the roller.
   */
  readonly adjust?: readonly RollAdjust[];
  /** Called with the final results — how the caller of `engine.roll` gets them back. */
  readonly onRolled?: (results: readonly number[]) => void;
  readonly source?: EventSource;
  readonly direction?: ActionDirection;
  readonly bypasses?: readonly string[];
}

/** One adjustment to a roll's results. */
export type RollAdjust = (
  results: readonly number[],
  reroll: () => Promise<readonly number[]>,
) => readonly number[] | Promise<readonly number[]>;

/** Context passed to a transformer while an action flows through a character. */
export interface ActionContext {
  readonly source: EventSource | undefined;
  readonly target: Character | undefined;
  /** The status (buff/skill) that owns the transformer currently running. */
  readonly status: Status | undefined;
  readonly engine: GameEngine;
}

/**
 * A transformer intercepts an Action on its way from a source character
 * (outgoing) or to a target character (incoming) and returns a (possibly
 * different) Action. Transformers on a character run in **ascending weight**
 * order, each one wrapping the previous — so lower weights are applied
 * first.
 *
 * The engine stamps every Action it hands to a transformer with its
 * **direction** (`action.direction`): `'outgoing'` in the source phase,
 * `'incoming'` in the target phase. A transformer that only cares about one
 * of the two checks it — this is how a single listener serves both:
 *
 * ```ts
 * // Capped incoming damage at 50; outgoing actions pass through untouched.
 * (action, ctx) =>
 *   action.direction !== 'incoming'
 *     ? action
 *     : gaugeTransform((prev) => (cur, max) => Math.max(prev(cur, max), cur - 50))(action, ctx)
 * ```
 *
 * The classic example as a passive action modifier ability on a buff or
 * skill (the only place transformers live now):
 *
 * ```ts
 * abilities: [
 *   passiveActionModifier({
 *     name: 'Iron Hide',
 *     transform: (action, ctx) =>
 *       action.direction !== 'incoming'
 *         ? action
 *         : gaugeTransform((prev) => (cur, max) => Math.max(prev(cur, max), cur - 50))(action, ctx),
 *   }),
 * ]
 * ```
 */
export type ActionTransformer = (action: Action, ctx: ActionContext) => Action;

/** Wraps the update function of every `gauge` action a transformer sees. */
export function gaugeTransform(wrap: (prev: GaugeUpdate) => GaugeUpdate): ActionTransformer {
  return (action) =>
    action.type === 'gauge'
      ? { ...action, update: wrap(action.update) }
      : action;
}

/**
 * Like `gaugeTransform`, but the wrapper also sees the transform context —
 * handy for scaling effects off a buff's own variables:
 *
 * ```ts
 * transform: (action, ctx) =>
 *   action.direction !== 'outgoing'
 *     ? action
 *     : gaugeTransformCtx((prev, tctx) => (cur, max) =>
 *         prev(cur, max) - 5 * Number(tctx.status?.vars.stacks ?? 0))(action, ctx)
 * ```
 */
export function gaugeTransformCtx(
  wrap: (prev: GaugeUpdate, ctx: ActionContext) => GaugeUpdate,
): ActionTransformer {
  return (action, ctx) =>
    action.type === 'gauge'
      ? { ...action, update: wrap(action.update, ctx) }
      : action;
}

/**
 * The change a `gauge` action would make **right now**: its `update`
 * evaluated against the gauge's current values, minus the current value —
 * signed, so damage is negative and healing positive. Non-gauge actions
 * return `0` (like `amountOf` for events), so a transformer can ask "is
 * this action damage?" without narrowing first:
 *
 * ```ts
 * if (gaugeDelta(action) < 0) { ... } // this action deals damage
 * ```
 *
 * Transformers run before any write lands, so this is the same delta the
 * batch would apply if the action were the first write to its gauge — the
 * "amount" a replacement effect wants to re-aim (see `replaceAction`).
 */
export function gaugeDelta(action: Action): number {
  return action.type === 'gauge'
    ? action.update(action.target.current, action.target.max) - action.target.current
    : 0;
}

/**
 * Replaces an action outright — the "prevent the old one, emit a new one"
 * pattern. When `match` claims an action, `build` returns the replacement
 * that takes its place in the pipeline: **the original never continues**,
 * and the replacement flows on through the rest of the phase (the
 * direction the engine stamped is carried onto it). Non-matching actions
 * pass through untouched, so this composes with other transformers like
 * any listener.
 *
 * A replacement is **not a new cast**: it stays in the same pipeline
 * position, so it does not re-enter the outgoing/incoming phases or the
 * restrictions gate (those already ran on the original — see
 * docs/spec/03-actions.md §5). What it *can* do is aim the same effect
 * elsewhere — turning damage into mana loss:
 *
 * ```ts
 * const manaShield = passiveActionModifier({
 *   name: 'Mana Shield',
 *   transform: replaceAction(
 *     (action, ctx) =>
 *       action.type === 'gauge' &&
 *       action.direction === 'incoming' &&
 *       ctx.target?.hp === action.target &&
 *       gaugeDelta(action) < 0,
 *     (action, ctx) => ({
 *       type: 'gauge',
 *       target: ctx.target!.mana,
 *       update: (cur) => cur + gaugeDelta(action),
 *       intent: 'damage',
 *       source: action.source,
 *     }),
 *   ),
 * });
 * ```
 *
 * The builder decides everything else about the replacement — kind, target,
 * `source`, `bypasses`, `intent`; only the phase direction is carried over
 * automatically.
 */
export function replaceAction(
  match: (action: Action, ctx: ActionContext) => boolean,
  build: (action: Action, ctx: ActionContext) => Action,
): ActionTransformer {
  return (action, ctx) => {
    if (!match(action, ctx)) return action;
    const replacement = build(action, ctx);
    return action.direction !== undefined && replacement.direction !== action.direction
      ? { ...replacement, direction: action.direction }
      : replacement;
  };
}

/**
 * Redirects gauge actions from one gauge to another — "turns damage into
 * mana loss" as a ready-made transformer:
 *
 * ```ts
 * abilities: [
 *   passiveActionModifier({
 *     name: 'Mana Shield',
 *     transform: redirectGauge((t) => t.gauge('hp'), (t) => t.gauge('mana'), {
 *       direction: 'incoming',
 *       intent: 'damage',
 *     }),
 *   }),
 * ]
 * ```
 *
 * Every `gauge` action aimed at `from(target)` is replaced by a same-size
 * action on `to(target)`: the signed delta the original would apply
 * (`gaugeDelta`) is applied to the new gauge instead, so damage becomes a
 * loss on the new gauge and healing becomes a gain. The replacement keeps
 * the original's `source`, stamps the matching intent (`'damage'` for a
 * loss, `'heal'` for a gain), and carries the pipeline direction.
 *
 * `opts.direction` restricts which pipeline phase redirects: `'incoming'`
 * makes a defensive shield (the owner's own outgoing actions pass through
 * untouched), `'outgoing'` makes an offensive drain (the owner's actions
 * burn the target's other gauge). Without it, both directions redirect.
 * `opts.intent` restricts which intents redirect — a shield set to
 * `intent: 'damage'` converts damage but leaves heals healing HP and lets
 * `changeGaugeBy` / `setGauge` writes (intent `'other'` / `'set'`) pass
 * through. Without it, every movement on `from` redirects.
 */
export function redirectGauge(
  from: (target: Character) => Gauge,
  to: (target: Character) => Gauge,
  opts?: { readonly direction?: ActionDirection; readonly intent?: GaugeIntent },
): ActionTransformer {
  const direction = opts?.direction;
  const intent = opts?.intent;
  return replaceAction(
    (action, ctx) =>
      action.type === 'gauge' &&
      (direction === undefined || action.direction === direction) &&
      (intent === undefined || action.intent === intent) &&
      ctx.target !== undefined &&
      from(ctx.target) === action.target,
    (action, ctx) => {
      if (ctx.target === undefined) return action; // unreachable — `match` required it
      const delta = gaugeDelta(action);
      return {
        type: 'gauge',
        target: to(ctx.target),
        update: (cur) => cur + delta,
        intent: delta < 0 ? 'damage' : delta > 0 ? 'heal' : 'other',
        ...(action.source ? { source: action.source } : {}),
      };
    },
  );
}

/* ------------------------------------------------------------------ */
/*  Sugar builders — the everyday vocabulary for content creators      */
/* ------------------------------------------------------------------ */

/** Sets a gauge's current value to `value`. */
export function setGauge(target: Gauge, value: number, source?: EventSource): GaugeAction {
  return { type: 'gauge', target, update: () => value, intent: 'set', ...(source ? { source } : {}) };
}

/**
 * Moves a gauge's current value by `delta` (negative = spend, positive =
 * gain). Stamped `intent: 'other'`: it is a generic movement, not damage or
 * healing — use `damage`/`heal` when you want those semantics (a
 * "cannot be damaged" restriction does not stop a `changeGaugeBy`).
 */
export function changeGaugeBy(target: Gauge, delta: number, source?: EventSource): GaugeAction {
  return { type: 'gauge', target, update: (cur) => cur + delta, intent: 'other', ...(source ? { source } : {}) };
}

/** Deals `amount` damage: reduces the gauge by `amount`. */
export function damage(target: Gauge, amount: number, source?: EventSource): GaugeAction {
  return {
    type: 'gauge',
    target,
    update: (cur) => cur - amount,
    intent: 'damage',
    ...(source ? { source } : {}),
  };
}

/** Heals `amount`: increases the gauge by `amount`. */
export function heal(target: Gauge, amount: number, source?: EventSource): GaugeAction {
  return {
    type: 'gauge',
    target,
    update: (cur) => cur + amount,
    intent: 'heal',
    ...(source ? { source } : {}),
  };
}

/** Rolls dice. See `RollAction` for why this is an action. */
export function roll(
  count: number,
  sides: number,
  options: {
    reason?: string;
    source?: EventSource;
    adjust?: readonly RollAdjust[];
    onRolled?: (results: readonly number[]) => void;
  } = {},
): RollAction {
  if (!Number.isInteger(count) || count < 1) throw new Error(`roll: count must be a positive integer, got ${count}`);
  if (!Number.isInteger(sides) || sides < 2) throw new Error(`roll: sides must be an integer of at least 2, got ${sides}`);
  return {
    type: 'roll',
    count,
    sides,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.adjust ? { adjust: options.adjust } : {}),
    ...(options.onRolled ? { onRolled: options.onRolled } : {}),
    ...(options.source ? { source: options.source } : {}),
  };
}

/** Moves an entity to a zone. See `MoveAction` for why this is an action. */
export function move(
  target: Entity,
  to: Zone,
  options: { position?: ZonePosition; reason?: string; source?: EventSource } = {},
): MoveAction {
  return {
    type: 'move',
    target,
    to,
    ...(options.position !== undefined ? { position: options.position } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.source ? { source: options.source } : {}),
  };
}

/** Adds a buff to a character (a fresh instance is created when applied). */
export function addBuff(target: Character, buff: BuffDef, source?: EventSource): AddBuffAction {
  return { type: 'addBuff', target, buff, ...(source ? { source } : {}) };
}

/**
 * Removes a removable buff from a character, by instance or by id. A no-op
 * for buffs declared `removable: false` (an aura's permanent mark) and for
 * skills.
 */
export function removeBuff(target: Character, buff: Buff | string, source?: EventSource): RemoveBuffAction {
  return { type: 'removeBuff', target, buff, ...(source ? { source } : {}) };
}

/**
 * Destroys a character through the normal path (deferred to the SBA pass,
 * resolved with any other pending destructions). Characters that "cannot be
 * destroyed" are skipped — unless the action names the restriction it beats
 * (`opts.bypasses`, e.g. `destroy(goblin, hero, { bypasses:
 * ['indestructible:0'] })`).
 */
export function destroy(
  target: Character,
  source?: EventSource,
  opts?: { readonly bypasses?: readonly string[] },
): DestroyAction {
  return {
    type: 'destroy',
    target,
    ...(opts?.bypasses ? { bypasses: opts.bypasses } : {}),
    ...(source ? { source } : {}),
  };
}

/**
 * Swaps a character's form: skills, gauge maxes (current clamps to the new
 * max), name and icon. The character object — its identity — never changes;
 * buffs persist across the swap. When `source` is a `Buff`, the transform is
 * keyed by that buff and pops (reverting the form) when the buff is removed;
 * a character source — or no source — is a permanent transform.
 *
 * ```ts
 * await engine.apply([transform(hero, { name: 'Sheep', gauges: { hp: 5 } })]);
 * ```
 */
export function transform(
  target: Character,
  form: TransformForm,
  source?: EventSource,
): TransformAction {
  for (const [id, value] of Object.entries(form.gauges ?? {})) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`transform: gauge "${id}" must be a finite number >= 0, got ${value}`);
    }
  }
  return { type: 'transform', target, form, ...(source ? { source } : {}) };
}

/**
 * Pops a character's current effective transformation, returning them to
 * the previous state. A **live tie** (a hex pinning the form) refuses the
 * pop — the hex holds; the buff is removed only by a removal action. With
 * no tie, the top of the form stack pops.
 *
 * ```ts
 * await engine.apply([popTransform(hero, mage)]);  // undo the Demon form
 * ```
 */
export function popTransform(target: Character, source?: EventSource): PopTransformAction {
  return { type: 'popTransform', target, ...(source ? { source } : {}) };
}

/**
 * **Discover** — reveal cards from the top of `from` into the `revealed` zone
 * until one's `cost` fact is at most `maxCost`, offer that one, and put every
 * card still in `revealed` on the bottom of `rest` in a random order.
 *
 * ```ts
 * await engine.apply([discover({
 *   from: 'deck', revealed: 'revealed', count: 3, maxCost: 2, to: 'play', rest: 'deck',
 * })]);
 * ```
 */
export function discover(options: {
  readonly from: string;
  /** The temporary holding zone; must be empty when the reveal begins. */
  readonly revealed: string;
  readonly count: number;
  readonly maxCost: number;
  readonly skip?: ReadonlyMap<string, number | boolean>;
  readonly to: string;
  readonly rest: string;
  readonly owner?: Player;
  readonly source?: EventSource;
  readonly reason?: string;
}): DiscoverAction {
  if (!Number.isInteger(options.count) || options.count < 1) {
    throw new Error(`discover: count must be a positive integer, got ${options.count}`);
  }
  if (!Number.isFinite(options.maxCost)) {
    throw new Error(`discover: maxCost must be a finite number, got ${options.maxCost}`);
  }
  if (options.revealed === options.to || options.revealed === options.from) {
    throw new Error(
      `discover: the revealed zone must be its own place — got "${options.revealed}" for ` +
        `from="${options.from}" / to="${options.to}"`,
    );
  }
  return {
    type: 'discover',
    from: options.from,
    revealed: options.revealed,
    count: options.count,
    maxCost: options.maxCost,
    ...(options.skip && options.skip.size > 0 ? { skip: options.skip } : {}),
    to: options.to,
    rest: options.rest,
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };
}
