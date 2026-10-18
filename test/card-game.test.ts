/**
 * Tests for the card-game example (examples/card-game) — the rules the card
 * layer adds on top of the engine, and the engine behaviour it leans on.
 * Each `it` is one behavior, in the style of the engine suite.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import { playableCards } from '../examples/card-game/english.js';
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
    const inHand = game.activeSide.hand.cards.find((c) => c.printedId === card.id);
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

  it('is a standing rule: removing it lets a creature attack the turn it lands', async () => {
    const { game, a } = makeGame(deckOf(WISP), deckOf(WISP));
    expect(game.rules.describe()).toContain('A creature cannot act the turn it enters play.');
    expect(game.rules.remove('summoning-sickness')).toBe(true);
    await game.setup();

    a.script(play(WISP));
    await turn(game);
    const wisp = game.sideOf(a).board[0]!;
    expect(wisp.hasStatus('summoning-sickness')).toBe(false);
    expect(game.readyAttackers(game.sideOf(a))).toContain(wisp);
  });

  it('can be switched on by a game that starts without it', async () => {
    const { game, a } = makeGame(deckOf(WISP), deckOf(WISP));
    game.rules.remove('summoning-sickness');
    game.rules.add({ id: 'summoning-sickness', name: 'Back again.', at: 'creature:enters', affects: 'turn-owner', actions: [{ kind: 'summoning-sickness' }] });
    await game.setup();
    a.script(play(WISP));
    await turn(game);
    expect(game.sideOf(a).board[0]!.hasStatus('summoning-sickness')).toBe(true);
  });

  it('lets a charge creature attack the turn it lands', async () => {
    const { game, a } = makeGame(deckOf(WOLFRIDER), deckOf(WISP));
    await game.setup();
    for (let i = 0; i < 4; i++) await turn(game); // ramp to 3 crystals

    a.script(play(WOLFRIDER));
    await turn(game);
    const rider = game.sideOf(a).board[0]!;
    // Charge is an exception to the rule, not an absence of it: the rule still applies, and Charge beats it.
    expect(rider.hasStatus('summoning-sickness')).toBe(true);
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

    b.script(() => ({ kind: 'play', card: game.activeSide.hand.cards.find((c) => c.printedId === 'fireball')!, targets: [hoarder] }));
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

describe('card game — acting the turn a creature enters play', () => {
  const arrive = async (text: string) => {
    const { cards, diagnostics } = playableCards(text);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const card = cards[0]!;
    const { game, a } = makeGame(deckOf(card), deckOf(WISP));
    await game.setup();
    for (let i = 0; i < 4; i++) await turn(game); // ramp
    return { game, a, card, cards };
  };

  it('"This can act the turn it enters play" lets it attack at once', async () => {
    const { game, a, card } = await arrive('Card Quick\n{ "cost": 1, "type": "creature", "creatureConfig": { "power": 2, "health": 2 } }\nThis can act the turn it enters play.');
    a.script(play(card));
    await turn(game);
    const creature = game.sideOf(a).board[0]!;
    expect(game.readyAttackers(game.sideOf(a))).toContain(creature);
  });

  it('"This can attack the turn it enters play" does too', async () => {
    const { game, a, card } = await arrive('Card Rusher\n{ "cost": 1, "type": "creature", "creatureConfig": { "power": 2, "health": 2 } }\nThis can attack the turn it enters play.');
    a.script(play(card));
    await turn(game);
    expect(game.readyAttackers(game.sideOf(a))).toContain(game.sideOf(a).board[0]!);
  });

  it('"This can use any ability" does not let it attack (attacking has its own line)', async () => {
    const { game, a, card } = await arrive('Card Tinker\n{ "cost": 1, "type": "creature", "creatureConfig": { "power": 2, "health": 2 } }\nThis can use any ability the turn it enters play.');
    a.script(play(card));
    await turn(game);
    expect(game.readyAttackers(game.sideOf(a))).toHaveLength(0);
  });

  it('"Creatures you own can attack the turn they enter play" frees every creature you own while it is in play', async () => {
    const { game, a, card } = await arrive('Card Warchief\n{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 3 } }\nCreatures you own can attack the turn they enter play.');
    a.script(play(card), play(card));
    await turn(game);
    const board = game.sideOf(a).board;
    expect(board).toHaveLength(2);
    expect(game.readyAttackers(game.sideOf(a))).toHaveLength(2);
  });

  it('applies to a creature that arrives any way at all: cheated in from the stack it is still sick', async () => {
    const { game, a } = makeGame(deckOf(WISP), deckOf(WISP));
    await game.setup();
    await game.collectUserDecisions();
    const wisp = game.sideOf(a).hand.cards[0]! as Character;
    await game.engine.moveTo(wisp, 'play', { source: game.sideOf(a).hero });
    expect(game.sideOf(a).board).toContain(wisp);
    expect(wisp.hasStatus('summoning-sickness')).toBe(true);
    expect(game.readyAttackers(game.sideOf(a))).not.toContain(wisp);
  });
});
