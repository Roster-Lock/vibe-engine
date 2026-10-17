/**
 * **`draw(player, count)`** — move `count` cards from the top of a player's
 * library to that player's hand.
 *
 * One function of a player and a number, so the same thing answers a card that
 * says `Draw(you, 2).`, a turn-start rule, and a side's own `draw`. Each card is
 * a real move through the pipeline (`zone:changed`), which is what makes "when
 * you draw a card" writable content.
 *
 * What differs between games is what happens at the edges, so those are the
 * game's to say and the default does the plain thing:
 *
 * - **an empty library** (`onEmpty`) — Hearthstone's fatigue; by default, nothing
 *   happens and the draw simply stops short;
 * - **a full hand** (`maxHand`, `overflow`) — Hearthstone burns the card; by
 *   default there is no limit.
 */
import type { GameEngine, Player } from '../../engine/index.js';

/** `draw(player, count)`. */
export type DrawFn = (player: Player, count: number) => Promise<void>;

export interface DrawRules {
  /** The zone drawn from (top first). */
  readonly library: string;
  /** The zone drawn into. */
  readonly hand: string;
  /** Called once for each card asked for that the library could not supply. */
  readonly onEmpty?: (player: Player) => Promise<void> | void;
  /** The most cards a hand holds. Beyond it, a drawn card goes to `overflow`. */
  readonly maxHand?: number;
  /** Where a card that does not fit goes (a discard pile). Required with `maxHand`. */
  readonly overflow?: string;
}

/**
 * The `draw(player, count)` a game has registered for its engine, if any.
 *
 * A document is compiled once and played on many engines, so the language's
 * `Draw(you, 2).` cannot hold a game's draw (with its fatigue and hand limit)
 * itself; it asks the engine it is running on. A game registers its own at setup
 * with `setEngineDraw`; without one the plain draw is used.
 */
const ENGINE_DRAWS = new WeakMap<GameEngine, DrawFn>();

export function setEngineDraw(engine: GameEngine, draw: DrawFn): void {
  ENGINE_DRAWS.set(engine, draw);
}

export function engineDraw(engine: GameEngine): DrawFn | undefined {
  return ENGINE_DRAWS.get(engine);
}

/** Builds `draw(player, count)` for an engine, under a game's edge rules. */
export function createDraw(engine: GameEngine, rules: DrawRules): DrawFn {
  if (rules.maxHand !== undefined && rules.overflow === undefined) {
    throw new Error('createDraw: a hand limit needs an overflow zone to send the extra card to');
  }
  return async (player, count) => {
    for (let drawn = 0; drawn < count; drawn += 1) {
      const top = engine.zones.zone(rules.library, player)?.top;
      if (!top) {
        await rules.onEmpty?.(player);
        continue;
      }
      const full =
        rules.maxHand !== undefined && (engine.zones.zone(rules.hand, player)?.size ?? 0) >= rules.maxHand;
      await engine.moveTo(top, full ? rules.overflow! : rules.hand, { owner: player, reason: 'draw' });
    }
  };
}
