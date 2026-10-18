/**
 * Triggered abilities are **respondable to**.
 *
 * The engine is pointed at `CardStack.scheduler()`, so a trigger does not run
 * when it fires — it is queued and put on the stack at the next priority
 * window (Magic rule 603.3). These tests hold that to account: a trigger is
 * visible on the stack, the opponent can answer it, and the answer resolves
 * before the trigger does.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import type { Card } from '../examples/card-game/cards.js';
import { playableCards } from '../examples/card-game/english.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { PASS, put, type PriorityRequest, type PriorityResponse } from '../src/games/cards/stack.js';
import { instant } from '../src/games/cards/speed.js';
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

/** Records every stack it is shown, and answers ability objects with a bolt. */
class ResponderToTriggers extends ScriptedCardPlayer {
  readonly stackNames: string[][] = [];
  responses = 0;

  override async takePriority(request: PriorityRequest): Promise<PriorityResponse> {
    this.stackNames.push(request.stack.map((object) => object.name));
    const game = this.game;
    if (!game || request.stack.length === 0) return PASS;
    // Answer a *triggered ability*, not a spell: the point here is that a
    // trigger is a stack object like any other.
    if (!request.stack.some((object) => object.kind === 'ability')) return PASS;
    const side = game.sideOf(this);
    const answer = side.hand.cards.find(
      (card) => card.cost <= side.mana && game.targetsFor(card, this).some((t) => t.controller !== this),
    );
    if (!answer) return PASS;
    // Aim at the enemy *hero* — a hero has no `power` stat, a creature does.
    const target = game
      .targetsFor(answer, this)
      .find((t) => t.controller !== this && t.stat('power') === undefined)!;
    if (!(await game.chargeFor(answer, this))) return PASS;
    this.responses += 1;
    return put(game.castObject(answer, this, [target]));
  }
}

const deckOf = (card: Card, n = 30): Card[] => Array.from({ length: n }, () => card);

/** A creature whose arrival effect is a real zone trigger (it picks no target). */
function warden(): Card {
  const { cards } = playableCards(
    [
      'Card Test Warden',
      '{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 1 } }',
      'When this enters play from active then Deal 2 damage to all enemy characters.',
    ].join('\n'),
  );
  return cards[0]!;
}

/** A 1-cost instant bolt. */
function bolt(): Card {
  const { cards } = playableCards(
    ['Card Test Bolt', '{ "cost": 1, "type": "spell" }', 'Deal 3 damage to target enemy character.'].join('\n'),
  );
  return instant(cards[0]!);
}

async function turn(game: CardGame): Promise<void> {
  await game.collectUserDecisions();
  await game.runGame();
}

describe('triggered abilities on the stack', () => {
  it('puts a trigger on the stack instead of running it, and lets it be answered', async () => {
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(warden()));
    const bob = new ResponderToTriggers('Bob', 'b', deckOf(bolt()));
    const events: GameEvent[] = [];
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3, onEvent: (e) => events.push(e) });
    await game.setup();

    const aliceHero = game.sideOf(alice).hero;
    const bobHero = game.sideOf(bob).hero;

    // Two turns of nothing, so Bob has a mana crystal to answer with.
    await turn(game);
    await turn(game);
    expect(game.sideOf(bob).mana).toBeGreaterThanOrEqual(1);

    alice.script(() => ({ kind: 'play', card: game.sideOf(alice).hand.cards[0]!, targets: [] }));
    await turn(game);

    // The arrival trigger was a stack object — Bob was shown it, by name,
    // with his bolt able to go on top of it.
    expect(bob.stackNames.some((names) => names.some((n) => n.includes('enters play from active')))).toBe(true);
    // He answered it...
    expect(bob.responses).toBe(1);
    // ...and both effects happened: his bolt, then the trigger.
    expect(aliceHero.gauge('hp').current).toBe(27);
    expect(bobHero.gauge('hp').current).toBe(28);

    // LIFO again: the answer resolved before the trigger it answered.
    const damaged = events
      .filter(isDamage)
      .filter((event) => 'target' in event)
      .map((event) => (event as { target: { name: string } }).target.name);
    expect(damaged).toEqual(['Alice', 'Bob']);
  });

  it('resolves a trigger even when nobody answers it', async () => {
    const card = warden();
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(card));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(card));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const bobHero = game.sideOf(bob).hero;
    alice.script(() => ({ kind: 'play', card: game.sideOf(alice).hand.cards[0]!, targets: [] }));
    await turn(game);

    // The window opened and closed, and the trigger still ran.
    expect(bobHero.gauge('hp').current).toBe(28);
    expect(game.cardStack.size).toBe(0);
    expect(game.cardStack.pendingTriggered).toHaveLength(0);
  });

  it('opens a window for a trigger raised by an attack, not just by a cast', async () => {
    // Attacks are immediate, so the window for what they trigger has to be
    // opened by the game (`settleTriggers`), not by the stack.
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(warden()));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(warden()));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const side = game.sideOf(alice);
    // Turn 1: Alice plays a warden (its arrival trigger opens a window).
    alice.script(() => ({ kind: 'play', card: side.hand.cards[0]!, targets: [] }));
    await turn(game);
    // Turn 2: Bob passes, which wakes Alice's creature for turn 3.
    await turn(game);
    // Turn 3: Alice attacks with it — and the attack's triggers need a window.
    alice.script((g) => ({ kind: 'attack', attacker: g.sideOf(alice).board[0]!, target: g.sideOf(bob).hero }));
    await turn(game);

    // Nothing is left waiting: every trigger an attack raised got its window.
    expect(game.cardStack.size).toBe(0);
    expect(game.cardStack.pendingTriggered).toHaveLength(0);
  });
});
