/**
 * The stack and priority — MTG-style interaction, built on zones.
 *
 * ## Casting is a move
 *
 * The thing on the stack **is the card**. Casting moves it `hand → stack`;
 * resolving moves it `stack → active`, runs it, then `active → play` (a
 * permanent) or `active → garbage` (a spell). That falls straight out of
 * the decided identity model (docs/design/15-zones.md: "a card and the
 * creature it becomes are one identity in two forms") and it means every
 * step of casting is an ordinary `move` action — so a replacement effect
 * can redirect it and an `on: 'move'` restriction can stop it, for free.
 *
 * `active` exists so the stack means exactly "waiting to resolve". Magic
 * leaves a resolving spell on the stack until resolution finishes, which is
 * why a spell can count "spells on the stack" and include itself; here it
 * cannot. Its capacity of 1 is the engine's assertion that resolution does
 * not nest.
 *
 * ## Priority
 *
 * `runPriority` is the round-robin: the player with priority either adds an
 * object to the stack or passes — answering through `PriorityOwner`, a
 * capability a player implements. Whoever adds something **keeps** priority;
 * when every player passes in succession, the top object resolves and
 * priority returns to the active player. All passing on an empty stack ends
 * the window.
 *
 * ## Abilities on the stack
 *
 * An ability is a stack object too, and it is **not a card**: an
 * `AbilityObject` is an `Entity` with `type: 'ability'`, placed on the
 * stack rather than moved there (it did not exist anywhere before, so
 * there is nothing for a replacement effect to intercept). On resolution it
 * **ceases to exist** instead of going to a zone — which is exactly what
 * Magic does with it, and why `destination` belongs to spells only.
 *
 * Its `source` permanent stays in play throughout. That is the whole point
 * of a separate object: the ability can resolve after its source is
 * destroyed.
 *
 * ## The stack is LIFO, always
 *
 * It is **one array, bottom-first**: `stackObject`/`cast` push, `resolveTop`
 * pops, and nothing else touches either end. So the last thing put on is the
 * first thing resolved, in every path — a response before the spell it
 * answered, a trigger before the spell that raised it, the last player to
 * stack before the others (APNAP).
 *
 * The only views out are **top-first**, so no caller can accidentally walk
 * the stack backwards:
 *
 * | Member | Order |
 * | --- | --- |
 * | `objects` | a top-first **copy** — the resolution order |
 * | `top` | the next thing to resolve |
 * | `#objects` | private, bottom-first — the storage detail, not the model |
 *
 * `counter` splices an object out wherever it sits and leaves the rest in
 * their relative order. `test/stack-lifo.test.ts` pins all of it.
 *
 * ## Timing
 *
 * `CastSpeed` is the instant/sorcery split, enforced by `canPut`:
 *
 * - `'instant'` — legal whenever you have priority;
 * - `'sorcery'` — legal only in your own main phase with an **empty
 *   stack** (Magic rule 307.1), so a sorcery can never be a response.
 *
 * A **triggered** ability obeys neither: it goes on the stack the next
 * time a player would get priority, whoever's turn it is (rule 603.3).
 * `queueTriggered` is that path, and `runPriority` drains the queue in
 * APNAP order — active player's triggers first — before asking anyone for
 * priority.
 *
 * ## Triggers are respondable to
 *
 * `scheduler()` is a `TriggerScheduler` (src/engine/trigger-scheduler.ts):
 * point the engine at it and a triggered ability no longer resolves the
 * instant it fires. It is wrapped as an ability object, queued, and put on
 * the stack at the next priority window — where every player may respond
 * to it, and where it can be countered before it ever runs.
 *
 * ```ts
 * const stack = new CardStack(engine);
 * //   new GameEngine({ scheduler: stack.scheduler() })
 * ```
 *
 * ## What this is not, yet
 *
 * - **Nothing here charges a cost.** Mana and tapping are out of scope, so
 *   "can I afford it" is the host's business; `canPut` only answers "is
 *   this the right time".
 * - **Priority is not yet a `ChoiceRequest`.** `PriorityOwner` is a second
 *   way to ask a player something, alongside `Player.choose` (choice.ts).
 *   Folding it in needs a third request kind, because "act or pass"
 *   answers with a stack object rather than a selection — not just a
 *   rename.
 */
