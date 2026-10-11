/**
 * A Player is one participant in a game — a human, an AI, or a scripted
 * opponent. A player owns a name, an optional team tag, and the characters
 * they control.
 *
 * The one thing every player does each round is **decide**: produce the
 * `Decision`s for their living characters. How that happens is up to the
 * subclass:
 *
 * - a human player waits for input (see `src/ui/human-player.ts`),
 * - a scripted player picks the first skill and first valid targets
 *   (`ScriptedPlayer` in `src/multiplayer/local.ts`),
 * - an AI player picks randomly (`RandomAI` in `src/multiplayer/random-ai.ts`).
 *
 * ```ts
 * const hero = new Character('Hero', { maxHp: 100 });
 * const player = new RandomAI('Hero', [hero], 'party');
 * ```
 */
import { autoChoose, type ChoiceAnswer, type ChoiceRequest } from './choice.js';
import type { Decision } from './game.js';
import type { GameEngine } from './engine.js';
import type { Character } from './character.js';

export abstract class Player {
  /**
   * A stable id for this player. Defaults to a slug of the name; the game
   * seed ceremony sorts contributions by it (`Game.collectSeed`).
   */
  readonly id: string;
  readonly name: string;
  /** Team tag applied to the player's characters. */
  readonly team: string | undefined;
  /** The characters this player controls. */
  readonly characters: readonly Character[];

  constructor(name: string, characters: readonly Character[], team?: string, id?: string) {
    this.id = id ?? (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || name);
    this.name = name;
    this.team = team;
    this.characters = [...characters];
    // Convenience: stamp the team tag and the controller onto the owned
    // characters so the engine can attribute wins and losses.
    for (const character of this.characters) {
      character.controller = this;
      if (team) character.team = team;
    }
  }

  /**
   * True when every owned character is defeated **or destroyed** — a player
   * loses when it has no characters that can still fight, whether their HP
   * crossed zero or a `destroy` action took them out (docs/design/03).
   */
  get isDefeated(): boolean {
    return this.characters.every((character) => character.isDefeated || character.destroyed);
  }

  /** The controlled characters still standing. */
  get livingCharacters(): Character[] {
    return this.characters.filter((character) => !character.isDefeated);
  }

  /** What this player's characters want to do this round. */
  abstract decide(engine: GameEngine): Promise<Decision[]>;

  /**
   * Answers a choice the engine needs **mid-resolution** — which targets,
   * or whether to take an optional effect (see choice.ts).
   *
   * This is the whole of the choice protocol: the chooser is a player, so
   * the player answers. A human implementation waits for input, a remote
   * one goes over the wire, an AI evaluates. The default answers
   * automatically (fewest targets, yes to a confirm), so existing players
   * and tests need no implementation — and a game only overrides it where
   * the decision actually matters.
   *
   * Unlike `decide`, which is asked once a round for everything this
   * player's characters will do, `choose` is asked at the moment an effect
   * needs the answer and may be asked several times while one object
   * resolves, with a different chooser each time.
   */
  async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    return autoChoose(request);
  }

  /**
   * Seed ceremony (optional, both-or-neither). Before the first round the
   * game asks every player that implements these hooks for a **commit** (a
   * hash of the secret it will contribute) and, once all commits are in, for
   * a **reveal** (the secret itself). The revealed secrets — sorted by
   * `id` — become the seed that randomizes trigger order, so no player can
   * pick its contribution after seeing the others'.
   */
  commitSeed?(): string | Promise<string>;
  revealSeed?(): string | Promise<string>;

  toString(): string {
    return this.name;
  }
}
