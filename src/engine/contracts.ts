/**
 * **The extension contracts — where a game opens the engine's vocabularies.**
 *
 * Every event the engine can dispatch and every action it can execute is an
 * entry in one of the two maps below. `GameEvent` and `Action` are *derived*
 * from them, so a map is the only place a vocabulary is declared.
 *
 * The maps are plain interfaces, which means they are **open**. A game adds
 * its own vocabulary by declaration merging, with no edit to the engine:
 *
 * ```ts
 * declare module 'vibe-engine/contracts' {
 *   interface GameEventMap {
 *     'turn:start': { type: 'turn:start' };
 *   }
 *   interface ActionMap {
 *     summon: SummonAction;
 *   }
 * }
 * ```
 *
 * After which `engine.emit({ type: 'turn:start' })` type-checks, a triggered
 * ability may subscribe to `'turn:start'`, `ctx.event` narrows on it like any
 * built-in, and `engine.actions.register('summon', handler)` executes the new
 * action. The engine's own events and actions are ordinary entries in these
 * same maps — shipped content, not a privileged category.
 *
 * ## Why one dedicated module
 *
 * Declaration merging targets the module that *declares* the interface; a
 * re-export through a barrel does not merge. Putting both maps here gives
 * every game one stable, documented augmentation target
 * (`'vibe-engine/contracts'` for a package consumer, `../engine/contracts.js`
 * inside this repo) instead of one per vocabulary file.
 *
 * ## What this file may not do
 *
 * It is **types only**. It declares the shared shapes; it must never execute
 * anything, or augmenting a map would drag runtime code into the import graph.
 * Types here are erased, so the type-only cycle with `events.ts` and
 * `actions.ts` costs nothing at runtime.
 */
import type { ActionDirection, GaugeAction, MoveAction, AddBuffAction, RemoveBuffAction, DestroyAction, TransformAction, PopTransformAction, DiscoverAction, RollAction } from './actions.js';
import type { CharacterDestroyedBatchEvent, CharacterDestroyedEvent, CharacterSurvivedBatchEvent, CharacterSurvivedEvent, CharacterTransformedBatchEvent, CharacterTransformedEvent, BuffAddedEvent, BuffDestroyedBatchEvent, BuffDestroyedEvent, EventSource, GaugeChangedBatchEvent, GaugeChangedEvent, GaugeMaxChangedEvent, StatChangedEvent, ZoneChangedBatchEvent, ZoneChangedEvent } from './events.js';
import type { Ability, Targeting } from './ability/index.js';
import type { Buff } from './status/index.js';
import type { Character } from './character.js';
import type { ChoiceAnswer } from './choice.js';
import type { Player } from './player.js';

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

/**
 * The fields **every** action carries, whatever the game.
 *
 * The engine reads these generically, so a custom action must declare them or
 * it will not survive the pipeline: `source` and `direction` are stamped and
 * read by the transformer pass, and `bypasses` is read at the restrictions
 * gate. The `ActionMapIsWellFormed` assertion below rejects an `ActionMap`
 * entry that omits them, which turns a confusing downstream error into a
 * precise one at the declaration site.
 *
 * Every field is optional because content never sets `direction` (the engine
 * stamps it) and most actions have no source and pierce no restriction.
 */
export interface ActionBase {
  /** The discriminant — must equal the `ActionMap` key it is declared under. */
  readonly type: string;
  /** Who is responsible for the action: a character, or a buff doing its thing. */
  readonly source?: EventSource;
  /** Stamped by the engine — `'outgoing'` in the source phase, `'incoming'` in the target's. */
  readonly direction?: ActionDirection;
  /** Named exceptions — restriction ids this action pierces at the gate. */
  readonly bypasses?: readonly string[];
}

/**
 * Every action the engine can execute, keyed by its `type` tag.
 *
 * Augment it to declare a game's own actions, then register a handler with
 * `engine.actions.register(...)`. Each value must carry the `type` tag it is
 * keyed under, and must extend `ActionBase` — both enforced below.
 */
export interface ActionMap {
  gauge: GaugeAction;
  move: MoveAction;
  addBuff: AddBuffAction;
  removeBuff: RemoveBuffAction;
  destroy: DestroyAction;
  transform: TransformAction;
  popTransform: PopTransformAction;
  /**
   * Reveal until a card is worth taking. A built-in rather than a game's own
   * action because the mechanic is generic: it reads zones and the entity's
   * declared `attributes`, both of which the engine already has. What is
   * *game-specific* is only the numbers the content passes.
   */
  discover: DiscoverAction;
  /** Roll dice. See `RollAction`. */
  roll: RollAction;
}

