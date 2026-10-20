import { describe, expect, it } from 'vitest';
import type { Entity, ZoneDef } from '../src/engine/index.js';
import { validateFormat, type CardFormat } from '../src/games/cards/formats.js';

// Card kinds are boolean facts on `Entity.attributes`.
const is = (...facts: string[]) => (card: Entity) => facts.every((f) => card.attributes?.get(f) === true);
const isAny = (...facts: string[]) => (card: Entity) => facts.some((f) => card.attributes?.get(f) === true);

const DECK: ZoneDef = { id: 'deck', ordered: true, visibility: 'hidden', scope: 'per-player', ownerOnly: true, group: 'library' };
const command = (id: string): ZoneDef => ({ id, visibility: 'public', scope: 'per-player', ownerOnly: true, group: 'command' });

const LEGACY: CardFormat = { id: 'legacy', zones: [{ zone: DECK, min: 60 }] };

const COMMANDER: CardFormat = {
  id: 'commander',
  zones: [
    { zone: DECK, min: 99, max: 99 },
    { zone: command('commander'), min: 1, max: 1, accepts: is('legendary', 'creature'), describe: 'a legendary creature' },
  ],
};

const OATHBREAKER: CardFormat = {
  id: 'oathbreaker',
  zones: [
    { zone: DECK, min: 58, max: 58 },
    { zone: command('planeswalker'), min: 1, max: 1, accepts: is('planeswalker'), describe: 'a planeswalker' },
    { zone: command('signature-spell'), min: 1, max: 1, accepts: isAny('instant', 'sorcery'), describe: 'an instant or sorcery' },
  ],
};

const card = (name: string, ...facts: string[]): Entity => ({
  type: 'card',
  name,
  attributes: new Map(facts.map((f) => [f, true])),
});
const many = (n: number): Entity[] => Array.from({ length: n }, (_, i) => card(`Card ${i}`));

describe('validateFormat', () => {
  it('accepts a legal Legacy deck and rejects a short one', () => {
    expect(validateFormat(LEGACY, new Map([['deck', many(60)]]))).toEqual([]);
    expect(validateFormat(LEGACY, new Map([['deck', many(59)]]))).toHaveLength(1);
  });

  it('requires a legendary creature in the commander zone', () => {
    const ok = new Map([['deck', many(99)], ['commander', [card('Atraxa', 'legendary', 'creature')]]]);
    expect(validateFormat(COMMANDER, ok)).toEqual([]);
    const bad = new Map([['deck', many(99)], ['commander', [card('Bear', 'creature')]]]);
    expect(validateFormat(COMMANDER, bad)[0]).toMatch(/legendary creature/);
  });

  it('checks both Oathbreaker command zones', () => {
    const ok = new Map([
      ['deck', many(58)],
      ['planeswalker', [card('Jace', 'planeswalker')]],
      ['signature-spell', [card('Bolt', 'instant')]],
    ]);
    expect(validateFormat(OATHBREAKER, ok)).toEqual([]);
    const bad = new Map([
      ['deck', many(58)],
      ['planeswalker', [card('Bolt', 'instant')]],
    ]);
    expect(validateFormat(OATHBREAKER, bad)).toHaveLength(2);
  });

  it('rejects zones the format does not have', () => {
    expect(validateFormat(LEGACY, new Map([['deck', many(60)], ['hand', []]]))).toEqual(['legacy has no zone "hand"']);
  });
});
