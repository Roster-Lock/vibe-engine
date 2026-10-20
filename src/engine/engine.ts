/**
 * The GameEngine is the coordinator. It:
 *
 * - owns the **trigger stack** (`TriggerStack`) — every triggered ability
 *   attaches a listener with a unique id, and when an event fires the stack
 *   collects the matching listeners into the **prepare stack** (gated by
 *   each ability's prestack filter, `when`), sorts them by listener id,
 *   shuffles them with the seeded PRNG, promotes the result to the
 *   **active stack**, and runs it
 * - pushes every Action through the outgoing/incoming transformation
 *   pipeline and applies the result to the world
 * - asks a **player** to choose (choice.ts) when a
 *   prompt-triggered ability fires
 * - tracks registered players, and asks the game's outcome checks whether
 *   the game is over (it does not know what "over" means)
 *
 * The trigger-order PRNG is seeded from the `seed` option (or a random
 * seed); `Game.runLoop` replaces it with the commit/reveal seed built from
 * the players' secrets. Same seed + same game state ⇒ same trigger order.
 *
 * ```ts
 * const engine = new GameEngine({ host });
 * engine.registerCharacter(hero);
 * engine.registerCharacter(goblin);
 *
 * await engine.useAbility(hero, fireball, { targets: [goblin] });
 * await engine.apply([damage(goblin, 20, hero)]);
 * ```
 */
import type { Ability, ManualAbility, StatContext, TargetPattern, Targeting } from './ability/index.js';
import type { Action, ActionDirection, ActionTransformer, DiscoverAction, GaugeAction, RollAction, RollAdjust, TransformForm } from './actions.js';
import { assertValidRoll, createDiceRng, type Roller } from './dice.js';
import { GasMeter, OutOfGasError, type GasOptions } from './gas.js';
import { Grants, SEE, type CapabilityDef, type Grant, type GrantEnd } from './grants.js';
import { ActionRegistry } from './action-registry.js';
import type { TargetWho } from './contracts.js';
import { OutcomeRegistry } from './outcome.js';
import { TargetingRegistry } from './targeting.js';
import { addBuff as addBuffAction, damage as damageAction, heal as healAction, move as moveAction, removeBuff as removeBuffAction, roll as rollAction } from './actions.js';
import { Character, type FormChange, type TransformPop } from './character.js';
import type {
  BuffDestroyReason,
  BuffDestroyedEvent,
  CharacterDestroyedEvent,
  CharacterSurvivedEvent,
  CharacterTransformedEvent,
  EventSource,
  GameEvent,
  GaugeChangedEvent,
  GaugeMaxChange,
  GaugeWrite,
  ZoneChangedEvent,
} from './events.js';
import { Gauge, type GaugeSba } from './gauge.js';
import { GARBAGE, IN_PLAY, ZoneRegistry, type Entity, type Zone, type ZoneEnd, type ZonePosition, type ZoneTransition } from './zone.js';
export type { GaugeSba } from './gauge.js';
export type { DeferredTrigger } from './trigger-stack.js';
export {
  ImmediateScheduler,
  type ReadyTrigger,
  type TriggerScheduler,
} from './trigger-scheduler.js';
import type { Player } from './player.js';
import {
  firstBlockingRestriction,
  type AttemptContext,
  type BlockedAttempt,
  type RestrictionInstance,
  type RestrictionKind,
} from './restrictions.js';
import { createPrng, createRandomSeed, hashString } from './seed.js';
import type { BuffDef } from './status/index.js';
import { Buff, type Status } from './status/index.js';
import { slugify } from './status/shared.js';
import {
  AutoChooser,
  SealedRound,
  duplicateIds,
  resolveLabel,
  resolveWritten,
  validateAnswer,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Chooser,
} from './choice.js';
import { TriggerStack, type DeferredTrigger } from './trigger-stack.js';
import type { TriggerScheduler } from './trigger-scheduler.js';


/**
 * The unified transform hook an ability exposes, if any. Only passive action
 * modifiers have one: a single listener the engine runs in **both** pipeline
 * directions — the action itself carries its `direction`, so the modifier
 * checks it when it only wants one. Manual/triggered abilities expose
 * nothing here.
 */
function abilityTransform(ability: Ability): ActionTransformer | undefined {
  return 'transform' in ability ? ability.transform : undefined;
}

/**
 * The character ultimately responsible for an action's source: a character
 * source is itself; a buff source resolves to the character that created
 * it (the buff's `caster`) — or, when the buff itself was applied with no
 * source, to the character it is attached to (e.g. an aura buff granting
 * its marks: the marks are attributed to the character wearing the aura).
 */
function casterOf(source: EventSource | undefined): Character | undefined {
  if (source instanceof Character) return source;
  return source?.caster ?? source?.target;
}

/** One gauge's pre-batch state, kept while a gauge batch settles. */
interface GaugeBatchEntry {
  readonly from: number;
  readonly owner: Character | undefined;
  source: EventSource | undefined;
  readonly writes: GaugeWrite[];
}

/** One pending destruction resolved by the destroy phase. */
type DestroyedCharacter =
  | {
      kind: 'gauge';
      rule: GaugeSba;
      character: Character;
      changes: GaugeWrite[];
      source?: EventSource;
    }
  | {
      kind: 'max-zero';
      rule: GaugeSba;
      character: Character;
      maxChanges: GaugeMaxChange[];
      source?: EventSource;
    }
  | { kind: 'direct-action'; character: Character; source?: EventSource };

/**
 * A content-registered state-based rule — a continuous condition over the
 * whole game state, checked at the SBA pass, not event-driven:
 *
 * ```ts
 * engine.addStateBasedRule({
 *   name: 'Overbuff',
 *   when: (engine) => totalBuffCount(engine) > 10,
 *   then: (engine) => [win('party')],
 * });
 * ```
 *
 * Contract (docs/design/04-sba.md):
 * - each rule fires **at most once per pass iteration**;
 * - the pass loops while any rule's actions **changed the state**, and stops
 *   on the first no-change iteration — a rule like "heal everyone while
 *   total mana is 0" terminates once everyone is full;
 * - rules should be written so their effect eventually stops changing state;
 *   the max-action-depth guard is the backstop;
 * - `win`/`lose` actions produced by a rule resolve at the win/lose layer —
 *   the game ends before any further rule or event.
 */
/**
 * Whether an ability can be used, and why not. See `GameEngine.canUse`.
 *
 * `usable: true` with a `reason` is a **hint**, not a refusal — today only
 * `'no-targets'`, which a UI should grey out but which the engine allows.
 */
export interface AbilityAvailability {
  readonly usable: boolean;
  readonly reason?: 'not-manual' | 'not-owned' | 'restricted' | 'unavailable' | 'no-targets';
  /** The restriction that blocked it, when `reason` is `'restricted'`. */
  readonly blockedBy?: RestrictionInstance;
}

export interface StateBasedRule {
  /** Rule name for diagnostics. */
  readonly name: string;
  /** Sort key among content rules. Defaults to 50 (after the built-ins). */
  readonly priority?: number;
  /** The continuous condition, checked at each pass iteration. */
  readonly when: (engine: GameEngine) => boolean;
  /**
   * The actions to apply when the condition holds. May be async: a rule that has to *ask* something
   * (run a rule card, say) before it knows the actions can wait for the answer.
   */
  readonly then: (engine: GameEngine) => Action[] | Promise<Action[]>;
}

/* ----------------------------- engine ------------------------------- */

export interface EngineOptions {
  /**
   * Answers a choice that **no player owns** — an unowned character's
   * ability, which happens in tests and scripted battles where characters
   * are registered without players. Defaults to `AutoChooser`.
   *
   * A real game never needs this: every character has a controller, and
   * that player answers (see choice.ts).
   */
  readonly chooser?: Chooser;
  /** Cap on nested action chains (guards against infinite trigger loops). Defaults to 100. */
  readonly maxActionDepth?: number;
  /**
   * The gas budget — a cap on the total *work* one scope (a move, an ability, a
   * top-level `apply`) may do, so a loop that never ends ends anyway. Defaults to
   * 10,000 units a scope. `false` turns it off. See `src/engine/gas.ts`.
   */
  readonly gas?: GasOptions | false;
  /**
   * What order triggers run in, and when (trigger-scheduler.ts).
   *
   * Omit it and everything runs the moment the resolution unit completes,
   * which is what a turn-based game wants. A card game supplies one that
   * puts triggers on its stack so players may respond; a real-time game
   * supplies one that spreads them across frames.
   */
  scheduler?: TriggerScheduler;
  /** Optional observer for every event (logging, UI hooks). */
  readonly onEvent?: (event: GameEvent) => void;
  /**
   * Seed for the PRNG that randomizes trigger order. Defaults to a random
   * seed. `Game.runLoop` replaces it with the commit/reveal seed built from
   * the players' secrets — same seed + same game state ⇒ same order.
   */
  readonly seed?: string;
  /**
   * Where dice results come from. Defaults to a seeded stream of its own
   * (derived from `seed`, separate from the trigger shuffle's). Replace it for
   * physical play (the result of the real die) or an online server (a secure
   * source). See `src/engine/dice.ts`.
   */
  readonly roller?: Roller;
}

export class GameEngine {
  /** The trigger stack: listeners, prepare/active stack, trigger runs. */
  readonly #stack: TriggerStack;
  /** Players registered with the engine (see `registerPlayer`). */
  readonly #players = new Set<Player>();
  /**
   * When the game is over — a game's question, answered by the game
   * (outcome.ts). The engine only decides *when* to ask.
   */
  readonly #outcomes = new OutcomeRegistry();
  /** What a targeting value means — `'self'`/`'any'` aside, a game's answer (targeting.ts). */
  readonly #targeting = new TargetingRegistry();
  /**
   * How each action is executed (action-registry.ts). Seeded with the engine's
   * own actions in the constructor; a game adds its own with
   * `engine.actions.register(...)`.
   */
  readonly #actions = new ActionRegistry();

  readonly #chooser: Chooser;
  readonly #onEvent: ((event: GameEvent) => void) | undefined;
  readonly #maxDepth: number;
  /** The active game seed (see `EngineOptions.seed` and `setSeed`). */
  #seed: string;
  /** The PRNG the trigger shuffle draws from, seeded from `#seed`. */
  #rng: () => number;
  /** The PRNG dice draw from — its own stream, so a roll never shifts a shuffle. */
  #diceRng: () => number;
  /** A replacement for the seeded dice source, if the game set one. */
  #roller: Roller | undefined;

  /**
   * Zones, and which zone every registered entity is in (zone.ts). Replaces
   * the two `Set<Character>` fields this used to be — `play` and `garbage`
   * are now ordinary declared zones, so a game can add its own alongside
   * them and one mechanism governs all of them.
   */
  readonly #zones = new ZoneRegistry();
  /** The `play` zone instance — where a registered character starts. */
  readonly #play: Zone;

