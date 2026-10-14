/**
 * Tests for the card-game example (examples/card-game) — the rules the card
 * layer adds on top of the engine, and the engine behaviour it leans on.
 * Each `it` is one behavior, in the style of the engine suite.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import {
  BLOODFEN_RAPTOR,
  FIREBALL,
  LOOT_HOARDER,
  SHIELDBEARER,
  WISP,
  WOLFRIDER,
  type Card,
} from '../examples/card-game/cards.js';
import { GameEndInterrupt, type Character } from '../src/engine/index.js';

/** A player that runs a fixed script of moves, one per turn-move request. */
class ScriptedCardPlayer extends CardPlayer {
  #script: ((game: CardGame) => Move)[] = [];

  /** Queues the moves for the next turn; anything left over ends the turn. */
  script(...moves: ((game: CardGame) => Move)[]): this {
    this.#script = [...moves];
    return this;
  }

  async chooseMove(game: CardGame): Promise<Move> {
    const next = this.#script.shift();
    return next ? next(game) : { kind: 'end' };
  }
}

/** A deck of one repeated card — keeps draws predictable. */
const deckOf = (card: Card, n = 30): Card[] => Array.from({ length: n }, () => card);

function makeGame(
  first: readonly Card[],
  second: readonly Card[],
): { game: CardGame; a: ScriptedCardPlayer; b: ScriptedCardPlayer } {
  const a = new ScriptedCardPlayer('Alice', 'a', first);
  const b = new ScriptedCardPlayer('Bob', 'b', second);
  const game = new CardGame([a, b], { log: () => {}, openingHand: 3 });
  return { game, a, b };
}

/** Runs one turn: upkeep, then the active player's scripted moves. */
async function turn(game: CardGame): Promise<void> {
  await game.collectUserDecisions();
  await game.runGame();
}

/** Plays the first copy of a card from the active side's hand. */
const play =
  (card: Card, targets: (game: CardGame) => Character[] = () => []) =>
  (game: CardGame): Move => {
    const inHand = game.activeSide.hand.cards.find((c) => c.id === card.id);
    if (!inHand) throw new Error(`test: ${card.name} is not in hand`);
    return { kind: 'play', card: inHand, targets: targets(game) };
  };

describe('card game — mana', () => {
  it('grows the hero’s derived mana max by one crystal a turn and refills it', async () => {
    const { game, a } = makeGame(deckOf(WISP), deckOf(WISP));
    await game.setup();

    await turn(game); // Alice, turn 1
    expect(a.hero.gauge('mana').max).toBe(1);
    expect(a.hero.gauge('mana').current).toBe(1);

    await turn(game); // Bob, turn 2
    await turn(game); // Alice, turn 3
    expect(a.hero.gauge('mana').max).toBe(2);
    expect(a.hero.gauge('mana').current).toBe(2);
  });

  it('spends mana when a card is played', async () => {
    const { game, a } = makeGame(deckOf(BLOODFEN_RAPTOR), deckOf(WISP));
    await game.setup();
    await turn(game); // turn 1: 1 crystal, cannot afford a 2-drop
    await turn(game);

    a.script(play(BLOODFEN_RAPTOR));
    await turn(game); // turn 3: 2 crystals
    expect(a.hero.gauge('mana').current).toBe(0);
    expect(game.sideOf(a).board).toHaveLength(1);
  });
});

describe('card game — the board', () => {
  it('gives a new creature summoning sickness, and clears it next turn', async () => {
    const { game, a } = makeGame(deckOf(WISP), deckOf(WISP));
    await game.setup();

    a.script(play(WISP));
    await turn(game); // turn 1: Wisp lands
    const wisp = game.sideOf(a).board[0]!;
    expect(wisp.hasStatus('summoning-sickness')).toBe(true);
    expect(game.readyAttackers(game.sideOf(a))).toHaveLength(0);

    await turn(game); // Bob
    await game.collectUserDecisions(); // Alice's upkeep wakes it
    expect(wisp.hasStatus('summoning-sickness')).toBe(false);
    expect(game.readyAttackers(game.sideOf(a))).toContain(wisp);
  });

  it('lets a charge creature attack the turn it lands', async () => {
    const { game, a } = makeGame(deckOf(WOLFRIDER), deckOf(WISP));
    await game.setup();
    for (let i = 0; i < 4; i++) await turn(game); // ramp to 3 crystals

    a.script(play(WOLFRIDER));
    await turn(game);
    const rider = game.sideOf(a).board[0]!;
    expect(rider.hasStatus('summoning-sickness')).toBe(false);
    expect(game.readyAttackers(game.sideOf(a))).toContain(rider);
  });
});

