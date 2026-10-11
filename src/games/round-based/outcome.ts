/**
 * **Round-based outcomes** — teams, `win`/`lose`, and the game-over check.
 *
 * This is the layer that used to be `src/engine/teams.ts`, wired into the
 * engine's settle loop whether a game wanted team-based defeat or not. It is a
 * *game's* answer to "when is this over", and it is built entirely from the
 * engine's extension seams — which makes it the clearest demonstration that
 * they work:
 *
 * 1. the `win` and `lose` **actions** are declared by augmenting `ActionMap`
 *    (`./win-lose.ts`), exactly as any other game declares an action;
 * 2. their **handlers** are registered with `engine.actions.register(...)`;
 * 3. the **game-over check** is registered with `engine.outcomes.add(...)`,
 *    so the engine asks the question at its settle boundaries without knowing
 *    what a team is.
 *
 * Nothing here edits the engine. A card game can use `Game`/`GameEndInterrupt`
 * without using `TeamOutcome`, and a sandbox can use neither.
 *
 * ## The outcome
 *
 * Two independent facts decide it:
 *
 * - **who has won** — teams explicitly marked via a `win` action. Exactly one
 *   winner ends the game with that team's players; **two or more winners at
 *   the same time is a draw**.
 * - **who is still standing** — teams not marked lost and with a player who
 *   still has a living character. With no explicit winner, exactly one
 *   standing team wins, and **when all remaining teams lose at the same time
 *   it is a draw**.
 *
 * Two of the engine's restriction gates feed in, through the predicates it
 * exposes (docs/design/11-restrictions.md):
 *
 * - `engine.deadForDefeat(character)` — a character at 0 whose death rule is
 *   gated ("indestructible") is *not* dead and keeps its owner in the game.
 * - `engine.cannotWin(players)` — a team with a matching `on: 'win'`
 *   restriction is not crowned by the standing rule; the game simply does not
 *   end that way.
 */
import {
  GameEndInterrupt,
  type Character,
  type GameEngine,
  type Player,
} from '../../engine/index.js';

/** Human-readable label for a team key in error messages. */
const teamLabel = (key: string | Player): string => (typeof key === 'string' ? key : key.name);

export class TeamOutcome {
  /** Teams explicitly marked as lost via `lose` actions. */
  readonly #lostTeams = new Set<string | Player>();
  /** Teams explicitly marked as won via `win` actions. */
  readonly #wonTeams = new Set<string | Player>();

  /**
   * Installs this outcome on an engine: registers the `win`/`lose` handlers
   * and the game-over check. Returns `this`, so a caller can keep the handle.
   */
  install(engine: GameEngine): this {
    engine.actions.register('win', (action, ctx) => {
      if (blocked(engine, 'win', action.team, action.bypasses, ctx.source)) return;
      this.markWon(engine, action.team);
    });
    engine.actions.register('lose', (action, ctx) => {
      if (blocked(engine, 'lose', action.team, action.bypasses, ctx.source)) return;
      this.markLost(engine, action.team);
    });
    engine.outcomes.add((live) => this.check(live));
    return this;
  }

  /**
   * Declares a side the winner. Validation + marker only; resolution is
   * deferred to the settle boundary so several teams can win in the same
   * `apply` (which resolves as a draw).
   */
  markWon(engine: GameEngine, side: string | Player): void {
    const key = teamKey(side);
    if (playersInTeam(engine, key).length === 0) {
      throw new Error(`win: no registered players on team "${teamLabel(key)}"`);
    }
    this.#wonTeams.add(key);
  }

  /** Marks a side as lost. Validation + marker only; resolution is deferred. */
  markLost(engine: GameEngine, side: string | Player): void {
    const key = teamKey(side);
    if (playersInTeam(engine, key).length === 0) {
      throw new Error(`lose: no registered players on team "${teamLabel(key)}"`);
    }
    this.#lostTeams.add(key);
  }

