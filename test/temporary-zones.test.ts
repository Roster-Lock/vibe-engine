/**
 * Temporary zones and piles: Fact or Fiction.
 *
 *   Move the top 5 cards from your deck to the temporary zone Pool.
 *   Reveal all cards from Pool.
 *   Target opponent separates Pool into Fact and Fiction.
 *   You choose Fact or Fiction.
 *   Move all cards from the chosen pile to your hand.
 *   Move all cards from the other pile to your garbage.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import { ELVEN_ARCHER, SHIELDBEARER, BLOODFEN_RAPTOR, WISP, type Card } from '../examples/card-game/cards.js';
import { playableCards } from '../examples/card-game/english.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { lowerDocument, parseDocument, renderDocument } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import type { ChoiceAnswer, ChoiceRequest } from '../src/engine/index.js';

const FACT_OR_FICTION = `Card Fact or Fiction
Cost 4
Spell
Move the top 5 cards from your deck to the temporary zone Pool.
Reveal all cards from Pool.
Target opponent separates Pool into Fact and Fiction.
You choose Fact or Fiction.
Move all cards from the chosen pile to your hand.
Move all cards from the other pile to your garbage.`;

class Idle extends CardPlayer {
  async chooseMove(): Promise<Move> {
    return { kind: 'end' };
  }
}

const lower = (text: string) =>
  lowerDocument(parseDocument(text, { zones: new ZoneDictionary(['hand', 'deck']) }).doc);

describe('temporary zones — the language', () => {
  it('round-trips every sentence of Fact or Fiction', () => {
    const source = `Ability FoF\n${FACT_OR_FICTION.split('\n').slice(3).join('\n')}`;
    const ir = lower(source);
    const { text, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    for (const line of source.split('\n').slice(1)) {
      // Bare pile names print in full the first time and every time: `the temporary zone Pool`.
      expect(text.replace(/the temporary zone Pool/g, 'Pool').replace('from Pool.', 'from Pool.')).toContain(line.replace(/the temporary zone Pool/g, 'Pool'));
    }
    expect(lower(text).abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
  });

  it('knows the piles it has been told about', () => {
    const result = parseDocument('Ability A\nYou choose Fact or Fiction.', { zones: new ZoneDictionary(['hand']) });
    expect(result.diagnostics.map((d) => d.message)[0]).toMatch(/which piles\?/);
    const bad = parseDocument('Ability A\nMove all cards from Pool to your hand.', { zones: new ZoneDictionary(['hand']) });
    expect(bad.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('Fact or Fiction — playing it', () => {
  const deck: Card[] = Array.from({ length: 30 }, (_, i) => [ELVEN_ARCHER, SHIELDBEARER, BLOODFEN_RAPTOR, WISP][i % 4]!);

  async function play(keep: 'Fact' | 'Fiction', bobPutsInFact: number) {
    const alice = new Idle('Alice', 'a', deck);
    const bob = new Idle('Bob', 'b', deck);
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    const a = game.sideOf(alice);
    const five = a.deck.cards.slice(0, 5);
    const asked: string[] = [];
    bob.choose = async (request: ChoiceRequest): Promise<ChoiceAnswer> => {
      if (request.kind !== 'select') throw new Error('Bob was asked something else');
      asked.push(request.prompt);
      // Bob sees all five revealed to him, and puts the first `bobPutsInFact` in Fact.
      expect(request.options).toHaveLength(5);
      return { kind: 'select', chosen: request.options.slice(0, bobPutsInFact) };
    };
    alice.choose = async (request: ChoiceRequest): Promise<ChoiceAnswer> => {
      if (request.kind !== 'label') throw new Error('Alice was asked something else');
      expect(request.options).toEqual(['Fact', 'Fiction']);
      return { kind: 'label', value: keep };
    };
    const { cards, diagnostics } = playableCards(FACT_OR_FICTION);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const spell = cards[0]!;
    if (spell.kind !== 'spell') throw new Error('spell');
    const handBefore = a.hand.size;
    const actions = await spell.effect({ self: a.hero, engine: game.engine, side: a as never }, { targets: [] });
    await game.engine.apply(actions);
    return { game, a, five, handBefore, asked };
  }

  it('Bob splits 2 / 3 and Alice keeps Fact: two cards to her hand, three to her garbage', async () => {
    const { a, five, handBefore, asked } = await play('Fact', 2);
    expect(asked).toHaveLength(1);
    expect(a.hand.size).toBe(handBefore + 2);
    expect(a.garbage.size).toBe(3);
    for (const card of five.slice(0, 2)) expect(a.hand.has(card)).toBe(true);
    for (const card of five.slice(2)) expect(a.garbage.has(card)).toBe(true);
  });

  it('Alice keeps Fiction instead: the other three', async () => {
    const { a, five, handBefore } = await play('Fiction', 2);
    expect(a.hand.size).toBe(handBefore + 3);
    expect(a.garbage.size).toBe(2);
    for (const card of five.slice(2)) expect(a.hand.has(card)).toBe(true);
  });

  it('leaves no temporary zone behind', async () => {
    const { game } = await play('Fact', 1);
    expect(game.engine.zones.definitions.filter((d) => d.id.startsWith('temp:'))).toEqual([]);
  });

  it('sends cards left in a temporary zone to their owner\'s garbage when the ability ends', async () => {
    const alice = new Idle('Alice', 'a', deck);
    const bob = new Idle('Bob', 'b', deck);
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    const a = game.sideOf(alice);
    const top = a.deck.cards.slice(0, 3);
    const { cards } = playableCards('Card Park\nCost 1\nSpell\nMove the top 3 cards from your deck to the temporary zone Parking.');
    const spell = cards[0]!;
    if (spell.kind !== 'spell') throw new Error('spell');
    const actions = await spell.effect({ self: a.hero, engine: game.engine, side: a as never }, { targets: [] });
    await game.engine.apply(actions);
    for (const card of top) expect(a.garbage.has(card)).toBe(true);
    expect(game.engine.zones.definitions.filter((d) => d.id.startsWith('temp:'))).toEqual([]);
  });
});
