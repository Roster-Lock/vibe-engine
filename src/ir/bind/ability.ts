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
  markersFor,
  move as moveEntity,
  heal,
  gaugeDelta,
  gaugeTransformCtx,
  passiveActionModifier,
  removeBuff,
  setGauge,
  type Ability,
  type Entity,
  type Zone,
  type AbilityContext,
  type Action,
  type AnyTriggeredAbility,
  type BuffDef,
  type GameEngine,
  type ChoiceRequest,
  type GameEvent,
  type Player,
  type SealedRound,
  type ManualAbility,
  type PassiveActionModifier,
  type TargetPattern,
  type Targeting,
  type TargetWho,
} from '../../engine/index.js';
// `win`/`lose` are round-based game actions, not engine vocabulary.
import { lose, win } from '../../games/round-based/index.js';
import type {
  CardSelectorIR,
  CardSourceIR,
  ZoneRefIR,
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
  ZoneSectionIR,
} from '../ability.js';
import { isAlly, isEnemy } from '../../games/round-based/index.js';
import { isEntityEffect } from '../ability.js';
import { validateRounds } from '../rounds.js';
import { engineCast, engineCastable, type CastFn } from '../../games/cards/cast.js';
import { engineCreate, type CreateFn } from '../../games/cards/create.js';
import { createDraw, engineDraw, type DrawFn } from '../../games/cards/draw.js';
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
  /**
   * Bind an ability whose choice rounds break the table procedure instead of
   * throwing. For a caller that has already reported the problems as
   * diagnostics (the English compiler) and still wants a document to preview.
   * Defaults to `false`: a JSON document nobody checked is refused.
   */
  readonly allowUnsoundRounds?: boolean;
  /**
   * The game's `cast(player, card)`, for *Cast this card*. Without one the effect
   * uses the one the game registered for its engine (`setEngineCast`), and fails
   * if there is none — casting is the game's business, not the IR's.
   */
  readonly cast?: CastFn;
  /**
   * Finds an ability of the document being bound by its `id`. `bindDocument` fills
   * it in with its own abilities (so "have Open Present" can name a sibling); a
   * host may supply one for abilities that live elsewhere.
   */
  readonly resolveAbility?: (id: string) => ManualAbility | undefined;
  /**
   * The game's `draw(player, count)`, for the language's `Draw(you, 2).` Without
   * one, a plain draw is used: cards move from the top of the aliased `library`
   * to the aliased `hand`, with no limit and no penalty for an empty library.
   */
  readonly draw?: DrawFn;
  /** The game's `create(player, creature)`, for the language's `Create a Giant Golem.` */
  readonly create?: CreateFn;
}

/** A `Zone` section, bound: call `apply` once the game's zones and players exist. */
export interface ZoneBinding {
  /** The zone, as the document wrote it. */
  readonly zone: string;
  /**
   * Runs the section for each instance of the zone — all players', for a per-player
   * zone — with that instance's owner as "you". Safe to call again: it sets the same
   * state.
   */
  apply(engine: GameEngine): Promise<void>;
  /**
   * Runs the zone's standing rules for `event` (`When your turn starts then …` is `turn:start`).
   * A rule that says "your" runs only for the instance `turnOwner` owns.
   */
  trigger(event: string, engine: GameEngine, turnOwner: Player | undefined): Promise<void>;
}

export interface BindResult {
  readonly abilities: ManualAbility[];
  /** One binding per `Zone` section, in document order. */
  readonly zones: ZoneBinding[];
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
  /**
   * The choice rounds this resolution has opened, by name. Present only where an
   * ability actually resolves (a cast or a trigger); a context built just to
   * evaluate a predicate has none.
   */
  readonly rounds?: Map<string, RoundState>;
  /** The most recent roll this resolution made; `rolled` values read it. */
  readonly rolled?: { results: readonly number[] };
  /** Values kept with `store`, by name; `variable` values read them. */
  readonly variables?: Map<string, number>;
  /** The card an ability a zone or effect gave it belongs to — "this card". */
  readonly host?: Entity;
  /** The zone instance a `Zone` section is being applied to — "this zone". */
  readonly thisZone?: Zone;
  /** Temporary piles this resolution made; they are cleared away when it ends. */
  readonly temporary?: TemporaryZones;
}

/**
 * Piles an effect makes for a moment (`the temporary zone Pool`, the two halves of a split).
 * They are real zones while the ability resolves, and gone after it: whatever is still in
 * one then goes to its owner's garbage.
 */
class TemporaryZones {
  static #next = 1;
  readonly zones = new Map<string, Zone>();
  /** The outcome of the last contest played in this resolution (`the winners`, `the losers`). */
  winners: Player[] = [];
  losers: Player[] = [];
  /** The opponent "target opponent" named the first time; later mentions are the same player. */
  targetOpponent: Player | undefined;
  /** The pile picked by the last `choosePile`, and the one not picked. */
  chosen: string | undefined;
  other: string | undefined;

  /** The zone called `name` (`@chosen` / `@other` for the last choice), made on first use if `create`. */
  resolve(ctx: { readonly engine: GameEngine }, name: string, create: boolean): Zone | undefined {
    const real = name === '@chosen' ? this.chosen : name === '@other' ? this.other : name;
    if (real === undefined) return undefined;
    const existing = this.zones.get(real);
    if (existing || !create) return existing;
    const id = `temp:${TemporaryZones.#next++}:${real}`;
    ctx.engine.zones.declare({ id, visibility: 'public' });
    const made = ctx.engine.zones.zone(id)!;
    this.zones.set(real, made);
    return made;
  }
}

/** Ends the piles: leftover cards go to their owners' garbage, then the zones are removed. */
async function clearTemporary(ctx: ResolveContext, options: BindOptions): Promise<void> {
  if (!ctx.temporary) return;
  const garbage = options.aliases?.garbage ?? 'garbage';
  for (const zone of ctx.temporary.zones.values()) {
    for (const card of [...zone.members]) {
      const owner = card.owner ?? ctx.self.controller;
      await ctx.engine.moveTo(card, garbage, { ...(owner ? { owner } : {}), source: ctx.self, reason: 'temporary zone ended' });
    }
    ctx.engine.zones.undeclare(zone.id);
  }
  ctx.temporary.zones.clear();
}

