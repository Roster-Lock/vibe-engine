/**
 * Ordered-zone mutation: the verbs behind scry, "seventh from the top",
 * shuffling a card in. Pure registry/zone behaviour, no game needed.
 */
import { describe, expect, it } from 'vitest';
import { Zone, ZoneRegistry, type Entity } from '../src/engine/index.js';

const card = (name: string): Entity => ({ type: 'card', name });

function deckOf(n: number) {
  const registry = new ZoneRegistry([{ id: 'deck', ordered: true, visibility: 'hidden' }, { id: 'hand' }]);
  const deck = registry.zone('deck')!;
  const cards = Array.from({ length: n }, (_, i) => card(`c${i + 1}`));
  for (const c of cards) registry.add(c, deck);
  return { registry, deck, hand: registry.zone('hand')!, cards };
}
const names = (zone: Zone) => zone.members.map((m) => m.name).join(',');

describe('ordered zones — positions', () => {
  it('places the nth from the top (1-based) and clamps when short', () => {
    const { registry, deck } = deckOf(5);
    const x = card('x');
    registry.add(x, registry.zone('hand')!);
    registry.move(x, deck, { nth: 3, from: 'top' });
    expect(names(deck)).toBe('c1,c2,x,c3,c4,c5');
    registry.move(x, registry.zone('hand')!);
    registry.move(x, deck, { nth: 99, from: 'top' });
    expect(names(deck)).toBe('c1,c2,c3,c4,c5,x');
  });

  it('places the nth from the bottom so it ends up nth from the bottom', () => {
    const { registry, deck } = deckOf(5);
    const x = card('x');
    registry.add(x, registry.zone('hand')!);
    registry.move(x, deck, { nth: 3, from: 'bottom' });
    expect(names(deck)).toBe('c1,c2,c3,x,c4,c5');
    expect(deck.nth(3, 'bottom')).toBe(x);
    registry.move(x, registry.zone('hand')!);
    registry.move(x, deck, { nth: 1, from: 'bottom' });
    expect(deck.nth(1, 'bottom')).toBe(x);
    registry.move(x, registry.zone('hand')!);
    registry.move(x, deck, { nth: 99, from: 'bottom' });
    expect(deck.top).toBe(x);
  });
});

describe('ordered zones — peeking', () => {
  it('reads the nth from either end and a section in zone order', () => {
    const { deck, cards } = deckOf(7);
    expect(deck.nth(7, 'top')).toBe(cards[6]);
    expect(deck.nth(2, 'bottom')).toBe(cards[5]);
    expect(deck.nth(8)).toBeUndefined();
    expect(deck.nth(0)).toBeUndefined();
    expect(deck.section(3).map((c) => c.name)).toEqual(['c1', 'c2', 'c3']);
    expect(deck.section(2, 'bottom').map((c) => c.name)).toEqual(['c6', 'c7']);
    expect(deck.section(99)).toHaveLength(7);
  });

  it('has no ends in an unordered zone', () => {
    const { registry, hand } = deckOf(0);
    registry.add(card('a'), hand);
    expect(hand.nth(1)).toBeUndefined();
    expect(hand.section(1)).toEqual([]);
  });
});

describe('ordered zones — reposition and arrange', () => {
  it('moves top to bottom, bottom to top and to a depth, without leaving the zone', () => {
    const { registry, deck, cards } = deckOf(5);
    registry.reposition(cards[0]!, 'bottom');
    expect(names(deck)).toBe('c2,c3,c4,c5,c1');
    registry.reposition(cards[0]!, 'top');
    expect(names(deck)).toBe('c1,c2,c3,c4,c5');
    registry.reposition(cards[0]!, { nth: 3, from: 'top' });
    expect(names(deck)).toBe('c2,c3,c1,c4,c5');
    expect(registry.zoneOf(cards[0]!)).toBe(deck);
    expect(deck.size).toBe(5);
  });

  it('refuses to reposition in an unordered zone', () => {
    const { registry, hand } = deckOf(0);
    const a = card('a');
    registry.add(a, hand);
    expect(registry.reposition(a, 'top')).toBe(false);
  });

  it('arranges a scry: keepers on top in order, the rest underneath', () => {
    const { registry, deck, cards } = deckOf(6);
    const [c1, c2, c3] = cards;
    registry.arrange(deck, 3, { top: [c3!, c1!], bottom: [c2!] });
    expect(names(deck)).toBe('c3,c1,c4,c5,c6,c2');
  });

  it('throws when the placement is not exactly the section', () => {
    const { registry, deck, cards } = deckOf(6);
    expect(() => registry.arrange(deck, 3, { top: [cards[0]!] })).toThrow();
    expect(() => registry.arrange(deck, 2, { top: [cards[0]!, cards[4]!] })).toThrow();
    expect(() => registry.arrange(deck, 2, { top: [cards[0]!, cards[0]!] })).toThrow();
  });
});
