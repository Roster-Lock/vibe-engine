/**
 * **Trigger scheduling** — the one part of trigger dispatch that differs
 * between games.
 *
 * `TriggerStack` does four things, and only one of them is game-specific:
 *
 * | Concern | Varies by game? |
 * | --- | --- |
 * | which listeners exist for an event (the registry) | no |
 * | whether each one joins (the `when` gate) | no |
 * | **what order they run in, and when** | **yes** |
 * | how one runs (targeting, cast, apply) | no |
 *
 * So that third row is an interface. A turn-based game resolves everything
 * the moment the resolution unit completes. A card game puts each trigger
 * on a stack where players may respond before it resolves. A real-time game
 * cannot do either: it has a frame clock, so a trigger raised mid-frame is
 * due on some *later* frame, and a nested chain has to be spread across
 * frames rather than drained in one go.
 *
 * All three want the same registry, the same gate, and the same execution —
 * which is why this is a scheduler and not a second trigger system.
 */
import type { GameEvent } from './events.js';
import { shuffle } from './seed.js';
import type { DeferredTrigger } from './trigger-stack.js';

/**
 * A trigger that passed its gate and is ready to run.
 *
 * `id` is its listener's registration number — the **deterministic base
 * order**. A scheduler that wants reproducibility sorts by it before
 * applying any randomness, which is what makes a seeded game replayable.
 */
export interface ReadyTrigger extends DeferredTrigger {
  readonly id: number;
}

export interface TriggerScheduler {
  /**
   * Takes the triggers one event made ready, in registration order.
   *
   * Called once per event, with every listener that passed its gate — so a
   * scheduler sees the whole group and can order it, not one at a time.
   */
  enqueue(ready: readonly ReadyTrigger[], event: GameEvent): void;

  /** How many are waiting. For diagnostics, tests, and UI. */
  readonly pending: number;

  /**
   * Runs whatever is due now. The engine calls this when a resolution unit
   * completes; a scheduler whose timing is its own (a frame clock, a
   * priority window) may legitimately do nothing here and run its triggers
   * from elsewhere.
   *
   * `maxRuns` is the engine's runaway guard — a scheduler that loops
   * forever should throw rather than hang.
   */
  drain(maxRuns: number): Promise<void>;
}

/**
 * The default: everything runs as soon as the resolution unit completes.
 *
 * Order is the deterministic registration order, **then** a seeded shuffle
 * — so the base order never depends on attachment timing, and the
 * randomness is reproducible from the game seed. Triggers raised while
 * draining are appended and run after the current ones, so a chain
 * resolves depth-first within one unit.
 */
export class ImmediateScheduler implements TriggerScheduler {
  readonly #queue: ReadyTrigger[] = [];
  readonly #rng: () => number;

  constructor(rng: () => number) {
    this.#rng = rng;
  }

  enqueue(ready: readonly ReadyTrigger[]): void {
    if (ready.length === 0) return;
    const prepare = [...ready].sort((a, b) => a.id - b.id);
    shuffle(prepare, this.#rng);
    this.#queue.push(...prepare);
  }

  get pending(): number {
    return this.#queue.length;
  }

  async drain(maxRuns: number): Promise<void> {
    let runs = 0;
    while (this.#queue.length > 0) {
      runs += 1;
      if (runs > maxRuns) {
        throw new Error(
          `Trigger queue exceeded max depth ${maxRuns} — possible infinite trigger loop.`,
        );
      }
      await this.#queue.shift()!.run();
    }
  }
}
