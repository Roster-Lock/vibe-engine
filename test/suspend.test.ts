/**
 * Counters, declared zones, and Suspend — written entirely in English:
 *
 *   Zone Suspend (per-player, public)
 *   At the start of your turn, remove a counter from all cards in this zone.
 *   At the start of your turn, cast all cards with no counters from this zone without paying their cost.
 *
 *   Card Ancestral Vision
 *   ...
 *   Suspend: Move this card to the Suspend zone with 2 counters on it.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import { WISP } from '../examples/card-game/cards.js';
import { playableCards } from '../examples/card-game/english.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { lowerDocument, parseDocument, renderDocument } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';

const DOCUMENT = `Zone Suspend (per-player, public)
At the start of your turn, remove a counter from all cards in this zone.
At the start of your turn, cast all cards with no counters from this zone without paying their cost.

Card Ancestral Vision
Cost 6
Spell
Draw(you, 3).
Suspend: Move this card to the Suspend zone with 2 counters on it.`;

class Idle extends CardPlayer {
  async chooseMove(): Promise<Move> {
    return { kind: 'end' };
  }
}

const lower = (text: string) => lowerDocument(parseDocument(text, { zones: new ZoneDictionary(['hand', 'Suspend']) }).doc);

describe('counters and declared zones — the language', () => {
  it('round-trips the sentences', () => {
    const source = `Ability A
Move this card to the Suspend zone with 5 counters on it.
Move this card to the Suspend zone with 3 time counters on it.
Remove a counter from all cards in this zone.
Remove 2 time counters from the top card in your hand.
Cast all cards with no counters from this zone without paying their cost.`;
    const ir = lower(source);
    const { text, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    for (const line of source.split('\n').slice(1)) expect(text).toContain(line);
    expect(lower(text).abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
    expect(ir.abilities[0]!.steps[0]!.effects[0]).toEqual({ kind: 'moveCard', to: 'Suspend', article: 'the', counters: { count: 5 } });
  });

  it('keeps Remove a counter apart from Remove Poison', () => {
    const effect = lower('Buff Poison\n\nAbility A\nRemove Poison from all characters.').abilities[0]!.steps[0]!.effects[0]!;
    expect(effect.kind).toBe('removeBuff');
  });

  it('reads "At the start of your turn" as a standing rule of the zone', () => {
    const ir = lowerDocument(
      parseDocument('Zone Suspend\nAt the start of your turn, remove a counter from all cards in this zone.', {
        zones: new ZoneDictionary(['Suspend']),
      }).doc,
    );
    expect(ir.zones?.[0]?.triggers).toHaveLength(1);
    expect(ir.zones?.[0]?.triggers?.[0]).toMatchObject({ event: 'turn:start', yours: true });
  });
});

describe('Suspend', () => {
  it('compiles: the zone, its rules, and the card\'s own ability', () => {
    const { cards, diagnostics, zoneDefs, zoneBindings } = playableCards(DOCUMENT);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(zoneDefs).toEqual([{ id: 'Suspend', scope: 'per-player', visibility: 'public' }]);
    expect(zoneBindings).toHaveLength(1);
    expect(cards[0]!.handAbilities).toHaveLength(1);
  });

  async function table() {
    const authored = playableCards(DOCUMENT);
    const vision = authored.cards[0]!;
    const alice = new Idle('Alice', 'a', Array.from({ length: 30 }, () => vision));
    const bob = new Idle('Bob', 'b', Array.from({ length: 30 }, () => WISP));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    game.installZones(authored);
    await game.setup();
    return { game, alice, bob, vision };
  }
  const turn = async (game: CardGame) => {
    await game.collectUserDecisions();
    await game.runGame();
  };

  it('is offered from the hand, suspends the card with counters, ticks down each of its owner\'s turns, then casts it free', async () => {
    const { game, alice } = await table();
    await game.collectUserDecisions(); // Alice, turn 1
    const side = game.sideOf(alice);
    const offered = game.cardAbilities(alice);
    expect(offered.length).toBeGreaterThan(0);
    const { card, ability } = offered[0]!;
    expect(ability.name).toBe('Suspend');

    await game.engine.useCardAbility(alice, card, ability);
    const suspended = game.engine.zones.zone('Suspend', alice)!;
    expect(suspended.members).toContain(card);
    expect(game.engine.counters(card)).toBe(2);
    // No longer in the hand, so the ability is not offered for it again.
    expect(game.cardAbilities(alice).some((o) => o.card === card)).toBe(false);

    await game.runGame(); // end Alice's turn 1
    await turn(game); // Bob, turn 2: not Alice's turn, nothing ticks
    expect(game.engine.counters(card)).toBe(2);

    const handBefore = side.hand.size;
    await game.collectUserDecisions(); // Alice, turn 3: 2 -> 1
    expect(game.engine.counters(card)).toBe(1);
    expect(suspended.members).toContain(card);
    await game.runGame();
    await turn(game); // Bob, turn 4

    await game.collectUserDecisions(); // Alice, turn 5: 1 -> 0, then cast free
    expect(game.engine.counters(card)).toBe(0);
    expect(suspended.members).not.toContain(card);
    // Cast with no mana spent: Draw(you, 3) resolved, and the spell is in its owner's garbage.
    expect(side.garbage.has(card)).toBe(true);
    expect(side.hand.size).toBeGreaterThanOrEqual(handBefore + 3 - 1);
  });
});
