/**
 * **Interchangeable trigger scheduling** (src/engine/trigger-scheduler.ts).
 *
 * `TriggerStack` keeps the registry, the `when` gate and the execution of
 * a trigger; what order they run in and *when* is a `TriggerScheduler`.
 * That is the one part of dispatch a turn-based game, a card game and a
 * real-time game genuinely disagree on:
 *
 * - turn-based drains everything the moment the resolution unit completes;
 * - a card game puts each one on a stack so players may respond first;
 * - a real-time game has a **frame clock**, so a trigger raised mid-frame
 *   is due on a later frame and a nested chain spreads across frames
 *   rather than resolving in one go.
 *
 * The third is what this file demonstrates, because it is the one the
 * default cannot fake.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  ImmediateScheduler,
  Player,
  auto,
  buff,
  damage,
  type Action,
  type Decision,
  type GameEvent,
  type ReadyTrigger,
  type TriggerScheduler,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

class Idle extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/**
 * A frame-based scheduler, as a real-time game would want it: a trigger
 * raised now is due on the **next** frame, never this one.
 *
 * `drain` therefore does nothing — the engine's resolution unit is not the
 * unit of time any more. `tick` is, and it runs exactly one frame's worth,
 * so a cascade that the default scheduler would resolve in one apply is
 * spread across as many frames as it has waves.
 */
class FrameScheduler implements TriggerScheduler {
  #thisFrame: ReadyTrigger[] = [];
  #nextFrame: ReadyTrigger[] = [];

  enqueue(ready: readonly ReadyTrigger[]): void {
    // Registration order, so frames are reproducible.
    this.#nextFrame.push(...[...ready].sort((a, b) => a.id - b.id));
  }

  get pending(): number {
    return this.#thisFrame.length + this.#nextFrame.length;
  }

  /** The engine's unit is not a frame, so nothing is due here. */
  async drain(): Promise<void> {}

  /** Advances one frame: runs what was raised during the last one. */
  async tick(): Promise<number> {
    this.#thisFrame = this.#nextFrame;
    this.#nextFrame = [];
    const ran = this.#thisFrame.length;
    while (this.#thisFrame.length > 0) {
      await this.#thisFrame.shift()!.run();
    }
    return ran;
  }
}

/** "Whenever anything survives a hit, deal 1 back" — a cascading trigger. */
const retaliate = buff({
  name: 'Retaliate',
  weight: 1,
  abilities: [
    auto({
      name: 'Retaliate',
      event: 'character:survived',
      targets: () => [],
      cast: (ctx): Action[] =>
        ctx.engine
          .validTargets({ who: 'enemy', count: 1 }, ctx.self)
          .map((enemy) => damage(enemy.gauge('hp'), 1, ctx.self)),
    }),
  ],
});

function arena(scheduler?: TriggerScheduler) {
  const events: GameEvent[] = [];
  const engine = createEngine({
    seed: 'scheduler',
    maxActionDepth: 12,
    onEvent: (event) => events.push(event),
    ...(scheduler ? { scheduler } : {}),
  });
  const hero = new Character('Hero', { maxHp: 100, maxMana: 0 });
  const foe = new Character('Foe', { maxHp: 100, maxMana: 0 });
  hero.team = 'you';
  foe.team = 'them';
  engine.registerPlayers([new Idle('You', [hero], 'you'), new Idle('Them', [foe], 'them')]);
  return { engine, hero, foe, events };
}

describe('the default scheduler', () => {
  it('drains everything in one resolution unit', async () => {
    const { engine, hero, foe } = arena();
    await engine.addBuff(hero, retaliate);
    // One hit; the retaliation cascade then runs to the depth guard,
    // because for a turn-based game "now" is the only time there is.
    await expect(engine.apply([damage(foe.gauge('hp'), 1)])).rejects.toThrow(/infinite trigger loop|max depth/);
    expect(foe.gauge('hp').current).toBeLessThan(99);
  });

  it('is what an engine with no scheduler option uses', async () => {
    const { engine } = arena(new ImmediateScheduler(() => 0.5));
    // Constructing one explicitly is the same thing the engine defaults to.
    expect(engine.triggerQueueSize).toBe(0);
  });
});

describe('a frame-based scheduler', () => {
  it('holds a trigger until the next frame, and spreads a cascade across frames', async () => {
    const frames = new FrameScheduler();
    const { engine, hero, foe } = arena(frames);
    await engine.addBuff(hero, retaliate);

    await engine.apply([damage(foe.gauge('hp'), 1)]);
    // The hit landed and the retaliation is *scheduled*, not run — this is
    // the behaviour the default scheduler cannot express.
    expect(foe.gauge('hp').current).toBe(99);
    expect(frames.pending).toBe(1);

    expect(await frames.tick()).toBe(1);
    expect(foe.gauge('hp').current).toBe(98); // one wave

    expect(await frames.tick()).toBe(1);
    expect(foe.gauge('hp').current).toBe(97); // the next wave, a frame later

    // The cascade is still going — but it is bounded by the clock, not by
    // a depth guard, so it never had to be an error.
    expect(frames.pending).toBe(1);
  });

  it('keeps a frame reproducible by registration order', async () => {
    const frames = new FrameScheduler();
    const { engine, hero, foe } = arena(frames);
    // Two copies of the same listener: both are raised by one event, and
    // both run in the frame after it.
    await engine.addBuff(hero, buff({ ...retaliate, stacks: true }));
    await engine.addBuff(hero, buff({ ...retaliate, stacks: true }));
    await engine.apply([damage(foe.gauge('hp'), 1)]);
    expect(frames.pending).toBe(2);
    expect(await frames.tick()).toBe(2);
    expect(foe.gauge('hp').current).toBe(97); // 1 + 1 + 1
  });
});