/** Every action the engine can execute — the union of `ActionMap`. */
export type Action = ActionMap[keyof ActionMap];

/* ------------------------------------------------------------------ */
/*  Events                                                             */
/* ------------------------------------------------------------------ */

/**
 * Every event the engine can dispatch, keyed by its `type` tag.
 *
 * Augment it to declare a game's own events; triggered abilities can then
 * subscribe to them and `ctx.event` narrows on them like any built-in. A value
 * may be a union — several built-ins come in versions (see `events.ts`, "no
 * optional properties") — in which case every member carries the same tag.
 */
export interface GameEventMap {
  'turn:start': { type: 'turn:start' };
  'turn:end': { type: 'turn:end' };
  'gauge:changed': GaugeChangedEvent;
  'gauge:changed:batch': GaugeChangedBatchEvent;
  'gauge:maxChanged': GaugeMaxChangedEvent;
  'stat:changed': StatChangedEvent;
  'zone:changed': ZoneChangedEvent;
  'zone:changed:batch': ZoneChangedBatchEvent;
  'buff:added': BuffAddedEvent;
  'buff:destroyed': BuffDestroyedEvent;
  'buff:destroyed:batch': BuffDestroyedBatchEvent;
  /** A player has answered a sealed round. Carries **no** content — only that they are ready. */
  'choice:ready': { type: 'choice:ready'; player: Player };
  /** A sealed round opened: every answer, at once, in chooser order. */
  'choice:revealed': {
    type: 'choice:revealed';
    answers: readonly { readonly player: Player; readonly answer: ChoiceAnswer }[];
  };
  /**
   * Dice were rolled. `results` are final — after the roller answered and every
   * adjustment applied. `source` is absent for a roll nobody caused.
   */
  'roll:made': {
    type: 'roll:made';
    count: number;
    sides: number;
    results: readonly number[];
    source?: EventSource;
  };
  /**
   * A commitment was invalid, vague or changed, so its player forfeits the
   * round. Announced after `choice:revealed`, which carries the valid answers.
   */
  'choice:forfeited': { type: 'choice:forfeited'; player: Player; reason: string };
  /**
   * A scope ran out of gas — almost certainly an infinite loop. Announced once, before
   * the `OutOfGasError` propagates, so an observer can log or show what happened.
   */
  'gas:exhausted': { type: 'gas:exhausted'; label: string; used: number; limit: number };
  /**
   * Players were given a capability on a card (`see`, or a game's `cast`…).
   * Announced **without the card**: the table learns that a look happened, or that
   * someone may now cast something, and who — as it would physically — not which
   * card it is.
   */
  'grant:added': { type: 'grant:added'; capability: string; players: readonly Player[]; count: number };
  /** A grant ended (the card left its zone, the effect or turn finished, its source was revoked, or `end()`). */
  'grant:removed': { type: 'grant:removed'; capability: string; players: readonly Player[]; count: number };
  'cycle:detected': { type: 'cycle:detected'; grantor: Buff; attemptedId: string };
  'character:transformed': CharacterTransformedEvent;
  'character:transformed:batch': CharacterTransformedBatchEvent;
  'character:destroyed': CharacterDestroyedEvent;
  'character:survived': CharacterSurvivedEvent;
  'character:destroyed:batch': CharacterDestroyedBatchEvent;
  'character:survived:batch': CharacterSurvivedBatchEvent;
  'ability:used': { type: 'ability:used'; character: Character; ability: Ability; targeting: Targeting };
}

/** Every event the engine can dispatch — the union of `GameEventMap`. */
export type GameEvent = GameEventMap[keyof GameEventMap];

/* ------------------------------------------------------------------ */
/*  Restriction kinds                                                  */
/* ------------------------------------------------------------------ */

/**
 * Every kind of attempt a restriction can block, keyed by its own name.
 *
 * A restriction ability is a pure predicate — "cannot be X if Y" — and this is
 * the **X**. The engine gates the attempts it makes itself (`target`,
 * `destroy`, `gauge`, `buff`, `transform`, `move`, `activate`); a game declares
 * the rest by augmenting this interface, exactly as it declares an action or an
 * event:
 *
 * ```ts
 * declare module 'vibe-engine/contracts' {
 *   interface RestrictionKindMap {
 *     win: 'win';    // "cannot win the game"
 *     lose: 'lose';  // "cannot lose the game"
 *   }
 * }
 * ```
 *
 * `control` and `revive` are declared here as placeholders with no action
 * behind them yet — a kind is cheap to name, and reserving them keeps content
 * that says "cannot be revived" compiling.
 */
