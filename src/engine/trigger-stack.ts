/**
 * The trigger stack — the engine's listener registry and the queue that
 * defers trigger execution.
 *
 * Every triggered ability attaches a listener with a unique id. When an
 * event fires, the stack collects the matching listeners into the
 * **prepare stack** (gated by each ability's prestack filter, `when`),
 * sorts them by listener id, shuffles them with the engine's seeded PRNG,
 * and **queues** them (see `enqueue`). The queue drains — one trigger at a
 * time, FIFO — after the current resolution unit completes
 * (`GameEngine.apply` / the turn hooks), so every trigger in a unit sees the
 * unit's settled state: a board wipe's death triggers run after all the
 * destructions and their events, not interleaved with them.
 *
 * The `GameEngine` owns one of these and feeds it the services it needs:
 * the PRNG draw (so `setSeed` re-seeds the shuffle), target resolution, the
 * action pipeline, and the context builder that embeds the engine in every
 * `TriggerContext`.
 */
import type { AnyTriggeredAbility, TargetPattern, Targeting, TriggerContext } from './ability/index.js';
import type { Action } from './actions.js';
import type { Character } from './character.js';
import type { EventSource, GameEvent } from './events.js';
import type { ChoiceAnswer, ChoiceRequest } from './choice.js';
import { ImmediateScheduler, type ReadyTrigger, type TriggerScheduler } from './trigger-scheduler.js';
import { Buff, type Status } from './status/index.js';

/**
 * A trigger that has been collected, gated and ordered, and is ready to
 * run — handed to a `defer` sink before the stack runs it itself.
 *
 * This is the seam that lets a game make triggers **respondable to**. By
 * default the engine runs a trigger the moment the queue drains, which is
 * right for a turn-based RPG and wrong for a card game: in Magic a
 * triggered ability goes on the stack and every player may respond to it
 * before it resolves. A sink takes the trigger, puts it wherever its game
 * keeps pending objects, and calls `run` later.
 *
 * `run` does exactly what the engine would have done — targeting, cast,
 * and applying the resulting actions with the right source attribution —
 * so a sink never has to reimplement trigger execution.
 */
export interface DeferredTrigger {
  readonly owner: Character;
  readonly status: Status;
  readonly ability: AnyTriggeredAbility;
  readonly event: GameEvent;
  /** Runs it now. Resolves when its actions have been applied. */
  run(): Promise<void>;
}

/** What the trigger stack needs from its engine. */
export interface TriggerStackServices {
  /** Draws one number from the engine's seeded PRNG (the shuffle stream). */
  readonly rng: () => number;
  /** Resolves the characters matching a pattern (see `GameEngine.validTargets`). */
  readonly validTargets: (pattern: TargetPattern, self: Character) => Character[];
  /** Runs actions through the engine's pipeline (a trigger's `cast` result). */
  readonly apply: (actions: Action[], context?: { source?: EventSource }) => Promise<void>;
  /**
   * Builds the `TriggerContext` handed to abilities (embeds the engine and
   * the status that owns the triggered ability — `ctx.status`).
   */
  readonly context: (self: Character, status: Status, event: GameEvent) => TriggerContext<GameEvent['type']>;
  /** Asks a choice and validates the answer (see `GameEngine.#ask`). */
  readonly ask: (request: ChoiceRequest) => Promise<ChoiceAnswer>;
  /**
   * Decides what order triggers run in, and when (trigger-scheduler.ts).
   * Defaults to `ImmediateScheduler` — registration order, seeded shuffle,
   * everything drained when the resolution unit completes.
   */
  readonly scheduler?: TriggerScheduler;
}

/**
 * One registered trigger: a triggered ability listening to an event type on
 * behalf of a status (buff or skill) attached to a character. The `id` is
 * unique per stack (assigned at registration) and is what the prepare stack
 * is sorted by before the seeded shuffle.
 */
export interface TriggerListener {
  readonly id: number;
  readonly owner: Character;
  readonly status: Status;
  readonly ability: AnyTriggeredAbility;
  readonly event: GameEvent['type'];
}

export class TriggerStack {
  /** Trigger listeners by event type, in registration order. */
  readonly #listeners = new Map<GameEvent['type'], TriggerListener[]>();
  /** Status instance -> the listeners it registered (for clean detach). */
  readonly #listenersByStatus = new Map<Status, TriggerListener[]>();
  /** Monotonic counter backing `TriggerListener.id`. */
  #nextListenerId = 0;
  readonly #services: TriggerStackServices;
  readonly #scheduler: TriggerScheduler;

  constructor(services: TriggerStackServices) {
    this.#services = services;
    this.#scheduler = services.scheduler ?? new ImmediateScheduler(services.rng);
  }