  /** Who may do what to which single card, on top of its zone's rule (`grants.ts`). */
  readonly #grants = new Grants((grant) => {
    void this.emit({ type: 'grant:removed', capability: grant.capability, players: grant.players, count: 1 });
  });

  /**
   * Moves an entity between zones and **collects** the transition for
   * announcement. Returns the transition, or undefined for a no-op (the
   * entity is already there, or unregistered) — events announce changes.
   *
   * Collected rather than emitted immediately so a settle's moves announce
   * as one `zone:changed:batch`, the way gauge writes and destructions do.
   */
  #moveZone(entity: Entity, to: Zone, position?: ZonePosition): ZoneTransition | undefined {
    const transition = this.#zones.move(entity, to, position);
    if (!transition) return undefined;
    // A card that changes zone is a new object: "while it is yours" ends here.
    this.#grants.entityLeftZone(entity);
    this.#pendingZoneMoves.push(transition);
    // Entering play from anywhere else **realizes** the entity's gauges.
    if (to.group === IN_PLAY && transition.from?.group !== IN_PLAY && entity instanceof Character) {
      this.#realizeGauges(entity);
    }
    return transition;
  }

  /**
   * Sets a character's gauges to their derived maxima — what it means for a
   * card to *arrive* in play.
   *
   * A gauge's value is only meaningful while its owner is in play: a card
   * in a deck or a hand has no current hit points, nothing can damage it,
   * and no buff sits on it. So the value is not maintained out of play —
   * it is (re)established on the way in. A creature bounced to hand and
   * replayed therefore comes back **fresh**, not carrying the damage it
   * took last time, which is the behaviour a card game wants.
   *
   * Silent, like registration: arriving in play is setup, not healing, so
   * it emits no `gauge:changed` and fires no triggers. That is also why
   * `registerCharacter` does **not** realize — a character placed directly
   * into play keeps the state it was constructed with (a half-spent mana
   * pool stays half-spent); only a *move* into play resets.
   */
  #realizeGauges(character: Character): void {
    for (const gauge of character.gauges) {
      this.#refreshGaugeSilent(character, gauge);
      gauge.current = gauge.max;
    }
  }

  /** Zone transitions collected this settle, awaiting their batch event. */
  readonly #pendingZoneMoves: ZoneTransition[] = [];

  /**
   * Announces every zone change collected since the last flush: one
   * `zone:changed` per move, then one `zone:changed:batch` for the lot.
   * A no-op when nothing moved.
   */
  #announceZoneMoves(): void {
    if (this.#pendingZoneMoves.length === 0) return;
    const moves = this.#pendingZoneMoves.splice(0, this.#pendingZoneMoves.length);
    const events: ZoneChangedEvent[] = moves.map((move) =>
      move.from
        ? { type: 'zone:changed', entity: move.entity, from: move.from, to: move.to }
        : { type: 'zone:changed', entity: move.entity, to: move.to },
    );
    for (const event of events) void this.emit(event);
    void this.emit({ type: 'zone:changed:batch', events });
  }

  /**
   * Puts a **non-character entity** into a zone for the first time — an
   * ability object appearing on the stack, a token conjured mid-effect.
   *
   * This is a placement, not a move: the entity did not exist anywhere
   * before, so there is nothing for a replacement effect to intercept and
   * it does not pass the pipeline. It announces the first-placement version
   * of `zone:changed` (the one with no `from`).
   *
   * Characters go through `registerCharacter`, which also arms their skills
   * and derives their stats.
   */
  async addEntity(
    entity: Entity,
    zoneId: string,
    options: { owner?: Player; position?: ZonePosition } = {},
  ): Promise<boolean> {
    const zone = this.#zones.zone(zoneId, options.owner);
    if (!zone) throw new Error(`addEntity: no zone "${zoneId}"`);
    if (!this.#zones.add(entity, zone, options.position)) return false;
    this.#pendingZoneMoves.push({ entity, from: undefined, to: zone });
    this.#announceZoneMoves();
    await this.drainTriggers();
    return true;
  }

  /**
   * Removes an entity from the game entirely — it **ceases to exist**
   * rather than going anywhere, which is what happens to an ability once it
   * has finished resolving. No `zone:changed`: that event names a
   * destination, and there isn't one.
   */
  removeEntity(entity: Entity): boolean {
    this.#grants.entityRemoved(entity);
    return this.#zones.remove(entity);
  }

  /* ------------------------------ visibility ------------------------------ */

  /**
   * **Who may see a custom zone's cards**, replacing its viewer list. A real
   * `Player[]`: the keyword that calls this works out "players other than its
   * owner" (or "target player") from the game, so the zone itself never learns
   * what a teammate or an opponent is. Only a `'custom'` zone has a list to set.
   */
  setViewers(zone: Zone, players: readonly Player[]): void {
    if (zone.visibility !== 'custom') {
      throw new Error(
        `setViewers: zone "${zone.key}" is "${zone.visibility}", not "custom" — only a custom zone has a viewer list`,
      );
    }
    zone._viewers = [...new Set(players)];
  }

  /**
   * **Shows one card to some players**, on top of what its zone allows — a grant
   * of the `see` capability. See `grant` for the lifetimes.
   */
  showTo(entity: Entity, players: readonly Player[], options: { until?: GrantEnd; source?: EventSource } = {}): Grant {
    return this.grant(entity, players, SEE, options);
  }

  /* -------------------------------- grants -------------------------------- */

  /**
   * **Declares a capability** a game can grant — `'cast'`, `'play'`, `'activate'`.
   * The engine reads none of them; it only remembers who holds which. `see` is
   * built in.
   *
   * A capability implies nothing by default: permission to act on a card is not
   * permission to look at it (a Boxed Present is cast by opening it, and casting it
   * is what reveals it). A game that wants a link says so — `{ implies: ['see'] }` —
   * and then granting the one grants the other, to the same players and for as long.
   */
  declareCapability(name: string, def: CapabilityDef = {}): void {
    this.#grants.declare(name, def);
  }

  /**
   * **Gives players a capability on one card**, announced as `grant:added`
   * without naming the card.
   *
   * `until` is how long: `'zone-change'` (default — while the card stays where it
   * is), `'resolution'` (inside `engine.resolution(...)`, for one effect),
   * `'turn-end'`, or `'manual'` (until `end()`). `source` is who granted it, so
   * `revokeGrants(source)` ends exactly that source's grants and leaves any other
   * effect's permission on the same card alone. Several grants are a union.
   */
  grant(
    entity: Entity,
    players: readonly Player[],
    capability: string,
    options: { until?: GrantEnd; source?: EventSource } = {},
  ): Grant {
    if (!this.#zones.has(entity)) throw new Error(`grant: "${entity.name}" is not in the game`);
    const grant = this.#grants.add(entity, players, capability, options.until ?? 'zone-change', options.source);
    void this.emit({ type: 'grant:added', capability, players: grant.players, count: 1 });
    return grant;
  }

  /* ---------------------------- card abilities ---------------------------- */

  /**
   * **Sets the abilities every card in `zone` has while it is there**, and who may
   * use them — replacing both lists. A card has the abilities it was printed with
   * plus whatever its current zone or an effect gives it: a Boxed Present zone
   * gives every card in it *Open Present*, an ability no card printed.
   *
   * Like the viewer list this is standing state set while the game runs (by a
   * keyword or a rule), not part of the zone's declaration, so it can change
   * mid-game. A card that enters has the abilities; one that leaves loses them.
   */
  setZoneAbilities(zone: Zone, abilities: readonly Ability[], users: readonly Player[]): void {
    const manual = abilities.map((ability) => {
      if (ability.kind !== 'manual') {
        throw new Error(`setZoneAbilities: "${ability.name}" is not a manual ability (kind: ${ability.kind})`);
      }
      return ability;
    });
    zone._abilities = manual.map((ability) => ({ ability, users: [...new Set(users)] }));
  }

  /**
   * **Adds one ability to a zone's cards**, for some players — "Cards in your
   * boxed zone have Open Present for all opponents." Unlike `setZoneAbilities` it
   * keeps what the zone already gives. Giving the same ability again (same `id`) replaces who
   * may use it rather than listing it twice.
   */
  addZoneAbility(zone: Zone, ability: Ability, users: readonly Player[]): void {
    if (ability.kind !== 'manual') {
      throw new Error(`addZoneAbility: "${ability.name}" is not a manual ability (kind: ${ability.kind})`);
    }
    const entry = { ability, users: [...new Set(users)] };
    // Matched by id, not object: a document compiled again (a reload) makes new ability
    // objects, and the fresh one should replace the stale one, not sit beside it.
    const at = zone._abilities.findIndex((existing) => existing.ability.id === ability.id);
    if (at >= 0) zone._abilities[at] = entry;
    else zone._abilities.push(entry);
  }

  /* ------------------------------- counters ------------------------------ */

  readonly #counters = new WeakMap<Entity, Map<string, number>>();

  /** How many counters of `kind` are on `entity` (zero if none). A counter is a number a card carries; the engine reads none of them. */
  counters(entity: Entity, kind = 'counter'): number {
    return this.#counters.get(entity)?.get(kind) ?? 0;
  }

  /** Every counter kind on `entity` with a count above zero. */
  countersOn(entity: Entity): ReadonlyMap<string, number> {
    return new Map([...(this.#counters.get(entity) ?? [])].filter(([, n]) => n > 0));
  }

  /** Puts `count` counters of `kind` on `entity`. */
  addCounters(entity: Entity, count: number, kind = 'counter'): void {
    if (!Number.isInteger(count) || count < 0) throw new Error(`addCounters: ${count} is not a whole number of counters`);
    const have = this.#counters.get(entity) ?? new Map<string, number>();
    have.set(kind, (have.get(kind) ?? 0) + count);
    this.#counters.set(entity, have);
    this.#stateVersion += 1;
  }

  /** Takes up to `count` counters of `kind` off `entity`; returns how many came off. */
  removeCounters(entity: Entity, count: number, kind = 'counter'): number {
    const have = this.#counters.get(entity);
    const removed = Math.min(Math.max(count, 0), have?.get(kind) ?? 0);
    if (have && removed > 0) {
      have.set(kind, have.get(kind)! - removed);
      this.#stateVersion += 1;
    }
    return removed;
  }

  /**
   * **Takes one ability away from a zone's cards** — "Cards in this zone no longer
   * have Open Present." It removes what `addZoneAbility` / `setZoneAbilities` gave,
   * for everyone it was given to. Returns whether the zone had it.
   *
   * It does not touch an ability a card was *granted* (`grantAbility`) — that has its
   * own lifetime and source — nor one the card printed.
   */
  removeZoneAbility(zone: Zone, ability: Ability): boolean {
    const at = zone._abilities.findIndex((entry) => entry.ability.id === ability.id);
    if (at < 0) return false;
    zone._abilities.splice(at, 1);
    return true;
  }

  /**
   * **Gives one card an ability** for some players, for a lifetime — the effect
   * form of `setZoneAbilities` ("until end of turn, that card has *Cast this
   * card*"). A grant like any other: `source`, `until`, ended by `revokeGrants`.
   */
  grantAbility(
    entity: Entity,
    ability: Ability,
    players: readonly Player[],
    options: { until?: GrantEnd; source?: EventSource } = {},
  ): Grant {
    if (ability.kind !== 'manual') {
      throw new Error(`grantAbility: "${ability.name}" is not a manual ability (kind: ${ability.kind})`);
    }
    if (!this.#zones.has(entity)) throw new Error(`grantAbility: "${entity.name}" is not in the game`);
    const capability = `ability:${ability.id}`;
    this.#grants.declare(capability);
    const grant = this.#grants.add(entity, players, capability, options.until ?? 'zone-change', options.source, ability);
    void this.emit({ type: 'grant:added', capability, players: grant.players, count: 1 });
    return grant;
  }

  /**
   * The abilities `player` may use **on this card** right now: those its zone gives
   * (when `player` is one of the zone's users) and those an effect granted them.
   */
  abilitiesFor(player: Player, entity: Entity): readonly ManualAbility[] {
    const zone = this.#zones.zoneOf(entity);
    const found = [...this.#grants.abilitiesFor(player, entity)];
    for (const entry of zone?.abilityEntries ?? []) {
      if (entry.users.includes(player) && !found.includes(entry.ability)) found.unshift(entry.ability);
    }
    return found;
  }

  /**
   * **A player uses an ability a card has been given.** The player must be one who
   * may (`abilitiesFor`); `self` is their first living character and `host` is the
   * card, so "this card" in the ability means it. The actions flow through the
   * pipeline like any ability's.
   */
  async useCardAbility(
    player: Player,
    entity: Entity,
    ability: Ability,
    targeting: Targeting = { targets: [] },
  ): Promise<void> {
    return this.metered(`ability ${ability.name}`, () => this.#useCardAbility(player, entity, ability, targeting));
  }

  async #useCardAbility(player: Player, entity: Entity, ability: Ability, targeting: Targeting): Promise<void> {
    if (ability.kind !== 'manual' || !this.abilitiesFor(player, entity).includes(ability)) {
      throw new Error(`useCardAbility: ${player.name} may not use "${ability.name}" on "${entity.name}"`);
    }
    const self = player.livingCharacters[0];
    if (!self) throw new Error(`useCardAbility: ${player.name} has no character to use "${ability.name}"`);
    const ctx = { self, engine: this, host: entity };
    if (ability.available && !ability.available(ctx)) {
      throw new Error(`useCardAbility: "${ability.name}" cannot be used right now`);
    }
    const pool = this.validTargets(ability.targeting, self);
    const invalid = targeting.targets.filter((target) => !pool.includes(target));
    if (invalid.length > 0) {
      throw new Error(
        `useCardAbility: "${ability.name}" cannot target ${invalid.map((t) => `"${t.name}"`).join(', ')} — outside its targeting pattern`,
      );
    }
    const actions = await ability.cast(ctx, targeting);
    if (actions.length > 0) await this.apply(actions, { source: self });
  }

  /** Whether a live grant lets `player` do `capability` to this card. */
  mayAct(player: Player, entity: Entity, capability: string): boolean {
    return this.#grants.allows(player, entity, capability);
  }

  /** Ends every grant `source` made, and only those. */
  revokeGrants(source: EventSource): void {
    this.#grants.revokeFrom(source);
  }

  /** Runs `fn` as one resolution: `'resolution'` grants made inside end when it does. */
  resolution<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.#grants.scope(fn);
  }

  /**
   * **Whether `player` may see this card** — its zone's rule, or a live grant.
   * This is the question a view is built from. A zone's *size* is not hidden by
   * any rule, only its contents.
   */
  canSee(player: Player, entity: Entity): boolean {
    const zone = this.#zones.zoneOf(entity);
    if (!zone) return false;
    return this.zoneShows(player, zone) || this.#grants.allows(player, entity, SEE);
  }

  /**
   * Whether `zone`'s **own rule** shows its cards to `player` — public, the owner's
   * own, or on a custom zone's viewer list — ignoring any per-card grant. A view
   * uses it to tell whether a player could see a card where it *was*.
   */
  zoneShows(player: Player, zone: Zone): boolean {
    switch (zone.visibility) {
      case 'public':
        return true;
      case 'owner':
        return zone.owner === player;
      case 'custom':
        return zone.viewers.includes(player);
      case 'hidden':
        return false;
    }
  }

  /** The cards of a zone `player` may see, in the zone's order. */
  visibleMembers(zone: Zone, player: Player): readonly Entity[] {
    return zone.members.filter((member) => this.canSee(player, member));
  }

  /**
   * **Looks at the top of an ordered zone without moving anything** — the peek
   * a reveal mechanic needs.
   *
   * The engine had no way to do this, which is why "look at the top card of
   * your library" was inexpressible: a move was the only way anything left a
   * deck, so every look was also a take. A peek is not a move — nothing changes
   * zone, so **nothing is announced and no trigger fires**, the same reasoning
   * `ZoneRegistry.shuffle` already records. If content wants an event, it moves
   * the card afterwards and gets one.
   *
   * Returns `undefined` for a zone that does not exist, is empty, or is
   * **unordered** — a bag has no top, and inventing one (the first member, the
   * last) would be a silent lie about which card was seen.
   */
  reveal(zoneId: string, owner?: Player): Entity | undefined {
    const zone = owner ? this.#zones.zone(zoneId, owner) : this.#zones.unownedZone(zoneId);
    return zone?.ordered ? zone.top : undefined;
  }

  /**
   * Shuffles an ordered zone with the game's seeded PRNG.
   *
   * Public because content needs it and only the game knows when: "the rest on
   * the bottom in a random order" is a shuffle, and it belongs to the effect
   * that wrote it rather than to a hidden helper. Announces nothing, for the
   * reason on `ZoneRegistry.shuffle` — no player learns the order.
   */
  shuffleZone(zoneId: string, owner?: Player): void {
    const zone = owner ? this.#zones.zone(zoneId, owner) : this.#zones.unownedZone(zoneId);
    if (zone) this.#zones.shuffle(zone, () => this.random());
  }

  /**
   * **The `nth` entity (1-based) from one end of an ordered zone**, without
   * moving it — "the seventh card from the top". Like `reveal`, a look: nothing
   * is announced. Pair it with `moveTo` to *get* the card ("put the 7th card from
   * the top into your hand"). Undefined when the zone is unordered or too short.
   */
  peek(zoneId: string, nth: number, options: { owner?: Player; from?: ZoneEnd } = {}): Entity | undefined {
    return this.#orderedZone(zoneId, options.owner)?.nth(nth, options.from);
  }

  /**
   * **The first `count` entities from one end** of an ordered zone, in zone
   * order — the section a scry looks at. Announces nothing; see `peek`.
   */
  peekSection(zoneId: string, count: number, options: { owner?: Player; from?: ZoneEnd } = {}): readonly Entity[] {
    return this.#orderedZone(zoneId, options.owner)?.section(count, options.from) ?? [];
  }

  /**
   * Moves an entity **within its ordered zone**: top to bottom, bottom to top,
   * "third from the top". Announces nothing — it never changes zone, so no
   * `zone:changed` — and is not gated by the action pipeline, like a shuffle.
   * Returns false when the entity is not in an ordered zone.
   */
  reposition(entity: Entity, position: ZonePosition): boolean {
    const moved = this.#zones.reposition(entity, position);
    if (moved) this.#stateVersion += 1;
    return moved;
  }

  /**
   * **Commits a scry-style rearrangement** of the first `count` entities of an
   * ordered zone: `top` go back on top in the order given, `bottom` go under.
   * The two lists must be exactly that section (see `ZoneRegistry.arrange`).
   * Announces nothing.
   */
  arrange(
    zoneId: string,
    count: number,
    placement: { top?: readonly Entity[]; bottom?: readonly Entity[] },
    options: { owner?: Player; from?: ZoneEnd } = {},
  ): void {
    const zone = this.#orderedZone(zoneId, options.owner);
    if (!zone) throw new Error(`arrange: no ordered zone "${zoneId}"`);
    this.#zones.arrange(zone, count, placement, options.from);
    this.#stateVersion += 1;
  }

  /**
   * **Shuffles an entity into an ordered zone** — it goes in as a real move
   * (replacement effects, restrictions and `zone:changed` all apply), then the
   * zone is shuffled, so where it landed is irrelevant. If the entity is already
   * in the zone it is just shuffled with the rest.
   */
  async shuffleIn(
    entity: Entity,
    zoneId: string,
    options: { owner?: Player; reason?: string; source?: EventSource } = {},
  ): Promise<void> {
    await this.moveTo(entity, zoneId, { ...options, position: 'bottom' });
    // Shuffle where it actually landed — a replacement effect may have redirected it.
    const landed = this.#zones.zoneOf(entity);
    if (landed) this.#zones.shuffle(landed, () => this.random());
  }

  #orderedZone(zoneId: string, owner?: Player): Zone | undefined {
    const zone = owner ? this.#zones.zone(zoneId, owner) : this.#zones.unownedZone(zoneId);
    return zone?.ordered ? zone : undefined;
  }

  /**
   * Moves an entity to a zone by id (a per-player zone needs its `owner`) —
   * the game-facing verb for a draw, a discard, a bounce.
   *
   * Sugar over `apply([move(...)])`, so it goes through the whole pipeline:
   * replacement effects may redirect it, an `on: 'move'` restriction may
   * block it, and it announces `zone:changed`.
   */
  async moveTo(
    entity: Entity,
    zoneId: string,
    options: { owner?: Player; position?: ZonePosition; reason?: string; source?: EventSource } = {},
  ): Promise<void> {
    // A `per-player` zone is resolved through the entity: a character's
    // controller owns the pile it lands in, so a caller does not have to
    // repeat what the entity already knows. An explicit owner still wins.
    const zone = this.#zoneFor(entity, zoneId, options.owner);
    if (!zone) throw new Error(`moveTo: no zone "${zoneId}"${options.owner ? ` for ${options.owner.name}` : ''}`);
    await this.apply(
      [
        moveAction(entity, zone, {
          ...(options.position !== undefined ? { position: options.position } : {}),
          ...(options.reason ? { reason: options.reason } : {}),
        }),
      ],
      options.source ? { source: options.source } : {},
    );
  }

  /**
   * Every registered **character**, in registration order.
   *
   * Zones hold entities, and only some of them are characters — an ability
   * waiting on the stack is an entity with no gauges and no statuses. The
   * engine's own rules (stat derivation, the destroy phase, targeting,
   * defeat) are about characters, so they walk this rather than every
   * entity.
   */
  #chars(): Character[] {
    return this.#zones.entitiesOf<Character>('character');
  }

  /**
   * Asks a choice and validates the answer (choice.ts).
   *
   * Routing is the point: a request names its **chooser**, and that player
   * answers. Only when nothing owns the decision — an unowned character's
   * ability, with no player to ask — does the engine fall back to its
   * configured `chooser`, which speaks the same protocol. There is no
   * second interface.
   *
   * Validation happens here, in one place, so every path is held to the
   * same rules: a player, a scripted chooser, or a remote client that
   * might try to answer outside the options it was offered.
   */
  /**
   * Asks a choice — the public form of the routing below, for content that
   * needs a decision mid-resolution ("you **may** …", a repeat's "again?").
   */
  async ask(request: ChoiceRequest): Promise<ChoiceAnswer> {
    return this.#ask(request);
  }

  /**
   * **Asks several players at once** — the "everyone chooses, then reveal" round.
   *
   * With `sealed: true`, every request goes out concurrently, each to its own
   * `chooser` (which must be a distinct player: a sealed round is *between*
   * players). A chooser answers without seeing anyone else's, and each answer is
   * held in the returned `SealedRound` as it arrives, announced only as
   * `choice:ready` — never its content. The promise resolves when **every
   * chooser** is ready; players with no request are not waited on. Nothing is
   * readable until `revealRound`.
   *
   * With `sealed: false` the requests are asked **one at a time in the order
   * given**, each chooser seeing the state the earlier answers left, and the
   * round comes back already revealed. That is today's sequential behaviour; it
   * is here so a card's wording ("in secret" or not) is the only thing that
   * decides which.
   */
  async askAll(requests: readonly ChoiceRequest[], options: { sealed: boolean }): Promise<SealedRound> {
    const choosers = requests.map((request) => request.chooser);
    if (options.sealed) {
      const players = choosers.filter((chooser): chooser is Player => chooser !== undefined);
      if (players.length !== choosers.length) {
        throw new Error('askAll: every request in a sealed round needs a chooser');
      }
      if (new Set(players).size !== players.length) {
        throw new Error('askAll: a player can answer a sealed round only once');
      }
    }
    for (const request of requests) {
      if (request.kind === 'label') {
        const distinct = new Set(request.options);
        if (request.options.length < 2 || distinct.size !== request.options.length) {
          throw new Error(`askAll: "${request.prompt}" needs at least two different options to choose between`);
        }
      }
      if (request.kind !== 'select') continue;
      const repeated = duplicateIds(request.options);
      if (repeated.length > 0) {
        throw new Error(
          `askAll: "${request.prompt}" offers more than one option with the id ${repeated.map((id) => `"${id}"`).join(', ')} — every card needs a unique id`,
        );
      }
    }
    const round = new SealedRound(requests);
    if (!options.sealed) {
      // Open choices are validated as they are made, and a bad one is a bug.
      const cast: { player: Player; option: string }[] = [];
      for (const request of requests) {
        // Each voter sees the votes already cast.
        const answer = await this.#ask(request.kind === 'label' ? { ...request, prior: [...cast] } : request);
        if (request.chooser) round._commit(request.chooser, answer);
        if (request.chooser && answer.kind === 'label') cast.push({ player: request.chooser, option: answer.value });
      }
      round._open();
      return round;
    }
    // A commitment is judged at the reveal, not here: nobody learns that a
    // face-down answer is invalid until it is turned over (see `SealedRound`).
    await Promise.all(
      requests.map(async (request) => {
        const player = request.chooser!;
        round._commit(player, await player.choose(request));
        await this.emit({ type: 'choice:ready', player });
      }),
    );
    return round;
  }

  /**
   * Opens a sealed round: judges every commitment, announces the valid answers
   * at once (`choice:revealed`), and announces each forfeit (`choice:forfeited`).
   * Throws if some chooser is not ready yet, or if the round was already opened.
   *
   * Returns the players who forfeited — an invalid or vague commitment, or an
   * attempt to change one. What that costs is the game's rule, not the
   * engine's: the IR's `reveal` makes them lose the game.
   */
  async revealRound(round: SealedRound): Promise<readonly { readonly player: Player; readonly reason: string }[]> {
    if (round.revealed) throw new Error('revealRound: this round is already revealed');
    const forfeited = round._open();
    await this.emit({ type: 'choice:revealed', answers: round.answers });
    for (const { player, reason } of forfeited) await this.emit({ type: 'choice:forfeited', player, reason });
    return forfeited;
  }

  async #ask(request: ChoiceRequest): Promise<ChoiceAnswer> {
    this.gas.spend('ask', request.kind);
    const answerer = request.chooser ?? this.#chooser;
    const answer = await answerer.choose(request);
    const problem = validateAnswer(request, answer);
    if (problem) throw new Error(`"${request.prompt}": ${problem}`);
    // An open choice is made in view, so a written value is resolved on the
    // spot and callers only ever see a pick.
    if (request.kind === 'select' && answer.kind === 'written') {
      const resolved = resolveWritten(request.options, answer.text);
      return { kind: 'select', chosen: 'chosen' in resolved ? resolved.chosen : [] };
    }
    if (request.kind === 'label' && answer.kind === 'written') {
      const resolved = resolveLabel(request.options, answer.text);
      return { kind: 'label', value: 'value' in resolved ? resolved.value : request.options[0]! };
    }
    return answer;
  }

  /**
   * **The garbage pile a thing belongs to** — the one owned by its
   * controller, or the ownerless pile when it has none.
   *
   * This is the ownership the destroy path used to lack: `graveyard` was one
   * shared `Set`, so "whose pile is this" was unanswerable. Resolving it per
   * entity is what makes a per-player garbage zone work without teaching
   * every reader who owns what.
   */
  #garbageFor(entity: Entity): Zone {
    const zone = this.#zoneFor(entity, GARBAGE.id);
    if (!zone) throw new Error(`GameEngine: no "${GARBAGE.id}" zone`);
    return zone;
  }

  /**
   * The instance of `zoneId` an entity belongs in: the one owned by its
   * controller, or the ownerless pile when it has none. An explicit owner
   * always wins (moving something into another player's zone is a real
   * thing to do).
   */
  #zoneFor(entity: Entity, zoneId: string, owner?: Player): Zone | undefined {
    const resolved = owner ?? (entity instanceof Character ? entity.controller : undefined);
    return resolved
      ? this.#zones.zone(zoneId, resolved)
      : this.#zones.unownedZone(zoneId);
  }

  /** True when a character has been moved to a garbage pile (i.e. is dead). */
  #inGarbage(character: Character): boolean {
    return this.#zones.zoneOf(character)?.id === GARBAGE.id;
  }

  /**
   * The zone registry — declare a game's zones here (a deck, a hand, a
   * stack). `play` and `graveyard` ship declared; see zone.ts.
   */
  get zones(): ZoneRegistry {
    return this.#zones;
  }

  /**
   * `destroy` actions awaiting the next SBA pass, in application order —
   * resolved together with any HP ≤ 0 deaths from the same batch (see
   * `#destroyPhase`). Each entry keeps the action's `bypasses` (the
   * restriction ids that destruction pierces at the destroy gate).
   */
  #pendingDestroy: Array<{ target: Character; source?: EventSource; bypasses?: readonly string[] }> = [];
  /**
   * Characters whose derived gauge **max** triggered a registered max-aspect
   * gauge rule (a `maxModifier` buff with a large negative contribution),
   * awaiting the next destroy phase — the death is attributed to the max
   * write the recompute produced and reported with the rule's reason.
   */
  #pendingMaxZero: Array<{
    target: Character;
    rule: GaugeSba;
    maxChanges: GaugeMaxChange[];
    source?: EventSource;
  }> = [];
  /**
   * The `buff:destroyed` events emitted by the current `apply`, in order —
   * summarized as one `buff:destroyed:batch` at the apply's end (each apply
   * accumulates its own; nested applies save and restore this).
   */
  #buffDestroyedBatch: BuffDestroyedEvent[] = [];
  /**
   * The `character:transformed` events emitted by the current `apply`, in
   * order — summarized as one `character:transformed:batch` at the apply's
   * end, the same way `#buffDestroyedBatch` summarizes removals (each apply
   * accumulates its own; nested applies save and restore this).
   */
  #transformedBatch: CharacterTransformedEvent[] = [];
  #depth = 0;
  /** True while `drainTriggers` is running (nested applies must not re-drain). */
  #draining = false;
  /** Content state-based rules, sorted by `priority` ascending. */
  #sbaRules: StateBasedRule[] = [];
  /** True while the content SBA loop is running (nested applies skip it). */
  #inSBAPass = false;
  /**
   * Monotonic state version — bumped whenever a write, destruction, buff
   * change, or an outcome marker actually lands. The content SBA loop uses it
   * to detect "this iteration changed nothing" and stop.
   */
  #stateVersion = 0;
  /**
   * The state version the last world-stat refresh ran at — the gate for
   * `#refreshWorldStats`: derived stats whose `value` functions read the
   * world are re-derived only when the state actually changed since.
   */
  #lastStatRefreshVersion = -1;
  /**
   * Whether the content SBA rules were already checked during this apply —
   * gates the end-of-apply leftover check so an apply whose gauge batch
   * already ran the rules does not run them a second time.
   */
  #sbaCheckedThisApply = false;

  /**
   * How much work this scope has done and may still do. Open a scope around a unit of
   * your own work with `metered`; the engine's own entry points already do.
   */
  readonly gas: GasMeter;

  constructor(options: EngineOptions = {}) {
    this.gas = new GasMeter(options.gas === false ? { limit: Number.POSITIVE_INFINITY } : options.gas);
    this.#play = this.#zones.zone('play')!;
    this.#chooser = options.chooser ?? new AutoChooser();
    this.#onEvent = options.onEvent;
    this.#maxDepth = options.maxActionDepth ?? 100;
    this.#seed = options.seed ?? createRandomSeed();
    this.#rng = createPrng(hashString(this.#seed));
    this.#diceRng = createDiceRng(this.#seed);
    this.#roller = options.roller;
    this.#stack = new TriggerStack({
      rng: () => this.#rng(),
      validTargets: (pattern, self) => this.validTargets(pattern, self),
      apply: (actions, context) => this.apply(actions, context),
      context: (self, status, event) => ({ self, engine: this, status, event }),
      ask: (request) => this.#ask(request),
      gas: this.gas,
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    });
    // The built-in death rules live on every character's HP gauge (see
    // character.ts) — the engine has no gauge registry of its own.
    // The engine's own actions go through the same registry a game uses.
    this.#registerBuiltinActions();
  }

  /**
   * How actions are executed — the runtime half of the open `ActionMap`
   * (action-registry.ts). A game declares an action by augmenting the map,
   * then teaches the engine to run it:
   *
   * ```ts
   * engine.actions.register('summon', (action, ctx) => {
   *   ctx.engine.registerCharacter(action.unit);
   * });
   * ```
   */
  get actions(): ActionRegistry {
    return this.#actions;
  }

  /* ------------------------- registration ------------------------- */

  /**
   * Registers a character: skills are attached and their abilities armed.
   *
   * `options.zone` is where it lands — `play` by default, or a game's own
   * zone to **stage** it out of play (a card resolving in `active`, a
   * permanent about to be cheated in from the `stack`). Placement is silent,
   * like registration: it announces nothing, so the `zone:changed` event
   * belongs to the `moveTo` that follows and carries a real `from` — which
   * is what makes `when this enters play from active` expressible.
   */
  registerCharacter(
    character: Character,
    options: { zone?: string; owner?: Player; position?: ZonePosition } = {},
  ): this {
    if (this.#zones.has(character)) return this;
    const zone =
      options.zone === undefined
        ? this.#play
        : this.#zones.zone(options.zone, options.owner);
    if (!zone) {
      throw new Error(
        `registerCharacter: no zone "${options.zone}"${options.owner ? ` for ${options.owner.name}` : ''}`,
      );
    }
    this.#zones.add(character, zone, options.position);
    for (const status of character.statuses) {
      this.#stack.attachStatus(status, character);
    }
    // Skills may carry stat contributions (`stat`, `maxModifier`) — derive
    // every stat once, silently (setup, not play: no events, no triggers).
    this.#refreshStatsSilent(character);
    // A newly registered character can change world-derived values (a swarm
    // count, a summon) — re-derive every **function** value across all
    // registered characters, silently, so setup is settled in any
    // registration order (and a mid-game registration takes effect
    // immediately; the next settle's refresh keeps it current).
    for (const other of this.#chars()) {
      if (other === character || this.#inGarbage(other)) continue;
      for (const gauge of this.#functionGauges(other)) {
        this.#refreshGaugeSilent(other, gauge);
      }
      for (const name of this.#functionStatNames(other)) {
        this.#refreshStatSilent(other, name);
      }
    }
    return this;
  }

  get registeredCharacters(): Character[] {
    return this.#chars();
  }

  /**
   * Registers a player (and all its characters) so the engine can detect
   * wins and losses. Until at least one player is registered, gauge changes
   * never end the game — `GameEndInterrupt` is only thrown once the game's
   * participants are known.
   */
  registerPlayer(player: Player): this {
    if (this.#players.has(player)) return this;
    this.#players.add(player);
    for (const character of player.characters) {
      this.registerCharacter(character);
    }
    return this;
  }

  /** Registers several players at once (see `registerPlayer`). */
  registerPlayers(players: readonly Player[]): this {
    for (const player of players) this.registerPlayer(player);
    return this;
  }

  /**
   * Registers a content state-based rule (see `StateBasedRule` for the
   * contract). Rules run in the SBA pass — after the outcome checks and the destroy
   * phase — in ascending `priority` order, looping while the state changes.
   */
  addStateBasedRule(rule: StateBasedRule): this {
    this.#sbaRules.push(rule);
    this.#sbaRules.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    return this;
  }

  /** The players registered with the engine, in registration order. */
  get players(): Player[] {
    return [...this.#players];
  }

  /**
   * When the game is over — a game's question. A game registers its own check
   * (see `OutcomeRegistry`); the engine runs them at each settle boundary and
   * owns no opinion about what "over" means.
   */
  get outcomes(): OutcomeRegistry {
    return this.#outcomes;
  }

  /**
   * What a targeting value means. The engine answers `'self'` and `'any'`
   * itself — neither needs a model of the world — and a game registers the
   * rest (see `TargetingRegistry`).
   */
  get targeting(): TargetingRegistry {
    return this.#targeting;
  }

  /* -------------------------- targeting ---------------------------- */

  /**
   * The characters that match a targeting pattern, relative to `self`.
   *
   * Resolution order:
   * 1. filter by `who` (self/ally/enemy/any),
   * 2. apply `match` — or, when `negate` is set, exclude candidates that
   *    match (with no `match`, `negate` inverts the `who` filter itself),
   * 3. remove characters with a matching `on: 'target'` restriction — a
   *    hard filter ("cannot be targeted"),
   * 4. append `include` — specific characters that are always valid,
   *    regardless of `who`/`match`/`negate` **and of target restrictions**
   *    (`include` is the named-exception primitive for targeting: a
   *    hexproof character listed in `include` is still targetable).
   */
  /**
   * The predicate a targeting value stands for, relative to `self`.
   *
   * `'self'` and `'any'` are the engine's own — they ask nothing about the
   * world. Anything else is a game's, registered on `engine.targeting`; a
   * missing one throws here rather than silently matching nobody.
   */
  #whoMatcher(who: TargetWho, self: Character): (candidate: Character) => boolean {
    if (who === 'self') return (candidate) => candidate === self;
    if (who === 'any') return () => true;
    const resolve = this.#targeting.get(who);
    if (!resolve) {
      throw new Error(
        `No targeting resolver registered for who "${who}". Declare it in TargetWhoMap ` +
          `(contracts.ts), then register one with engine.targeting.register("${who}", …).`,
      );
    }
    return (candidate) => resolve(self, candidate, this);
  }

  validTargets(pattern: TargetPattern, self: Character): Character[] {
    // Resolved once, before the pool is walked, so a `who` with no resolver
    // is a loud error even when nothing is in range — otherwise a forgotten
    // registration would look exactly like "no valid targets".
    const matchesWho = this.#whoMatcher(pattern.who, self);

    const pool = this.registeredCharacters.filter((c) => {
      // Targeting draws only from **targetable zones** — a property of the
      // zone declaration, not a hard-coded graveyard check. By default only
      // `play` is targetable, so the graveyard is out of the pool (revive
      // is a dedicated effect, see docs 01/05) and so is anything a game
      // moved to a hand, a deck or a removed pile.
      if (this.#zones.zoneOf(c)?.targetable !== true) return false;
      const who = matchesWho(c);
      let fits: boolean;
      if (pattern.match) {
        const matched = pattern.match({ self, engine: this }, c);
        fits = who && (pattern.negate ? !matched : matched);
      } else {
        fits = pattern.negate ? !who : who;
      }
      if (!fits) return false;
      // "Cannot be targeted" restrictions remove the character from the
      // pool. The acting character (`self`) is the source of the attempt.
      return (
        this.attemptBlocked({
          kind: 'target',
          target: c,
          ctx: { self: c, source: self, sourceCharacter: self, pattern, engine: this },
        }) === undefined
      );
    });

    for (const included of pattern.include ?? []) {
      if (
        this.#zones.has(included) &&
        this.#zones.zoneOf(included)?.targetable === true &&
        !pool.includes(included)
      ) {
        pool.push(included);
      }
    }
    return pool;
  }

  /* ------------------------- public actions ------------------------ */

  /**
   * Fires an event: external observers (`onEvent`) hear it immediately, and
   * the matching trigger listeners are collected and **queued** — they run
   * later, when the current resolution unit completes (`drainTriggers`).
   */
  async emit(event: GameEvent): Promise<void> {
    this.#notify(event);
    this.#stack.enqueue(event);
    // "This turn" permissions end with the turn.
    if (event.type === 'turn:end') this.#grants.turnEnded();
  }

  /**
   * Listens to every event the engine announces, alongside the `onEvent` option.
   * Returns a function that stops listening. A server uses it to give each connected
   * player their own redacted copy of the stream.
   */
  observe(listener: (event: GameEvent) => void): () => void {
    this.#observers.add(listener);
    return () => {
      this.#observers.delete(listener);
    };
  }

  readonly #observers = new Set<(event: GameEvent) => void>();

  #notify(event: GameEvent): void {
    this.#onEvent?.(event);
    for (const observer of this.#observers) observer(event);
  }

  /** How many triggers the scheduler is holding (diagnostics, tests, UI). */
  get triggerQueueSize(): number {
    return this.#stack.pending;
  }

  /** The seed currently driving the trigger-order PRNG. */
  get seed(): string {
    return this.#seed;
  }

  /**
   * Re-seeds the PRNG that randomizes trigger order. The `Game` seed
   * ceremony calls this before the first round; tests can pass a fixed seed
   * for reproducible trigger orders.
   */
  setSeed(seed: string): void {
    this.#seed = seed;
    this.#rng = createPrng(hashString(seed));
    this.#diceRng = createDiceRng(seed);
  }

  /**
   * Draws one number from the engine's seeded PRNG — the same stream that
   * randomizes trigger order. Pass it to anything else that wants a seeded
   * draw (a game's initiative tie-breaks, say) so the whole game stays
   * reproducible from its seed: same seed + same state ⇒ same outcome.
   */
  random(): number {
    return this.#rng();
  }

  /**
   * Replaces where dice results come from — a table's physical die, or a
   * server's secure source. Pass `undefined` to go back to the seeded stream.
   */
  setRoller(roller: Roller | undefined): void {
    this.#roller = roller;
  }

  /**
   * **Rolls dice through the pipeline** and returns the final results.
   *
   * Sugar over `apply([roll(...)])`, so replacement effects may change the dice
   * or adjust the outcome, and `roll:made` is announced. Returns `[]` if the
   * roll was blocked before it happened.
   */
  async roll(
    count: number,
    sides: number,
    options: { source?: EventSource; reason?: string; adjust?: readonly RollAdjust[] } = {},
  ): Promise<readonly number[]> {
    let results: readonly number[] = [];
    await this.apply(
      [
        rollAction(count, sides, {
          ...(options.reason ? { reason: options.reason } : {}),
          ...(options.source ? { source: options.source } : {}),
          ...(options.adjust ? { adjust: options.adjust } : {}),
          onRolled: (rolled) => {
            results = rolled;
          },
        }),
      ],
      options.source ? { source: options.source } : {},
    );
    return results;
  }

  /** The body of the `roll` action: ask the roller, adjust, announce. */
  async #roll(action: RollAction): Promise<void> {
    const context = { source: action.source, reason: action.reason };
    const dice = async (): Promise<readonly number[]> => {
      const rolled = this.#roller
        ? await this.#roller(action.count, action.sides, context)
        : Array.from({ length: action.count }, () => 1 + Math.floor(this.#diceRng() * action.sides));
      assertValidRoll(rolled, action.count, action.sides);
      return rolled;
    };
    let results = await dice();
    // Adjustments may exceed the die's faces ("add 1"), so they are not re-validated.
    for (const adjust of action.adjust ?? []) results = await adjust(results, dice);
    this.#stateVersion += 1;
    action.onRolled?.(results);
    await this.emit({
      type: 'roll:made',
      count: action.count,
      sides: action.sides,
      results,
      ...(action.source ? { source: action.source } : {}),
    });
  }

  /**
   * Runs the queued triggers after a resolution unit completes (a move's
   * `apply`, or a turn hook). Nested applies — a trigger's own actions, a
   * bomb's buff:destroyed self-triggers — never re-enter this: the queue only drains at the
   * unit boundary, so triggers appended while draining run after the
   * current ones (FIFO).
   */
  /**
   * Runs the triggers queued since the last drain, now.
   *
   * `emit` only *queues* matching listeners; they run when the resolution unit
   * completes. A game that defines its own resolution unit — a turn boundary,
   * a frame — calls this to declare "that unit is over". The engine's own
   * settle cycle calls it internally.
   */
  async drainTriggers(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      await this.#stack.drain(this.#maxDepth);
    } finally {
      this.#draining = false;
    }
  }

  /**
   * The content state-based rule loop, run after the destroy phase of every
   * settle:
   *
   * - each rule fires at most once per iteration;
   * - a rule's actions apply through the normal pipeline (a nested apply
   *   that does not re-enter this loop and does not drain triggers — its
   *   events join the unit's queue);
   * - the loop repeats while any iteration actually changed the state, and
   *   stops on the first no-change iteration;
   * - a game-declared outcome action resolves at the nested apply's
   *   check — the game ends before any further rule or event.
   */
  async #runContentSBAs(): Promise<void> {
    if (this.#sbaRules.length === 0 || this.#inSBAPass) return;
    // Rules are checked for this apply from here on (the end-of-apply
    // leftover must not run them a second time).
    this.#sbaCheckedThisApply = true;
    this.#inSBAPass = true;
    const wasDraining = this.#draining;
    this.#draining = true;
    try {
      let iterations = 0;
      while (true) {
        iterations += 1;
        this.gas.spend('loop', 'state-based rules');
        if (iterations > this.#maxDepth) {
          throw new Error(
            `State-based rules exceeded max depth ${this.#maxDepth} — possible infinite SBA loop.`,
          );
        }
        const before = this.#stateVersion;
        for (const rule of this.#sbaRules) {
          if (!rule.when(this)) continue;
          const actions = await rule.then(this);
          if (actions.length === 0) continue;
          await this.apply(actions);
        }
        if (this.#stateVersion === before) return;
      }
    } finally {
      this.#draining = wasDraining;
      this.#inSBAPass = false;
    }
  }

  /**
   * Whether `owner` can use `ability` **right now**, and why not when it
   * cannot.
   *
   * This is the question a UI asks to decide whether a hotkey is lit. It
   * is deliberately a *query*, not a flag the engine maintains: the answer
   * is derived from the board every time, so an ability "enabled by a
   * trigger" needs nothing kept in sync and survives a reload or a replay.
   *
   * `reason: 'no-targets'` is **advisory**. `useAbility` does not refuse
   * it, because an ability that resolves its own groups legitimately has
   * an empty pick pool; a UI should still grey it out.
   */
  canUse(owner: Character, ability: Ability): AbilityAvailability {
    if (ability.kind !== 'manual') return { usable: false, reason: 'not-manual' };
    if (!owner.abilities.includes(ability)) return { usable: false, reason: 'not-owned' };
    const blocked = this.attemptBlocked({
      kind: 'activate',
      target: owner,
      ctx: { self: owner, source: owner, sourceCharacter: owner, ability, engine: this },
    });
    if (blocked) return { usable: false, reason: 'restricted', blockedBy: blocked };
    if (ability.available && !ability.available({ self: owner, engine: this })) {
      return { usable: false, reason: 'unavailable' };
    }
    if (ability.targeting.who !== 'self' && this.validTargets(ability.targeting, owner).length === 0) {
      return { usable: true, reason: 'no-targets' };
    }
    return { usable: true };
  }

  /**
   * The player uses a manual ability with explicit targeting info. The
   * ability's `cast` runs and its actions flow through the pipeline.
   */
  async useAbility(owner: Character, ability: Ability, targeting: Targeting): Promise<void> {
    return this.metered(`ability ${ability.name}`, () => this.#useAbility(owner, ability, targeting));
  }

  async #useAbility(owner: Character, ability: Ability, targeting: Targeting): Promise<void> {
    if (ability.kind !== 'manual') {
      throw new Error(`useAbility: "${ability.name}" is not a manual ability (kind: ${ability.kind})`);
    }
    if (!owner.abilities.includes(ability)) {
      throw new Error(`useAbility: "${owner.name}" does not have the ability "${ability.name}"`);
    }
    const availability = this.canUse(owner, ability);
    if (!availability.usable) {
      throw new Error(
        `useAbility: "${owner.name}" cannot use "${ability.name}" right now (${availability.reason}` +
          `${availability.blockedBy ? `: ${availability.blockedBy.id}` : ''})`,
      );
    }
    const pool = this.validTargets(ability.targeting, owner);
    const invalid = targeting.targets.filter((t) => !pool.includes(t));
    if (invalid.length > 0) {
      throw new Error(
        `useAbility: "${ability.name}" cannot target ` +
          invalid.map((t) => `"${t.name}"`).join(', ') +
          ' — outside its targeting pattern',
      );
    }
    // The pattern's shape, not just its pool. Picking the same character
    // twice, or picking more than the pattern asks for, are both outside
    // it — the same rules `validateAnswer` holds a chooser to (choice.ts).
    // Picking *fewer* stays legal: there may be fewer legal options than
    // the count.
    const { targets } = targeting;
    if (ability.targeting.allowDuplicates !== true && new Set(targets).size !== targets.length) {
      throw new Error(
        `useAbility: "${ability.name}" cannot target the same character more than once — outside its targeting pattern`,
      );
    }
    const max = Array.isArray(ability.targeting.count)
      ? ability.targeting.count[1]
      : (ability.targeting.count ?? 1);
    if (targets.length > max) {
      throw new Error(
        `useAbility: "${ability.name}" takes at most ${max} target(s), got ${targets.length} — outside its targeting pattern`,
      );
    }
    const actions = await ability.cast({ self: owner, engine: this }, targeting);
    await this.emit({ type: 'ability:used', character: owner, ability, targeting });
    await this.apply(actions, { source: owner });
  }

  /**
   * Applies actions; every action passes through the pipeline first.
   *
   * Consecutive `gauge` actions are applied as one **batch**: every write
   * lands first, the game-over check runs (before any events), and only
   * then are the netted events emitted. This is how a vampire's
   * drain-and-self-heal is judged on the net result instead of one change
   * at a time. A non-gauge action (buff, win, lose, …) in the middle of a
   * batch flushes the pending gauge changes first, so ordering is preserved.
   *
   * `win`/`lose` actions only record markers; the game is resolved after
   * every gauge batch and at the end of the apply, so several teams can
   * end the game in the same apply: the outcome checks run once, at the end.
   */
  async apply(actions: Action[], context: { source?: EventSource } = {}): Promise<void> {
    // The outermost apply is a scope of its own; one reached from inside a move or an
    // ability shares that scope's budget.
    return this.metered('apply', () => this.#apply(actions, context));
  }

  /**
   * Runs `fn` as one **gas scope** — a unit of work with a budget. Called inside
   * another scope it shares that budget (a trigger fired by a move is part of the
   * move); called outside one it starts a fresh budget. When the budget runs out the
   * work stops with an `OutOfGasError`, announced once as `gas:exhausted`.
   *
   * The engine's entry points (`apply`, `useAbility`, `useCardAbility`) already open
   * one; a host wraps its own units — one player's move, one phase — the same way.
   */
  async metered<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    try {
      return await this.gas.scope(label, fn);
    } catch (error) {
      if (error instanceof OutOfGasError && !error.announced) {
        error.announced = true;
        await this.emit({ type: 'gas:exhausted', label: error.label, used: error.used, limit: error.limit });
      }
      throw error;
    }
  }

  async #apply(actions: Action[], context: { source?: EventSource } = {}): Promise<void> {
    this.#depth += 1;
    if (this.#depth > this.#maxDepth) {
      this.#depth -= 1;
      throw new Error(
        `Action chain exceeded max depth ${this.#maxDepth} — possible infinite trigger loop.`,
      );
    }
    // A fresh top-level apply starts with an unchecked SBA pass; nested
    // applies (triggers, bombs) keep the outer apply's state.
    if (this.#depth === 1) this.#sbaCheckedThisApply = false;
    const outerBuffBatch = this.#buffDestroyedBatch;
    this.#buffDestroyedBatch = [];
    const outerTransformedBatch = this.#transformedBatch;
    this.#transformedBatch = [];
    try {
      let pending: Array<{ action: GaugeAction; source: EventSource | undefined }> = [];
      const flush = async (): Promise<void> => {
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        await this.#applyGaugeBatch(batch);
      };

      for (const raw of actions) {
        this.gas.spend('action', raw.type);
        const source = raw.source ?? context.source;
        let action: Action = raw;

        // Restrictions gate — "cannot be X if Y" blocks the action before
        // it ever reaches transformers ("can't beats can" stays global; a
        // blocked attempt is a no-op, not an error). `destroy` is gated
        // later, at the destroy phase; `win`/`lose` in `#execute`.
        const gateKind = this.#gateKind(action);
        if (gateKind) {
          const gateTarget = this.actionTarget(action);
          if (
            gateTarget &&
            this.attemptBlocked({
              kind: gateKind,
              target: gateTarget,
              bypasses: action.bypasses,
              ctx: this.#attemptContext(action, source, gateTarget),
            })
          ) {
            continue;
          }
        }

        // Outgoing: transformers on the source character, weight ascending.
        // Buff sources have no statuses of their own to transform through.
        if (source instanceof Character) {
          for (const status of source.statuses) {
            for (const ability of status.abilities) {
              action = this.#transform(abilityTransform(ability), action, source, this.actionTarget(action), status, 'outgoing');
            }
          }
        }

        // Incoming: transformers on the target character, weight ascending.
        const target = this.actionTarget(action);
        if (target) {
          for (const status of target.statuses) {
            for (const ability of status.abilities) {
              action = this.#transform(abilityTransform(ability), action, source, target, status, 'incoming');
            }
          }
        }

        if (action.type === 'gauge') {
          pending.push({ action, source });
        } else {
          await flush();
          await this.#execute(action, source);
        }
      }
      await flush();
      // World-derived stats settle now: a function contribution (creature
      // count, another character's gauge) whose inputs changed this settle
      // is re-derived before deaths resolve, so a gauge max driven to 0 by
      // a world change dies in the same settle.
      await this.#refreshWorldStats();
      // Destroy actions that no gauge batch flushed (an apply with only
      // non-gauge actions) are resolved now — the phase moves them to the
      // graveyard and announces them — then the outcome checks run
      // (a gauge batch would have resolved both earlier). Content rules are
      // checked here too, unless a gauge batch in this apply already ran
      // them (each batch is its own settle/pass).
      const destroyed = await this.#destroyPhase(new Map());
      // The graveyard move itself changed world-derived stats (a creature
      // left play) — re-derive so the next settle starts from settled
      // values; a death discovered here resolves at the next settle's
      // destroy phase.
      await this.#refreshWorldStats();
      await this.#enforceFormStack();
      if (!this.#sbaCheckedThisApply) await this.#runContentSBAs();
      await this.#announceDestructions(destroyed);
      this.#outcomes.run(this);
      // The form changes this apply made (pushes and pops — `transform`
      // actions, buff-tied forms landing and leaving, the form-stack SBA
      // step), summarized as one batch event — same timing as the buff
      // batch: after the individual `character:transformed` events and
      // before the drain. A game ended above skips this (outcome-first).
      if (this.#transformedBatch.length > 0) {
        await this.emit({
          type: 'character:transformed:batch',
          events: this.#transformedBatch,
        });
      }
      // The buffs this apply destroyed, summarized as one batch event —
      // announced before the drain, so observers hear the summary after the
      // individual `buff:destroyed` events and the batch's own triggers join
      // the queue behind them. A game ended above skips this (win/lose-first).
      if (this.#buffDestroyedBatch.length > 0) {
        await this.emit({
          type: 'buff:destroyed:batch',
          events: this.#buffDestroyedBatch,
        });
      }
      // The unit is complete: run the triggers its events queued. If the
      // game ended above, the throw skips this line — queued death triggers
      // never run at game end (win/lose-first).
      await this.drainTriggers();
    } finally {
      this.#buffDestroyedBatch = outerBuffBatch;
      this.#transformedBatch = outerTransformedBatch;
      this.#depth -= 1;
    }
  }

  /* ------------------------- convenience --------------------------- */

  /** Deals damage to a character's HP (or any gauge) through the pipeline. */
  async damage(target: Gauge, amount: number, source?: EventSource): Promise<void> {
    await this.apply([damageAction(target, amount, source)]);
  }

  /** Heals a gauge through the pipeline. */
  async heal(target: Gauge, amount: number, source?: EventSource): Promise<void> {
    await this.apply([healAction(target, amount, source)]);
  }

  /** Adds a buff to a character through the pipeline. */
  async addBuff(target: Character, buff: BuffDef, source?: EventSource): Promise<void> {
    await this.apply([{ type: 'addBuff', target, buff, ...(source ? { source } : {}) }]);
  }

  /** Removes a buff from a character through the pipeline. */
  async removeBuff(target: Character, buff: Buff | string, source?: EventSource): Promise<void> {
    await this.apply([{ type: 'removeBuff', target, buff, ...(source ? { source } : {}) }]);
  }

  /** Destroys a character through the pipeline (deferred to the SBA pass). */
  async destroy(
    target: Character,
    source?: EventSource,
    opts?: { readonly bypasses?: readonly string[] },
  ): Promise<void> {
    await this.apply([
      {
        type: 'destroy',
        target,
        ...(opts?.bypasses ? { bypasses: opts.bypasses } : {}),
        ...(source ? { source } : {}),
      },
    ]);
  }

  /* --------------------------- internals --------------------------- */

  /** The character that owns a gauge, if it is registered. */
  characterOf(gauge: Gauge): Character | undefined {
    for (const character of this.#chars()) {
      if (character.gauges.includes(gauge)) return character;
    }
    return undefined;
  }

  /* --------------------- derived stats & gauge maxes --------------------- */

  /**
   * The derivation contributions currently attached to a character for a
   * **named stat**, in status order (weight ascending; equal weights fall
   * back to the order the statuses were applied in). The status list is
   * already sorted the way the action pipeline runs, so the derived value
   * composes exactly like any transformer. Gauge maxes collect through
   * `#gaugeContributions` instead — a gauge-tied `stat` contribution (see
   * ability/stat.ts).
   */
  #statContributions(
    character: Character,
    name: string,
  ): Array<{ value?: (ctx: StatContext) => number; multiply: number; add: number; status: Status }> {
    const result: Array<{ value?: (ctx: StatContext) => number; multiply: number; add: number; status: Status }> = [];
    for (const status of character.statuses) {
      for (const ability of status.abilities) {
        if (ability.kind === 'stat' && ability.stat === name) {
          result.push({
            ...(ability.value ? { value: ability.value } : {}),
            multiply: ability.multiply,
            add: ability.add,
            status,
          });
        }
      }
    }
    return result;
  }

  /**
   * The derivation contributions currently attached to a character for a
   * **gauge's max** — every gauge-tied `stat` contribution naming that
   * gauge's id (`'hp'`, `'mana'`, or any gauge the character carries), in
   * status order. `maxModifier` is sugar for a gauge-tied `stat`, so its
   * contributions land here too.
   */
  #gaugeContributions(
    character: Character,
    gauge: Gauge,
  ): Array<{ value?: (ctx: StatContext) => number; multiply: number; add: number; status: Status }> {
    const result: Array<{ value?: (ctx: StatContext) => number; multiply: number; add: number; status: Status }> = [];
    for (const status of character.statuses) {
      for (const ability of status.abilities) {
        if (ability.kind === 'stat' && ability.gauge === gauge.id) {
          result.push({
            ...(ability.value ? { value: ability.value } : {}),
            multiply: ability.multiply,
            add: ability.add,
            status,
          });
        }
      }
    }
    return result;
  }

  /**
   * The derived value of a named stat: the character's **base** — the
   * constructed `speed` or a `CharacterDef.stats` base — rewritten by every
   * attached contribution in status order. A contribution with a `value`
   * function **replaces** the running value with the function's result
   * (MTG "equal to" — read-only, must return a finite number); a static
   * contribution rewrites it as `value = value * multiply + add`. A stat
   * with no base and no value-function contribution is `undefined` (it
   * does not exist); static rewrites are skipped while the running value
   * is `undefined`. Named stats are stored unclamped.
   */
  #statValue(character: Character, name: string): number | undefined {
    let running = character.statBase(name);
    for (const contribution of this.#statContributions(character, name)) {
      if (contribution.value) {
        const next = contribution.value({ self: character, engine: this, status: contribution.status });
        if (!Number.isFinite(next)) {
          throw new Error(
            `stat "${name}": the derivation of "${contribution.status.name}" returned a non-finite value (${next})`,
          );
        }
        running = next;
      } else if (running !== undefined) {
        running = running * contribution.multiply + contribution.add;
      }
    }
    return running;
  }

  /**
   * The base a gauge's derived max starts from: its **transformed base max** —
   * the construction `baseMax`, rewritten by every transform on the form stack
   * in stack order, clamped at 0.
   *
   * Every gauge goes through the same path. A transform names a gauge by id, so
   * a stamina bar or a card game's loyalty counters transform exactly as `hp`
   * does — there is no built-in gauge that gets special treatment.
   */
  #gaugeBase(character: Character, gauge: Gauge): number {
    return character.transformedBaseMax(gauge.id);
  }

  /**
   * The effective max for a gauge: its base (see `#gaugeBase`), rewritten
   * by every attached gauge-tied contribution in status order, clamped at 0
   * (a curse can't give a negative max — it just kills at 0). The clamp
   * applies to the final result only: an intermediate negative is still
   * rewritten by later multipliers, so a later "+50" cannot resurrect a max
   * that a curse already drove below 0.
   */
  #gaugeMax(character: Character, gauge: Gauge): number {
    let running = this.#gaugeBase(character, gauge);
    for (const contribution of this.#gaugeContributions(character, gauge)) {
      if (contribution.value) {
        const next = contribution.value({ self: character, engine: this, status: contribution.status });
        if (!Number.isFinite(next)) {
          throw new Error(
            `gauge "${gauge.id}": the derivation of "${contribution.status.name}" returned a non-finite value (${next})`,
          );
        }
        running = next;
      } else {
        running = running * contribution.multiply + contribution.add;
      }
    }
    return Math.max(0, running);
  }

  /**
   * The named stats a character can have: `speed`, any custom base stat,
   * and every name contributed by an attached status.
   */
  #statNames(character: Character): string[] {
    const names = new Set<string>(character.statBaseKeys());
    for (const status of character.statuses) {
      for (const ability of status.abilities) {
        if (ability.kind === 'stat' && ability.stat !== undefined) names.add(ability.stat);
      }
    }
    return [...names];
  }

  /**
   * The gauges whose maxes at least one **function** contribution derives —
   * the only gauge maxes a change to the *world* (a gauge write, a
   * destruction) can alter. Static contributions change only through
   * status or form changes, which refresh the character directly.
   */
  #functionGauges(character: Character): Gauge[] {
    const ids = new Set<string>();
    for (const status of character.statuses) {
      for (const ability of status.abilities) {
        if (ability.kind === 'stat' && ability.gauge !== undefined && ability.value) {
          ids.add(ability.gauge);
        }
      }
    }
    return character.gauges.filter((gauge) => ids.has(gauge.id));
  }

  /**
   * The named stats with at least one **function** contribution attached —
   * the only named stats a change to the *world* can alter.
   */
  #functionStatNames(character: Character): string[] {
    const names = new Set<string>();
    for (const status of character.statuses) {
      for (const ability of status.abilities) {
        if (ability.kind === 'stat' && ability.stat !== undefined && ability.value) names.add(ability.stat);
      }
    }
    return [...names];
  }

  /**
   * Re-derives one named stat and announces the change: a `stat:changed`
   * event (with the change's source when a status or form change caused it —
   * a world-driven re-derivation carries none). `from`/`to` are the
   * **effective** values: when the derivation produced nothing (the last
   * contribution left), the stat reverts to its base, and that revert is
   * what the event reports. A transition from or to `undefined` — a custom
   * stat with no base coming into or going out of existence — is not
   * announced; the grantor's own `buff:added`/`buff:destroyed` covers it.
   * Destroyed characters are skipped: their stats are moot and on-defeat
   * removals must not emit noise.
   */
  async #refreshStat(character: Character, name: string, source?: EventSource): Promise<void> {
    if (this.#inGarbage(character)) return;
    const from = character.stat(name);
    const to = this.#statValue(character, name);
    if (to === from) return;
    character.setDerivedStat(name, to);
    const effective = character.stat(name);
    if (from === undefined || effective === undefined) return;
    await this.emit(
      source
        ? { type: 'stat:changed', character, stat: name, from, to: effective, source }
        : { type: 'stat:changed', character, stat: name, from, to: effective },
    );
  }

  /**
   * Re-derives every derived value a character has — every gauge's max and
   * every named stat (`speed`, custom bases, status contributions). Called
   * after a status or form change; gauge maxes emit `gauge:maxChanged` and
   * can queue destructions, named stats emit `stat:changed` — both with the
   * change's source when there is one.
   */
  async #refreshStats(character: Character, source?: EventSource): Promise<void> {
    for (const gauge of character.gauges) {
      await this.#recomputeMax(character, gauge, source);
    }
    // The declared names *plus* anything with a lingering cached value — a
    // name whose only contribution just left is no longer declared, but its
    // cache must be refreshed away (revert to the base / undefined).
    const names = new Set([...this.#statNames(character), ...character.statCacheKeys()]);
    for (const name of names) {
      await this.#refreshStat(character, name, source);
    }
  }

  /** Re-derives one gauge's max **silently** — no events, no triggers, no max-aspect destruction (registration setup semantics). */
  #refreshGaugeSilent(character: Character, gauge: Gauge): void {
    gauge.max = this.#gaugeMax(character, gauge);
  }

  /** Re-derives one named stat **silently**. */
  #refreshStatSilent(character: Character, name: string): void {
    character.setDerivedStat(name, this.#statValue(character, name));
  }

  /**
   * Re-derives every derived value **silently** — used at registration,
   * where a skill's contributions are folded in as part of setup (no
   * events, no triggers).
   */
  #refreshStatsSilent(character: Character): void {
    for (const gauge of character.gauges) {
      this.#refreshGaugeSilent(character, gauge);
    }
    const names = new Set([...this.#statNames(character), ...character.statCacheKeys()]);
    for (const name of names) {
      this.#refreshStatSilent(character, name);
    }
  }

  /**
   * Re-derives every **function-derived** value across all registered
   * characters — the world-state half of the derivation schedule. Runs at
   * each settle (the apply tail, before and after the destroy phase) and
   * on demand through `refreshDerivedStats`; a no-op unless the state
   * changed since the last run. A gauge max that changes here emits
   * `gauge:maxChanged` and can queue a destruction; a value with no
   * function contribution is skipped — it can only change through status
   * or form changes, which refresh the character directly.
   */
  async #refreshWorldStats(): Promise<void> {
    if (this.#stateVersion === this.#lastStatRefreshVersion) return;
    this.#lastStatRefreshVersion = this.#stateVersion;
    for (const character of this.#chars()) {
      if (this.#inGarbage(character)) continue;
      for (const gauge of this.#functionGauges(character)) {
        await this.#recomputeMax(character, gauge);
      }
      for (const name of this.#functionStatNames(character)) {
        await this.#refreshStat(character, name);
      }
    }
  }

  /**
   * Re-derives every function-derived value now (see `#refreshWorldStats`) —
   * a no-op when nothing changed since the last derivation. Game loops that
   * read derived values between settles — initiative `speed`, display
   * stats — can call this first (LocalGame does, before each round).
   */
  async refreshDerivedStats(): Promise<void> {
    await this.#refreshWorldStats();
  }

  /**
   * The first rule attached to a gauge whose `aspect` matches and whose
   * condition currently holds — the **firing** rule. Priority order wins
   * ("first firing rule wins" is deterministic).
   */
  #firingGaugeRule(
    gauge: Gauge,
    character: Character,
    aspect: 'current' | 'max',
  ): GaugeSba | undefined {
    return gauge.sbas.find(
      (rule) => rule.aspect === aspect && rule.when(gauge, character, this),
    );
  }

  /**
   * Re-derives one gauge's effective max and reports the change: a
   * `gauge:maxChanged` event (with the status-change source), and — when a
   * registered **max-aspect** gauge rule fires on the re-derived max (the
   * built-in: derived max driven to 0) — a pending destruction for the
   * next destroy phase, attributed to the max write the recompute produced
   * and reported with the rule's reason. Destroyed characters are skipped:
   * their gauges are moot and on-defeat removals must not emit noise.
   */
  async #recomputeMax(character: Character, gauge: Gauge, source?: EventSource): Promise<void> {
    if (this.#inGarbage(character)) return;
    const from = gauge.max;
    const to = this.#gaugeMax(character, gauge);
    if (to === from) return;
    gauge.max = to;
    this.#stateVersion += 1;
    await this.emit(
      source
        ? { type: 'gauge:maxChanged', gauge, from, to, source }
        : { type: 'gauge:maxChanged', gauge, from, to },
    );
    const rule = this.#firingGaugeRule(gauge, character, 'max');
    if (rule) {
      this.#pendingMaxZero.push({
        target: character,
        rule,
        maxChanges: [
          source
            ? { type: 'gauge:maxChanged', gauge, target: character, from, to, source }
            : { type: 'gauge:maxChanged', gauge, target: character, from, to },
        ],
        ...(source ? { source } : {}),
      });
    }
  }

  /**
   * Destroyed characters, across every garbage pile.
   *
   * A game with per-player piles usually wants one player's — use
   * `garbageOf(player)` for that. This is the whole table, for the many
   * questions that are about death rather than ownership ("has anything
   * died yet", a defeat check).
   */
  get garbage(): Character[] {
    return this.#zones.instancesOf(GARBAGE.id).flatMap((zone) => zone.of<Character>('character'));
  }

  /** One player's garbage pile, in the order things landed there. */
  garbageOf(player: Player): Character[] {
    return this.#zones.zone(GARBAGE.id, player)?.of<Character>('character') ?? [];
  }

  /** True when a character is registered and not destroyed. */
  isInPlay(character: Character): boolean {
    // "In play" is a zone **family** question, not "registered and not
    // dead": an entity bounced to a hand is registered and alive but not in
    // play. Defeat still counts the graveyard (`deadForDefeat`), so leaving
    // play is neutral for win/lose — a hero card in hand has not lost.
    return this.#zones.zoneOf(character)?.group === IN_PLAY;
  }

  /**
   * The unified restrictions gate (docs/design/11-restrictions.md) — one
   * entry point every gate consults: targeting (`validTargets`), destroy
   * (`canDestroy`), the action pipeline (`apply`, before transformers), and
   * win/lose (`resolveGameEnd`'s predicates, `#execute`).
   *
   * Returns the first restriction blocking the attempt, or `undefined` when
   * nothing blocks it. "Can't beats can": a matching restriction blocks the
   * attempt, period — unless the attempt **names the rule it beats**
   * (`attempt.bypasses` carries restriction ids like `"indestructible:0"`).
   *
   * The returned restriction is also the "why can't I do that" answer for a
   * UI layer: the check itself never throws, and blocked attempts are
   * silent no-ops (targeting at `useAbility` is the one gate that keeps
   * explaining itself by throwing).
   */
  attemptBlocked(attempt: BlockedAttempt): RestrictionInstance | undefined {
    return firstBlockingRestriction(attempt.target, attempt.kind, attempt.ctx, attempt.bypasses);
  }

  /**
   * The "cannot be destroyed" gate — the hook the destroy phase consults
   * before destroying a character, and the win/lose "dead" predicate uses
   * to keep an indestructible character's owner in the game.
   *
   * `on: 'destroy'` restrictions block the destruction (the HP→destroy rule
   * is gated too, consulted with no source — state-based death is not
   * attributed to an actor). `bypasses` carries the restriction ids a
   * `destroy` action explicitly pierces ("destroy it anyway").
   */
  canDestroy(target: Character, source?: EventSource, bypasses?: readonly string[]): boolean {
    return (
      this.attemptBlocked({
        kind: 'destroy',
        target,
        bypasses,
        ctx: { self: target, source, sourceCharacter: casterOf(source), engine: this },
      }) === undefined
    );
  }

  /** The character an action is aimed at (for pipeline target). */
  /**
   * The character an action acts on, or undefined when it has none — what the
   * restriction gates and the incoming transformer pass run against.
   *
   * Resolved through the action registry, so a game's action participates in
   * the pipeline on the same terms as a built-in by declaring a `subject`.
   * An action that declares none is treated as having no character subject:
   * passives cannot modify it and restrictions cannot block it, which is the
   * right answer for a board-wide or game-ending action and the wrong one for
   * an action aimed at a character.
   */
  actionTarget(action: Action): Character | undefined {
    return this.#actions.subjectOf(action);
  }

  /**
   * The restriction kind that gates an action in the pipeline (before
   * transformers) — `undefined` for actions gated elsewhere: `destroy` is
   * gated at the destroy phase, `win`/`lose` in `#execute`.
   */
  #gateKind(action: Action): RestrictionKind | undefined {
    switch (action.type) {
      case 'gauge':
        // Current-value writes are "gauge changes". Maximum changes are
        // never actions — they come from statuses (maxModifier), which are
        // gated as buffs on add/remove.
        return 'gauge';
      case 'addBuff':
      case 'removeBuff':
        return 'buff';
      case 'transform':
      case 'popTransform':
        // "Cannot be transformed" gates the form swap before it reaches
        // transformers — a locked form is untouched, period. The pop is the
        // same gate: a locked form cannot be undone either.
        return 'transform';
      case 'move':
        // "Cannot be discarded", "cannot leave play". Gated before
        // transformers, so a blocked move is a no-op rather than a
        // redirected one.
        return 'move';
      case 'destroy':
        return undefined;
      default:
        // An action a game declared: the engine cannot know what restriction
        // kind it maps to, so it is ungated. A game gates its own actions by
        // registering them with a `subject` and a matching restriction kind.
        return undefined;
    }
  }

  /**
   * The attempt context for an action flowing through the pipeline gate.
   * Gauge actions carry their gauge and intent; raw gauge actions without
   * an intent count as `'other'`.
   */
  #attemptContext(action: Action, source: EventSource | undefined, target: Character): AttemptContext {
    const base: AttemptContext = { self: target, source, sourceCharacter: casterOf(source), engine: this };
    switch (action.type) {
      case 'gauge':
        return { ...base, gauge: action.target, intent: action.intent ?? 'other' };
      default:
        return base;
    }
  }

  /**
   * True when a gauge rule currently fires on one of the character's gauges
   * and its `then` destroys that character — "the destroy phase would take
   * it". Consults the same rules as the destroy phase, so win/lose and
   * destruction never disagree about what death means.
   */
  wouldBeDestroyed(character: Character): boolean {
    for (const gauge of character.gauges) {
      for (const aspect of ['current', 'max'] as const) {
        const rule = this.#firingGaugeRule(gauge, character, aspect);
        if (rule && this.#ruleDestroys(rule, character)) return true;
      }
    }
    return false;
  }

  /**
   * Whether a gauge is one the state-based pass **watches** — it carries
   * `GaugeSba` rules, so its value can end the character (`hp` does by
   * default; a bare resource gauge like `mana` does not).
   *
   * This decides which writes are reported in `character:destroyed.changes`
   * and can produce `character:survived`. It replaces the old hardcoded
   * `gauge === character.hp` test, so a stamina-death game gets the same
   * forensics `hp` always had. The authoritative lethal test is
   * `#wouldBeDestroyed`, which actually runs each rule's `then`; this is the
   * cheap structural test for "a gauge whose state means something".
   */
  #isWatchedGauge(gauge: Gauge): boolean {
    return gauge.sbas.length > 0;
  }

  /** True when the rule's actions include a `destroy` of the character. */
  #ruleDestroys(rule: GaugeSba, character: Character): boolean {
    return rule
      .then(character, this)
      .some((action) => action.type === 'destroy' && action.target === character);
  }

  /**
   * The attempt context of a **state-based** attempt — one the engine makes on
   * its own behalf rather than at a character's bidding, so there is no actor:
   * an outcome check asking "does this character count as dead?".
   *
   * A game composing its own restriction kinds (see `src/games/round-based/`)
   * builds the same context to ask the same question, so this is public.
   */
  stateAttempt(character: Character): AttemptContext {
    return { self: character, source: undefined, sourceCharacter: undefined, engine: this };
  }

  /**
   * Runs one transformer on an action, stamping the action with the pipeline
   * phase it is flowing through (`'outgoing'` or `'incoming'`) so the
   * transformer can tell the two apart — see `ActionTransformer`.
   */
  #transform(
    transformer: ActionTransformer | undefined,
    action: Action,
    source: EventSource | undefined,
    target: Character | undefined,
    status: Status | undefined,
    direction: ActionDirection,
  ): Action {
    if (!transformer) return action;
    const stamped = action.direction === direction ? action : { ...action, direction };
    return transformer(stamped, { source, target, status, engine: this });
  }

  /**
   * Applies a single (fully transformed) non-gauge action to the world.
   *
   * Dispatch is a **registry lookup**, not a `switch`. `ActionMap`
   * (contracts.ts) is open, so a closed switch over it would silently do
   * nothing for an action a game declared — the fall-through of a `switch`
   * with no `default` in a `void` method is invisible. A missing handler is
   * instead a loud error naming the tag.
   *
   * Gauge changes never reach this method — they are batched and settled by
   * `#applyGaugeBatch`, so the game-over check runs once per batch *before*
   * any events are emitted. That batching is an engine invariant rather than
   * a handler a game may replace, so it is checked here rather than
   * registered.
   */
  async #execute(action: Action, source: EventSource | undefined): Promise<void> {
    if (action.type === 'gauge') {
      throw new Error(`Internal error: gauge actions must be batched, not executed alone`);
    }
    const handler = this.#actions.get(action.type);
    if (!handler) {
      throw new Error(
        `No handler registered for action "${action.type}". Declare it in ActionMap ` +
          `(contracts.ts), then register one with ` +
          `engine.actions.register("${action.type}", …).`,
      );
    }
    await handler(action, { engine: this, source });
  }

  /**
   * The engine's own actions, registered exactly the way a game registers
   * its own — they are shipped content, not a privileged category. Nothing in
   * the dispatch path distinguishes `move` from a game's `summon`.
   *
   * Called once from the constructor. `gauge` is absent on purpose: it never
   * reaches `#execute` (see there).
   */
  #registerBuiltinActions(): void {
    this.#actions
      // `gauge` has no handler — it is batched and settled, never dispatched
      // (see `#execute`) — but it is the one action whose subject the pipeline
      // absolutely needs: without it, "cannot be damaged" would stop blocking
      // and damage-modifying passives would stop firing.
      .subject('gauge', (action) => this.characterOf(action.target))
      .register('move', (action) => {
        // The transition is collected, not announced here: a settle's moves
        // announce together as one `zone:changed:batch` (see
        // `#announceZoneMoves`, flushed with the destructions), the way
        // gauge writes and deaths already batch.
        this.#moveZone(action.target, action.to, action.position);
        this.#stateVersion += 1;
      }, {
        // Only a character has statuses to gate or transform through; a
        // non-character entity's move has no subject.
        subject: (action) =>
          action.target.type === 'character' ? (action.target as Character) : undefined,
      })
      .register('addBuff', async (action, ctx) => {
        const source = ctx.source;
        const target = action.target;
        // A mark applied by a buff's own ability (an aura granting its
        // status) remembers the granting status — so when the aura is
        // removed, its permanent marks can be destroyed with it. Sources
        // that are characters (skills, manual casts) grant no link.
        const grantedBy = source instanceof Buff ? source : undefined;
        const instance = new Buff(action.buff, { caster: casterOf(source), target, grantedBy });
        // Cycle detection: a status may never grant a status that is one
        // of its own ancestors (a child creating its parent — including
        // itself). The grant is refused, the grantor is removed — so a
        // bomb-style grantor blows up in-game via its buff:destroyed self-trigger — and a
        // `cycle:detected` event is emitted. The recursion dies here
        // instead of at the action-depth guard.
        if (grantedBy && this.#createsCycle(grantedBy, instance.id)) {
          await this.emit({ type: 'cycle:detected', grantor: grantedBy, attemptedId: instance.id });
          const wearer = grantedBy.target;
          if (wearer && wearer.removeStatus(grantedBy)) {
            await this.#finalizeBuffRemoval(wearer, grantedBy);
          }
          return;
        }
        if (!target.addBuff(instance)) return; // duplicate non-stackable buff
        this.#stack.attachStatus(instance, target);
        this.#stateVersion += 1;
        await this.emit(
          source
            ? { type: 'buff:added', character: target, buff: instance, source }
            : { type: 'buff:added', character: target, buff: instance },
        );
        // A `transformModifier` ability ties the buff to a form: while the
        // buff is attached, its form pins the wearer (pushed keyed by the
        // buff instance — a live tie). The tie's push announces
        // `character:transformed` and re-derives the maxes itself.
        const tieAbility = instance.abilities.find((a) => a.kind === 'transformModifier');
        if (tieAbility && tieAbility.kind === 'transformModifier') {
          await this.#pushForm(target, tieAbility.form, instance, true);
        }
        // The buff may carry a stat contribution (`stat`, `maxModifier`) —
        // re-derive the wearer's stats now (a derived gauge max change
        // emits `gauge:maxChanged`; a max driven to 0 queues the character
        // for the destroy phase).
        await this.#refreshStats(target, source);
      }, { subject: (action) => action.target })
      .register('removeBuff', async (action, ctx) => {
        const target = action.target;
        const found = target.removeBuff(action.buff);
        if (!found) return;
        this.#stateVersion += 1;
        await this.#finalizeBuffRemoval(target, found, ctx.source);
      }, { subject: (action) => action.target })
      .register('destroy', (action, ctx) => {
        // Deferred to the SBA pass so all pending destructions (HP ≤ 0
        // deaths from the batch, other destroy actions) land together. The
        // destroy gate (`canDestroy`) is consulted there — the action's
        // `bypasses` ride along so a named exception can pierce it.
        this.#pendingDestroy.push({
          target: action.target,
          source: ctx.source,
          bypasses: action.bypasses,
        });
      }, { subject: (action) => action.target })
      .register('transform', async (action, ctx) => {
        // Swap the target's form: skills (the arriving set's instances — a
        // set worn before comes back with its `vars` intact), gauge maxes
        // (derived — current clamps down), name and icon. The identity — the
        // Character object — never changes, and buffs persist. The entry is
        // keyed by the source: a buff's own ability (a werewolf curse that
        // transforms its wearer) is a **tie** — it pops, reverting the form,
        // when that buff is removed, and it pins the form above later
        // pushes while the buff is active. A character source (or none) is a
        // permanent transform.
        const source = ctx.source;
        const tied = source instanceof Buff && this.#isAttached(source);
        await this.#pushForm(action.target, action.form, source, tied);
      }, { subject: (action) => action.target })
      .register('popTransform', async (action, ctx) => {
        // Pop the character's *current effective* transformation, returning
        // them to the previous state. A **live tie pins the form** — the
        // pop is refused while the hex holds (the state-based rule: the
        // buff's liveness determines the form, so the buff's transformation
        // is re-asserted and the buff itself is only removed by a removal
        // action). Otherwise the top entry pops.
        const target = action.target;
        if (target.transforms.some((e) => e.tied)) return;
        const pop = target.popTopTransform();
        if (pop) await this.#finishFormPop(target, pop, ctx.source);
      }, { subject: (action) => action.target })
      .register('discover', (action) => this.#discover(action))
      .register('roll', (action) => this.#roll(action))
  }

  /**
   * **Reveal until a card is worth taking** — the body of the `discover`
   * action.
   *
   * The mechanic is five sub-behaviours and every one of them is where a naive
   * implementation goes wrong, so each is worth naming:
   *
   * 1. **Peek, do not take.** `reveal` reads the top without moving it, so a
   *    card that gets declined was never announced as leaving and re-entering
   *    the deck — no trigger fires for a look.
   * 2. **Stop at the first match, not the best.** Magic's Discover offers the
   *    *first* card within the cost, and the loop must not keep revealing once
   *    it has one: the rest of the deck is left alone.
   * 3. **Ask, do not take.** The card is *offered*; a take moves it, a decline
   *    bottoms it and the loop continues. That is `ask`, so a scripted player,
   *    a remote client and the auto-chooser all work without a second path.
   * 4. **Bottom, then shuffle.** The revealed-but-untaken cards are put on the
   *    bottom **oldest first** (so their relative order is what it was) and the
   *    zone is shuffled once at the end. Shuffling per card would be fine and
   *    wasteful; moving them in reverse would silently reverse a deck.
   * 5. **Nothing found is normal.** Reaching `count` without a match bottoms
   *    the reveals and stops. It is not an error and not an infinite loop.
   */
  async #discover(action: DiscoverAction): Promise<void> {
    // Whose zones these are, and therefore **who is asked**. An explicit owner
    // wins — content may discover on another player's library — and otherwise
    // it is whoever is responsible for the action.
    const owner = action.owner ?? casterOf(action.source)?.controller;
    const reason = action.reason ?? 'discover';
    // `maxCost` is read through the entity's own `attributes`, so the engine
    // never learns what a cost is — only that a game declared one.
    // A **number** fact, because a cost is compared with `<=`: a boolean fact
    // (a land flag) is a different question, and coercing it to 1 would make
    // "is this a land" indistinguishable from "is its cost 1". A card with no
    // cost at all reads 0, which matches.
    const costOf = (entity: Entity): number => {
      const value = entity.attributes?.get('cost');
      return typeof value === 'number' ? value : 0;
    };
    const affordable = (entity: Entity): boolean => costOf(entity) <= action.maxCost;
    // A skipped card is revealed and put aside, never offered — "or a land".
    // The facts were compiled from the effect's own predicate, so the engine
    // compares a map against declared attributes and learns nothing. A
    // boolean fact must be declared as one, or it will not match here.
    const passes = (entity: Entity): boolean => {
      if (!action.skip) return false;
      for (const [fact, value] of action.skip) {
        if ((entity.attributes?.get(fact) ?? 0) !== value) return false;
      }
      return true;
    };

    const library = owner ? this.#zones.zone(action.from, owner) : this.#zones.unownedZone(action.from);
    if (!library?.ordered) return;

    // **Reveal into the holding zone, one at a time.** Moving each card rather
    // than peeking is what makes the reveal observable: a `zone:changed` fires,
    // so "when a card is revealed" is a question the game can ask. It also means
    // the loop always looks at the *current* top, so it cannot re-examine a card
    // it already put aside.
    for (let looked = 0; looked < action.count; looked += 1) {
      const top = library.members[0];
      if (!top) break;
      await this.moveTo(top, action.revealed, {
        ...(owner ? { owner } : {}),
        ...(action.source ? { source: action.source } : {}),
        reason,
      });
      if (!affordable(top) || passes(top)) continue;

      const answer = await this.ask({
        kind: 'confirm',
        prompt: `Put ${top.name} into play?`,
        chooser: owner,
      });
      if (answer.kind === 'confirm' && answer.yes) {
        await this.moveTo(top, action.to, {
          ...(owner ? { owner } : {}),
          ...(action.source ? { source: action.source } : {}),
          reason,
        });
        break;
      }
    }

    // Whatever is still waiting in the holding zone is "the rest". Reading it
    // from the zone rather than from a list is the point of having one: a card
    // moved out mid-reveal (taken, or destroyed by a trigger) is not in it, so
    // it cannot be bottomed by accident. Oldest first, then one shuffle.
    const held = owner
      ? (this.#zones.zone(action.revealed, owner)?.members ?? [])
      : (this.#zones.unownedZone(action.revealed)?.members ?? []);
    for (const entity of [...held]) {
      await this.moveTo(entity, action.rest, {
        ...(owner ? { owner } : {}),
        position: 'bottom',
        reason,
      });
    }
    this.shuffleZone(action.rest, owner);
  }

  /**
   * The shared tail of every buff leaving a character (dispelled, its
   * wearer destroyed, or the cascade): the status is already off the
   * character — now announce its `buff:destroyed` (while the buff's own
   * trigger listeners are still attached, so a buff that dies with its
   * wearer still hears the event — the same-batch principle), disarm its
   * triggers, and take any permanent marks it granted down with it.
   */
  async #finalizeBuffRemoval(
    character: Character,
    buff: Buff,
    source?: EventSource,
    reason: BuffDestroyReason = 'removed',
  ): Promise<void> {
    // A transform this buff keyed pops with it — the form reverts *before*
    // the removal is announced, so the buff's own buff:destroyed
    // self-triggers (collected now, run at the drain) and every observer
    // see the character back in its original form. The transform can sit on
    // any character (a mage's polymorph buff transforms an enemy), so every
    // character the engine knows — plus the removal target itself — is
    // scanned.
    const scan = new Set<Character>([character, ...this.#chars()]);
    for (const c of scan) {
      const pop = c.popTransform(buff);
      if (!pop) continue;
      await this.#finishFormPop(c, pop, source);
    }
    // Emit before detaching: the buff's own `buff:destroyed` triggers are
    // collected while it is still attached — "when this buff dies" is just
    // a self-listening trigger. Execution is deferred by the trigger queue.
    const event: BuffDestroyedEvent = source
      ? { type: 'buff:destroyed', character, buff, reason, source }
      : { type: 'buff:destroyed', character, buff, reason };
    await this.emit(event);
    // Remember it for the apply's `buff:destroyed:batch` summary.
    this.#buffDestroyedBatch.push(event);
    this.#stack.detachStatus(buff);
    // Permanent marks granted by this status die with it — the aura is
    // gone, so the blessings it left behind are gone too.
    await this.#destroyGrantedMarks(buff);
    // The status is gone — re-derive the wearer's stats (a removed
    // contribution reverts automatically; a derived gauge max change emits
    // `gauge:maxChanged`). Skipped for destroyed characters: their gauges
    // are moot and on-defeat removals must not emit noise.
    await this.#refreshStats(character, source);
  }

  /* ------------------------- form-stack helpers ------------------------ */

  /**
   * Whether a buff is currently attached to any character the engine knows
   * (or to the character it was stamped onto when the engine created it).
   * Used to classify a buff-keyed transform as a **live tie** (the "hex
   * holds" rule) and to detect dangling ties for the form-stack SBA step.
   */
  #isAttached(buff: Buff): boolean {
    return (
      this.#chars().some((c) => c.statuses.includes(buff)) ||
      (buff.target !== undefined && buff.target.statuses.includes(buff))
    );
  }

  /**
   * The shared tail of a form **push** (the `transform` action, and a
   * `transformModifier` tie landing with its buff): record the entry,
   * re-wire the skill swap's trigger listeners, and announce the change —
   * only when the effective form actually changed. A push suppressed by a
   * live tie changes nothing observable (the tie's form still pins the
   * character), so it is silent beyond the stack itself; the max
   * re-derivation (`gauge:maxChanged`) is change-aware too.
   */
  async #pushForm(
    target: Character,
    form: TransformForm,
    source: EventSource | undefined,
    tied: boolean,
  ): Promise<void> {
    const change = target.pushTransform(form, source, tied);
    for (const skill of change.swap.removed) this.#stack.detachStatus(skill);
    for (const skill of change.swap.added) this.#stack.attachStatus(skill, target);
    this.#stateVersion += 1;
    if (change.changed) {
      const event: CharacterTransformedEvent = source
        ? { type: 'character:transformed', character: target, form, reason: 'pushed', source }
        : { type: 'character:transformed', character: target, form, reason: 'pushed' };
      this.#transformedBatch.push(event); // the apply's `character:transformed:batch`
      await this.emit(event);
      // The form may change gauge maxes — re-derive the stats (a max
      // driven to 0 queues the character for the destroy phase).
      await this.#refreshStats(target, source);
    }
  }

  /**
   * The shared tail of a form **pop** (a keying buff's removal, the direct
   * `popTransform` action, and the form-stack SBA step): re-wire the skill
   * swap's trigger listeners and announce the revert — only when the
   * effective form actually changed (popping a tie whose form another tie
   * still pins changes nothing observable).
   */
  async #finishFormPop(target: Character, pop: TransformPop, source?: EventSource): Promise<void> {
    for (const skill of pop.swap.removed) this.#stack.detachStatus(skill);
    for (const skill of pop.swap.added) this.#stack.attachStatus(skill, target);
    this.#stateVersion += 1;
    if (pop.changed) {
      const event: CharacterTransformedEvent = source
        ? { type: 'character:transformed', character: target, form: pop.form, reason: 'popped', source }
        : { type: 'character:transformed', character: target, form: pop.form, reason: 'popped' };
      this.#transformedBatch.push(event); // the apply's `character:transformed:batch`
      await this.emit(event);
      // The form may have changed gauge maxes — re-derive the stats (this
      // can be a different character than the one a buff was removed from).
      await this.#refreshStats(target, source);
    }
  }

  /**
   * When a character is **destroyed**, every buff attached to it with
   * `removedOnDefeat` (the default) **dies with it** — the same batch as
   * the wearer's own destruction, announced as `buff:destroyed` with
   * `reason: 'wearer-destroyed'`. A bomb goes off when its wearer dies.
   * Strictly wearer-scoped: the destroyed character's own buffs die; buffs
   * they *created* on other characters are untouched (a fallen caster's
   * buffs stick around on their targets). The death goes through the
   * ordinary path, so the buff's buff:destroyed self-triggers fire and any marks it
   * granted are destroyed by the cascade too.
   */
  async #removeOnDefeatBuffs(character: Character): Promise<void> {
    for (const status of [...character.statuses]) {
      if (!(status instanceof Buff) || !status.removedOnDefeat) continue;
      character.removeStatus(status);
      await this.#finalizeBuffRemoval(character, status, undefined, 'wearer-destroyed');
    }
  }

  /**
   * The removal cascade: when a status is removed, every **permanent**
   * (`removable: false`) status it granted is destroyed with it — an aura
   * being dispelled takes its marks along. This is the one path that can
   * remove an unremovable mark, and the only way such marks ever leave.
   *
   * The cascade follows `grantedBy` chains (a mark that itself granted
   * further marks takes those down too) and skips removable buffs — they
   * have ordinary dispel rules and are unaffected by their grantor's fate.
   */
  async #destroyGrantedMarks(grantor: Status): Promise<void> {
    const pending = [grantor];
    const destroyed = new Set<Status>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const character of this.#chars()) {
        for (const status of [...character.statuses]) {
          if (!(status instanceof Buff) || status.removable || destroyed.has(status)) continue;
          if (status.grantedBy !== current) continue;
          destroyed.add(status);
          character.removeStatus(status);
          // Full removal path: detach, event (reason 'removed', the grantor
          // as source — the aura's cascade took the mark), the mark's own
          // buff:destroyed self-triggers if any, and its own cascade.
          await this.#finalizeBuffRemoval(character, status, current instanceof Buff ? current : undefined, 'removed');
          pending.push(status); // its own marks cascade too
        }
      }
    }
  }

  /**
   * Would granting a status with `id` from `grantor` create a cycle?
   *
   * Every status granted by another status remembers its grantor
   * (`grantedBy`), so the grantor chains form a forest: a grant is a
   * **cycle** when the new status's id already appears anywhere in the
   * grantor's own ancestry — the child would be creating its parent
   * (or itself). Instance chains are acyclic by construction (an instance
   * is created with a grantor that already exists), so the walk always
   * terminates.
   */
  #createsCycle(grantor: Status, id: string): boolean {
    let current: Status | undefined = grantor;
    while (current) {
      if (current.id === id) return true;
      current = current.grantedBy;
    }
    return false;
  }

  /* ------------------------ state-based actions ----------------------- */

  /**
   * The form-stack SBA step — the state-based half of "the hex holds".
   *
   * The **pinning** itself is automatic: a live tie (a buff-keyed transform
   * whose keying buff is attached) dominates the form fold, so a transform
   * pushed while a hex is active is recorded but never becomes the
   * character's form — "we attempt to push, the pass sees the hex's buff is
   * active, so the buff's transformation is used". This step keeps the tie
   * set **honest**, the way the destroy phase keeps the graveyard honest:
   * every entry marked `tied` whose keying buff is no longer attached is a
   * **dangling tie** — the buff left by a bypass path (content calling
   * `character.removeStatus` directly), so its transformation is removed.
   *
   * Runs at each settle with the other built-in SBAs (after the destroy
   * phase — buffs that died with their wearers already popped their ties —
   * and before content rules, which then see the settled form).
   */
  async #enforceFormStack(): Promise<void> {
    for (const character of this.#chars()) {
      for (const entry of [...character.transforms]) {
        if (!entry.tied) continue;
        const buff = entry.source;
        if (!(buff instanceof Buff) || this.#isAttached(buff)) continue;
        const pop = character.popTransform(buff);
        if (pop) await this.#finishFormPop(character, pop);
      }
    }
  }

  /**
   * Settles the **buff gates** on the batch's gauges — the conditional
   * buffs (see `GaugeBuffGate`): for each written gauge, every gate whose
   * condition holds and whose buff is missing applies the buff, and every
   * gate whose condition no longer holds removes it. Both go through the
   * normal pipeline (restrictions, events, triggers), so a gate's buff can
   * carry any abilities — stat changes, action modifiers, restrictions.
   * Applying an already-attached / removing an absent buff is a no-op, so
   * the transitions terminate; gates whose condition is untouched by the
   * write are not re-evaluated.
   *
   * Runs with the other built-in SBAs (after the destroy phase, so
   * destroyed characters are skipped; before content rules, which then see
   * the gate-settled state).
   */
  async #settleBuffGates(pre: Map<Gauge, GaugeBatchEntry>): Promise<void> {
    for (const [gauge, p] of pre) {
      if (!p.owner || this.#inGarbage(p.owner)) continue;
      if (gauge.buffGates.length === 0) continue;
      for (const gate of gauge.buffGates) {
        const buffId = gate.buff.id ?? slugify(gate.buff.name);
        const holds = gate.when(gauge, p.owner, this);
        const attached = p.owner.hasStatus(buffId);
        if (holds && !attached) {
          await this.apply([addBuffAction(p.owner, gate.buff)]);
        } else if (!holds && attached) {
          await this.apply([removeBuffAction(p.owner, buffId)]);
        }
      }
    }
  }

  /**
   * The destroy phase of the SBA pass — every pending destruction lands
   * **simultaneously**:
   *
   * 1. collect the pending destroys — characters whose gauge a registered
   *    **current-aspect** rule fires on (the built-in: HP crossed `min`
   *    this batch), plus queued `destroy` actions and the pending max-aspect
   *    fires;
   * 2. **collect the death's triggers before the cleanup** — a buff that dies with its wearer
   *    dies with its wearer (`removedOnDefeat`) still hears the death, the
   *    way the characters themselves die together (execution is deferred by
   *    the trigger queue, so the triggers still see the settled world);
   * 3. the wearer is marked destroyed and its on-defeat buffs **die with
   *    it** — the same batch, so a `buff:destroyed` listener can tell a buff
   *    that died from one that was removed by checking whether the old
   *    wearer is still in play (a buff's self-trigger bomb no longer fires nested
   *    applies here — a character already destroyed by one is skipped);
   * 4. re-run the game-end check **before any events** — a `destroy` action
   *    can end the game, and win/lose-first means no destroyed events and no
   *    death triggers at game end.
   *
   * Returns the characters this phase actually destroyed, so the caller can
   * notify the observers (their `character:destroyed` triggers were already
   * queued here).
   */
  async #destroyPhase(pre: Map<Gauge, GaugeBatchEntry>): Promise<DestroyedCharacter[]> {
    const dying: DestroyedCharacter[] = [];
    const deferred: Action[] = [];
    for (const [gauge, p] of pre) {
      if (!p.owner || this.#inGarbage(p.owner)) continue;
      // A current-aspect rule on this gauge fires — the built-in "current
      // reached min" death, or any content condition ("current === 4").
      // The gauge carries its own rules, so the phase needs no gauge-kind
      // knowledge (a future stamina gauge participates the same way).
      // Attributed to the gauge's writes.
      const rule = this.#firingGaugeRule(gauge, p.owner, 'current');
      if (!rule || !this.canDestroy(p.owner)) continue;
      const actions = rule.then(p.owner, this);
      // A destroy of the character is consumed by this phase (simultaneous
      // with every other death); anything else defers to a nested apply
      // after the graveyard moves.
      const destroys = actions.filter(
        (action): action is Extract<Action, { type: 'destroy' }> =>
          action.type === 'destroy' && action.target === p.owner,
      );
      if (destroys.length === 0) continue;
      deferred.push(...actions.filter((action) => action.type !== 'destroy' || action.target !== p.owner));
      dying.push({
        kind: 'gauge',
        rule,
        character: p.owner,
        changes: p.writes,
        source: p.source,
      });
    }
    for (const pending of this.#pendingDestroy) {
      if (
        !this.#inGarbage(pending.target) &&
        this.canDestroy(pending.target, pending.source, pending.bypasses) &&
        !dying.some((d) => d.character === pending.target)
      ) {
        dying.push({ kind: 'direct-action', character: pending.target, source: pending.source });
      }
    }
    // A max-aspect rule fired on a status-driven re-derivation (the built-in:
    // derived max driven to 0) — resolved together with every other pending
    // destruction, attributed to the max write the recompute produced.
    for (const zero of this.#pendingMaxZero) {
      if (
        !this.#inGarbage(zero.target) &&
        this.canDestroy(zero.target, zero.source) &&
        !dying.some((d) => d.character === zero.target)
      ) {
        dying.push({
          kind: 'max-zero',
          rule: zero.rule,
          character: zero.target,
          maxChanges: zero.maxChanges,
          source: zero.source,
        });
      }
    }
    this.#pendingDestroy = [];
    this.#pendingMaxZero = [];
    if (dying.length === 0) return [];

    // Same-batch principle: a buff that dies with its wearer dies with its wearer still hears the
    // death. The destroyed events' triggers are collected NOW, while the
    // dying characters' buffs are still attached — the trigger queue defers
    // execution, so the triggers still see the settled world; the observers
    // are told in `#announceDestructions` after the cleanup.
    const batchEvents: CharacterDestroyedEvent[] = [];
    for (const d of dying) {
      if (this.#inGarbage(d.character)) continue;
      batchEvents.push(this.#buildDestroyedEvent(d));
    }
    if (batchEvents.length > 0) {
      this.#stack.enqueue({
        type: 'character:destroyed:batch',
        events: batchEvents,
      });
    }

    const destroyed: DestroyedCharacter[] = [];
    for (const d of dying) {
      if (this.#inGarbage(d.character)) continue; // already destroyed by a nested apply
      // The wearer's own on-defeat buffs are still attached here — its
      // self-death triggers are collected before the buffs die.
      this.#stack.enqueue(this.#buildDestroyedEvent(d));
      // The wearer is marked destroyed FIRST — its buffs then die in the
      // same batch, and a `buff:destroyed` listener can tell "died with its
      // wearer" from "removed" by checking whether the old wearer is still
      // in play (`engine.isInPlay(event.character)`).
      this.#moveZone(d.character, this.#garbageFor(d.character));
      d.character.destroyed = true;
      destroyed.push(d);
      this.#stateVersion += 1;
      await this.#removeOnDefeatBuffs(d.character);
    }
    // A rule's non-destroy actions run after the graveyard moves (they see
    // the settled wipe); their own destroys resolve at the end of the apply.
    for (const action of deferred) {
      await this.apply([action]);
    }
    if (destroyed.length > 0) {
      // Win/lose-first: a destroy can end the game — checked before any
      // events, so the queued death triggers never run at game end.
      this.#outcomes.run(this);
    }
    return destroyed;
  }

  /** Builds the `character:destroyed` event for a pending destruction. */
  #buildDestroyedEvent(d: DestroyedCharacter): CharacterDestroyedEvent {
    switch (d.kind) {
      case 'gauge':
        return d.source
          ? {
              type: 'character:destroyed',
              character: d.character,
              reason: d.rule.reason,
              changes: d.changes,
              source: d.source,
            }
          : {
              type: 'character:destroyed',
              character: d.character,
              reason: d.rule.reason,
              changes: d.changes,
            };
      case 'max-zero':
        return d.source
          ? {
              type: 'character:destroyed',
              character: d.character,
              reason: d.rule.reason,
              changes: [],
              maxChanges: d.maxChanges,
              source: d.source,
            }
          : {
              type: 'character:destroyed',
              character: d.character,
              reason: d.rule.reason,
              changes: [],
              maxChanges: d.maxChanges,
            };
      case 'direct-action':
        return d.source
          ? {
              type: 'character:destroyed',
              character: d.character,
              reason: 'direct-action',
              changes: [],
              source: d.source,
            }
          : {
              type: 'character:destroyed',
              character: d.character,
              reason: 'direct-action',
              changes: [],
            };
    }
  }

  /**
   * Tells the observers about the destructions — one `character:destroyed`
   * event per destroyed character, then the `character:destroyed:batch`.
   * The triggers were already collected (queued) by `#destroyPhase` before
   * the buff cleanup, so this only notifies the `onEvent` observers.
   */
  async #announceDestructions(destroyed: DestroyedCharacter[]): Promise<void> {
    // The graveyard moves this settle made are zone changes like any other.
    // They announce **before** the destructions: the move is the mechanical
    // fact ("left play"), the destruction is the interpretation ("died,
    // for this reason, from these writes"), so the sequence an observer
    // sees reads damage → left play → died.
    this.#announceZoneMoves();
    for (const d of destroyed) {
      this.#notify(this.#buildDestroyedEvent(d));
    }
    if (destroyed.length > 0) {
      this.#notify({
        type: 'character:destroyed:batch',
        events: destroyed.map((d) => this.#buildDestroyedEvent(d)),
      });
    }
  }

  /**
   * Applies a batch of gauge writes as one atomic settlement:
   *
   * 1. every write lands (the net result per gauge is whatever the gauge
   *    ends at — a 10-damage + 6-heal batch is a net 4 damage),
   * 2. the game-over check runs **before any events** (a killing blow ends
   *    the game instead of triggering abilities or destroyed events),
   * 3. the destroy phase moves every pending destruction (HP ≤ 0 deaths
   *    plus queued `destroy` actions and status-driven max-0 deaths) to the
   *    graveyard simultaneously,
   * 4. only if the game continues are the netted events emitted — with
   *    `character:destroyed` / `character:survived` carrying the batch's
   *    HP writes so triggers can find the damage dealers.
   */
  async #applyGaugeBatch(
    batch: Array<{ action: GaugeAction; source: EventSource | undefined }>,
  ): Promise<void> {
    // Pre-batch state per gauge, the source of the last write that touched
    // it (used to attribute the netted events), and every write that lands
    // on a character's own gauge (so `character:survived` can name all the
    // drainers).
    const pre = new Map<Gauge, GaugeBatchEntry>();
    for (const { action } of batch) {
      if (!pre.has(action.target)) {
        pre.set(action.target, {
          from: action.target.current,
          owner: this.characterOf(action.target),
          source: undefined,
          writes: [],
        });
      }
    }

    // 1. Apply every write in order; clamping happens per write, so the net
    //    is whatever the gauge holds after the whole batch. Each write on a
    //    character's own gauge is recorded with its own before/after and
    //    source.
    //
    //    A `damage`/`heal` write is additionally clamped here, once,
    //    against its own `intent` — a damage action can never net out as a
    //    heal (or vice versa), however many passive modifiers rewrote it
    //    along the way. This is the only floor on a modifier chain's
    //    result; see the long comment on `bindModifier` in
    //    `src/ir/bind/ability.ts` for why it belongs here and not per step.
    //    Applying one write, recording it for the netted events. Split out
    //    because `handleDamage` may send the change to gauges this batch
    //    never aimed at, which still need their own before/after captured.
    const applyWrite = (gauge: Gauge, delta: number, source: EventSource | undefined): void => {
      let entry = pre.get(gauge);
      if (!entry) {
        entry = { from: gauge.current, owner: this.characterOf(gauge), source: undefined, writes: [] };
        pre.set(gauge, entry);
      }
      if (source) entry.source = source;
      const from = gauge.current;
      gauge.current = from + delta;
      if (gauge.current !== from) this.#stateVersion += 1;
      if (entry.owner && this.#isWatchedGauge(gauge)) {
        entry.writes.push(
          source
            ? { type: 'gauge:changed', gauge, target: entry.owner, from, to: gauge.current, source }
            : { type: 'gauge:changed', gauge, target: entry.owner, from, to: gauge.current },
        );
      }
    };

    for (const { action, source } of batch) {
      const gauge = action.target;
      const from = gauge.current;
      const proposed = action.update(gauge.current, gauge.max);
      const clamped =
        action.intent === 'damage'
          ? Math.min(proposed, from)
          : action.intent === 'heal'
            ? Math.max(proposed, from)
            : proposed;

      // The very end: the thing being changed says how the change lands on
      // it (`Character.handleDamage` / `handleHeal`) — a permanent type's
      // own resolution: a ward gauge soaking the first points, healing
      // overflowing into a shield. What it returns is applied as-is; it
      // does not re-enter the pipeline, which is the whole point of asking
      // here and not earlier. Plain gauge movement is never routed.
      const owner = pre.get(gauge)?.owner ?? this.characterOf(gauge);
      const landing = {
        gauge,
        delta: clamped - from,
        ...(source ? { source } : { source: undefined }),
      };
      const routed = !owner
        ? undefined
        : action.intent === 'damage'
          ? owner.handleDamage(landing)
          : action.intent === 'heal'
            ? owner.handleHeal(landing)
            : undefined;

      if (routed) for (const write of routed) applyWrite(write.gauge, write.delta, source);
      else applyWrite(gauge, clamped - from, source);
    }

    // 2. State-based actions: is the game over? (before any events)
    this.#outcomes.run(this);

    // 3. Destroy phase — every pending destruction lands simultaneously
    //    (HP ≤ 0 deaths from this batch + queued `destroy` actions +
    //    max-0 deaths from status changes). All graveyard moves complete
    //    before any events emit.
    const destroyed = await this.#destroyPhase(pre);

    // 3.4 The form-stack SBA — clean dangling ties (a tie whose keying buff
    //    is gone by a bypass path). The pinning itself is automatic; this
    //    step only keeps the tie set honest.
    await this.#enforceFormStack();

    // 3.5 Buff gates — the conditional buffs on the batch's gauges settle
    //    their transitions (apply/remove through the pipeline). Gates run
    //    before the content rules, so content sees the gate-settled state.
    await this.#settleBuffGates(pre);

    // 3.6 Content state-based rules react to the settled state (their
    //    actions apply through nested applies; the loop stops once an
    //    iteration changes nothing — see `#runContentSBAs`).
    await this.#runContentSBAs();

    // 4. Emit the netted events per gauge, in first-touch order. Damage and
    //    healing are *derived* from the hp gauge:changed event (see the
    //    helpers in events.ts) — there are no dedicated damage/heal events.
    //    One `gauge:changed:batch` then summarizes them all.
    const changes: GaugeChangedEvent[] = [];
    for (const [gauge, p] of pre) {
      const to = gauge.current;
      const source = p.source;
      if (to === p.from) continue;
      const event: GaugeChangedEvent = p.owner
        ? source
          ? { type: 'gauge:changed', gauge, target: p.owner, from: p.from, to, source }
          : { type: 'gauge:changed', gauge, target: p.owner, from: p.from, to }
        : source
          ? { type: 'gauge:changed', gauge, from: p.from, to, source }
          : { type: 'gauge:changed', gauge, from: p.from, to };
      changes.push(event);
      await this.emit(event);
    }
    if (changes.length > 0) {
      await this.emit({ type: 'gauge:changed:batch', events: changes });
    }

    // 5. Announce the destructions — one event per character, after every
    //    graveyard move is complete, so death triggers see the full wipe.
    await this.#announceDestructions(destroyed);

    // 6. Survivors — the flip side of `character:destroyed`. Any character
    //    whose **watched gauge** (a gauge carrying state-based rules — `hp` by
    //    default) took at least one damaging write in this batch and is still
    //    standing gets a `character:survived`, even when the net change is
    //    zero (damage and heal cancelled out): `changes` still lists every
    //    write, which is what revenge-style triggers filter on. A single
    //    `character:survived:batch` carries them all.
    const survivors: CharacterSurvivedEvent[] = [];
    for (const [gauge, p] of pre) {
      if (
        p.owner &&
        this.#isWatchedGauge(gauge) &&
        gauge.current > gauge.min &&
        p.writes.some((write) => write.to < write.from)
      ) {
        const event: CharacterSurvivedEvent = {
          type: 'character:survived',
          character: p.owner,
          changes: p.writes,
        };
        survivors.push(event);
        await this.emit(event);
      }
    }
    if (survivors.length > 0) {
      await this.emit({
        type: 'character:survived:batch',
        events: survivors,
      });
    }
  }
}
