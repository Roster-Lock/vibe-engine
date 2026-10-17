/**
 * Tests for the interactive card-game loop the UI drives: a human player
 * whose `chooseMove` suspends until the page submits, inside the real
 * `CardGame.runLoop()`.
 *
 * This is the risky part of the UI — everything else is rendering — so it
 * is checked headlessly: the game must *wait* for the human, apply exactly
 * the move they submitted, and then come back and ask again.
 */
import { describe, expect, it } from 'vitest';
import { GreedyAI } from '../examples/card-game/ai.js';
import { ELVEN_ARCHER, STARTER_DECK, type Card } from '../examples/card-game/cards.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { HumanCardPlayer } from '../examples/card-game/human.js';
import { PASS } from '../src/games/cards/stack.js';

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Whether the move is legal right now — the check the UI's buttons make. */
function legalMove(game: CardGame, player: HumanCardPlayer): Move | undefined {
  const side = game.sideOf(player);
  const playable = side.hand.cards
    .filter((card: Card) => card.cost <= side.mana)
    .sort((a, b) => b.cost - a.cost);
  for (const card of playable) {
    const pattern = card.kind === 'spell' ? card.targeting : card.onPlayTargeting;
    if (!pattern) return { kind: 'play', card, targets: [] };
    const targets = game.targetsFor(card, player);
    if (targets.length > 0) return { kind: 'play', card, targets: [targets[0]!] };
  }
  const attacker = game.readyAttackers(side)[0];
  if (attacker) {
    const target = game.attackTargets(attacker)[0];
    if (target) return { kind: 'attack', attacker, target };
  }
  return undefined;
}

describe('interactive card game', () => {
  it('waits for the human, plays the submitted move, then asks again', async () => {
    // A deterministic deck: every card is a 1-cost Elven Archer, so turn 1
    // always has a targeted enters-play effect to play.
    const humanDeck: Card[] = Array.from({ length: 30 }, () => ELVEN_ARCHER);
    const human = new HumanCardPlayer('You', 'you', humanDeck);
    const ai = new GreedyAI('AI', 'ai', STARTER_DECK);
    const game = new CardGame([human, ai], { log: () => {} });

    // A passive human still has to answer priority windows — that is the
    // point of the stack. Answering them is the test driver's job here, and
    // counting them proves the window really opened.
    let priorityWindows = 0;
    const yieldPriority = setInterval(() => {
      if (human.isResponding) {
        priorityWindows += 1;
        human.submitPriority(PASS);
      }
    }, 1);

    const finished = game.runLoop();
    await waitFor(() => human.isWaiting, 'the human’s first turn');

    // Turn 1: one crystal, and the opening hand.
    const side = game.sideOf(human);
    expect(game.turn).toBe(1);
    expect(side.mana).toBe(1);

    const archer = side.hand.cards[0]!;
    expect(archer.printedId).toBe('elven-archer');
    const handBefore = side.hand.size;
    const enemyHero = game.sideOf(ai).hero;
    const hpBefore = enemyHero.gauge('hp').current;
    expect(game.targetsFor(archer, human)).toContain(enemyHero);

    human.submitMove({ kind: 'play', card: archer, targets: [enemyHero] });
    // Casting puts it on the stack: the caster gets priority first, and must
    // pass (with the opponent) before the Archer resolves and arrives.
    await waitFor(() => side.board.length === 1, 'the Archer to land');
    expect(priorityWindows).toBeGreaterThan(0);
    expect(side.hand.size).toBe(handBefore - 1);
    expect(side.mana).toBe(0);
    expect(enemyHero.gauge('hp').current).toBe(hpBefore - 1); // enters-play ping

    // Passing hands the turn to the AI, and control comes back on turn 3.
    human.submitMove({ kind: 'end' });
    await waitFor(() => human.isWaiting && game.turn >= 3, 'the human’s next turn');

    // Then play it out: pass every turn and let the AI finish the job.
    const autoPass = setInterval(() => {
      if (human.isWaiting) human.submitMove({ kind: 'end' });
    }, 1);
    const winners = await finished;
    clearInterval(autoPass);
    clearInterval(yieldPriority);
    expect(Array.isArray(winners)).toBe(true);
    expect(game.turn).toBeGreaterThan(1);
  });

  it('watches a whole match finish without a human', async () => {
    const red = new GreedyAI('Red', 'red', STARTER_DECK);
    const blue = new GreedyAI('Blue', 'blue', STARTER_DECK);
    const game = new CardGame([red, blue], { log: () => {} });
    const winners = await game.runLoop();
    expect(winners.length).toBeGreaterThanOrEqual(0);
    // One hero must have fallen (or the turn cap was reached).
    const defeated = game.players.filter((p) => p.isDefeated);
    expect(defeated.length > 0 || game.turn >= 60).toBe(true);
  });

  it('alternates between two humans in hotseat', async () => {
    const one = new HumanCardPlayer('Player 1', 'one', STARTER_DECK);
    const two = new HumanCardPlayer('Player 2', 'two', STARTER_DECK);
    const game = new CardGame([one, two], { log: () => {} });

    void game.runLoop();
    await waitFor(() => one.isWaiting, 'player 1’s turn');
    expect(two.isWaiting).toBe(false);

    one.submitMove({ kind: 'end' });
    await waitFor(() => two.isWaiting, 'player 2’s turn');
    expect(one.isWaiting).toBe(false);

    two.submitMove({ kind: 'end' });
    await waitFor(() => one.isWaiting, 'player 1’s second turn');
    expect(game.turn).toBe(3);
  });
});