/** A named choice round: the engine's sealed round, and whether it was secret. */
interface RoundState {
  readonly round: SealedRound;
  readonly secret: boolean;
  /** True for a vote — a round over labelled options, whose answers `votes` counts. */
  readonly label: boolean;
  /** The names on the ballot of a vote — every one has a tally, even 0. */
  readonly options?: readonly string[];
}

/** The votes cast for each option in the most recent vote; empty when there is none. */
function tallyOf(ctx: ResolveContext): Map<string, number> {
  const counts = new Map<string, number>();
  let latest: RoundState | undefined;
  for (const state of ctx.rounds?.values() ?? []) if (state.label) latest = state;
  if (!latest) return counts;
  if (!latest.round.revealed) {
    throw new Error('the votes are still sealed — reveal them before counting');
  }
  for (const option of latest.options ?? []) counts.set(option, 0);
  for (const { answer } of latest.round.answers) {
    if (answer.kind === 'label') counts.set(answer.value, (counts.get(answer.value) ?? 0) + 1);
  }
  return counts;
}

/** The most (or fewest) votes any option on the ballot got; 0 when there is no vote. */
function voteStatOf(ctx: ResolveContext, stat: 'highest' | 'lowest'): number {
  const counts = [...tallyOf(ctx).values()];
  if (counts.length === 0) return 0;
  return stat === 'highest' ? Math.max(...counts) : Math.min(...counts);
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

/** What a roll came to: the total, or the highest / lowest die. Zero if nothing was rolled. */
function rolledStat(results: readonly number[] | undefined, stat: 'total' | 'highest' | 'lowest'): number {
  if (!results || results.length === 0) return 0;
  if (stat === 'highest') return Math.max(...results);
  if (stat === 'lowest') return Math.min(...results);
  return results.reduce((sum, die) => sum + die, 0);
}

function valueOf(value: ValueIR, ctx: ResolveContext, options: BindOptions): number {
  switch (value.kind) {
    case 'const':
      return value.value;
    case 'rolled':
      return rolledStat(ctx.rolled?.results, value.stat);
    case 'variable':
      return ctx.variables?.get(value.name) ?? 0;
    case 'votes':
      return tallyOf(ctx).get(value.option) ?? 0;
    case 'voteStat':
      return voteStatOf(ctx, value.stat);
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
        // The latest roll, so a formula reads `roll.total` (English: "the total").
        roll: {
          total: rolledStat(ctx.rolled?.results, 'total'),
          highest: rolledStat(ctx.rolled?.results, 'highest'),
          lowest: rolledStat(ctx.rolled?.results, 'lowest'),
        },
        // `votes.Attack` — the latest vote's tally (empty before one is held).
        votes: Object.fromEntries(ctx.rounds && [...ctx.rounds.values()].some((s) => s.label) ? tallyOf(ctx) : []),
        vote: {
          highest: ctx.rounds && [...ctx.rounds.values()].some((s) => s.label) ? voteStatOf(ctx, 'highest') : 0,
          lowest: ctx.rounds && [...ctx.rounds.values()].some((s) => s.label) ? voteStatOf(ctx, 'lowest') : 0,
        },
        // Stored values are plain names in a formula: `(AttackerRoll * 2)`.
        ...Object.fromEntries(ctx.variables ?? []),
      }, { step: () => ctx.engine.gas.spend('math') });
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
        case 'winners':
        case 'losers':
          return candidate.controller !== undefined && (ctx.temporary?.[predicate.to] ?? []).includes(candidate.controller);
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
function patternOf(
  query: Extract<EntityQueryIR, { kind: 'all' }>,
  options: BindOptions,
  /** The resolution's scratch, so `owned by the winners` can read the last contest. */
  temporary?: TemporaryZones,
): TargetPattern {
  const who: TargetWho = query.who;
  if (!query.filter) return { who, count: 1 };
  const check = checkOf(query.filter, options);
  return {
    who,
    count: 1,
    match: (tctx, candidate) =>
      check(
        {
          self: tctx.self,
          engine: tctx.engine,
          targeting: undefined,
          event: NO_EVENT,
          subject: undefined,
          bindings: NO_BINDINGS,
          ...(temporary ? { temporary } : {}),
        },
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
      const pool = ctx.engine.validTargets(patternOf(query, options, ctx.temporary), ctx.self);
      return query.other ? pool.filter((c) => c !== ctx.self) : pool;
    }
  }
}

/* ------------------------------- effects ------------------------------ */

function effectActions(effect: EffectIR, ctx: ResolveContext, options: BindOptions): Action[] {
  ctx.engine.gas.spend('effect', effect.kind);
  if (effect.kind === 'result') {
    const action = effect.win ? win : lose;
    if (effect.players === 'you') {
      const player = ctx.self.controller;
      return player ? [action(player, ctx.self)] : [];
    }
    return ctx.engine.players.map((player) => action(player, ctx.self));
  }

  // Round effects ask players, so they run in `effectsAsync`; a pure action list
  // has nothing to return for them.
  if (isRoundEffect(effect)) return [];

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

/* --------------------------- choice rounds ---------------------------- */

/** Effects that ask players or open/read a round, and so cannot be a pure action list. */
function isRoundEffect(
  effect: EffectIR,
): effect is Extract<
  EffectIR,
  { kind: 'choose' | 'reveal' | 'moveChosen' | 'roll' | 'store' | 'draw' | 'table' | 'revealCard' | 'castCard' | 'moveCard' | 'moveCards' | 'revealCards' | 'split' | 'choosePile' | 'removeCounters' | 'castCards' | 'play' | 'create' | 'scry' | 'zoneAbility' }
> {
  return (
    effect.kind === 'zoneAbility' ||
    effect.kind === 'revealCard' ||
    effect.kind === 'castCard' ||
    effect.kind === 'moveCard' ||
    effect.kind === 'moveCards' ||
    effect.kind === 'revealCards' ||
    effect.kind === 'removeCounters' ||
    effect.kind === 'play' ||
    effect.kind === 'create' ||
    effect.kind === 'castCards' ||
    effect.kind === 'split' ||
    effect.kind === 'choosePile' ||
    effect.kind === 'scry' ||
    effect.kind === 'table' ||
    effect.kind === 'store' ||
    effect.kind === 'draw' ||
    effect.kind === 'choose' ||
    effect.kind === 'reveal' ||
    effect.kind === 'moveChosen' ||
    effect.kind === 'roll'
  );
}

/**
 * The players a `choose` asks: the controller first, then **round the table** in
 * seating order from them (so with seats A B C D and C casting: C, D, A, B).
 */
function choosersOf(who: 'you' | 'each' | 'opponents' | 'winners' | 'losers', ctx: ResolveContext): Player[] {
  const you = ctx.self.controller;
  const everyone = ctx.engine.players;
  if (who === 'winners' || who === 'losers') return [...(ctx.temporary?.[who] ?? [])];
  if (who === 'you') return you ? [you] : [];
  if (who === 'opponents') return everyone.filter((player) => player !== you);
  const at = you ? everyone.indexOf(you) : -1;
  if (at < 0) return you ? [you, ...everyone.filter((player) => player !== you)] : [...everyone];
  return [...everyone.slice(at), ...everyone.slice(0, at)];
}

/**
 * The players of a `choose` in the order they answer.
 *
 * Only an open round of `each` player has an order to choose; a sealed round
 * answers all at once and a `you` / `opponents` round has no seating to rotate.
 * `caster-first` is `choosersOf`; the others rotate or reverse the engine's
 * seating (`engine.players`). `random` rolls a die with one face per seat — a
 * real roll through the pipeline, so a table rolls a real die and the roll is
 * announced.
 */
async function votersOf(
  effect: Extract<EffectIR, { kind: 'choose' }>,
  ctx: ResolveContext,
): Promise<Player[]> {
  const order = effect.order ?? 'caster-first';
  const base = choosersOf(effect.players, ctx);
  if (effect.secret || effect.players !== 'each' || order === 'caster-first') return base;
  const seats = ctx.engine.players;
  const rotate = (start: number): Player[] => [...seats.slice(start), ...seats.slice(0, start)];
  if (order === 'reverse') return [...seats].reverse();
  const caster = ctx.self.controller;
  const at = Math.max(0, caster ? seats.indexOf(caster) : 0);
  if (order === 'caster-last') return rotate((at + 1) % seats.length);
  // A single seat has nothing to roll for.
  if (seats.length < 2) return [...seats];
  const [roll] = await ctx.engine.roll(1, seats.length, { source: ctx.self, reason: 'who votes first' });
  return rotate((roll! - 1) % seats.length);
}

function roundOf(name: string, ctx: ResolveContext): RoundState {
  const state = ctx.rounds?.get(name);
  if (!state) throw new Error(`choice round "${name}" has not been opened`);
  return state;
}

/**
 * `Scry(player, X)`: the player looks at the top X cards of their library, chooses any
 * number to put on the bottom, and then the order the rest go back on top. Only they see
 * the cards, and only for as long as it takes.
 */
async function scry(
  player: Player,
  count: number,
  ctx: ResolveContext,
  libraryRole: string,
  prompt: string,
  /** Where the cards not kept on top go: the bottom of the library (scry), or this zone (surveil). */
  discardTo?: string,
): Promise<void> {
  const library = ctx.engine.zones.zone(libraryRole, player);
  if (!library) throw new Error(`"${prompt}": ${player.name} has no ${libraryRole} to scry`);
  const section = library.section(count);
  if (section.length === 0) return;
  const looks = section.map((card) => ctx.engine.showTo(card, [player], { until: 'manual', source: ctx.self }));
  try {
    const down = await ctx.engine.ask({
      kind: 'select',
      prompt: `${prompt}: choose any number of cards to put ${discardTo ? 'in your garbage' : 'on the bottom'}`,
      chooser: player,
      options: section,
      count: [0, section.length],
      source: ctx.self,
    });
    const bottom = down.kind === 'select' ? [...down.chosen] : [];
    // The rest go back on top; the player names the top card, then the next, and so on.
    const rest = section.filter((card) => !bottom.includes(card));
    const top: Entity[] = [];
    while (rest.length > 1) {
      const next = await ctx.engine.ask({
        kind: 'select',
        prompt: `${prompt}: choose the next card to put on top`,
        chooser: player,
        options: rest,
        count: 1,
        source: ctx.self,
      });
      const picked = next.kind === 'select' ? next.chosen[0] : undefined;
      const card = picked && rest.includes(picked) ? picked : rest[0]!;
      rest.splice(rest.indexOf(card), 1);
      top.push(card);
    }
    top.push(...rest);
    if (discardTo) {
      // Surveil: the discards leave first; what is left of the section goes back on top in order.
      for (const card of bottom) await ctx.engine.moveTo(card, discardTo, { owner: player, source: ctx.self, reason: prompt });
      ctx.engine.arrange(library.id, top.length, { top }, { owner: player });
    } else {
      ctx.engine.arrange(library.id, section.length, { top, bottom }, { owner: player });
    }
  } finally {
    for (const look of looks) look.end();
  }
}

/** The players a zone reference names ("target opponent" asks the controller when there are several). */
async function playersOf(
  whose: ZoneRefIR['whose'],
  ctx: ResolveContext,
  prompt: string,
): Promise<(Player | undefined)[]> {
  const controller = ctx.self.controller;
  switch (whose) {
    case 'shared':
    case 'temporary':
    case 'this':
      return [undefined];
    case 'owner':
      return [];
    case 'you':
      return controller ? [controller] : [];
    case 'each':
      return choosersOf('each', ctx);
    case 'opponents':
      return choosersOf('opponents', ctx);
    case 'opponent': {
      const others = choosersOf('opponents', ctx);
      if (others.length <= 1) return others;
      // "Target opponent" is chosen once: every later mention in the same resolution is the same player.
      if (ctx.temporary?.targetOpponent && others.includes(ctx.temporary.targetOpponent)) return [ctx.temporary.targetOpponent];
      const answer = await ctx.engine.ask({
        kind: 'label',
        prompt,
        chooser: controller,
        options: others.map((player) => player.name),
      });
      const picked = (answer.kind === 'label' ? others.find((player) => player.name === answer.value) : undefined) ?? others[0]!;
      if (ctx.temporary) ctx.temporary.targetOpponent = picked;
      return [picked];
    }
  }
}

/** One place cards are taken from: a zone (with its owner), or everything a player can cast. */
interface CardGroup {
  readonly members: readonly Entity[];
  /** Whose zone it is — where "its owner's" sends them, unless the cards say otherwise. */
  readonly owner: Player | undefined;
  /** The player this group belongs to, to pair with "all opponents' … to all opponents' …". */
  readonly player: Player | undefined;
}

async function groupsOf(
  from: CardSourceIR,
  ctx: ResolveContext,
  zone: (role: string) => string,
  prompt: string,
): Promise<CardGroup[]> {
  if ('castableBy' in from) {
    const castable = engineCastable(ctx.engine);
    if (!castable) throw new Error(`"${prompt}": this game has no cards that can be cast`);
    const players = await playersOf(from.castableBy, ctx, prompt);
    return players.map((player) => ({ members: player ? castable(player) : [], owner: undefined, player }));
  }
  if (from.whose === 'this') {
    if (!ctx.thisZone) throw new Error(`"${prompt}": "this zone" needs a Zone section to be about`);
    return [{ members: ctx.thisZone.members, owner: ctx.thisZone.owner, player: ctx.thisZone.owner }];
  }
  if (from.whose === 'temporary') {
    const pile = ctx.temporary?.resolve(ctx, from.zone, false);
    if (!pile) throw new Error(`"${prompt}": there is no temporary zone "${from.zone}" yet — move cards into it first`);
    return [{ members: pile.members, owner: undefined, player: undefined }];
  }
  const groups: CardGroup[] = [];
  for (const player of await playersOf(from.whose, ctx, prompt)) {
    const source = ctx.engine.zones.zone(zone(from.zone), player);
    if (!source) throw new Error(`"${prompt}": there is no zone "${from.zone}" to take cards from`);
    groups.push({ members: source.members, owner: source.owner, player });
  }
  return groups;
}

/**
 * `Move <cards> from <zone> to <zone>.` — the cards each source gives up, and the moves
 * that put them where they go.
 *
 * Which players' zones: `you`, an `opponent` (the only one, or the one the controller
 * names), every `opponents`, or `each` player; `shared` is a zone nobody owns; or the
 * cards a player could cast. The destination is one zone, or `owner` (each card back to
 * its own owner's — the card's, when it says whose it is, else the zone's), or — when both
 * ends say the same many-player thing ("all opponents' … to all opponents' …") — the
 * same player's.
 */
async function moveCardsActions(
  effect: Extract<EffectIR, { kind: 'moveCards' }>,
  ctx: ResolveContext,
  zone: (role: string) => string,
  prompt: string,
): Promise<Action[]> {
  const fromWhose = 'castableBy' in effect.from ? effect.from.castableBy : effect.from.whose;
  // Who a destination zone belongs to: its owner's (the card's), the same many-player
  // thing as the source (all opponents' … to all opponents' …), or one named player.
  const named = new Map<string, Player | undefined>();
  for (const ref of [effect.to, ...(effect.rest ? [effect.rest.to] : [])]) {
    const many = (ref.whose === 'each' || ref.whose === 'opponents') && ref.whose === fromWhose;
    if (ref.whose === 'owner' || ref.whose === 'shared' || ref.whose === 'temporary' || ref.whose === 'this' || many || named.has(ref.whose)) continue;
    const players = await playersOf(ref.whose, ctx, prompt);
    if (players.length !== 1) {
      throw new Error(`"${prompt}": "${ref.whose}" names more than one place for the cards to go — name one zone`);
    }
    named.set(ref.whose, players[0]);
  }

  const controller = ctx.self.controller;
  const actions: Action[] = [];
  for (const group of await groupsOf(effect.from, ctx, zone, prompt)) {
    // `any number of …` names a pool and lets the controller pick from it; otherwise the
    // selector itself says which cards.
    const poolSelect: CardSelectorIR = effect.select.any
      ? { ...effect.select, how: effect.select.how === 'choose' ? 'all' : effect.select.how, any: undefined as never }
      : effect.select;
    const pool = await takeCards(poolSelect, group.members, ctx, prompt);
    if (pool.length === 0) continue;

    let picked: Entity[] = pool;
    let rest: Entity[] = [];
    const looks = effect.select.any && controller ? pool.map((card) => ctx.engine.showTo(card, [controller], { until: 'manual', source: ctx.self })) : [];
    try {
      if (effect.select.any) {
        const answer = await ctx.engine.ask({
          kind: 'select',
          prompt: `${prompt}: choose any number of cards`,
          chooser: controller,
          options: pool,
          count: [0, pool.length],
          source: ctx.self,
        });
        picked = answer.kind === 'select' ? pool.filter((card) => answer.chosen.includes(card)) : [];
        rest = pool.filter((card) => !picked.includes(card));
      }
      if (effect.order === 'chosen') picked = await chooseOrder(picked, controller, ctx, prompt);
      if (effect.rest?.order === 'chosen') rest = await chooseOrder(rest, controller, ctx, prompt);
    } finally {
      for (const look of looks) look.end();
    }

    const destination = (ref: ZoneRefIR, card: Entity): Zone => {
      if (ref.whose === 'this') {
        if (!ctx.thisZone) throw new Error(`"${prompt}": "this zone" needs a Zone section to be about`);
        return ctx.thisZone;
      }
      if (ref.whose === 'temporary') {
        const pile = ctx.temporary?.resolve(ctx, ref.zone, true);
        if (!pile) throw new Error(`"${prompt}": there is no pile "${ref.zone}" to move cards to`);
        return pile;
      }
      const many = (ref.whose === 'each' || ref.whose === 'opponents') && ref.whose === fromWhose;
      const owner =
        ref.whose === 'owner' ? (card.owner ?? group.owner) : ref.whose === 'shared' ? undefined : many ? group.player : named.get(ref.whose);
      const to = ctx.engine.zones.zone(zone(ref.zone), owner);
      if (!to) throw new Error(`"${prompt}": there is no zone "${ref.zone}" to move cards to`);
      return to;
    };
    const placements: { card: Entity; to: Zone; position?: 'top' | 'bottom' }[] = [
      ...picked.map((card) => ({ card, to: destination(effect.to, card), ...(effect.to.position ? { position: effect.to.position } : {}) })),
      ...(effect.rest ? rest.map((card) => ({ card, to: destination(effect.rest!.to, card), ...(effect.rest!.to.position ? { position: effect.rest!.to.position } : {}) })) : []),
    ];

    // Cards put back in the zone they came from are re-arranged in place (a move to the zone
    // it is already in is no move); the section must be exactly the pool.
    const home = ctx.engine.zones.zoneOf(pool[0]!);
    const stay = placements.filter((p) => p.to === home);
    const leave = placements.filter((p) => p.to !== home);
    if (stay.length > 0 && home) {
      const unplaced = pool.filter((card) => !placements.some((p) => p.card === card));
      const top = [...unplaced, ...stay.filter((p) => p.position !== 'bottom').map((p) => p.card)];
      const bottom = stay.filter((p) => p.position === 'bottom').map((p) => p.card);
      const end = effect.select.how === 'bottom' ? 'bottom' : 'top';
      if (leave.length > 0) throw new Error(`"${prompt}": cards cannot both stay in and leave ${home.id} in one move`);
      ctx.engine.arrange(home.id, pool.length, { top, bottom }, { owner: home.owner, from: end });
      continue;
    }
    // Cards going on top of a zone are placed last-first so the first listed ends up on top.
    const onTop = leave.filter((p) => p.position === 'top').reverse();
    const others = leave.filter((p) => p.position !== 'top');
    for (const p of [...others, ...onTop]) {
      actions.push(moveEntity(p.card, p.to, { source: ctx.self, ...(p.position ? { position: p.position } : {}) }));
    }
  }
  return actions;
}

/** Asks the controller to put `cards` in order, first the one that goes first (on top). */
async function chooseOrder(cards: readonly Entity[], chooser: Player | undefined, ctx: ResolveContext, prompt: string): Promise<Entity[]> {
  const left = [...cards];
  const ordered: Entity[] = [];
  while (left.length > 1) {
    const answer = await ctx.engine.ask({
      kind: 'select',
      prompt: `${prompt}: choose the next card`,
      chooser,
      options: left,
      count: 1,
      source: ctx.self,
    });
    const picked = answer.kind === 'select' ? answer.chosen[0] : undefined;
    const card = picked && left.includes(picked) ? picked : left[0]!;
    left.splice(left.indexOf(card), 1);
    ordered.push(card);
  }
  return [...ordered, ...left];
}

/** `Reveal all cards castable by target opponent.` — every player may see them. */
async function revealCards(
  effect: Extract<EffectIR, { kind: 'revealCards' }>,
  ctx: ResolveContext,
  zone: (role: string) => string,
  prompt: string,
): Promise<void> {
  for (const group of await groupsOf(effect.from, ctx, zone, prompt)) {
    for (const card of await takeCards(effect.select, group.members, ctx, prompt)) {
      ctx.engine.showTo(card, ctx.engine.players, { source: ctx.self });
    }
  }
}

/** The cards a selector takes from a zone's members (in the zone's order, top first). */
async function takeCards(
  select: CardSelectorIR,
  members: readonly Entity[],
  ctx: ResolveContext,
  prompt: string,
): Promise<Entity[]> {
  const matching = members.filter(
    (card) =>
      // An ability waiting on the stack is not a card.
      card.type !== 'ability' &&
      (select.counters !== 'none' || ctx.engine.countersOn(card).size === 0) &&
      (select.cardKind === undefined || (select.cardKind === 'creature') === (card.type === 'character')),
  );
  switch (select.how) {
    case 'all':
      return [...matching];
    case 'top':
      return matching.slice(0, select.count);
    case 'bottom':
      return matching.slice(Math.max(0, matching.length - select.count));
    case 'random': {
      const pool = [...matching];
      const taken: Entity[] = [];
      while (taken.length < select.count && pool.length > 0) {
        taken.push(pool.splice(Math.floor(ctx.engine.random() * pool.length), 1)[0]!);
      }
      return taken;
    }
    case 'choose': {
      const count = Math.min(select.count, matching.length);
      if (count === 0) return [];
      const answer = await ctx.engine.ask({
        kind: 'select',
        prompt,
        chooser: ctx.self.controller,
        options: matching,
        count,
        source: ctx.self,
      });
      return answer.kind === 'select' ? [...answer.chosen] : [];
    }
  }
}

/**
 * Runs one round effect. `choose` and `reveal` act on the engine directly and
 * return no actions; `moveChosen` returns the moves for the caller to apply.
 */
async function roundEffectActions(
  effect: EffectIR,
  ctx: ResolveContext,
  options: BindOptions,
  prompt: string,
  apply?: (actions: Action[]) => Promise<void>,
): Promise<Action[]> {
  const zone = (role: string): string => options.aliases?.[role] ?? role;
  ctx.engine.gas.spend('effect', effect.kind);
  if (effect.kind === 'table') {
    if (!apply) throw new Error(`"${prompt}": a table of results cannot run outside a resolving ability`);
    // Read once. The first row that holds the result wins; `otherwise` is the
    // fallback; no row at all means the result simply does nothing.
    const result = valueOf(effect.on, ctx, options);
    const row =
      effect.rows.find((r) => !r.otherwise && result >= r.min && (r.max === null || result <= r.max)) ??
      effect.rows.find((r) => r.otherwise);
    for (const step of row?.steps ?? []) {
      const actions = await stepActionsAsync(step, ctx, options, prompt, apply);
      if (actions.length > 0) await apply(actions);
    }
    return [];
  }
  if (effect.kind === 'zoneAbility') {
    const ability = options.resolveAbility?.(effect.ability);
    if (!ability) throw new Error(`"${prompt}": there is no ability called "${effect.ability}" to give`);
    if (effect.owners === 'this') {
      const here = ctx.thisZone;
      if (!here) throw new Error(`"${prompt}": "this zone" needs a Zone section to be about`);
      // A shared zone has no owner, so "you" and "each opponent" would mean nobody.
      if (!here.owner && effect.users !== 'each') {
        throw new Error(
          `"${prompt}": the "${here.id}" zone is shared, so it has no owner — say "for all players"`,
        );
      }
      if (effect.remove) ctx.engine.removeZoneAbility(here, ability);
      else ctx.engine.addZoneAbility(here, ability, choosersOf(effect.users, ctx));
      return [];
    }
    const users = choosersOf(effect.users, ctx);
    const owners = effect.owners === 'shared' ? undefined : choosersOf(effect.owners, ctx);
    const zones = owners
      ? owners.map((owner) => ctx.engine.zones.zone(zone(effect.zone), owner))
      : [ctx.engine.zones.zone(zone(effect.zone))];
    if (zones.some((z) => !z)) throw new Error(`"${prompt}": there is no zone "${effect.zone}" to give an ability to`);
    for (const target of zones) {
      if (effect.remove) ctx.engine.removeZoneAbility(target!, ability);
      else ctx.engine.addZoneAbility(target!, ability, users);
    }
    return [];
  }
  if (effect.kind === 'revealCard' || effect.kind === 'castCard' || effect.kind === 'moveCard') {
    const host = ctx.host;
    if (!host) {
      throw new Error(`"${prompt}": "this" needs an ability a zone or an effect gave a card — this one belongs to a character`);
    }
    // The owner of the pile the card is in: where "its owner's garbage" is.
    const owner = ctx.engine.zones.zoneOf(host)?.owner;
    const moveHome = async (role: string): Promise<void> => {
      await ctx.engine.moveTo(host, zone(role), { ...(owner ? { owner } : {}), source: ctx.self, reason: prompt });
    };
    if (effect.kind === 'revealCard') {
      // Everyone sees it for as long as it stays where it is; casting it puts it
      // on the (public) stack, which is a move.
      ctx.engine.showTo(host, ctx.engine.players, { source: ctx.self });
    } else if (effect.kind === 'moveCard') {
      await moveHome(effect.to);
      if (effect.counters) ctx.engine.addCounters(host, effect.counters.count, effect.counters.kind);
    } else {
      const player = ctx.self.controller;
      if (!player) throw new Error(`"${prompt}": a card is cast by a player, and this ability has none`);
      const cast = options.cast ?? engineCast(ctx.engine);
      if (!cast) throw new Error(`"${prompt}": this game has no way to cast a card`);
      const cast_ = await cast(player, host);
      if (!cast_ && effect.otherwise !== undefined) await moveHome(effect.otherwise);
    }
    return [];
  }
  if (effect.kind === 'create') {
    const create = options.create ?? engineCreate(ctx.engine);
    if (!create) throw new Error(`"${prompt}": this game has no way to create a creature`);
    for (const player of choosersOf(effect.players, ctx)) await create(player, effect.creature);
    return [];
  }
  if (effect.kind === 'play') {
    if (!ctx.rounds) throw new Error(`"${prompt}": a contest cannot be played outside a resolving ability`);
    const { contest } = effect;
    // The list of players the contest receives: "player 1" is the first of them.
    const controller = ctx.self.controller;
    const players: Player[] =
      effect.players === 'you-and-opponent'
        ? [...(controller ? [controller] : []), ...((await playersOf('opponent', ctx, prompt)) as Player[])]
        : choosersOf(effect.players, ctx);
    if (contest.playerCount !== undefined && players.length !== contest.playerCount) {
      throw new Error(`"${prompt}": ${contest.name} needs ${contest.playerCount} players, but ${players.length} were named`);
    }
    // Everyone commits an option face down, then they are turned over together.
    const round = await ctx.engine.askAll(
      players.map((player): ChoiceRequest => ({ kind: 'label', prompt, chooser: player, options: [...contest.options] })),
      { sealed: true },
    );
    ctx.rounds.set('contest', { round, secret: true, label: true, options: contest.options });
    // A commitment that is invalid or changed loses the game for that player.
    const forfeited = await ctx.engine.revealRound(round);
    const chosen = new Map<Player, string>();
    for (const { player, answer } of round.answers) if (answer.kind === 'label') chosen.set(player, answer.value);
    const picks = players.map((player) => chosen.get(player));
    let winners: readonly number[] = [];
    let losers: readonly number[] = [];
    if (picks.every((pick) => pick !== undefined)) {
      for (const rule of contest.rules) {
        if (rule.kind === 'tie') {
          if (picks.every((pick) => pick === picks[0])) break;
        } else if (rule.kind === 'when') {
          if (rule.picks.every((pick) => picks[pick.player - 1] === pick.option)) {
            ({ winners, losers } = rule);
            break;
          }
        } else {
          ({ winners, losers } = rule);
          break;
        }
      }
    }
    if (ctx.temporary) {
      ctx.temporary.winners = winners.map((n) => players[n - 1]).filter((p): p is Player => p !== undefined);
      ctx.temporary.losers = losers.map((n) => players[n - 1]).filter((p): p is Player => p !== undefined);
    }
    return forfeited.map(({ player }) => lose(player, ctx.self));
  }
  if (effect.kind === 'removeCounters') {
    for (const group of await groupsOf(effect.from, ctx, zone, prompt)) {
      for (const card of await takeCards(effect.select, group.members, ctx, prompt)) {
        ctx.engine.removeCounters(card, effect.count, effect.counterKind);
      }
    }
    return [];
  }
  if (effect.kind === 'castCards') {
    const cast = options.cast ?? engineCast(ctx.engine);
    if (!cast) throw new Error(`"${prompt}": this game has no way to cast a card`);
    for (const group of await groupsOf(effect.from, ctx, zone, prompt)) {
      const caster = group.owner ?? ctx.self.controller;
      if (!caster) throw new Error(`"${prompt}": a card is cast by a player, and nobody owns this zone`);
      for (const card of await takeCards(effect.select, group.members, ctx, prompt)) {
        await cast(caster, card, effect.free ? { free: true } : undefined);
      }
    }
    return [];
  }
  if (effect.kind === 'split') {
    const pool = ctx.temporary?.resolve(ctx, effect.from.zone, false);
    if (!pool) throw new Error(`"${prompt}": there is no temporary zone "${effect.from.zone}" to separate`);
    const chooser = effect.chooser === 'you' ? ctx.self.controller : (await playersOf('opponent', ctx, prompt))[0];
    const first = ctx.temporary!.resolve(ctx, effect.into[0], true)!;
    const second = ctx.temporary!.resolve(ctx, effect.into[1], true)!;
    const cards = [...pool.members];
    const looks = chooser ? cards.map((card) => ctx.engine.showTo(card, [chooser], { until: 'manual', source: ctx.self })) : [];
    const answer = await ctx.engine.ask({
      kind: 'select',
      prompt: `${prompt}: choose the cards for ${effect.into[0]} (the rest are ${effect.into[1]})`,
      chooser,
      options: cards,
      count: [0, cards.length],
      source: ctx.self,
    }).finally(() => looks.forEach((look) => look.end()));
    const firstCards = answer.kind === 'select' ? cards.filter((card) => answer.chosen.includes(card)) : [];
    for (const card of cards) await ctx.engine.moveTo(card, firstCards.includes(card) ? first.id : second.id, { source: ctx.self, reason: prompt });
    return [];
  }
  if (effect.kind === 'choosePile') {
    const answer = await ctx.engine.ask({ kind: 'label', prompt, chooser: ctx.self.controller, options: [...effect.options] });
    const picked = answer.kind === 'label' && effect.options.includes(answer.value) ? answer.value : effect.options[0];
    if (!ctx.temporary) throw new Error(`"${prompt}": a pile cannot be chosen outside a resolving ability`);
    ctx.temporary.chosen = picked;
    ctx.temporary.other = effect.options[0] === picked ? effect.options[1] : effect.options[0];
    return [];
  }
  if (effect.kind === 'revealCards') {
    await revealCards(effect, ctx, zone, prompt);
    return [];
  }
  if (effect.kind === 'moveCards') {
    const actions = await moveCardsActions(effect, ctx, zone, prompt);
    if (apply) {
      // Applied now, so a later sentence ("Draw …") sees the cards where they went.
      if (actions.length > 0) await apply(actions);
      return [];
    }
    return actions;
  }
  if (effect.kind === 'store') {
    if (!ctx.variables) throw new Error(`"${prompt}": a value cannot be stored outside a resolving ability`);
    ctx.variables.set(effect.name, valueOf(effect.value, ctx, options));
    return [];
  }
  if (effect.kind === 'draw') {
    const count = Math.floor(valueOf(effect.count, ctx, options));
    // The host's, else the one this engine's game registered, else a plain draw.
    const draw =
      options.draw ??
      engineDraw(ctx.engine) ??
      createDraw(ctx.engine, { library: zone('library'), hand: zone('hand') });
    for (const player of choosersOf(effect.players, ctx)) await draw(player, count);
    return [];
  }
  if (effect.kind === 'scry') {
    const count = Math.floor(valueOf(effect.count, ctx, options));
    for (const player of choosersOf(effect.players, ctx)) await scry(player, count, ctx, zone('library'), prompt, effect.surveil ? zone('garbage') : undefined);
    return [];
  }
  if (effect.kind === 'roll') {
    if (!ctx.rolled) throw new Error(`"${prompt}": dice cannot be rolled outside a resolving ability`);
    const count = Math.floor(valueOf(effect.count, ctx, options));
    const sides = Math.floor(valueOf(effect.sides, ctx, options));
    // Through the pipeline, so a modifier may change the dice or the outcome.
    ctx.rolled.results = await ctx.engine.roll(count, sides, { source: ctx.self, reason: prompt });
    return [];
  }
  if (effect.kind === 'choose') {
    if (!ctx.rounds) throw new Error(`"${prompt}": a choice cannot be asked outside a resolving ability`);
    const requests: ChoiceRequest[] = [];
    for (const player of await votersOf(effect, ctx)) {
      if (effect.pick.kind === 'label') {
        requests.push({ kind: 'label', prompt, chooser: player, options: effect.pick.options });
      } else if (effect.pick.kind === 'card') {
        // A player with nothing to choose from is not in the round: they are
        // neither waited on nor moved.
        const options_ = ctx.engine.zones.zone(zone(effect.pick.from), player)?.members ?? [];
        if (options_.length === 0) continue;
        requests.push({
          kind: 'select',
          prompt,
          chooser: player,
          options: options_,
          count: 1,
          source: ctx.self,
          markers: markersFor(options_),
        });
      } else {
        const min = Math.floor(valueOf(effect.pick.min, ctx, options));
        const max = Math.floor(valueOf(effect.pick.max, ctx, options));
        requests.push({ kind: 'number', prompt, chooser: player, min, max });
      }
    }
    const round = await ctx.engine.askAll(requests, { sealed: effect.secret });
    ctx.rounds.set(effect.round, {
      round,
      secret: effect.secret,
      label: effect.pick.kind === 'label',
      ...(effect.pick.kind === 'label' ? { options: effect.pick.options } : {}),
    });
    return [];
  }
  if (effect.kind === 'reveal') {
    const state = roundOf(effect.round, ctx);
    if (state.round.revealed) return [];
    // A commitment must be a valid option, placed face down and left alone. One
    // that is vague or invalid, or was changed, loses the game for its player.
    const forfeited = await ctx.engine.revealRound(state.round);
    return forfeited.map(({ player }) => lose(player, ctx.self));
  }
  if (effect.kind === 'moveChosen') {
    const state = roundOf(effect.round, ctx);
    if (!state.round.revealed) {
      throw new Error(`"${prompt}": the choices in "${effect.round}" are still sealed — reveal them first`);
    }
    const actions: Action[] = [];
    for (const { player, answer } of state.round.answers) {
      if (answer.kind !== 'select') continue;
      const destination = ctx.engine.zones.zone(zone(effect.to), player);
      if (!destination) continue;
      for (const entity of answer.chosen) actions.push(moveEntity(entity, destination, { source: ctx.self }));
    }
    return actions;
  }
  return [];
}

/** A step's effects as actions, running any round effects (which may ask) in order. */
async function effectsAsync(
  effects: readonly EffectIR[],
  ctx: ResolveContext,
  options: BindOptions,
  prompt: string,
  apply?: (actions: Action[]) => Promise<void>,
): Promise<Action[]> {
  const actions: Action[] = [];
  for (const effect of effects) {
    actions.push(
      ...(isRoundEffect(effect)
        ? await roundEffectActions(effect, ctx, options, prompt, apply)
        : effectActions(effect, ctx, options)),
    );
  }
  return actions;
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
  return effectsAsync(step.effects, ctx, options, prompt, apply);
}

/** True when any of these steps needs to ask, repeats, or runs a choice round. */
function asks(steps: readonly StepIR[]): boolean {
  return steps.some(
    (step) => step.optional === true || step.repeat !== undefined || step.effects.some(isRoundEffect),
  );
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
    ctx.engine.gas.spend('loop', `repeat ${prompt}`);
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
    const actions = await effectsAsync(step.effects, ctx, options, prompt, apply);
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
  assertRoundsSound(ir.name, steps, options);
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
        ...(actx.host ? { host: actx.host } : {}),
        rounds: new Map(),
        rolled: { results: [] },
        variables: new Map(),
        temporary: new TemporaryZones(),
      };
      try {
      if (steps.length <= 1 && !asks(steps)) {
        return steps.flatMap((step) => stepActions(step, ctx, options));
      }
      const apply = async (actions: Action[]): Promise<void> => {
        await actx.engine.apply(actions, { source: actx.self });
      };
      if (steps.length <= 1) {
        // One step, but it asks or repeats — the single-apply shortcut
        // cannot await.
        return await stepActionsAsync(steps[0]!, ctx, options, ir.name, apply);
      }
      for (const step of steps) {
        const actions = await stepActionsAsync(step, ctx, options, ir.name, apply);
        if (actions.length > 0) await apply(actions);
      }
      return [];
      } finally {
        await clearTemporary(ctx, options);
      }
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

/**
 * Binds a `Zone` section. It is applied by the host, not cast: it needs the game's
 * zones and players to exist, and it runs once per instance of the zone.
 */
function bindZone(ir: ZoneSectionIR, options: BindOptions): ZoneBinding {
  /** Runs `steps` once for each instance of the zone (all players', if per-player), with its owner as "you". */
  const run = async (
    engine: GameEngine,
    steps: readonly StepIR[],
    only?: Player,
  ): Promise<void> => {
    const id = options.aliases?.[ir.zone] ?? ir.zone;
    const def = engine.zones.definitions.find((candidate) => candidate.id === id);
    if (!def) throw new Error(`Zone "${ir.zone}": the game has no zone "${id}"`);
    const perPlayer = (def.scope ?? 'shared') === 'per-player';
    const owners: (Player | undefined)[] = perPlayer ? engine.players : [undefined];
    for (const owner of owners) {
      if (only && owner !== only) continue;
      // "You" is the instance's owner: run as their first character, who they control.
      const holder = owner ?? engine.players[0];
      const self = holder?.livingCharacters[0] ?? holder?.characters[0];
      if (!self) throw new Error(`Zone "${ir.zone}": there is no player to apply it for`);
      const ctx: ResolveContext = {
        self,
        engine,
        targeting: undefined,
        event: NO_EVENT,
        subject: undefined,
        bindings: NO_BINDINGS,
        thisZone: engine.zones.zone(id, owner)!,
        rounds: new Map(),
        rolled: { results: [] },
        variables: new Map(),
        temporary: new TemporaryZones(),
      };
      const apply = async (actions: Action[]): Promise<void> => {
        if (actions.length > 0) await engine.apply(actions, { source: self });
      };
      try {
        for (const step of steps) await apply(await stepActionsAsync(step, ctx, options, `Zone ${ir.zone}`, apply));
      } finally {
        await clearTemporary(ctx, options);
      }
    }
  };
  return {
    zone: ir.zone,
    apply: (engine) => run(engine, ir.steps),
    async trigger(event, engine, turnOwner) {
      for (const rule of ir.triggers ?? []) {
        if (rule.event !== event) continue;
        await run(engine, rule.steps, rule.yours ? turnOwner : undefined);
      }
    },
  };
}

/**
 * Refuses an ability whose choice rounds break the table procedure (a secret
 * choice never revealed, a choice read before it is revealed, …). The messages
 * come from `validateRounds` and say what to write instead; warnings are not
 * errors and are left to whoever reports diagnostics.
 */
function assertRoundsSound(name: string, steps: readonly StepIR[], options: BindOptions): void {
  if (options.allowUnsoundRounds) return;
  const errors = validateRounds(steps).filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`"${name}": ${errors.map((issue) => issue.message).join(' ')}`);
  }
}

