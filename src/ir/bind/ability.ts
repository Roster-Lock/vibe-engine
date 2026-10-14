/**
 * `DocumentIR` → this engine's content: `ManualAbility`, `BuffDef`,
 * `TriggeredAbility`.
 *
 * This file is the **binding seam**. Everything above it (`src/english/`,
 * `src/ir/ability.ts`) is game-agnostic data; everything below it is
 * `src/engine`. A second game over the same IR supplies its own file like
 * this one — that is the whole reason the IR exists as a separate layer
 * rather than the English compiler building closures directly.
 *
 * Buff *definitions* are never embedded in the IR (a document is plain
 * data), so the caller supplies `resolveBuff`: a late-bound lookup over the
 * document's own declarations, the host dictionary, and imports. Late
 * binding matters because a buff's own trigger may add another buff that is
 * declared further down the document.
 */
import {
  Character,
  addBuff,
  auto,
  buff as makeBuff,
  cast,
  damage,
  destroy,
  discover,
  heal,
  gaugeDelta,
  gaugeTransformCtx,
  passiveActionModifier,
  removeBuff,
  setGauge,
  type Ability,
  type AbilityContext,
  type Action,
  type AnyTriggeredAbility,
  type BuffDef,
  type GameEngine,
  type GameEvent,
  type ManualAbility,
  type PassiveActionModifier,
  type TargetPattern,
  type Targeting,
  type TargetWho,
} from '../../engine/index.js';
// `win`/`lose` are round-based game actions, not engine vocabulary.
import { lose, win } from '../../games/round-based/index.js';
import type {
  AbilityIR,
  PredicateIR,
  ValueIR,
  BuffIR,
  CompareOp,
  DocumentIR,
  EffectIR,
  EntityQueryIR,
  ModifierIR,
  StepIR,
  TargetBindingIR,
  TargetingIR,
  TriggerIR,
} from '../ability.js';
import { isAlly, isEnemy } from '../../games/round-based/index.js';
import { isEntityEffect } from '../ability.js';
import { evaluateMathExpression } from '../math-expression.js';

export interface BindOptions {
  /**
   * Resolves a buff name to a definition. Called lazily (at cast time, not
   * bind time) so a document's buffs may reference each other in any order.
   * Returning `undefined` makes the effect a no-op — the English checker has
   * already reported the unknown name as a diagnostic.
   */
  readonly resolveBuff: (name: string) => BuffDef | undefined;
  /**
   * Maps an **abstract zone name** in the IR to the zone a game declared —
   * `{ library: 'deck', board: 'play' }`.
   *
   * The IR cannot name a zone directly: it is the share format, and a document
   * has to mean the same thing in a game whose library is `deck` and one whose
   * library is `pile`. So content writes the role (`library`) and the host
   * answers with its own id. An unmapped name passes through unchanged, so
   * content that *is* written against a particular game's ids still works — and
   * a missing zone is the game's error, reported by the engine.
   */
  readonly aliases?: Readonly<Record<string, string>>;
}

export interface BindResult {
  readonly abilities: ManualAbility[];
  readonly buffs: BuffDef[];
  /**
   * Game-scoped triggers (`at the start of turn, …`) — they belong to no
   * character, so the caller decides where to register them. See
   * `BuffIR.triggers` for the owned ones, which ride along on their buff.
   */
  readonly triggers: AnyTriggeredAbility[];
}

