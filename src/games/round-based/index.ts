/**
 * **Round-based** — the shared layer for games that play in rounds.
 *
 * Two different games in this repo need the same things, and neither of them is
 * the engine's business:
 *
 * - the **round loop** (`Game`, `Decision`, `GameEndInterrupt`) — implemented
 *   by `LocalGame` for turn-based combat, and extended directly by
 *   `examples/card-game`;
 * - **team outcomes** (`win`/`lose`, `TeamOutcome`) — the "last side standing"
 *   game-over rule this repo's two games share.
 *
 * This layer exists because of a finding worth keeping: the engine used to
 * hardcode *one* outcome model (teams) into its settle loop, so a game could
 * not have a different one. The `card-game` example is what proved these are
 * shared rather than turn-based-combat-specific — it shares none of tinyquest's
 * vocabulary, yet extends `Game` and uses the same outcome rules.
 *
 * Re-exports the whole engine surface, so content needs one import.
 */
export * from '../../engine/index.js';

export { TeamOutcome } from './outcome.js';
export { isAlly, isEnemy, registerTeamTargeting } from './targeting.js';
export { lose, win } from './win-lose.js';
export { startTurn, endTurn } from './turn.js';

import { GameEngine, type EngineOptions } from '../../engine/index.js';
import { TeamOutcome } from './outcome.js';
import { registerTeamTargeting } from './targeting.js';

/**
 * A `GameEngine` with the round-based outcome rules already installed — the
 * batteries-included entry point for a game that ends when the last side
 * falls.
 *
 * `new GameEngine()` remains correct, and is what a game wants when it has no
 * automatic game-over rule (a sandbox) or supplies its own check via
 * `engine.outcomes.add(...)`. The engine no longer assumes either way.
 */
export function createEngine(options: EngineOptions = {}): GameEngine {
  const engine = new GameEngine(options);
  new TeamOutcome().install(engine);
  // `'ally'`/`'enemy'` are this layer's, like the outcome rules — the engine
  // answers only `'self'`/`'any'`.
  registerTeamTargeting(engine);
  return engine;
}