export function bindTrigger(ir: TriggerIR, options: BindOptions): AnyTriggeredAbility {
  assertRoundsSound(ir.name, ir.steps, options);
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
      // `is damaged` watches the life gauge of whoever took it, read
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
        rounds: new Map(),
        rolled: { results: [] },
        variables: new Map(),
        temporary: new TemporaryZones(),
      };
      try {
      if (ir.steps.length <= 1 && !asks(ir.steps)) {
        return ir.steps.flatMap((step) => stepActions(step, ctx, options));
      }
      const apply = async (actions: Action[]): Promise<void> => {
        await tctx.engine.apply(actions, { source: tctx.self });
      };
      if (ir.steps.length <= 1) {
        return await stepActionsAsync(ir.steps[0]!, ctx, options, ir.name, apply);
      }
      for (const step of ir.steps) {
        const actions = await stepActionsAsync(step, ctx, options, ir.name, apply);
        if (actions.length > 0) await apply(actions);
      }
      return [];
      } finally {
        await clearTemporary(ctx, options);
      }
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
  const expiry = ir.fading !== undefined ? fadingAbility(ir, ir.fading) : undefined;
  if (expiry) abilities.push(expiry);
  return makeBuff({
    id: ir.id,
    name: ir.name,
    weight: ir.weight,
    ...(ir.fading !== undefined ? { variables: () => ({ counters: ir.fading }) } : {}),
    ...(abilities.length > 0 ? { abilities } : {}),
  });
}

