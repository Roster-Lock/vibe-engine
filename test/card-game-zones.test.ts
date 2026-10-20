/**
 * The card game's **zones**.
 *
 * A deck, a hand and the stack are engine zones (`examples/card-game/zones.ts`
 * declares them, `src/engine/zone.ts` holds them), and a card is an entity —
 * so these tests ask the engine where a card is, not the card layer. That is
 * what makes `when a card enters the stack from hand` a trigger a game can
 * write, and it is why the piles no longer have a private `Zone<T>` model of
 * their own.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import { WISP, type Card } from '../examples/card-game/cards.js';
import type { CardObject } from '../examples/card-game/objects.js';
import { playableCards } from '../examples/card-game/english.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import type { Character, GameEvent } from '../src/engine/index.js';

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

const deckOf = (card: Card, n = 30): Card[] => Array.from({ length: n }, () => ({ ...card }));

async function turn(game: CardGame): Promise<void> {
  await game.collectUserDecisions();
  await game.runGame();
}

function match(aDeck: readonly Card[], bDeck: readonly Card[] = deckOf(WISP), onEvent?: (event: GameEvent) => void) {
  const a = new ScriptedCardPlayer('Alice', 'a', aDeck);
  const b = new ScriptedCardPlayer('Bob', 'b', bDeck);
  const game = new CardGame([a, b], { log: () => {}, openingHand: 3, ...(onEvent ? { onEvent } : {}) });
  return { game, a, b };
}

describe('card game — the zones exist', () => {
  it('declares deck, hand, stack, active and garbage for the match', () => {
    const { game, a } = match(deckOf(WISP));
    const zones = game.engine.zones;
    expect(zones.zone('deck', a)?.id).toBe('deck');
    expect(zones.zone('hand', a)?.id).toBe('hand');
    expect(zones.zone('garbage', a)?.id).toBe('garbage');
    expect(zones.zone('stack')?.id).toBe('stack');
    expect(zones.zone('active')?.id).toBe('active');
    // The piles *are* those zones, not copies of them.
    expect(game.sideOf(a).deck.zone).toBe(zones.zone('deck', a));
    expect(game.sideOf(a).hand.zone).toBe(zones.zone('hand', a));
    expect(game.sideOf(a).garbage.zone).toBe(zones.zone('garbage', a));
  });

  it('scopes the piles per player and the stack to the table', () => {
    const { game, a, b } = match(deckOf(WISP));
    expect(game.engine.zones.zone('hand', a)).not.toBe(game.engine.zones.zone('hand', b));
    expect(game.engine.zones.zone('deck', a)).not.toBe(game.engine.zones.zone('deck', b));
    // Each player's discard is their own — a shared pile would mix them.
    expect(game.engine.zones.zone('garbage', a)).not.toBe(game.engine.zones.zone('garbage', b));
    expect(game.engine.zones.zone('garbage', a)?.owner).toBe(a);
    // The stack is shared: both players' spells wait in the same place.
    expect(game.engine.zones.definitions.find((d) => d.id === 'stack')?.scope).toBeUndefined();
  });

  it('keeps every card in exactly one pile', async () => {
    const { game, a } = match(deckOf(WISP, 30));
    await game.setup();
    const side = game.sideOf(a);

    // 30 in the deck list; the opening hand took three.
    expect(side.deck.size).toBe(27);
    expect(side.hand.size).toBe(3);
    expect(side.deck.size + side.hand.size).toBe(30);
    for (const card of side.hand.cards) {
      expect(game.engine.zones.zoneOf(card)).toBe(side.hand.zone);
    }
    for (const card of side.deck.cards) {
      expect(game.engine.zones.zoneOf(card)).toBe(side.deck.zone);
    }
  });

  it('moves a drawn card deck → hand, and burns a full hand into the garbage', async () => {
    const { game, a } = match(deckOf(WISP, 30));
    await game.setup();
    const side = game.sideOf(a);
    const drawn = side.deck.top!;

    await side.draw(1);
    expect(game.engine.zones.zoneOf(drawn)).toBe(side.hand.zone);
    expect(side.deck.size).toBe(26);

    while (side.hand.size < 10) await side.draw(1);
    expect(side.hand.size).toBe(10);
    const burned = side.deck.top!;
    await side.draw(1);
    expect(game.engine.zones.zoneOf(burned)).toBe(side.garbage.zone);
    expect(side.hand.size).toBe(10);
  });
});

describe('card game — casting is a move', () => {
  it('sends a played spell hand → stack → active → garbage', async () => {
    const { cards } = playableCards(
      ['Card Test Bolt', '{ "cost": 1, "type": "spell" }', 'Deal 1 damage to target enemy character.'].join('\n'),
    );
    const bolt = cards[0]!;
    const spell = deckOf(bolt).map((c) => c);
    const visits: string[] = [];
    let watched: CardObject | undefined;
    const { game, a, b } = match(spell, deckOf(WISP), (event) => {
      if (event.type === 'zone:changed' && event.entity === watched) visits.push(event.to.id);
    });
    await game.setup();

    const side = game.sideOf(a);
    watched = side.hand.cards[0]!;
    const enemyHero: Character = game.sideOf(b).hero;

    a.script(() => ({ kind: 'play', card: watched!, targets: [enemyHero] }));
    await turn(game);

    expect(visits).toEqual(['stack', 'active', 'garbage']);
    expect(game.engine.zones.zoneOf(watched!)).toBe(side.garbage.zone);
    expect(game.sideOf(b).garbage.size).toBe(0); // not the opponent's pile
    expect(enemyHero.gauge('hp').current).toBe(29);
  });

  it('keeps one entity across the whole life of a permanent', async () => {
    const { game, a } = match(deckOf(WISP));
    await game.setup();
    const side = game.sideOf(a);
    const wisp = side.hand.cards[0]!;

    a.script(() => ({ kind: 'play', card: wisp, targets: [] }));
    await turn(game);

    // The card *is* the creature: the same object that was in hand is the
    // one on the board, in `play` — not a second entity standing in for it.
    expect(game.engine.zones.zoneOf(wisp)).toBe(game.engine.zones.zone('play'));
    expect(side.board).toEqual([wisp]);
    expect(wisp.type).toBe('character');
  });
});

describe('card game — zones on demand', () => {
  it('lets the game declare a zone mid-match and move a card into it', async () => {
    const { game, a } = match(deckOf(WISP, 30));
    await game.setup();
    const side = game.sideOf(a);

    const exile = game.engine.zones.declare({ id: 'exile', visibility: 'public', group: 'removed' });
    expect(exile).toBeDefined();
    const card = side.hand.cards[0]!;
    await game.engine.moveTo(card, 'exile');

    expect(game.engine.zones.zoneOf(card)).toBe(exile);
    expect(exile!.members).toEqual([card]);
  });
});
