/**
 * The `win` and `lose` **actions** — declared the way any game declares one.
 *
 * The engine used to carry these in its own `ActionMap`, which meant every game
 * inherited "teams can win and lose" whether it had teams or not. They are
 * declared here by augmenting the map, and executed by handlers `TeamOutcome`
 * registers — the same `declare module` + `engine.actions.register(...)` recipe
 * a content author uses for a `summon`, with nothing privileged about it.
 *
 * The declarations must carry `ActionBase`'s pipeline fields (`source`,
 * `direction`, `bypasses`) or `ActionMapIsWellFormed` rejects them at compile
 * time — the guard that proves a game cannot half-declare an action.
 */
import type { ActionDirection, EventSource, Player } from '../../engine/index.js';

declare module '../../engine/contracts.js' {
  interface ActionMap {
    /** Declares a team (or a specific player) the winner; the game ends. */
    win: {
      type: 'win';
      team: string | Player;
      source?: EventSource;
      direction?: ActionDirection;
      bypasses?: readonly string[];
    };
    /** Marks a team (or a specific player) as lost. */
    lose: {
      type: 'lose';
      team: string | Player;
      source?: EventSource;
      direction?: ActionDirection;
      bypasses?: readonly string[];
    };
  }

  /**
   * The outcome restriction kinds — "cannot win the game" / "cannot lose the
   * game". They were in the engine's `RestrictionKind` union because the engine
   * resolved team outcomes itself; now that outcomes are a game's business
   * (see `./outcome.ts`), the kinds are this layer's to declare.
   */
  interface RestrictionKindMap {
    /** "Cannot win the game" — the team is not crowned by a standing check. */
    win: 'win';
    /** "Cannot lose the game" — the character does not count toward defeat. */
    lose: 'lose';
  }
}

/**
 * Ends the game immediately with the given team (or player) as the winner.
 *
 * Resolution is deferred to the settle boundary, so several teams winning in
 * the same `apply` resolves as a draw. An `on: 'win'` restriction on any of the
 * team's characters blocks the declaration ("cannot win the game").
 */
export function win(team: string | Player, source?: EventSource): { type: 'win'; team: string | Player; source?: EventSource } {
  return { type: 'win', team, ...(source ? { source } : {}) };
}

/** Marks a team (or player) as lost; if only one side remains, it wins. */
export function lose(team: string | Player, source?: EventSource): { type: 'lose'; team: string | Player; source?: EventSource } {
  return { type: 'lose', team, ...(source ? { source } : {}) };
}