import { GARBAGE } from '../../engine/index.js';
import { castSpeedOf, isInstant, type CastSpeed } from './speed.js';
import { Character } from '../../engine/index.js';
import type {
  Action,
  Entity,
  ReadyTrigger,
  TriggerScheduler,
  GameEngine,
  Player,
  TargetPattern,
} from '../../engine/index.js';

/** Where a card goes once it has finished resolving. */
export type StackDestination = 'play' | 'garbage';

export type { CastSpeed } from './speed.js';

/**
 * An **ability** waiting on the stack — an entity that is not a card.
 *
 * It has no gauges and no statuses; it exists only to occupy a place in
 * the resolution order, and it is removed from the game once resolved.
 */
export interface AbilityObject {
  readonly type: 'ability';
  readonly name: string;
  /** The permanent whose ability this is. It stays in play, untouched. */
  readonly source: Character;
}

/** Builds an ability object. */
export function abilityObject(name: string, source: Character): AbilityObject {
  return { type: 'ability', name, source };
}

/** The timing context a priority window runs in. */
export interface TimingWindow {
  readonly activePlayer: Player;
  /**
   * Whether sorcery-speed is permitted at all — in Magic's terms, whether
   * this is a main phase. An instant ignores it.
   */
  readonly mainPhase: boolean;
}

/** Context a stack object sees while it resolves. */
export interface ResolveContext {
  readonly engine: GameEngine;
  readonly controller: Player;
  /** The targets that were still legal at resolution. */
  readonly targets: readonly Character[];
}

/** What every stack object carries, spell or ability. */
interface StackObjectBase {
  readonly name: string;
  readonly controller: Player;
  /** Chosen when it went on the stack; re-checked for legality at resolution. */
  readonly targets: readonly Character[];
  /**
   * The pattern the targets were chosen against. Re-applied at resolution:
   * a target that is no longer legal is dropped, and an object that had
   * targets and has none left **fizzles**.
   */
  readonly targetPattern?: TargetPattern;
  /**
   * Defaults to `'sorcery'` — the restrictive timing, so an omission is safe.
   *
   * Usually unnecessary: mark the card or the ability with `instant(...)`
   * (`speed.ts`) and the stack reads it. An explicit field is for a stack
   * object that is not wrapping anything marked — a host-built trigger, say.
   */
  readonly speed?: CastSpeed;
  /**
   * What it does. Called at resolution rather than when it was stacked, so
   * it sees the board as it is when it actually resolves.
   */
  resolve(ctx: ResolveContext): Action[] | Promise<Action[]>;
}

/**
 * A card on the stack. It moves `hand → stack → active → destination`.
 *
 * `card` is any entity, not necessarily a `Character`: a spell has no
 * gauges and must not pretend to (see `Entity` in `src/engine/zone.ts`).
 * That is why targeting is resolved against `self` — the character a
 * pattern is relative to, usually the caster's avatar — rather than
 * against the card. A card that *is* a character (a permanent spell) can
 * leave `self` out and stands in for itself.
 */
export interface SpellObject extends StackObjectBase {
  readonly kind: 'spell';
  readonly card: Entity;
  /** The character the targeting pattern is relative to. Defaults to the card. */
  readonly self?: Character;
  readonly destination: StackDestination;
}

/** An ability on the stack. Placed, then removed — it goes nowhere. */
export interface AbilityStackObject extends StackObjectBase {
  readonly kind: 'ability';
  readonly ability: AbilityObject;
}

export type StackObject = SpellObject | AbilityStackObject;

/** The entity that occupies a zone for this object. */
export function entityOf(object: StackObject): Entity {
  return object.kind === 'spell' ? object.card : object.ability;
}

/**
 * An object's effective timing, in precedence order:
 *
 * 1. an explicit `speed` on the stack object (a host-built trigger);
 * 2. the **instant marker** on the card or ability it wraps — one symbol,
 *    whether the thing is a card or an activated ability;
 * 3. sorcery, the restrictive default, so forgetting is safe.
 */
export function speedOf(object: StackObject): CastSpeed {
  if (object.speed) return object.speed;
  if (isInstant(entityOf(object))) return 'instant';
  if (object.kind === 'ability' && isInstant(object.ability)) return 'instant';
  return castSpeedOf(object);
}

/** Why an object left the stack without resolving. */
export type CounterReason =
  /** An effect removed it ("counter target spell"). */
  | 'countered'
  /** Every target it needed became illegal — Magic's "countered on resolution". */
  | 'fizzled';

