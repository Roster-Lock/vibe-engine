/**
 * Priority in the card game: casting goes on the stack, and a player may
 * answer with an **instant** before it resolves.
 *
 * This is the whole point of the stack. A spell that is answered resolves
 * *last* — LIFO — and the answer is only legal because the instant symbol
 * (`speed.ts`) says the card may be cast whenever its controller holds
 * priority, not just in their own main phase.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import type { Card } from '../examples/card-game/cards.js';
import { playableCards } from '../examples/card-game/english.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { PASS, put, type PriorityRequest, type PriorityResponse } from '../src/games/cards/stack.js';
import { instant, isInstant } from '../src/games/cards/speed.js';
import { isDamage, type GameEvent } from '../src/games/turn-based/index.js';

class ScriptedCardPlayer extends CardPlayer {
  #script: ((game: CardGame) => Move)[] = [];

  script(...moves: ((game: CardGame) => Move)[]): this {
    this.#script = [...moves];
    return this;
  }

  override async chooseMove(game: CardGame): Promise<Move> {
    const next = this.#script.shift();
    return next ? next(game) : { kind: 'end' };
  }
}

/** A scripted player that also answers the stack with its instants. */
class ResponderCardPlayer extends ScriptedCardPlayer {
  responses = 0;

  override async takePriority(request: PriorityRequest): Promise<PriorityResponse> {
    const game = this.game;
    if (!game || request.stack.length === 0) return PASS;
    const side = game.sideOf(this);
    // Only something it can actually aim: an affordable instant with a legal
    // enemy target.
    const answer = side.hand.cards.find(
      (card) =>
        isInstant(card) &&
        card.cost <= side.mana &&
        game.targetsFor(card, this).some((t) => t.controller !== this),
    );
    if (!answer) return PASS;
    const target = game.targetsFor(answer, this).find((t) => t.controller !== this)!;
    if (!(await game.chargeFor(answer, this))) return PASS;
    this.responses += 1;
    return put(game.castObject(answer, this, [target]));
  }
}

const deckOf = (card: Card, n = 30): Card[] => Array.from({ length: n }, () => card);

/** A 1-cost instant bolt, authored in English and marked instant in code. */
function bolt(): Card {
  const { cards } = playableCards(
    ['Card Test Bolt', 'Cost 1', 'Spell', 'Deal 3 damage to target enemy character.'].join('\n'),
  );
  return instant(cards[0]!);
}

async function turn(game: CardGame): Promise<void> {
  await game.collectUserDecisions();
  await game.runGame();
}

describe('the stack in the card game', () => {
  it('casts onto the stack instead of resolving immediately', async () => {
    const card = bolt();
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(card));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(card));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const bobHero = game.sideOf(bob).hero;
    // Alice's spell is on the stack when Bob is asked for priority, and the
    // hero is untouched until everyone passes.
    const seen: string[] = [];
    bob.game = game;
    const originalTake = bob.takePriority.bind(bob);
    bob.takePriority = async (request: PriorityRequest): Promise<PriorityResponse> => {
      seen.push(`stack:${request.stack.length}`);
      return originalTake(request);
    };

    alice.script(() => ({
      kind: 'play',
      card: game.sideOf(alice).hand.cards[0]!,
      targets: [bobHero],
    }));
    await turn(game);

    expect(seen).toContain('stack:1');
    expect(bobHero.gauge('hp').current).toBe(27);
  });

  it('lets the opponent answer with an instant, and resolves it first', async () => {
    const card = bolt();
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(card));
    const bob = new ResponderCardPlayer('Bob', 'b', deckOf(card));
    const events: GameEvent[] = [];
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3, onEvent: (e) => events.push(e) });
    await game.setup();

    const aliceHero = game.sideOf(alice).hero;
    const bobHero = game.sideOf(bob).hero;

    // Two turns of nothing, so Bob has a mana crystal to answer with: mana
    // is refilled at *his* upkeep, and turn 1 is Alice's.
    await turn(game);
    await turn(game);
    expect(game.sideOf(bob).mana).toBeGreaterThanOrEqual(1);

    alice.script(() => ({ kind: 'play', card: game.sideOf(alice).hand.cards[0]!, targets: [bobHero] }));
    await turn(game);

    // Bob answered.
    expect(bob.responses).toBe(1);
    // Both resolved: each hero took a bolt.
    expect(bobHero.gauge('hp').current).toBe(27);
    expect(aliceHero.gauge('hp').current).toBe(27);

    // LIFO: the response resolved before the spell it answered.
    const damaged = events
      .filter(isDamage)
      .filter((event) => 'target' in event)
      .map((event) => (event as { target: { name: string } }).target.name);
    expect(damaged).toEqual(['Alice', 'Bob']);
  });

  it('does not offer a sorcery as an answer', async () => {
    // The same card, unmarked: sorcery speed, so it cannot respond — and
    // cannot be cast at all on someone else's turn.
    const { cards } = playableCards(
      ['Card Test Bolt', 'Cost 1', 'Spell', 'Deal 3 damage to target enemy character.'].join('\n'),
    );
    const slow = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(bolt()));
    const bob = new ResponderCardPlayer('Bob', 'b', deckOf(slow));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const bobHero = game.sideOf(bob).hero;
    const aliceHero = game.sideOf(alice).hero;
    await turn(game); // turn 1
    await turn(game); // turn 2 — Bob's crystal
    alice.script(() => ({ kind: 'play', card: game.sideOf(alice).hand.cards[0]!, targets: [bobHero] }));
    await turn(game);

    // Bob had a card and the mana, but no instant: he passed.
    expect(bob.responses).toBe(0);
    expect(bobHero.gauge('hp').current).toBe(27);
    expect(aliceHero.gauge('hp').current).toBe(30);
  });
});
