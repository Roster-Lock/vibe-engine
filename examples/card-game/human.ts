/**
 * The two players a UI needs, on top of `CardPlayer`:
 *
 * - `HumanCardPlayer` — `chooseMove` suspends on a promise the page
 *   resolves when the player clicks. This mirrors `HumanPlayer` in the
 *   turn-based demo (`Player.decide` waits for `submit`), adapted to the
 *   card game's one-move-at-a-time loop.
 * - `PacedGreedyAI` — the greedy opponent with a beat before each move, so
 *   an AI-vs-AI match can be watched instead of finishing instantly.
 */
import {
  PASS,
  type AbilityStackObject,
  type PriorityRequest,
  type PriorityResponse,
  type TriggerOrderRequest,
} from '../../src/games/cards/stack.js';
import type { Card } from './cards.js';
import { GreedyAI, CardPlayer } from './ai.js';
import type { CardGame, Move } from './game.js';

/**
 * A person at the keyboard. The page renders the board for whichever human
 * the game is currently asking, and calls `submitMove` when they commit.
 */
export class HumanCardPlayer extends CardPlayer {
  /** Called when the game starts waiting on this player (a render tick). */
  onWaiting?: () => void;
  #pending: ((move: Move) => void) | undefined;

  override async chooseMove(_game: CardGame): Promise<Move> {
    return new Promise<Move>((resolve) => {
      this.#pending = resolve;
      this.onWaiting?.();
    });
  }

  /** The page calls this when the player has chosen. */
  submitMove(move: Move): void {
    const resolve = this.#pending;
    this.#pending = undefined;
    resolve?.(move);
  }

  /** True while the game is waiting on this player's input. */
  get isWaiting(): boolean {
    return this.#pending !== undefined;
  }

  #pendingPriority: ((response: PriorityResponse) => void) | undefined;

  /**
   * Someone put something on the stack — the page decides whether to answer.
   * The same promise bridge as `chooseMove`, because it is the same kind of
   * wait with a different answer.
   */
  override async takePriority(request: PriorityRequest): Promise<PriorityResponse> {
    // Nothing on the stack means nothing to answer: a proactive instant is
    // offered through `chooseMove` on your own turn, so this is not the
    // place to ask. It also keeps a resolution from re-prompting the table
    // just to confirm the stack is still empty.
    if (request.stack.length === 0) return PASS;
    return new Promise<PriorityResponse>((resolve) => {
      this.#pendingPriority = resolve;
      this.onWaiting?.();
    });
  }

  /** The page calls this with `PASS` or a spell to put on the stack. */
  submitPriority(response: PriorityResponse): void {
    const resolve = this.#pendingPriority;
    this.#pendingPriority = undefined;
    resolve?.(response);
  }

  /** True while the game is waiting on this player to answer the stack. */
  get isResponding(): boolean {
    return this.#pendingPriority !== undefined;
  }

  #pendingOrder:
    | { resolve: (order: readonly AbilityStackObject[]) => void; triggers: readonly AbilityStackObject[] }
    | undefined;

  /**
   * Several of this player's abilities triggered at once: the page lets them
   * choose the order. Same promise bridge as the other two questions — the
   * difference is what comes back.
   */
  override async orderTriggers(request: TriggerOrderRequest): Promise<readonly AbilityStackObject[]> {
    return new Promise<readonly AbilityStackObject[]>((resolve) => {
      this.#pendingOrder = { resolve, triggers: request.triggers };
      this.onWaiting?.();
    });
  }

  /** The triggers waiting to be ordered — what the page lists. */
  get pendingTriggers(): readonly AbilityStackObject[] | undefined {
    return this.#pendingOrder?.triggers;
  }

  /**
   * The page calls this with the triggers in the order they should go **on**
   * the stack (the last one resolves first).
   */
  submitTriggerOrder(order: readonly AbilityStackObject[]): void {
    const pending = this.#pendingOrder;
    this.#pendingOrder = undefined;
    pending?.resolve(order);
  }

  /** True while the game is waiting on this player to order their triggers. */
  get isOrdering(): boolean {
    return this.#pendingOrder !== undefined;
  }
}

/** The greedy AI with a pause (and a render tick) before every move. */
export class PacedGreedyAI extends GreedyAI {
  readonly #beat: () => Promise<void>;

  constructor(name: string, team: string, deck: readonly Card[], beat: () => Promise<void>) {
    super(name, team, deck);
    this.#beat = beat;
  }

  override async chooseMove(game: CardGame): Promise<Move> {
    await this.#beat();
    return super.chooseMove(game);
  }
}