/**
 * What a player does with priority.
 *
 * Passing is its **own answer**, not the absence of one. A returned
 * `undefined` conflates three different things — "I choose to pass", "I had
 * nothing legal", and "my host is broken or forgot to return" — and the
 * middle one is a game state while the last is a bug. Naming the pass keeps
 * them apart, the way the engine's events carry no optional properties and
 * come in versions instead (see events.ts).
 */
export type PriorityResponse =
  /** "I pass." The loop counts it; all players passing resolves the top object. */
  | { readonly action: 'pass' }
  /** "I put this on the stack." Keeps priority with this player. */
  | { readonly action: 'put'; readonly object: StackObject };

/** The pass answer, as a value — `return PASS`. */
export const PASS: PriorityResponse = { action: 'pass' };

/** Puts an object on the stack, as a value — `return put(object)`. */
export function put(object: StackObject): PriorityResponse {
  return { action: 'put', object };
}

/** What a player is told when it is their turn to act. */
export interface PriorityRequest {
  /** The player being asked — `this`, for a player answering its own. */
  readonly player: Player;
  /** The stack as it stands, top first. */
  readonly stack: readonly StackObject[];
  readonly engine: GameEngine;
  /** The timing in force — check `CardStack.canPut` against it. */
  readonly window: TimingWindow;
}

/**
 * A player that can **hold priority**.
 *
 * A capability a `Player` implements, not a separate service. The same
 * argument that moved choices onto `Player.choose` (choice.ts) applies
 * here: the thing that decides whether to act is the player, so there is
 * no intermediary to name. A player that does not implement this simply
 * passes — which is the right default for an AI or a scripted opponent
 * that only acts on its own turn.
 *
 * It lives here rather than on `Player` itself because priority is a
 * card-game concept; the engine has no opinion about it.
 */
export interface PriorityOwner {
  /**
   * Return `PASS`, or `put(object)` to add to the stack. Timing is checked
   * against `request.window` — call `CardStack.canPut` first; an illegal
   * play is an error, not a pass.
   */
  takePriority(request: PriorityRequest): Promise<PriorityResponse>;
}

/** True when a player can hold priority (implements `PriorityOwner`). */
export function isPriorityOwner(player: Player): player is Player & PriorityOwner {
  return typeof (player as Partial<PriorityOwner>).takePriority === 'function';
}

/** The triggers waiting for one player to order them. */
export interface TriggerOrderRequest {
  /** The player being asked — the **only** player who orders these. */
  readonly player: Player;
  /**
   * That player's simultaneous triggers, in their default order (the order
   * the abilities were registered). Always two or more: one trigger is not
   * a question.
   */
  readonly triggers: readonly AbilityStackObject[];
  readonly engine: GameEngine;
}

/**
 * A player that **orders its own simultaneous triggers**.
 *
 * Rule 603.3b: when several abilities trigger at once, each player chooses
 * the order their own go on the stack — the active player first, then each
 * other player in turn order. Nobody orders anyone else's, which is why
 * this is asked once per player and not once per batch.
 *
 * The answer is the order they go **on the stack**, so the *last* one
 * resolves first (`triggerOrder` in the UI says so out loud). Return the
 * same triggers, each exactly once; anything else is a host bug and throws,
 * the way `runPriority` throws on an illegal `put`.
 *
 * A `Player` that does not implement this keeps the default: the order the
 * abilities were registered, which is deterministic and therefore
 * replayable. Choosing introduces an input — a legitimate one, like a move.
 */
export interface TriggerOrderer {
  orderTriggers(request: TriggerOrderRequest): Promise<readonly AbilityStackObject[]>;
}

/** True when a player orders its own triggers (implements `TriggerOrderer`). */
export function isTriggerOrderer(player: Player): player is Player & TriggerOrderer {
  return typeof (player as Partial<TriggerOrderer>).orderTriggers === 'function';
}

/** What one resolution did, for logs and tests. */
export interface ResolutionReport {
  readonly object: StackObject;
  /** `'resolved'`, or why it did not. */
  readonly outcome: 'resolved' | CounterReason;
  /** The targets that were still legal (empty for a fizzle). */
  readonly targets: readonly Character[];
}

export class CardStack {
  readonly #engine: GameEngine;
  readonly #objects: StackObject[] = [];
  /** Triggered abilities waiting for the next priority window (rule 603.3). */
  readonly #triggered: AbilityStackObject[] = [];
  #scheduler: TriggerScheduler | undefined;

