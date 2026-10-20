/**
 * The turn boundary — "a turn starts / ends", and the triggers that hang off
 * it.
 *
 * These were `GameEngine.startTurn()` / `endTurn()`. They are not engine
 * operations: the engine has no turn, and a real-time game would never call
 * them. What they do is announce an event and let its triggers run — which is
 * two lines against the engine's public surface, so the engine need not ship
 * them at all.
 *
 * The two events (`turn:start`, `turn:end`) are declared by augmenting
 * `GameEventMap`, exactly as a game declares an event of its own. They were
 * previously in the engine's map for the same reason `win`/`lose` were in its
 * action map: one game's vocabulary living in the core.
 */
import type { GameEngine, Player } from '../../engine/index.js';

declare module '../../engine/contracts.js' {
  interface GameEventMap {
    /** A turn begins. Announced by `startTurn`; `player` is whose turn it is, when the game says. */
    'turn:start': { type: 'turn:start' } | { type: 'turn:start'; player: Player };
    /** A turn ends. Announced by `endTurn`. */
    'turn:end': { type: 'turn:end' } | { type: 'turn:end'; player: Player };
  }
}

/**
 * Announces the start of a turn and runs the triggers it wakes.
 *
 * `emit` only queues matching listeners; they run when the resolution unit
 * completes. A turn boundary is a resolution unit, so this drains it — a
 * `turn:start` trigger therefore fires before `startTurn()` resolves.
 */
export async function startTurn(engine: GameEngine, player?: Player): Promise<void> {
  await engine.emit(player ? { type: 'turn:start', player } : { type: 'turn:start' });
  await engine.drainTriggers();
}

/** Announces the end of a turn and runs the triggers it wakes. */
export async function endTurn(engine: GameEngine, player?: Player): Promise<void> {
  await engine.emit(player ? { type: 'turn:end', player } : { type: 'turn:end' });
  await engine.drainTriggers();
}