describe('card game — taunt', () => {
  it('removes every other enemy from an attacker’s target pool', async () => {
    const { game, a, b } = makeGame(deckOf(WOLFRIDER), deckOf(SHIELDBEARER));
    await game.setup();
    for (let i = 0; i < 2; i++) await turn(game); // 1 crystal each

    b.script(play(SHIELDBEARER));
    await turn(game); // Alice turn 3 (nothing)
    await turn(game); // Bob turn 4: Shieldbearer (2 mana)
    const taunter = game.sideOf(b).board[0]!;
    expect(taunter.name).toBe('Shieldbearer');

    a.script(play(WOLFRIDER));
    await turn(game); // Alice turn 5: Wolfrider has charge
    const rider = game.sideOf(a).board[0]!;

    const targets = game.attackTargets(rider);
    expect(targets).toEqual([taunter]); // not Bob's hero
    expect(targets).not.toContain(b.hero);
  });

  it('does not stop a spell — only attacks are taxed', async () => {
    const { game, b } = makeGame(deckOf(FIREBALL), deckOf(SHIELDBEARER));
    await game.setup();
    for (let i = 0; i < 2; i++) await turn(game);
    b.script(play(SHIELDBEARER));
    await turn(game);
    await turn(game);

    expect(game.targetsFor(FIREBALL, game.players[0]!)).toContain(b.hero);
  });
});

describe('card game — abilities', () => {
  it('runs an on-death trigger: Loot Hoarder draws its controller a card', async () => {
    const { game, a, b } = makeGame(deckOf(LOOT_HOARDER), deckOf(FIREBALL));
    await game.setup();
    for (let i = 0; i < 2; i++) await turn(game);

    a.script(play(LOOT_HOARDER));
    await turn(game); // Alice turn 3: 2 mana, Loot Hoarder (2/1) lands
    const hoarder = game.sideOf(a).board[0]!;

    await turn(game); // Bob turn 4
    await turn(game); // Alice turn 5
    await turn(game); // Bob turn 6
    await turn(game); // Alice turn 7 — 4 crystals
    const handBefore = game.sideOf(a).hand.size;

    b.script(() => ({ kind: 'play', card: game.activeSide.hand.cards.find((c) => c.id === 'fireball')!, targets: [hoarder] }));
    await turn(game); // Bob turn 8: Fireball kills the Hoarder

    expect(game.sideOf(a).board).not.toContain(hoarder);
    expect(game.sideOf(a).hand.size).toBe(handBefore + 1); // the on-death trigger drew
  });
});

describe('card game — winning', () => {
  it('ends the match when a hero dies, and the survivor wins', async () => {
    const { game, a, b } = makeGame(deckOf(FIREBALL), deckOf(WISP));
    await game.setup();

    // Burn Bob's hero down with the engine directly — the win condition is
    // the engine's, not the card layer's.
    let winners: typeof game.players = [];
    try {
      await game.engine.damage(b.hero.gauge('hp'), 30, a.hero);
    } catch (error) {
      if (!(error instanceof GameEndInterrupt)) throw error;
      winners = error.winners;
    }

    expect(winners).toEqual([a]);
    // Win/lose resolves *before* the destroy phase, so the hero is defeated
    // (hp at 0) without ever being moved to the garbage.
    expect(b.hero.isDefeated).toBe(true);
    expect(b.isDefeated).toBe(true);
  });
});