  constructor(engine: GameEngine) {
    this.#engine = engine;
  }

  /** The stack, **top first** — the resolution order. */
  get objects(): readonly StackObject[] {
    return [...this.#objects].reverse();
  }

  get size(): number {
    return this.#objects.length;
  }

  get top(): StackObject | undefined {
    return this.#objects[this.#objects.length - 1];
  }

  /**
   * Whether `player` may put `object` on the stack right now.
   *
   * An instant needs only priority. A sorcery needs its controller's own
   * main phase and an **empty stack** (rule 307.1) — which is what stops a
   * sorcery being used as a response.
   */
  canPut(object: StackObject, player: Player, window: TimingWindow): boolean {
    if (speedOf(object) === 'instant') return true;
    return player === window.activePlayer && window.mainPhase && this.#objects.length === 0;
  }

  /**
   * Puts an object on the stack.
   *
   * A **spell** is *moved* there (`hand → stack`) through the pipeline, so
   * a restriction or a replacement effect may stop it — in which case the
   * card never arrives and the object is not stacked, and this returns
   * false. An **ability** is *placed* there: it did not exist anywhere
   * before, so there is nothing to intercept.
   *
   * Timing is the caller's business unless a `window` is supplied, in which
   * case `canPut` gates it.
   */
  async stackObject(
    object: StackObject,
    options: { player?: Player; window?: TimingWindow } = {},
  ): Promise<boolean> {
    const { player, window } = options;
    if (window && !this.canPut(object, player ?? object.controller, window)) return false;

    const stack = this.#zone('stack');
    if (object.kind === 'spell') {
      await this.#engine.moveTo(object.card, 'stack', { reason: 'cast' });
      if (!stack.contains(object.card)) return false;
    } else {
      await this.#engine.addEntity(object.ability, 'stack');
    }
    this.#objects.push(object);
    return true;
  }

  /** `stackObject`, under the name a card game uses for a spell. */
  async cast(object: StackObject): Promise<boolean> {
    return this.stackObject(object);
  }

  /**
   * A `TriggerScheduler` that puts triggers **on this stack** instead of
   * running them — this is what makes them respondable to.
   *
   * Wire it with `new GameEngine({ scheduler: stack.scheduler() })`. Each
   * ready trigger becomes an ability object queued for the next priority
   * window, where every player may respond to it and where it can be
   * countered before it ever runs. The object's `resolve` calls the
   * engine's own `run`, so targeting, casting and source attribution are
   * unchanged — being on the stack changes *when* a trigger happens, not
   * *what* it does.
   *
   * A trigger whose owner has **no controller** has no player to hold
   * priority for it, so it keeps the default behaviour: it runs when the
   * engine drains.
   *
   * Known gap: targets are chosen when the trigger **runs**, not when it
   * goes on the stack, so a trigger does not fizzle from its targets
   * becoming illegal while it waits. Magic chooses them on announcement.
   */
  scheduler(): TriggerScheduler {
    // Memoized: the unowned queue below is state, so two calls must not
    // hand out two independent schedulers.
    if (this.#scheduler) return this.#scheduler;
    const unowned: ReadyTrigger[] = [];
    const stack = this;
    this.#scheduler = {
      enqueue(ready: readonly ReadyTrigger[]): void {
        // Registration order first, so the stack order is reproducible.
        for (const trigger of [...ready].sort((a, b) => a.id - b.id)) {
          const controller = trigger.owner.controller;
          if (!controller) {
            unowned.push(trigger);
            continue;
          }
          stack.queueTriggered({
            kind: 'ability',
            ability: abilityObject(trigger.ability.name, trigger.owner),
            name: trigger.ability.name,
            controller,
            targets: [],
            // Timing never gates a trigger (rule 603.3); recorded for
            // display only.
            speed: 'instant',
            resolve: async (): Promise<Action[]> => {
              await trigger.run();
              return [];
            },
          });
        }
      },
      get pending(): number {
        return unowned.length + stack.pendingTriggered.length;
      },
      async drain(maxRuns: number): Promise<void> {
        // Only the unowned ones are the engine's to run; the rest wait for
        // a priority window.
        let runs = 0;
        while (unowned.length > 0) {
          runs += 1;
          if (runs > maxRuns) {
            throw new Error(`Trigger queue exceeded max depth ${maxRuns} — possible infinite trigger loop.`);
          }
          await unowned.shift()!.run();
        }
      },
    };
    return this.#scheduler;
  }

  /**
   * Queues a **triggered** ability. It obeys no timing: the next time a
   * player would receive priority it goes on the stack, whoever's turn it
   * is (rule 603.3). `runPriority` drains the queue in APNAP order.
   */
  queueTriggered(object: AbilityStackObject): void {
    this.#triggered.push(object);
  }

  get pendingTriggered(): readonly AbilityStackObject[] {
    return this.#triggered;
  }

  /**
   * Puts every queued triggered ability on the stack, the active player's
   * first (APNAP). Returns how many were stacked.
   *
   * Within one player's batch, an orderer chooses (rule 603.3b); everyone
   * else keeps the deterministic registration order.
   */
  async flushTriggered(players: readonly Player[], activePlayer: Player): Promise<number> {
    if (this.#triggered.length === 0) return 0;
    const queued = this.#triggered.splice(0, this.#triggered.length);
    const order = [activePlayer, ...players.filter((p) => p !== activePlayer)];
    let stacked = 0;
    for (const player of order) {
      const mine = queued.filter((o) => o.controller === player);
      for (const object of await this.#ordered(player, mine)) {
        if (await this.stackObject(object)) stacked += 1;
      }
    }
    // A trigger whose controller is not among `players` still resolves.
    for (const object of queued.filter((o) => !order.includes(o.controller))) {
      if (await this.stackObject(object)) stacked += 1;
    }
    return stacked;
  }

  /**
   * One player's triggers, in the order they go on the stack: the player's
   * answer if they order triggers, the registration order otherwise.
   */
  async #ordered(
    player: Player,
    mine: readonly AbilityStackObject[],
  ): Promise<readonly AbilityStackObject[]> {
    if (mine.length < 2 || !isTriggerOrderer(player)) return mine;
    const chosen = await player.orderTriggers({ player, triggers: mine, engine: this.#engine });
    // Exactly the triggers it was handed, each once: a dropped or duplicated
    // trigger is a host bug, and silently accepting it would lose a game
    // action with no error anywhere.
    const sameObjects =
      chosen.length === mine.length &&
      new Set(chosen).size === chosen.length &&
      chosen.every((object) => mine.includes(object));
    if (!sameObjects) {
      throw new Error(
        `flushTriggered: ${player.name} ordered triggers into ` +
          `${chosen.length} object(s) that are not the ${mine.length} it was asked about`,
      );
    }
    return chosen;
  }

  /**
   * Removes an object from the stack without resolving it, sending its card
   * to the garbage — "counter target spell".
   */
  async counter(object: StackObject, reason: CounterReason = 'countered'): Promise<boolean> {
    const index = this.#objects.indexOf(object);
    if (index === -1) return false;
    this.#objects.splice(index, 1);
    await this.#finish(object, reason);
    return true;
  }

  /**
   * Takes an object off the stack: a card goes to the garbage, an ability
   * ceases to exist. `destination` is a spell's; an ability has none.
   */
  async #finish(object: StackObject, reason: string): Promise<void> {
    if (object.kind === 'ability') {
      this.#engine.removeEntity(object.ability);
      return;
    }
    await this.#engine.moveTo(object.card, GARBAGE.id, { reason, owner: object.controller });
  }

  /**
   * Resolves the top object: legality is re-checked, then the card moves to
   * `active`, its actions apply, and it lands in its destination.
   *
   * Returns undefined when the stack is empty.
   */
  async resolveTop(): Promise<ResolutionReport | undefined> {
    const object = this.#objects.pop();
    if (!object) return undefined;

    // Legality is re-checked **on the stack**, before anything moves — an
    // object that needed targets and has none left is countered on
    // resolution and never becomes active.
    const legal = this.#legalTargets(object);
    if (object.targets.length > 0 && legal.length === 0) {
      await this.#finish(object, 'fizzled');
      return { object, outcome: 'fizzled', targets: [] };
    }

    const entity = entityOf(object);
    await this.#engine.moveTo(entity, 'active', { reason: 'resolving' });
    const actions = await object.resolve({
      engine: this.#engine,
      controller: object.controller,
      targets: legal,
    });
    if (actions.length > 0) {
      // An ability's actions are sourced to its **source permanent**, not
      // to the ability object — a non-character entity is not an
      // `EventSource`, and "who dealt this" should name the permanent.
      const source =
        object.kind === 'spell' ? (object.self ?? (object.card as Character)) : object.ability.source;
      await this.#engine.apply(actions, { source });
    }

    // The entity may have left `active` on its own — an effect that
    // destroyed or exiled the resolving object. Only finish it if it is
    // still there.
    if (this.#zone('active').contains(entity)) {
      if (object.kind === 'ability') this.#engine.removeEntity(entity);
      else await this.#engine.moveTo(object.card, object.destination, { reason: 'resolved', owner: object.controller });
    }
    return { object, outcome: 'resolved', targets: legal };
  }

  /**
   * The priority round-robin. Returns the resolutions it performed, in
   * order.
   *
   * Whoever adds to the stack keeps priority; when every player passes in
   * succession the top object resolves and priority returns to the active
   * player. All passing on an empty stack ends the window.
   */
  async runPriority(
    players: readonly Player[],
    options: { activePlayer?: number; mainPhase?: boolean; maxSteps?: number } = {},
  ): Promise<ResolutionReport[]> {
    if (players.length === 0) return [];
    const active = options.activePlayer ?? 0;
    const maxSteps = options.maxSteps ?? 1000;
    const window: TimingWindow = {
      activePlayer: players[active]!,
      mainPhase: options.mainPhase ?? true,
    };
    const reports: ResolutionReport[] = [];
    let index = active;
    let passes = 0;
    let steps = 0;

    while (true) {
      steps += 1;
      if (steps > maxSteps) {
        throw new Error(`runPriority: exceeded ${maxSteps} steps — a host that never passes?`);
      }

      // Rule 603.3: anything that triggered goes on the stack before a
      // player receives priority — no timing check, whoever's turn it is.
      // A newly stacked trigger resets the pass count: everyone must get
      // the chance to respond to it.
      if (await this.flushTriggered(players, window.activePlayer)) {
        passes = 0;
        index = active;
        continue;
      }

      // The player answers for itself. One that cannot hold priority
      // passes, so a scripted or AI opponent needs no implementation.
      const player = players[index]!;
      const response = isPriorityOwner(player)
        ? await player.takePriority({ player, stack: this.objects, engine: this.#engine, window })
        : PASS;
      if (response.action === 'put') {
        const added = response.object;
        // An illegal offer is a host bug, not a game state — the window is
        // in the request and `canPut` answers it. Fail loudly, the way
        // `engine.useAbility` does for out-of-pattern targets, rather than
        // silently dropping the play.
        if (!this.canPut(added, player, window)) {
          throw new Error(
            `runPriority: ${player.name} cannot put "${added.name}" on the stack now ` +
              `(${speedOf(added)} speed, ${this.#objects.length} on the stack, ` +
              `${window.mainPhase ? 'main phase' : 'not a main phase'}, ` +
              `active player ${window.activePlayer.name})`,
          );
        }
        // Adding resets the count and **keeps** priority with this player:
        // they may respond to their own object before anyone else sees it.
        const stacked = await this.stackObject(added);
        if (stacked) passes = 0;
        else passes += 1;
        continue;
      }
      // An explicit pass.
      passes += 1;
      if (passes < players.length) {
        index = (index + 1) % players.length;
        continue;
      }
      // Everyone passed in succession.
      if (this.#objects.length === 0) return reports;
      const report = await this.resolveTop();
      if (report) reports.push(report);
      passes = 0;
      index = active; // priority returns to the active player
    }
  }

  /** The object's targets that are still legal, by its own pattern. */
  #legalTargets(object: StackObject): Character[] {
    if (!object.targetPattern) return [...object.targets];
    // A pattern is relative to a character: a spell's `self` (usually the
    // caster), a permanent spell's own card, or an ability's source.
    const self =
      object.kind === 'spell'
        ? (object.self ?? (object.card as Character))
        : object.ability.source;
    if (!(self instanceof Character)) {
      throw new Error(
        `CardStack: "${object.name}" has a targeting pattern but no character to resolve it against — set "self"`,
      );
    }
    const pool = this.#engine.validTargets(object.targetPattern, self);
    return object.targets.filter((target) => pool.includes(target));
  }

  #zone(id: string) {
    const zone = this.#engine.zones.zone(id);
    if (!zone) throw new Error(`CardStack: the "${id}" zone is not declared — see src/games/cards/zones.ts`);
    return zone;
  }
}