  /**
   * The game-over check, run at every settle boundary. No-op while no players
   * are registered — a bare engine with characters only never ends the game.
   *
   * Throws `GameEndInterrupt` to end the game.
   */
  check(engine: GameEngine): void {
    const players = engine.players;
    if (players.length === 0) return;
    const teams = groupByTeam(players);

    const won = [...teams.entries()].filter(([key]) => this.#wonTeams.has(key));
    if (won.length === 1) {
      throw new GameEndInterrupt(won[0]![1]);
    }
    if (won.length > 1) {
      throw new GameEndInterrupt([]); // two teams won at once: ambiguous, draw
    }

    const standing = [...teams.entries()].filter(([key]) => !this.#teamLost(key, teams, engine));
    if (standing.length === 1) {
      // A team that "cannot win the game" is not determined the winner by the
      // standing rule — the game simply does not end that way. The block is
      // about *this* team's crowning only: other standing teams are
      // unaffected, and a blocked lone survivor is a stalemate until the
      // state changes (or the team loses).
      if (!cannotWin(engine, standing[0]![1])) {
        throw new GameEndInterrupt(standing[0]![1]);
      }
    }
    if (standing.length === 0) {
      throw new GameEndInterrupt([]); // everyone fell at once: draw
    }
  }

  /** True when a team has no players still standing (or was marked lost). */
  #teamLost(
    key: string | Player,
    teams: Map<string | Player, Player[]>,
    engine: GameEngine,
  ): boolean {
    if (this.#lostTeams.has(key)) return true;
    const players = teams.get(key) ?? [];
    return players.every((player) =>
      player.characters.every((character) => deadForDefeat(engine, character)),
    );
  }
}

/** The group key for a side: its team tag, or the player itself when teamless. */
function teamKey(side: string | Player): string | Player {
  return typeof side === 'string' ? side : (side.team ?? side);
}

/** Registered players grouped by team; teamless players are their own team. */
function groupByTeam(players: readonly Player[]): Map<string | Player, Player[]> {
  const teams = new Map<string | Player, Player[]>();
  for (const player of players) {
    const key = teamKey(player);
    const list = teams.get(key);
    if (list) list.push(player);
    else teams.set(key, [player]);
  }
  return teams;
}

/** The registered players on a team (empty when the team is unknown). */
function playersInTeam(engine: GameEngine, key: string | Player): Player[] {
  return groupByTeam(engine.players).get(key) ?? [];
}

/**
 * The `on: 'win'` / `on: 'lose'` restriction gate — "cannot win / cannot lose
 * the game". A plain block, not a replacement effect: the attempt is blocked
 * when **any** character of the affected team carries a matching restriction.
 */
function blocked(
  engine: GameEngine,
  kind: 'win' | 'lose',
  side: string | Player,
  bypasses: readonly string[] | undefined,
  source: Parameters<GameEngine['attemptBlocked']>[0]['ctx']['source'],
): boolean {
  return playersInTeam(engine, teamKey(side)).some((player) =>
    player.characters.some(
      (character) =>
        engine.attemptBlocked({
          kind,
          target: character,
          bypasses,
          ctx: { self: character, source, sourceCharacter: undefined, engine },
        }) !== undefined,
    ),
  );
}

/** Type-only re-export so consumers can name the shape without the engine. */
export type { Character };

/**
 * Whether a character counts as **dead for defeat**.
 *
 * True when it is destroyed, **or** when a gauge rule currently fires on one of
 * its gauges (its `then` destroys it) and the destruction is not gated — the
 * destroy phase would take it, and an outcome check runs before that phase. A
 * character whose destruction is gated ("indestructible") is *not* dead. An
 * `on: 'lose'` restriction keeps a character from counting toward defeat no
 * matter its state.
 *
 * This composes three facts the engine exposes — `attemptBlocked`,
 * `wouldBeDestroyed` and `canDestroy` — with the `'lose'` kind this layer
 * declares. The engine deliberately does not know that rule.
 */
export function deadForDefeat(engine: GameEngine, character: Character): boolean {
  if (blockedBy(engine, 'lose', character)) return false;
  return character.destroyed || (engine.wouldBeDestroyed(character) && engine.canDestroy(character));
}

/**
 * Whether a side **cannot win the game** — any of these characters carries a
 * matching `on: 'win'` restriction. A blocked team is not crowned by the
 * standing check; the game simply does not end that way.
 */
export function cannotWin(engine: GameEngine, players: readonly Player[]): boolean {
  return players.some((player) => player.characters.some((c) => blockedBy(engine, 'win', c)));
}

/** A state-based restriction attempt against one character, with no actor. */
function blockedBy(engine: GameEngine, kind: 'win' | 'lose', character: Character): boolean {
  return (
    engine.attemptBlocked({ kind, target: character, ctx: engine.stateAttempt(character) }) !==
    undefined
  );
}
