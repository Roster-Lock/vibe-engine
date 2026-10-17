/**
 * The `Game` class is the top-level driver that connects the engine to
 * whoever is playing — a local player, a UI, an AI, or a network peer.
 *
 * A Game subclass answers two questions every round:
 *
 * - `collectUserDecisions()` — what does each player want to do this round?
 * - `runGame(decisions)`     — apply those decisions to the world (and,
 *   usually, check whether the game is over).
 *
 * `runLoop()` repeats that cycle until a `GameEndInterrupt` ends the game,
 * and returns the winning `Player`s.
 *
 * ```ts
 * class BattleGame extends Game {
 *   async collectUserDecisions() { ...ask the players... }
 *   async runGame(decisions) { ...apply via the engine... }
 * }
 *
 * const winners = await new BattleGame(...).runLoop();
 * ```
 */
import { OutOfGasError } from './gas.js';
import type { Ability } from './ability/index.js';
import type { Character } from './character.js';
import type { Player } from './player.js';
import { buildSeed, verifyCommit, type SeedContribution } from './seed.js';

/**
 * One player's decision for a round: use an ability on some targets.
 *
 * `ability` should be a manual ability owned by `character` (see
 * `Character.manualAbilities`), and `targets` should sit inside its
 * targeting pattern — `GameEngine.useAbility` enforces both.
 */
export interface Decision {
  /** The character taking the action. */
  readonly character: Character;
  /** The ability (skill) the character is using. */
  readonly ability: Ability;
  /** The chosen targets. */
  readonly targets: Character[];
}

/**
 * Thrown — usually from `runGame` — to end the game loop with winners.
 *
 * `runLoop` catches it and returns the winners; any other error propagates
 * to the caller of `runLoop`.
 */
export class GameEndInterrupt extends Error {
  /** The winning players (empty = a draw). */
  readonly winners: Player[];

  constructor(winners: Player[], message = 'Game ended') {
    super(message);
    this.name = 'GameEndInterrupt';
    this.winners = winners;
  }
}

/** A player that participates in the seed ceremony (see `Game.collectSeed`). */
type SeedParticipant = Player & {
  commitSeed: () => string | Promise<string>;
  revealSeed: () => string | Promise<string>;
};

/**
 * The base class for a whole game session.
 *
 * Subclasses provide `collectUserDecisions` (how the players' choices are
 * gathered) and `runGame` (how a round is applied to the world). The loop
 * itself is fixed:
 *
 * ```
 * while (true) {
 *   const decisions = await this.collectUserDecisions();
 *   await this.runGame(decisions);
 * }
 * ```
 *
 * It ends when `runGame` throws a `GameEndInterrupt`, and returns that
 * interrupt's winners.
 */
export abstract class Game {
  /** The players taking part in this game. */
  readonly players: Player[];

  constructor(players: Player[] = []) {
    this.players = [...players];
  }

  /** Ask the players what they want to do this round. */
  abstract collectUserDecisions(): Promise<Decision[]>;

  /** Apply the round's decisions to the world. */
  abstract runGame(decisions: Decision[]): Promise<void>;

  /**
   * The commit/reveal seed ceremony, run before the first round. Every
   * player that implements both `commitSeed` and `revealSeed` first hands
   * over a blind commit; once all commits are in, each reveals its secret,
   * which is verified against its commit. The revealed secrets — sorted by
   * player id — are combined into the game seed (see `buildSeed`).
   *
   * Returns `undefined` when no player contributes, in which case the engine
   * keeps its own seed.
   */
  async collectSeed(): Promise<string | undefined> {
    const participants: SeedParticipant[] = this.players.filter(
      (player): player is SeedParticipant =>
        player.commitSeed !== undefined && player.revealSeed !== undefined,
    );
    if (participants.length === 0) return undefined;

    // Phase 1 — blind commits from everyone, before any secret is revealed.
    const commits = new Map<Player, string>();
    for (const player of participants) {
      commits.set(player, await player.commitSeed());
    }

    // Phase 2 — reveal, checking every secret against its commit.
    const entries: SeedContribution[] = [];
    for (const player of participants) {
      const secret = await player.revealSeed();
      const commit = commits.get(player);
      if (commit === undefined || !verifyCommit(commit, secret)) {
        throw new Error(
          `Seed ceremony: "${player.name}" revealed a secret that does not match its commit.`,
        );
      }
      entries.push({ playerId: player.id, secret });
    }
    return buildSeed(entries);
  }

  /**
   * Called with the game's seed before the first round — override it to
   * forward the seed to your engine (e.g. `engine.setSeed(seed)`). The
   * default does nothing; `seed` is `undefined` when no player contributed.
   */
  protected async applySeed(seed: string | undefined): Promise<void> {
    void seed;
  }

  /**
   * The main loop: collect the seed, collect decisions, run the round,
   * repeat. Ends when a `GameEndInterrupt` is thrown (returning its
   * winners); all other errors propagate to the caller.
   */
  async runLoop(): Promise<Player[]> {
    await this.applySeed(await this.collectSeed());
    try {
      while (true) {
        const decisions = await this.collectUserDecisions();
        await this.runGame(decisions);
      }
    } catch (error) {
      if (error instanceof GameEndInterrupt) return error.winners;
      // A loop nobody can stop is a draw (the engine has already announced
      // `gas:exhausted`). Magic's rule for a mandatory infinite loop, and the only
      // fair way to end a game that cannot go on.
      if (error instanceof OutOfGasError) return [];
      throw error;
    }
  }
}