export interface RestrictionKindMap {
  /** Cannot be chosen as a target. */
  target: 'target';
  /** Cannot be destroyed (the gauge→destroy rule is gated too). */
  destroy: 'destroy';
  /** Cannot have a gauge changed (current or maximum). */
  gauge: 'gauge';
  /** Cannot gain (or lose) buffs. */
  buff: 'buff';
  /** Cannot have its form changed (a transform action is a no-op). */
  transform: 'transform';
  /** Cannot be moved between zones ("cannot be discarded", "cannot leave play"). */
  move: 'move';
  /** Cannot use activated abilities ("silenced", "stunned"). */
  activate: 'activate';
  /** Cannot be controlled — declared; no action exists yet. */
  control: 'control';
  /** Cannot be revived — declared; no action exists yet. */
  revive: 'revive';
}

/** Every kind of attempt a restriction can block — the union of the map. */
export type RestrictionKind = RestrictionKindMap[keyof RestrictionKindMap];

/* ------------------------------------------------------------------ */
/*  Targeting vocabulary                                               */
/* ------------------------------------------------------------------ */

/**
 * Who an ability may target, relative to its owner, keyed by its own name.
 *
 * The engine natively answers only the two questions that need no model of
 * opposition — `self` and `any`. Whether a candidate is an *ally* or an
 * *enemy* depends on a game's notion of sides, and the engine has none: a
 * solo game, a free-for-all and a two-team skirmish all disagree. A game
 * declares the rest by augmenting this interface and registering a resolver on
 * `engine.targeting`:
 *
 * ```ts
 * declare module 'vibe-engine/contracts' {
 *   interface TargetWhoMap {
 *     ally: 'ally';
 *     enemy: 'enemy';
 *   }
 * }
 * engine.targeting.register('enemy', (self, candidate) => candidate.team !== self.team);
 * ```
 *
 * See `src/games/round-based/targeting.ts` for the team-based pair.
 */
export interface TargetWhoMap {
  /** The ability's own owner. */
  self: 'self';
  /** Any registered, targetable character. */
  any: 'any';
}

/** Who an ability may target — the union of the map. */
export type TargetWho = TargetWhoMap[keyof TargetWhoMap];

/* ------------------------------------------------------------------ */
/*  Well-formedness assertions                                         */
/* ------------------------------------------------------------------ */
/*
 * Augmenting an open map is unchecked by default: a game could key an action
 * under `summon` while its `type` says `'summonUnit'`. That would compile
 * cleanly and then fail confusingly deep inside dispatch, where the union is
 * no longer a nice discriminated set — the engine would never execute the
 * action, and exhaustiveness switches would stop matching.
 *
 * `AllTrue` below turns each mistake into an error **at the declaration
 * site**. Note the failure value is `false`, not `never`: `never` is
 * assignable to everything, so a `never` would satisfy the constraint
 * vacuously and the guard would silently pass. `false` is not assignable to
 * `true`, so the constraint fails and the error surfaces. (This was a real bug
 * in the first cut of this file — the guard looked right and enforced nothing.)
 *
 * These aliases are exported only so TypeScript cannot elide them; nothing
 * imports them.
 */

/** `T` is assignable only when every one of its properties is literally `true`. */
type AllTrue<T extends Record<string, true>> = T;

/** `true` when the value's own `type` tag is exactly the key it is declared under. */
type TagMatchesKey<K extends PropertyKey, V> = V extends { type: infer Tag }
  ? [Tag] extends [K]
    ? true
    : false
  : false;

/**
 * `true` when `V` *declares* every `ActionBase` field.
 *
 * Assignability is not enough here: every `ActionBase` field is optional, so
 * `{ type: 'summon'; amount: number }` structurally extends it while having no
 * `direction` key at all — and then the engine's transformer pass, which
 * stamps `direction` onto every action it pushes, fails to compile. The check
 * therefore has to be on the declared **keys**, not on the shape.
 */
type DeclaresActionBase<V> = [Exclude<keyof ActionBase, keyof V>] extends [never] ? true : false;

/** Every action must carry the pipeline fields and be keyed by its own tag. */
type ActionMapIsWellFormed = {
  [K in keyof ActionMap]: TagMatchesKey<K, ActionMap[K]> extends true
    ? DeclaresActionBase<ActionMap[K]>
    : false;
};

/** Every event must be keyed by its own tag. */
type GameEventMapIsWellFormed = {
  [K in keyof GameEventMap]: TagMatchesKey<K, GameEventMap[K]>;
};

export type _ActionMapIsWellFormed = AllTrue<ActionMapIsWellFormed>;
export type _GameEventMapIsWellFormed = AllTrue<GameEventMapIsWellFormed>;
