/**
 * Local play: a concrete `Game` that runs players against each other on one
 * machine. Each player supplies its own decisions via `Player.decide`, so
 * the same game loop works with scripted opponents (`ScriptedPlayer`), an
 * AI (`RandomAI` in `./random-ai.ts`), or a human (`HumanPlayer` in
 * `../ui/human-player.ts`).
 *
 * ```ts
 * const game = new LocalGame([
 *   new ScriptedPlayer('Hero', [hero], 'party'),
 *   new RandomAI('Goblins', [goblin], 'monsters'),
 * ], { onEvent: log });
 *
 * const winners = await game.runLoop();   // Player[]
 * ```
 */
import {
  Game,
  GameEndInterrupt,
  GameEngine,
  Player,
  chosenCharacters,
  commitSecret,
  type Decision,
  type GameEvent,
} from '../engine/index.js';
// Initiative is this game's policy, not the engine's (see the module docs).
import { createEngine, sortBySpeed } from '../games/turn-based/index.js';
import { endTurn, startTurn } from '../games/round-based/index.js';

/**
 * A player that always uses its first manual skill on the first valid
 * target — deterministic, handy for tests and scripted battles. It also
 * contributes a deterministic secret to the seed ceremony, so scripted
 * battles replay with the same trigger order.
 */
export class ScriptedPlayer extends Player {
  /** Deterministic per player: same players ⇒ same game seed. */
  readonly #secret = `scripted:${this.id}`;

  override commitSeed(): string {
    return commitSecret(this.#secret);
  }

  override revealSeed(): string {
    return this.#secret;
  }

  async decide(engine: GameEngine): Promise<Decision[]> {
    const decisions: Decision[] = [];
    for (const character of this.livingCharacters) {
      const ability = character.manualAbilities[0];
      if (!ability) continue;
      // Its own `choose` picks the targets — the base implementation takes
      // the fewest the pattern allows. This used to hand the question to a
      // private `AutoHost`, which was the design hinting that the method
      // belongs on the player (see choice.ts).
      const answer = await this.choose({
        kind: 'select',
        prompt: ability.name,
        chooser: this,
        options: engine.validTargets(ability.targeting, character),
        count: ability.targeting.count ?? 1,
        source: character,
        pattern: ability.targeting,
      });
      decisions.push({
        character,
        ability,
        targets: chosenCharacters(answer),
      });
    }
    return decisions;
  }
}

export interface LocalGameOptions {
  /** Round cap; the game ends as a draw once exceeded. Defaults to 100. */
  readonly maxRounds?: number;
  /** Optional observer for engine events (logging, UI hooks). */
  readonly onEvent?: (event: GameEvent) => void;
}

/**
 * A local battle: every round, each player's living characters decide what
 * to do, then the round is applied — in **initiative order** (descending
 * character speed, fastest first). The players are registered with the
 * engine, so wins and losses are decided by the engine's state-based
 * actions: as soon as a blow (or a `win`/`lose` action) leaves only one
 * team standing, the engine throws a `GameEndInterrupt` with that team's
 * players. The game also ends as a draw when the round cap is hit.
 */
export class LocalGame extends Game {
  readonly engine: GameEngine;
  readonly #maxRounds: number;
  #round = 0;

  constructor(players: Player[], options: LocalGameOptions = {}) {
    super(players);
    this.#maxRounds = options.maxRounds ?? 100;
    this.engine = createEngine({
      onEvent: options.onEvent,
    });
    this.engine.registerPlayers(players);
  }

  async collectUserDecisions(): Promise<Decision[]> {
    // Derived stats reflect the world as settled at the last apply — refresh
    // before the players decide and before initiative reads `speed`.
    await this.engine.refreshDerivedStats();
    await startTurn(this.engine);
    const decisions: Decision[] = [];
    for (const player of this.players) {
      decisions.push(...(await player.decide(this.engine)));
    }
    return decisions;
  }

  /** Forwards the commit/reveal game seed to the engine before round 1. */
  protected override async applySeed(seed: string | undefined): Promise<void> {
    if (seed !== undefined) this.engine.setSeed(seed);
  }

  async runGame(decisions: Decision[]): Promise<void> {
    this.#round += 1;
    if (this.#round > this.#maxRounds) throw new GameEndInterrupt([]); // draw

    // Initiative: the round's moves run in descending character speed, so
    // the fastest character acts first. Equal speeds are grouped and
    // shuffled with the engine's seeded PRNG — same seed, same tie order.
    for (const decision of sortBySpeed(decisions, () => this.engine.random())) {
      try {
        await this.engine.useAbility(decision.character, decision.ability, {
          targets: decision.targets,
        });
      } catch (error) {
        // Decisions are made at round start, but moves run in speed order —
        // a faster move may destroy a character before a later move's turn.
        // A move whose targets are gone **fizzles** (it does not abort the
        // round); the engine's targeting pool excludes the graveyard, so
        // "cannot target" here means the target left play. Any other error
        // is real and still propagates.
        if (!(error instanceof Error) || !error.message.includes('cannot target')) {
          throw error;
        }
      }
    }
    await endTurn(this.engine);

    // Win/lose is the engine's job now: as soon as a blow leaves one team
    // standing, `useAbility`/`endTurn` throws the GameEndInterrupt above.
  }
}