  /**
   * Attaches a status's abilities: triggered ones register a listener with a
   * unique id (the sort key for the prepare stack).
   */
  attachStatus(status: Status, owner: Character): void {
    const listeners: TriggerListener[] = [];
    for (const ability of status.abilities) {
      if (ability.kind !== 'trigger') continue;
      const listener: TriggerListener = {
        id: this.#nextListenerId++,
        owner,
        status,
        ability,
        event: ability.event,
      };
      listeners.push(listener);
      let bucket = this.#listeners.get(ability.event);
      if (!bucket) {
        bucket = [];
        this.#listeners.set(ability.event, bucket);
      }
      bucket.push(listener);
    }
    if (listeners.length > 0) this.#listenersByStatus.set(status, listeners);
  }

  /** Detaches a status's abilities (buff removed, or engine disposal). */
  detachStatus(status: Status): void {
    const listeners = this.#listenersByStatus.get(status);
    if (!listeners) return;
    for (const listener of listeners) {
      const bucket = this.#listeners.get(listener.event);
      if (!bucket) continue;
      const index = bucket.indexOf(listener);
      if (index !== -1) bucket.splice(index, 1);
      if (bucket.length === 0) this.#listeners.delete(listener.event);
    }
    this.#listenersByStatus.delete(status);
  }

  /**
   * Collects an event's matching triggers and **queues** them. Execution is
   * deferred — see `drain`.
   *
   * 1. every listener of that event type whose **prestack filter** (`when`)
   *    passes is added to the **prepare stack**,
   * 2. the prepare stack is sorted by the listeners' unique ids,
   * 3. it is shuffled with the seeded PRNG, and
   * 4. the result is appended to the queue, in that order.
   *
   * The listeners are captured at collection time, so a trigger still runs
   * even if its status is removed while earlier queued triggers resolve.
   */
  enqueue(event: GameEvent): void {
    const bucket = this.#listeners.get(event.type);
    if (!bucket || bucket.length === 0) return;

    // Gate: the prestack filter decides who is ready. The listener is
    // captured here, so a trigger still runs if its status is removed
    // while earlier ones resolve.
    const ready: ReadyTrigger[] = [];
    for (const listener of bucket) {
      const ctx = this.#services.context(listener.owner, listener.status, event);
      if (listener.ability.when && !listener.ability.when(ctx)) continue;
      ready.push({
        id: listener.id,
        owner: listener.owner,
        status: listener.status,
        ability: listener.ability,
        event,
        run: () => this.#runTrigger(listener, event),
      });
    }
    if (ready.length === 0) return;

    // Order and timing belong to the scheduler (trigger-scheduler.ts) —
    // the one part of dispatch a card game and a real-time game disagree
    // on. It gets the whole group, so it can order it.
    this.#scheduler.enqueue(ready, event);
  }

  /** How many triggers are waiting to run (exposed for tests/UI). */
  get pending(): number {
    return this.#scheduler.pending;
  }

  /** Runs whatever the scheduler says is due. */
  async drain(maxRuns: number): Promise<void> {
    await this.#scheduler.drain(maxRuns);
  }

  /** Runs one trigger from the active stack (auto- or prompt-targeting). */
  async #runTrigger(listener: TriggerListener, event: GameEvent): Promise<void> {
    const { owner, status, ability } = listener;
    // The listener only receives events of its subscribed type, so the event
    // is safe to narrow to the ability's type.
    const ctx = this.#services.context(owner, status, event);

    let targeting: Targeting | undefined;
    if (ability.prompt) {
      // A prompt trigger asks **which** targets, not *whether* — see
      // choice.ts. The chooser is the owner's controller; an unowned
      // character has none, and the engine falls back to its host.
      const pattern = ability.prompt(ctx);
      const options = this.#services.validTargets(pattern, owner);
      const answer = await this.#services.ask({
        kind: 'select',
        prompt: ability.name,
        chooser: owner.controller,
        options,
        count: pattern.count ?? 1,
        source: owner,
        pattern,
      });
      targeting = { targets: answer.kind === 'select' ? [...answer.chosen] : [] };
    } else if (ability.targeting) {
      targeting = { targets: this.#services.validTargets(ability.targeting, owner) };
    } else if (ability.targets) {
      const targets = await ability.targets(ctx);
      targeting = { targets };
    }

    const actions = await ability.cast(ctx, targeting);
    // A buff's triggered ability is attributed to the buff itself (so a
    // poison tick shows "from Poison", not "from its wearer"). Skill-owned
    // triggers stay attributed to the character.
    await this.#services.apply(actions, { source: status instanceof Buff ? status : owner });
  }
}
