/**
 * The trigger-ordering question, end to end through the card game.
 *
 * The stack-level rules are in `test/trigger-order.test.ts`. This checks the
 * plumbing a player actually touches: two abilities of one creature trigger
 * at once, the **human** is asked to order them, and the order they picked
 * is what the other player sees on the stack.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import { WISP, type Card } from '../examples/card-game/cards.js';
import { playableCards } from '../examples/card-game/english.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { HumanCardPlayer } from '../examples/card-game/human.js';
import { PASS, type PriorityRequest, type PriorityResponse } from '../src/games/cards/stack.js';

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** An opponent that records every stack it is shown, and always passes. */
class RecordingAI extends CardPlayer {
  readonly stacks: string[][] = [];

  override async takePriority(request: PriorityRequest): Promise<PriorityResponse> {
    this.stacks.push(request.stack.map((object) => object.name));
    return PASS;
  }

  async chooseMove(): Promise<Move> {
    return { kind: 'end' };
  }
}

const deckOf = (card: Card, n = 30): Card[] => Array.from({ length: n }, () => card);

/** A creature with **two** abilities that trigger on the same event. */
function herald(): Card {
  const { cards } = playableCards(
    [
      'Card Test Herald',
      'Cost 1',
      'Creature 1/1',
      'When this enters play from active then Deal 1 damage to all enemy characters.',
      'When this enters play from active then Deal 2 damage to all enemy characters.',
    ].join('\n'),
  );
  return cards[0]!;
}

describe('ordering triggers in the card game', () => {
  it('asks the human when two of their abilities trigger at once, and uses their order', async () => {
    const human = new HumanCardPlayer('You', 'you', deckOf(herald()));
    const ai = new RecordingAI('AI', 'ai', deckOf(WISP));
    const game = new CardGame([human, ai], { log: () => {}, openingHand: 3 });

    // Pass priority whenever the game asks, so the stack drains by itself.
    const passer = setInterval(() => {
      if (human.isResponding) human.submitPriority(PASS);
    }, 1);

    const finished = game.runLoop();
    await waitFor(() => human.isWaiting, 'the first turn');

    const side = game.sideOf(human);
    const card = side.hand.cards[0]!;
    expect(card.printedId).toBe('authored-test-herald');
    human.submitMove({ kind: 'play', card, targets: [] });

    await waitFor(() => human.isOrdering, 'the trigger-ordering question');
    const asked = human.pendingTriggers!;
    expect(asked).toHaveLength(2);

    // "Put deal-2 on the stack first, then deal-1": deal-1 is on top, so it
    // resolves first. (Deliberately not the default order, so the assertion
    // below cannot pass by accident.)
    const chosen = [asked[1]!, asked[0]!];
    human.submitTriggerOrder(chosen);

    await waitFor(() => side.board.length === 1, 'the Herald to land');
    // Wait for the *triggers* to reach the opponent, not merely for an empty
    // stack — there is a moment between the creature resolving and its
    // abilities being put on the stack.
    await waitFor(() => ai.stacks.some((names) => names.length === 2), 'the triggers to reach the opponent');
    await waitFor(
      () => game.cardStack.size === 0 && game.cardStack.pendingTriggered.length === 0,
      'the triggers to resolve',
    );

    // The opponent watched the order the human chose. `request.stack` is
    // top-first, and the human's answer is the order the triggers go *on* the
    // stack — so the last one they picked is the first name here.
    const bothOnTheStack = ai.stacks.find((names) => names.length === 2)!;
    expect(bothOnTheStack).toEqual([asked[0]!.name, asked[1]!.name]);
    // The default (registration order) would have put the other one on top.
    expect(bothOnTheStack).not.toEqual([asked[1]!.name, asked[0]!.name]);

    // Play it out so the loop is not left suspended.
    const endTurns = setInterval(() => {
      if (human.isWaiting) human.submitMove({ kind: 'end' });
      if (human.isResponding) human.submitPriority(PASS);
    }, 1);
    await finished;
    clearInterval(endTurns);
    clearInterval(passer);
  });

  it('does not ask when only one ability triggers', async () => {
    const { cards } = playableCards(
      [
        'Card Test Warden',
        'Cost 1',
        'Creature 1/1',
        'When this enters play from active then Deal 1 damage to all enemy characters.',
      ].join('\n'),
    );
    const human = new HumanCardPlayer('You', 'you', deckOf(cards[0]!));
    const ai = new RecordingAI('AI', 'ai', deckOf(WISP));
    const game = new CardGame([human, ai], { log: () => {}, openingHand: 3 });

    const passer = setInterval(() => {
      if (human.isResponding) human.submitPriority(PASS);
    }, 1);

    const finished = game.runLoop();
    await waitFor(() => human.isWaiting, 'the first turn');
    const side = game.sideOf(human);
    human.submitMove({ kind: 'play', card: side.hand.cards[0]!, targets: [] });
    await waitFor(() => side.board.length === 1, 'the Warden to land');

    // One trigger is not a question: the game never stopped to ask.
    expect(human.isOrdering).toBe(false);

    const endTurns = setInterval(() => {
      if (human.isWaiting) human.submitMove({ kind: 'end' });
      if (human.isResponding) human.submitPriority(PASS);
    }, 1);
    await finished;
    clearInterval(endTurns);
    clearInterval(passer);
  });
});