/**
 * Fading as an ordinary triggered ability: at the end of a turn the buff
 * removes one of its counters, and if it cannot, it takes itself off.
 *
 * The engine needs no concept of expiry for this — a buff is already a
 * bundle of abilities. The counters live in the instance's own `vars`, so each
 * instance fades on its own schedule: `fading 0` goes at the first turn end,
 * `fading 1` survives it and goes at the second.
 */
function fadingAbility(ir: BuffIR, counters: number): Ability {
  return auto({
    id: `${ir.id}-fading`,
    name: `${ir.name} fades`,
    event: 'turn:end',
    targets: () => [],
    cast: (ctx): Action[] => {
      const left = Number(ctx.status.vars.counters ?? counters);
      if (left <= 0) return [removeBuff(ctx.self, ir.id, ctx.self)];
      ctx.status.vars.counters = left - 1;
      return [];
    },
  });
}

/* ------------------------------ documents ----------------------------- */

export function bindDocument(doc: DocumentIR, options: BindOptions): BindResult {
  // An effect that names a sibling ability ("have Open Present") finds it here,
  // lazily, so the abilities may refer to each other in any order.
  const abilities: ManualAbility[] = [];
  const bound: BindOptions = {
    ...options,
    resolveAbility: (id) => options.resolveAbility?.(id) ?? abilities.find((ability) => ability.id === id),
  };
  abilities.push(...doc.abilities.map((ir) => bindAbility(ir, bound)));
  return {
    abilities,
    zones: (doc.zones ?? []).map((ir) => bindZone(ir, bound)),
    buffs: doc.buffs.map((ir) => bindBuff(ir, bound)),
    triggers: doc.triggers.map((ir) => bindTrigger(ir, bound)),
  };
}