/** Mirrors `english/dictionary.ts`'s `slug` — a buff's id when it declares none. */
function buffIdOf(def: BuffDef): string {
  return def.id ?? def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/* --------------------------- runtime context -------------------------- */

/**
 * What a bound effect needs to resolve its queries. `targeting` is the
 * player's pick for an activated ability; `event` carries the entities a
 * trigger's event supplied (`the attacker`, the characters that died).
 */
interface ResolveContext {
  readonly self: Character;
  readonly engine: GameEngine;
  readonly targeting: Targeting | undefined;
  readonly event: EventBinding;
  /**
   * The entity entity-scoped predicates ask about: the candidate a group
   * filter is testing, or the current element of an `any`/`every`.
   * Undefined outside an entity scope — those questions then answer false.
   */
  readonly subject: Character | undefined;
  /** The ability's **named** picks, by binding name. */
  readonly bindings: ReadonlyMap<string, readonly Character[]>;
}

/** The entities a triggering event bound, by role. */
interface EventBinding {
  readonly subjects: readonly Character[];
  readonly sources: readonly Character[];
}

const NO_BINDINGS: ReadonlyMap<string, readonly Character[]> = new Map();

const NO_EVENT: EventBinding = { subjects: [], sources: [] };

/* ------------------------------- values ------------------------------- */

/**
 * A character read for the math formula language: every gauge by id
 * (`hp`, `mana`, …), each gauge's max under `<id>Max`, and `speed`. A
 * plain object rather than the `Character` instance itself — nothing
 * about `hp`/`mana` is a property on `Character` (see its own doc: gauges
 * are declared data, reached through `.gauges`/`.gauge(id)`), so a
 * formula needs this translation to write `this.hp` at all.
 */
function mathCharacterOf(character: Character): Record<string, number> {
  const fields: Record<string, number> = { speed: character.speed };
  for (const gauge of character.gauges) {
    fields[gauge.id] = gauge.current;
    fields[`${gauge.id}Max`] = gauge.max;
  }
  return fields;
}

/**
 * The concrete gauge id a selector names **for this character**: a literal
 * id as written, or whatever the character declared as its life
 * (`Character.lifeGauge`). `undefined` when it asks for a life gauge the
 * character does not declare — the one place "damage" has nothing to
 * claim.
 *
 * Both halves of the language go through this, which is the point: a
 * `damage`/`healing` effect and a `damage`/`healing` modifier subject
 * resolve the same way, so the word cannot drift into meaning two gauges.
 */
function gaugeIdOf(
  selector: string | { readonly kind: 'life' },
  character: Character,
): string | undefined {
  return typeof selector === 'string' ? selector : character.lifeGauge;
}

function valueOf(value: ValueIR, ctx: ResolveContext, options: BindOptions): number {
  switch (value.kind) {
    case 'const':
      return value.value;
    case 'count':
      return resolveQuery(value.query, ctx, options).length;
    case 'gauge': {
      const entity = value.of ? resolveQuery(value.of, ctx, options)[0] : ctx.subject;
      const gauge = entity?.gauges.find((g) => g.id === value.gauge);
      return gauge?.current ?? 0;
    }
    case 'attribute': {
      const entity = value.of ? resolveQuery(value.of, ctx, options)[0] : ctx.subject;
      // Absent reads 0, like an absent gauge — content shared between games
      // should narrow rather than break.
      return entity?.attributes?.get(value.attribute) ?? 0;
    }
    case 'expr':
      // The formula escape hatch. Its context mirrors what the declarative
      // nodes can reach: `this` is the ability's owner (same word the rest
      // of the grammar uses for it), the entity a group filter is testing,
      // the triggering entities by role, and `count` — so `count % 2 = 0`
      // ("an even number of them") reads the way the sentence does.
      return evaluateMathExpression(value.expression, {
        this: mathCharacterOf(ctx.self),
        ...(ctx.subject ? { subject: mathCharacterOf(ctx.subject) } : {}),
        subjects: ctx.event.subjects.map(mathCharacterOf),
        sources: ctx.event.sources.map(mathCharacterOf),
        count: ctx.event.subjects.length,
      });
  }
}

/* ----------------------------- predicates ----------------------------- */

type EntityCheck = (ctx: ResolveContext, candidate: Character) => boolean;

function compare(op: CompareOp, left: number, right: number): boolean {
  switch (op) {
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    case '=': return left === right;
    case '!=': return left !== right;
  }
}

/** True when two players are on opposite sides (engine team semantics). */
function playersAreEnemies(a: { team?: string }, b: { team?: string }): boolean {
  return a !== b && (a.team === undefined || a.team !== b.team);
}

/**
 * Evaluates the one boolean vocabulary. Entity-scoped nodes read
 * `ctx.subject`; `any`/`every` re-enter with each match in scope, which is
 * what lets a count gate and a per-entity test compose.
 *
 * Buff lookups go through `resolveBuff` **per call**, not once at bind
 * time, because the dictionary is late-bound (a buff may be declared after
 * the trigger that references it).
 */
function predicateHolds(predicate: PredicateIR, ctx: ResolveContext, options: BindOptions): boolean {
  switch (predicate.kind) {
    case 'always':
      return true;
    case 'compare':
      return compare(
        predicate.op,
        valueOf(predicate.left, ctx, options),
        valueOf(predicate.right, ctx, options),
      );
    case 'and':
      return predicate.clauses.every((clause) => predicateHolds(clause, ctx, options));
    case 'or':
      return predicate.clauses.some((clause) => predicateHolds(clause, ctx, options));
    case 'not':
      return !predicateHolds(predicate.expression, ctx, options);
    case 'parity': {
      const value = valueOf(predicate.value, ctx, options);
      const even = Math.abs(value) % 2 === 0;
      return predicate.parity === 'even' ? even : !even;
    }
    case 'any':
    case 'every': {
      const entities = resolveQuery(predicate.query, ctx, options);
      const holds = (entity: Character): boolean =>
        predicateHolds(predicate.test, { ...ctx, subject: entity }, options);
      return predicate.kind === 'any' ? entities.some(holds) : entities.every(holds);
    }
    case 'hasBuff': {
      if (!ctx.subject) return false;
      const def = options.resolveBuff(predicate.buff);
      return def ? ctx.subject.hasStatus(buffIdOf(def)) : false;
    }
    case 'relation': {
      const candidate = ctx.subject;
      if (!candidate) return false;
      switch (predicate.to) {
        case 'self':
          return candidate === ctx.self;
        case 'you':
          return candidate.controller === ctx.self.controller;
        case 'opponent': {
          const you = ctx.self.controller;
          return (
            candidate.controller !== undefined &&
            you !== undefined &&
            playersAreEnemies(you, candidate.controller)
          );
        }
        case 'ally':
          return isAlly(ctx.self, candidate);
        case 'enemy':
          return isEnemy(ctx.self, candidate);
      }
    }
  }
}

/** A predicate as a per-candidate check (what a group filter needs). */
function checkOf(predicate: PredicateIR, options: BindOptions): EntityCheck {
  return (ctx, candidate) => predicateHolds(predicate, { ...ctx, subject: candidate }, options);
}

/* ------------------------------- queries ------------------------------ */

/** An `all …` query as an engine targeting pattern. */
function patternOf(query: Extract<EntityQueryIR, { kind: 'all' }>, options: BindOptions): TargetPattern {
  const who: TargetWho = query.who;
  if (!query.filter) return { who, count: 1 };
  const check = checkOf(query.filter, options);
  return {
    who,
    count: 1,
    match: (tctx, candidate) =>
      check(
        { self: tctx.self, engine: tctx.engine, targeting: undefined, event: NO_EVENT, subject: undefined, bindings: NO_BINDINGS },
        candidate,
      ),
  };
}

function resolveQuery(query: EntityQueryIR, ctx: ResolveContext, options: BindOptions): readonly Character[] {
  switch (query.kind) {
    case 'self':
      return [ctx.self];
    case 'picked':
      return ctx.targeting?.targets ?? [];
    case 'bound':
      return ctx.bindings.get(query.name) ?? [];
    case 'event':
      return query.role === 'source' ? ctx.event.sources : ctx.event.subjects;
    case 'all': {
      const pool = ctx.engine.validTargets(patternOf(query, options), ctx.self);
      return query.other ? pool.filter((c) => c !== ctx.self) : pool;
    }
  }
}

/* ------------------------------- effects ------------------------------ */

function effectActions(effect: EffectIR, ctx: ResolveContext, options: BindOptions): Action[] {
  if (effect.kind === 'result') {
    const action = effect.win ? win : lose;
    if (effect.players === 'you') {
      const player = ctx.self.controller;
      return player ? [action(player, ctx.self)] : [];
    }
    return ctx.engine.players.map((player) => action(player, ctx.self));
  }

  // Discover is an action rather than a loop here: `effectActions` is pure
  // (effect → actions), and this mechanic peeks, asks the player, and moves
  // cards. The zone roles are resolved through the host's aliases so the IR
  // never names a game's zones.
  if (effect.kind === 'discover') {
    const zone = (role: string): string => options.aliases?.[role] ?? role;
    // The skip test compiles into the **facts** that make it true, so the
    // engine never learns what a land is: it compares a map it was handed
    // against a card's declared attributes. A test it cannot reduce this way
    // (anything not a plain attribute comparison) is simply not applied — the
    // cost ceiling still governs — rather than throwing mid-resolution.
    const skip = skipFacts(effect.skip);
    return [
      discover({
        from: zone(effect.from),
        revealed: zone(effect.revealed),
        to: zone(effect.to),
        rest: zone(effect.rest),
        count: Math.max(1, Math.floor(valueOf(effect.count, ctx, options))),
        maxCost: valueOf(effect.maxCost, ctx, options),
        ...(skip ? { skip } : {}),
        source: ctx.self,
      }),
    ];
  }

  const entities = resolveQuery(effect.query, ctx, options);
  const actions: Action[] = [];
  switch (effect.kind) {
    case 'gauge': {
      for (const c of entities) {
        // The amount is evaluated **with the entity in scope** — "deal damage
        // equal to this character's toughness" is a per-entity amount, and a
        // scopeless `ValueIR` (a bare `gauge`, or an `attribute`) reads the
        // subject. Evaluating once outside the loop silently read 0.
        const amount = valueOf(effect.amount, { ...ctx, subject: c }, options);
        // Resolved per entity: the same `Deal 5 damage to all characters`
        // moves hp on one and loyalty on another, each by its own
        // declaration.
        const id = gaugeIdOf(effect.gauge, c);
        const gauge = id === undefined ? undefined : c.findGauge(id);
        if (!gauge) continue;
        if (effect.op === 'set') actions.push(setGauge(gauge, amount, ctx.self));
        else if (effect.op === 'add') actions.push(heal(gauge, amount, ctx.self));
        else actions.push(damage(gauge, amount, ctx.self));
      }
      break;
    }
    case 'destroy':
      for (const c of entities) actions.push(destroy(c, ctx.self));
      break;
    case 'addBuff': {
      const def = options.resolveBuff(effect.buff);
      if (!def) break; // unknown name — already a diagnostic
      for (const c of entities) actions.push(addBuff(c, def, ctx.self));
      break;
    }
    case 'removeBuff': {
      const def = options.resolveBuff(effect.buff);
      if (!def) break;
      const id = buffIdOf(def);
      for (const c of entities) actions.push(removeBuff(c, id, ctx.self));
      break;
    }
    case 'toggleBuff': {
      const def = options.resolveBuff(effect.buff);
      if (!def) break;
      const id = buffIdOf(def);
      // Every decision is read from the state *before* any of these
      // actions apply, which is what makes the flip atomic.
      for (const c of entities) {
        actions.push(c.hasStatus(id) ? removeBuff(c, id, ctx.self) : addBuff(c, def, ctx.self));
      }
      break;
    }
  }
  return actions;
}

/**
 * The attribute facts that make a `skip` predicate true, or `undefined` when it
 * is not a plain conjunction of attribute comparisons.
 *
 * The reduction is what keeps the engine generic: `land = 1` becomes
 * `{ land: 1 }`, and the discover loop only has to ask "does this entity declare
 * these facts". A predicate over anything else is not something a revealed card
 * can be tested against anyway (there is no board context mid-reveal), so it is
 * dropped rather than guessed at.
 *
 * This same reduction is what `PredicateIR` will use to filter an **action**;
 * it lives here because the reveal is the first effect that needed it.
 */
export function skipFacts(
  predicate: PredicateIR | undefined,
): ReadonlyMap<string, number | boolean> | undefined {
  if (!predicate) return undefined;
  const facts = new Map<string, number | boolean>();
  const collect = (node: PredicateIR): boolean => {
    if (node.kind === 'and') return node.clauses.every(collect);
    if (node.kind !== 'compare' || node.op !== '=') return false;
    const attribute = node.left.kind === 'attribute' ? node.left.attribute : undefined;
    const value = node.right.kind === 'const' ? node.right.value : undefined;
    if (attribute === undefined || value === undefined) return false;
    facts.set(attribute, value);
    return true;
  };
  return collect(predicate) && facts.size > 0 ? facts : undefined;
}

/** One step's actions — empty when its `when` predicate does not hold. */
function stepActions(step: StepIR, ctx: ResolveContext, options: BindOptions): Action[] {
  if (step.when && !predicateHolds(step.when, ctx, options)) return [];
  return step.effects.flatMap((effect) => effectActions(effect, ctx, options));
}

/**
 * One step's actions, asking the controller first when the step is
 * optional ("you **may** …").
 *
 * The `when` predicate is checked **before** the question, so a player is
 * never asked about a step that could not have run. A step with no owner
 * to ask falls through to the engine's own chooser, which answers yes by
 * default — declining would make every optional effect silently never
 * happen.
 */
async function stepActionsAsync(
  step: StepIR,
  ctx: ResolveContext,
  options: BindOptions,
  prompt: string,
  apply?: (actions: Action[]) => Promise<void>,
): Promise<Action[]> {
  if (step.when && !predicateHolds(step.when, ctx, options)) return [];
  if (step.optional) {
    const answer = await ctx.engine.ask({
      kind: 'confirm',
      prompt,
      chooser: ctx.self.controller,
      source: ctx.self,
    });
    if (answer.kind === 'confirm' && !answer.yes) return [];
  }
  if (step.repeat && apply) {
    // A repeat applies its own iterations, so there is nothing left to
    // hand back.
    await runRepeat(step, ctx, options, prompt, apply);
    return [];
  }
  return step.effects.flatMap((effect) => effectActions(effect, ctx, options));
}

/** True when any of these steps needs to ask, or repeats. */
function asks(steps: readonly StepIR[]): boolean {
  return steps.some((step) => step.optional === true || step.repeat !== undefined);
}

/** A repeat with no cap of its own still cannot run away. */
const REPEAT_LIMIT = 1000;

/**
 * Runs a repeating step, applying each iteration before deciding on the
 * next — so the `while` condition and the player both see what the
 * previous iteration did. That is why a repeat cannot just return actions
 * the way an ordinary step does.
 */
async function runRepeat(
  step: StepIR,
  ctx: ResolveContext,
  options: BindOptions,
  prompt: string,
  apply: (actions: Action[]) => Promise<void>,
): Promise<void> {
  const repeat = step.repeat!;
  const cap = Math.min(repeat.max ?? REPEAT_LIMIT, REPEAT_LIMIT);
  const mandatory = repeat.min ?? 0;
  for (let iteration = 0; iteration < cap; iteration += 1) {
    // The condition gates every iteration, mandatory ones included: the
    // floor means the player is not consulted, not that the effect applies
    // regardless.
    if (repeat.while && !predicateHolds(repeat.while, ctx, options)) return;
    if (repeat.confirm && iteration >= mandatory) {
      const answer = await ctx.engine.ask({
        kind: 'confirm',
        prompt: `${prompt} (again?)`,
        chooser: ctx.self.controller,
        source: ctx.self,
      });
      if (answer.kind === 'confirm' && !answer.yes) return;
    }
    const actions = step.effects.flatMap((effect) => effectActions(effect, ctx, options));
    if (actions.length > 0) await apply(actions);
  }
  if (repeat.max === undefined) {
    throw new Error(
      `"${prompt}": a repeat ran ${REPEAT_LIMIT} times without its condition turning false — possible infinite loop.`,
    );
  }
}

/* ----------------------------- targeting ------------------------------ */

/**
 * Assigns the ability's one pick list to its **named** bindings.
 *
 * The engine gives an ability a single pattern with a count, so bindings
 * are filled positionally: the first binding's `count` picks, then the
 * next's. Each slice is then checked against its *own* `who`/`filter`, so
 * a pick that is legal for one binding but not for the other is dropped
 * rather than silently accepted — the union pattern that let the player
 * choose it is deliberately looser than any single binding.
 */
function bindPicks(
  bindings: readonly TargetBindingIR[] | undefined,
  targeting: Targeting | undefined,
  options: BindOptions,
  actx: AbilityContext,
): ReadonlyMap<string, readonly Character[]> {
  if (!bindings || bindings.length === 0) return NO_BINDINGS;
  const picks = targeting?.targets ?? [];
  const out = new Map<string, readonly Character[]>();
  let offset = 0;
  for (const binding of bindings) {
    const slice = picks.slice(offset, offset + binding.count);
    offset += binding.count;
    const check = binding.filter ? checkOf(binding.filter, options) : undefined;
    const ctx: ResolveContext = {
      self: actx.self,
      engine: actx.engine,
      targeting: undefined,
      event: NO_EVENT,
      subject: undefined,
      bindings: NO_BINDINGS,
    };
    out.set(
      binding.name,
      slice.filter(
        (candidate) =>
          whoMatches(binding.who, candidate, actx) && (!check || check(ctx, candidate)),
      ),
    );
  }
  return out;
}

/** The `who` filter of a binding, relative to the ability's owner. */
function whoMatches(
  who: 'self' | 'ally' | 'enemy' | 'any',
  candidate: Character,
  actx: AbilityContext,
): boolean {
  switch (who) {
    case 'self':
      return candidate === actx.self;
    case 'ally':
      return isAlly(actx.self, candidate);
    case 'enemy':
      return isEnemy(actx.self, candidate);
    case 'any':
      return true;
  }
}

/**
 * The engine pattern for a set of named bindings: one pattern whose count
 * is their total and whose `match` admits a candidate legal for **any** of
 * them. Per-binding legality is enforced when the picks are assigned (see
 * `bindPicks`), because the engine cannot express "the first pick must be
 * an enemy and the second an ally".
 */
function bindingsPattern(
  bindings: readonly TargetBindingIR[],
  options: BindOptions,
): TargetPattern {
  const count = bindings.reduce((total, binding) => total + binding.count, 0);
  const whos = new Set(bindings.map((binding) => binding.who));
  const who: TargetWho = whos.size === 1 ? [...whos][0]! : 'any';
  const checks = bindings.map((binding) => ({
    who: binding.who,
    check: binding.filter ? checkOf(binding.filter, options) : undefined,
  }));
  // Distinctness is per ability: if any binding asks, every pick differs.
  const distinct = bindings.some((binding) => binding.distinct === true);
  return {
    who,
    count,
    ...(distinct ? {} : { allowDuplicates: true }),
    match: (tctx, candidate) => {
      const ctx: ResolveContext = {
        self: tctx.self,
        engine: tctx.engine,
        targeting: undefined,
        event: NO_EVENT,
        subject: undefined,
        bindings: NO_BINDINGS,
      };
      return checks.some(
        ({ who: bindingWho, check }) =>
          whoMatches(bindingWho, candidate, { self: tctx.self, engine: tctx.engine }) &&
          (!check || check(ctx, candidate)),
      );
    },
  };
}

function bindTargeting(targeting: TargetingIR, options: BindOptions): TargetPattern {
  const count = Array.isArray(targeting.count)
    ? ([targeting.count[0], targeting.count[1]] as [number, number])
    : (targeting.count as number);
  if (!targeting.filter) return { who: targeting.who, count };
  const check = checkOf(targeting.filter, options);
  return {
    who: targeting.who,
    count,
    match: (tctx, candidate) =>
      check({ self: tctx.self, engine: tctx.engine, targeting: undefined, event: NO_EVENT, subject: undefined, bindings: NO_BINDINGS }, candidate),
  };
}

/* ----------------------------- abilities ------------------------------ */

/**
 * An activated ability. A single step keeps the engine's one-shot apply
 * (identical to a hand-written `cast`); several steps resolve **one at a
 * time**, each fully landing before the next step's queries are evaluated.
 */
export function bindAbility(ir: AbilityIR, options: BindOptions): ManualAbility {
  const steps = ir.steps;
  const availableCheck = ir.available ? checkOf(ir.available, options) : undefined;
  return cast({
    id: ir.id,
    name: ir.name,
    targeting:
      ir.targets && ir.targets.length > 0
        ? bindingsPattern(ir.targets, options)
        : bindTargeting(ir.targeting, options),
    ...(ir.description ? { description: ir.description } : {}),
    ...(availableCheck
      ? {
          available: (actx: AbilityContext): boolean =>
            availableCheck(
              {
                self: actx.self,
                engine: actx.engine,
                targeting: undefined,
                event: NO_EVENT,
                subject: actx.self,
                bindings: NO_BINDINGS,
              },
              actx.self,
            ),
        }
      : {}),
    cast: async (actx: AbilityContext, targeting: Targeting) => {
      const ctx: ResolveContext = {
        self: actx.self,
        engine: actx.engine,
        targeting,
        event: NO_EVENT,
        subject: undefined,
        bindings: bindPicks(ir.targets, targeting, options, actx),
      };
      if (steps.length <= 1 && !asks(steps)) {
        return steps.flatMap((step) => stepActions(step, ctx, options));
      }
      const apply = async (actions: Action[]): Promise<void> => {
        await actx.engine.apply(actions, { source: actx.self });
      };
      if (steps.length <= 1) {
        // One step, but it asks or repeats — the single-apply shortcut
        // cannot await.
        return stepActionsAsync(steps[0]!, ctx, options, ir.name, apply);
      }
      for (const step of steps) {
        const actions = await stepActionsAsync(step, ctx, options, ir.name, apply);
        if (actions.length > 0) await apply(actions);
      }
      return [];
    },
  });
}

/* ------------------------------ triggers ------------------------------ */

/**
 * Pulls the entities a `:batch` event's individual event refers to.
 *
 * `sourceType` says which kind of cause counts. A buff-caused event has a
 * `Buff` source, not a character, so a card that answers only characters
 * says so and one that answers buffs says that instead — rather than the
 * binder silently keeping whichever it happens to understand.
 */
function bindingOf(event: unknown, sourceType: 'character' | 'buff' = 'character'): EventBinding {
  const subjects: Character[] = [];
  const sources: Character[] = [];
  const single = (e: Record<string, unknown>): void => {
    // `character` is the destruction/gauge subject; `entity` is the thing
    // that moved in a `zone:changed` — only a character can be filtered,
    // counted or targeted by the language, so a card in a deck is ignored.
    const subject = (e.character ??
      (e.target as unknown) ??
      (e.entity instanceof Character ? e.entity : undefined)) as Character | undefined;
    if (subject) subjects.push(subject);
    const source = e.source as { type?: string } | undefined;
    if (source && source.type === sourceType) sources.push(source as unknown as Character);
  };
  const record = event as Record<string, unknown>;
  const batch = record.events;
  if (Array.isArray(batch)) for (const e of batch) single(e as Record<string, unknown>);
  else single(record);
  return { subjects, sources };
}

/** The individual events of a `:batch` event (or the event itself). */
function eventsOf(event: unknown): readonly unknown[] {
  const batch = (event as { events?: unknown }).events;
  return Array.isArray(batch) ? batch : [event];
}

/**
 * A triggered ability.
 *
 * The evaluation order is the one the sentence implies but *reverses*: the
 * filter runs per triggering entity first, then the count gates the
 * filtered set, then the steps run. Both checks live in `when` — the
 * engine's prestack filter — so a trigger that does not pass never joins
 * the stack at all.
 */
/**
 * Which kind of cause this trigger's steps ask for. Taken from the first
 * `the source …` reference in its body — they all agree, because the
 * grammar writes the kind at the reference.
 */
function sourceTypeOf(ir: TriggerIR): 'character' | 'buff' {
  for (const step of ir.steps) {
    for (const effect of step.effects) {
      if (!isEntityEffect(effect)) continue;
      const query = effect.query;
      if (query.kind === 'event' && query.role === 'source' && query.sourceType) {
        return query.sourceType;
      }
    }
  }
  return 'character';
}

export function bindTrigger(ir: TriggerIR, options: BindOptions): AnyTriggeredAbility {
  const check = ir.filter ? checkOf(ir.filter, options) : undefined;

  /**
   * True when one individual event is the kind of change the trigger
   * wants. A gauge change carries no "was this damage" of its own — the
   * engine models damage as a gauge going down — so the direction is read
   * from the event's own `from`/`to`.
   */
  const changeMatches = (individual: unknown): boolean => {
    // A zone movement is matched by its two ends: `enters <zone>` reads the
    // destination, `leaves <zone>` the origin, and the optional opposite end
    // pins the other side of the move. A first placement has no `from`, so
    // an unqualified `enters play` fires for it too — that is what "no
    // matter where the previous zone was" means.
    if (ir.zone) {
      const event = individual as { from?: { id?: string }; to?: { id?: string } };
      const near = ir.zone.verb === 'enters' ? event.to?.id : event.from?.id;
      if (near !== ir.zone.id) return false;
      if (ir.zone.opposite !== undefined) {
        const far = ir.zone.verb === 'enters' ? event.from?.id : event.to?.id;
        if (far !== ir.zone.opposite) return false;
      }
      return true;
    }
    if (ir.gauge === undefined && ir.change === undefined) return true;
    const event = individual as {
      gauge?: { id?: string };
      from?: number;
      to?: number;
      character?: unknown;
      target?: unknown;
    };
    if (ir.gauge !== undefined) {
      // `takes damage` watches the life gauge of whoever took it, read
      // from that entity's own declaration — so the same trigger fires on
      // hp for a fighter and `loyalty` for a planeswalker. A named gauge
      // needs no entity.
      const entity = event.character ?? event.target;
      const wanted =
        typeof ir.gauge === 'string'
          ? ir.gauge
          : entity instanceof Character
            ? gaugeIdOf(ir.gauge, entity)
            : undefined;
      if (wanted === undefined || event.gauge?.id !== wanted) return false;
    }
    if (ir.change === undefined) return true;
    if (typeof event.from !== 'number' || typeof event.to !== 'number') return false;
    return ir.change === 'damage' ? event.to < event.from : event.to > event.from;
  };

  /** The triggering entities that survive the filter, per individual event. */
  const matching = (self: Character, engine: GameEngine, event: unknown): Character[] => {
    const ctx: ResolveContext = {
      self,
      engine,
      targeting: undefined,
      event: NO_EVENT,
      subject: undefined,
      bindings: NO_BINDINGS,
    };
    const kept: Character[] = [];
    for (const individual of eventsOf(event)) {
      if (!changeMatches(individual)) continue;
      const { subjects } = bindingOf(individual);
      for (const subject of subjects) {
        if (!check || check(ctx, subject)) kept.push(subject);
      }
    }
    return kept;
  };

  return auto({
    id: ir.id,
    name: ir.name,
    // The event name is compiled data, not a literal from the union — the
    // same widening every compiler does at its binding boundary.
    event: ir.event as GameEvent['type'],
    when: (tctx) => {
      // An event with no entity at all (`turn:start`) is a pure timing
      // trigger: nothing to filter, nothing to count.
      const bound = bindingOf(tctx.event);
      if (bound.subjects.length === 0 && !ir.filter && !ir.when) return true;

      const kept = matching(tctx.self, tctx.engine, tctx.event);
      // A batch event only fires when the batch held something, so "at
      // least one survived the filter" is the floor under every gate — it
      // is what an omitted `when` means, and what `count >= 1` would say.
      if (kept.length === 0) return false;
      if (!ir.when) return true;

      // The gate sees the *filtered* set: `count(event subjects)` is the
      // count the sentence's count phrase talks about.
      const ctx: ResolveContext = {
        self: tctx.self,
        engine: tctx.engine,
        targeting: undefined,
        event: { subjects: kept, sources: bound.sources },
        subject: undefined,
        bindings: NO_BINDINGS,
      };
      return predicateHolds(ir.when, ctx, options);
    },
    cast: async (tctx) => {
      const kept = matching(tctx.self, tctx.engine, tctx.event);
      // `the source` is whoever *else* caused it: a self-inflicted cost
      // retaliating against its own owner is never what content means.
      const sourceType = sourceTypeOf(ir);
      const sources = eventsOf(tctx.event)
        .filter((individual) => changeMatches(individual))
        .flatMap((individual) => bindingOf(individual, sourceType).sources)
        .filter((source) => source !== tctx.self);
      const ctx: ResolveContext = {
        self: tctx.self,
        engine: tctx.engine,
        targeting: undefined,
        event: { subjects: kept, sources },
        subject: undefined,
        bindings: NO_BINDINGS,
      };
      if (ir.steps.length <= 1 && !asks(ir.steps)) {
        return ir.steps.flatMap((step) => stepActions(step, ctx, options));
      }
      const apply = async (actions: Action[]): Promise<void> => {
        await tctx.engine.apply(actions, { source: tctx.self });
      };
      if (ir.steps.length <= 1) {
        return stepActionsAsync(ir.steps[0]!, ctx, options, ir.name, apply);
      }
      for (const step of ir.steps) {
        const actions = await stepActionsAsync(step, ctx, options, ir.name, apply);
        if (actions.length > 0) await apply(actions);
      }
      return [];
    },
  });
}

/* ------------------------------ modifiers ----------------------------- */

/**
 * Binds a modifier: a match on the action, then a rescaling of the
 * change's **magnitude**.
 *
 * The magnitude is read by evaluating the action's own `update` against the
 * gauge's real values — not by assuming a flat amount — so an amount
 * computed from the gauge rescales correctly, and two modifiers compose
 * rather than overwrite each other.
 *
 * Rewrites compose as **pure arithmetic on a signed magnitude that may go
 * negative mid-chain** — "reduced by 10" then "increased by 5" on 8 damage
 * is `8 - 10 + 5 = 3`, not 0. Nothing here floors it: the one place that
 * happens is `#applyGaugeBatch`, when the fully-composed change finally
 * reaches the gauge, clamped against the action's `intent` so a damage
 * action can never net out as a heal (or vice versa) — "reduced by 50" on
 * 10 damage is 0, not +40 healing. Composing the floor at every step, the
 * way this used to work, makes a chain **order-sensitive in a way the
 * magnitude is not supposed to be** (see `docs/todo/`): once a step floors
 * to exactly zero, no later `add`/`multiply`/`cap` can tell that from a
 * genuinely zero-magnitude action, so it never revives. Flooring once,
 * only where the result actually lands, avoids that.
 *
 * That same reasoning is why **damage-or-heal is judged from the action's
 * declared `intent`, fixed at creation, rather than the signed change at
 * this point in the chain** — the running change crosses zero exactly
 * when an earlier rewrite overshoots, and at that moment the live sign
 * stops meaning what it used to. `intent` doesn't move. An intent-less
 * raw gauge write (no `damage`/`heal` sugar) has no such anchor, so it
 * falls back to the live sign, same as before.
 */
function bindModifier(ir: ModifierIR, options: BindOptions): PassiveActionModifier {
  const match = ir.match;
  const targetCheck = match.target ? checkOf(match.target, options) : undefined;

  return passiveActionModifier({
    id: ir.id,
    name: ir.name,
    transform: (action, actx) => {
      if (action.type !== 'gauge') return action;
      if (match.direction && action.direction !== match.direction) return action;
      // A named gauge can be settled before anything else is resolved; the
      // life-gauge form needs the victim first, just below.
      if (typeof match.gauge === 'string' && action.target.id !== match.gauge) return action;

      // The owner of the modifier: for an outgoing action it is the actor,
      // for an incoming one it is the thing being acted on.
      const owner = action.direction === 'incoming' ? actx.target : actx.source;
      if (!(owner instanceof Character)) return action;
      const victim = actx.engine.characterOf(action.target);

      // `damage`/`healing` claim the **life gauge of whatever is being
      // changed** — hp on a fighter, `loyalty` on a planeswalker — read
      // from that entity's own declaration rather than assumed to be
      // `'hp'`. Note it is the *victim's* life gauge even for an outgoing
      // match: "damage you deal" is damage to the thing you hit, so which
      // gauge counts as its life is its question, not the actor's.
      if (match.gauge !== undefined && typeof match.gauge !== 'string') {
        if (!victim) return action;
        if (action.target.id !== gaugeIdOf(match.gauge, victim)) return action;
      }

      // "Damage you deal" means to something else — a self-inflicted cost
      // is not the kind of outgoing action a damage modifier is about.
      if (match.direction === 'outgoing' && victim === owner) return action;

      // The action's fixed direction: -1 for damage, +1 for heal, read
      // from `intent` where it was declared at creation and never
      // recomputed — see the function doc. Falls back to the live sign
      // only for an intent-less raw gauge write.
      const change = gaugeDelta(action);
      const originalSign =
        action.intent === 'damage' ? -1 : action.intent === 'heal' ? 1 : Math.sign(change);
      if (originalSign === 0) return action;
      const isDamage = originalSign < 0;
      if (match.change === 'damage' && !isDamage) return action;
      if (match.change === 'heal' && isDamage) return action;

      // The other party: who an outgoing action is aimed at (the victim),
      // or who an incoming one came from. Not `victim` for an incoming
      // action — that is always the owner itself, since an incoming
      // action's gauge write lands on the character whose own transformers
      // are running.
      const other =
        action.direction === 'incoming'
          ? actx.source instanceof Character
            ? actx.source
            : undefined
          : victim;

      const ctx: ResolveContext = {
        self: owner,
        engine: actx.engine,
        targeting: undefined,
        event: NO_EVENT,
        subject: victim,
        bindings: NO_BINDINGS,
      };
      if (targetCheck && (!other || !targetCheck(ctx, other))) return action;

      // The chance is rolled per action, after everything else has
      // matched — so a roll is never spent on an action the modifier was
      // not going to touch anyway.
      if (ir.chance !== undefined) {
        const percent = valueOf(ir.chance, ctx, options);
        if (actx.engine.random() * 100 >= percent) return action;
      }

      if (ir.rewrite.kind === 'prevent') {
        return { ...action, update: (current: number) => current };
      }
      if (ir.rewrite.kind === 'redirect') {
        if (!victim) return action;
        const destination = victim.findGauge(ir.rewrite.gauge);
        if (!destination || destination === action.target) return action;
        // The realized change, captured once — the same thing
        // `redirectGauge` (`src/engine/actions.ts`) does, and for the same
        // reason: the source gauge's own transformers have already run by
        // this point, so this is the delta they left behind, not a live
        // read repeated later.
        const realized = change;
        return {
          type: 'gauge',
          target: destination,
          update: (current: number) => current + realized,
          intent: realized < 0 ? 'damage' : realized > 0 ? 'heal' : 'other',
          ...(action.source ? { source: action.source } : {}),
        };
      }
      const operand = valueOf(
        ir.rewrite.kind === 'cap' ? ir.rewrite.at : ir.rewrite.by,
        ctx,
        options,
      );
      const rescale = rescaleOf(ir.rewrite.kind === 'cap' ? 'cap' : ir.rewrite.op, operand);
      return gaugeTransformCtx((prev) => (current, max) => {
        const base = prev(current, max);
        // The magnitude so far, signed relative to the action's *original*
        // direction — positive means "more of what this already was",
        // negative means a reduction has overshot past zero. Rescaling
        // this directly (no floor here) is what lets a later step see and
        // continue from an overshoot instead of a dead zero.
        const magnitude = originalSign * (base - current);
        return current + originalSign * rescale(magnitude);
      })(action, actx);
    },
  });
}

/** The magnitude rewrite for one op. */
function rescaleOf(op: 'add' | 'subtract' | 'multiply' | 'cap', operand: number): (magnitude: number) => number {
  switch (op) {
    case 'add':
      return (magnitude) => magnitude + operand;
    case 'subtract':
      return (magnitude) => magnitude - operand;
    case 'multiply':
      return (magnitude) => magnitude * operand;
    case 'cap':
      return (magnitude) => Math.min(magnitude, operand);
  }
}

/* -------------------------------- buffs ------------------------------- */

export function bindBuff(ir: BuffIR, options: BindOptions): BuffDef {
  const abilities: Ability[] = ir.triggers.map((trigger) => bindTrigger(trigger, options));
  for (const modifier of ir.modifiers ?? []) abilities.push(bindModifier(modifier, options));
  const expiry = ir.duration ? expiryAbility(ir) : undefined;
  if (expiry) abilities.push(expiry);
  return makeBuff({
    id: ir.id,
    name: ir.name,
    weight: ir.weight,
    ...(ir.stacks ? { stacks: true } : {}),
    ...(ir.duration?.kind === 'turns' && ir.duration.count > 1
      ? { variables: () => ({ turnsLeft: (ir.duration as { count: number }).count }) }
      : {}),
    ...(abilities.length > 0 ? { abilities } : {}),
  });
}

/**
 * A duration as an ordinary triggered ability: at the end of a turn, the
 * buff takes itself off.
 *
 * The engine needs no concept of expiry for this — a buff is already a
 * bundle of abilities, and one of them removing the buff is all "until end
 * of turn" means. For a multi-turn duration the countdown lives in the
 * instance's own `vars`, so each stack expires on its own schedule.
 */
function expiryAbility(ir: BuffIR): Ability {
  const duration = ir.duration!;
  const turns = duration.kind === 'turns' ? duration.count : 1;
  if (turns <= 1) {
    return auto({
      id: `${ir.id}-expiry`,
      name: `${ir.name} expires`,
      event: 'turn:end',
      targets: () => [],
      cast: (ctx): Action[] => [removeBuff(ctx.self, ir.id, ctx.self)],
    });
  }
  return auto({
    id: `${ir.id}-expiry`,
    name: `${ir.name} expires`,
    event: 'turn:end',
    targets: () => [],
    cast: (ctx): Action[] => {
      const left = Number(ctx.status.vars.turnsLeft ?? turns) - 1;
      ctx.status.vars.turnsLeft = left;
      return left <= 0 ? [removeBuff(ctx.self, ir.id, ctx.self)] : [];
    },
  });
}

/* ------------------------------ documents ----------------------------- */

export function bindDocument(doc: DocumentIR, options: BindOptions): BindResult {
  return {
    abilities: doc.abilities.map((ir) => bindAbility(ir, options)),
    buffs: doc.buffs.map((ir) => bindBuff(ir, options)),
    triggers: doc.triggers.map((ir) => bindTrigger(ir, options)),
  };
}
