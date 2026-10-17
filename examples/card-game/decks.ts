/**
 * Decks. A deck is a list of cards from the catalog (`cards.ts`) — thirty here, with up to
 * two copies of anything. A few extra cards the decks need live at the top of this file;
 * they are the same kind of data as the catalog's.
 */
import { damage } from '../../src/games/turn-based/index.js';
import {
  ASSASSINATE,
  BLESSING,
  BLOODFEN_RAPTOR,
  BOULDERFIST_OGRE,
  CONSECRATION,
  ELVEN_ARCHER,
  FIREBALL,
  GURUBASHI_BERSERKER,
  HEALING_TOUCH,
  LOOT_HOARDER,
  SHIELDBEARER,
  WISP,
  WOLFRIDER,
  type Card,
  type CreatureCard,
  type SpellCard,
} from './cards.js';

export const RAGING_BOAR: CreatureCard = {
  kind: 'creature',
  id: 'raging-boar',
  name: 'Raging Boar',
  cost: 1,
  power: 2,
  health: 1,
  keywords: ['charge'],
  text: 'Charge.',
};

export const STONEHIDE_GUARD: CreatureCard = {
  kind: 'creature',
  id: 'stonehide-guard',
  name: 'Stonehide Guard',
  cost: 4,
  power: 2,
  health: 6,
  keywords: ['taunt'],
  text: 'Taunt.',
};

export const SPARK: SpellCard = {
  kind: 'spell',
  id: 'spark',
  name: 'Spark',
  cost: 1,
  text: 'Deal 3 damage.',
  targeting: { who: 'enemy', count: 1 },
  effect: (ctx, targeting) => {
    const target = targeting.targets[0];
    return target ? [damage(target.gauge('hp'), 3, ctx.self)] : [];
  },
};

export const DRAGON_WHELP: CreatureCard = {
  kind: 'creature',
  id: 'dragon-whelp',
  name: 'Dragon Whelp',
  cost: 4,
  power: 5,
  health: 4,
};

const copies = (card: Card, n: number): Card[] => Array.from({ length: n }, () => card);

export interface Deck {
  readonly name: string;
  readonly blurb: string;
  readonly cards: readonly Card[];
}

export const DECKS: readonly Deck[] = [
  {
    name: 'Red Tide',
    blurb: 'Aggro: cheap charge creatures, burn to finish.',
    cards: [
      ...copies(WISP, 2), ...copies(RAGING_BOAR, 2), ...copies(ELVEN_ARCHER, 2), ...copies(WOLFRIDER, 2),
      ...copies(BLOODFEN_RAPTOR, 2), ...copies(LOOT_HOARDER, 2), ...copies(DRAGON_WHELP, 2),
      ...copies(GURUBASHI_BERSERKER, 1), ...copies(SPARK, 2), ...copies(FIREBALL, 2),
      ...copies(BLESSING, 2), ...copies(CONSECRATION, 1), ...copies(BOULDERFIST_OGRE, 1),
      ...copies(HEALING_TOUCH, 1), ...copies(SHIELDBEARER, 2), ...copies(ASSASSINATE, 1),
      ...copies(GURUBASHI_BERSERKER, 1), ...copies(CONSECRATION, 1), ...copies(BOULDERFIST_OGRE, 1),
    ],
  },
  {
    name: 'Iron Wall',
    blurb: 'Control: taunt walls, removal, big bodies late.',
    cards: [
      ...copies(SHIELDBEARER, 2), ...copies(STONEHIDE_GUARD, 2), ...copies(LOOT_HOARDER, 2),
      ...copies(ELVEN_ARCHER, 2), ...copies(BLOODFEN_RAPTOR, 1), ...copies(DRAGON_WHELP, 1),
      ...copies(GURUBASHI_BERSERKER, 2), ...copies(BOULDERFIST_OGRE, 2),
      ...copies(ASSASSINATE, 2), ...copies(CONSECRATION, 2), ...copies(HEALING_TOUCH, 2),
      ...copies(FIREBALL, 2), ...copies(SPARK, 2), ...copies(BLESSING, 1), ...copies(WISP, 2),
      ...copies(BLOODFEN_RAPTOR, 1), ...copies(DRAGON_WHELP, 1), ...copies(BLESSING, 1),
    ],
  },
  {
    name: 'Glass Cannon',
    blurb: 'Burn: every spell it can find, a few bodies to buy time.',
    cards: [
      ...copies(SHIELDBEARER, 2), ...copies(ELVEN_ARCHER, 2), ...copies(LOOT_HOARDER, 2),
      ...copies(WISP, 2), ...copies(BLOODFEN_RAPTOR, 2), ...copies(STONEHIDE_GUARD, 1),
      ...copies(SPARK, 2), ...copies(FIREBALL, 2), ...copies(CONSECRATION, 2),
      ...copies(ASSASSINATE, 1), ...copies(HEALING_TOUCH, 2), ...copies(BLESSING, 2),
      ...copies(WOLFRIDER, 2), ...copies(DRAGON_WHELP, 2), ...copies(BOULDERFIST_OGRE, 1),
      ...copies(STONEHIDE_GUARD, 1), ...copies(ASSASSINATE, 1), ...copies(BOULDERFIST_OGRE, 1),
    ],
  },
  {
    name: 'Even Keel',
    blurb: 'Midrange: a curve of solid creatures with a little of everything.',
    cards: [
      ...copies(WISP, 1), ...copies(ELVEN_ARCHER, 2), ...copies(RAGING_BOAR, 1),
      ...copies(LOOT_HOARDER, 2), ...copies(BLOODFEN_RAPTOR, 2), ...copies(SHIELDBEARER, 2),
      ...copies(WOLFRIDER, 2), ...copies(DRAGON_WHELP, 2), ...copies(STONEHIDE_GUARD, 1),
      ...copies(GURUBASHI_BERSERKER, 2), ...copies(BOULDERFIST_OGRE, 2),
      ...copies(BLESSING, 2), ...copies(FIREBALL, 2), ...copies(SPARK, 1),
      ...copies(ASSASSINATE, 1), ...copies(CONSECRATION, 1), ...copies(HEALING_TOUCH, 2),
      ...copies(SPARK, 1), ...copies(RAGING_BOAR, 1),
    ],
  },
];

/** What is wrong with a deck, if anything: thirty cards, no more than two of any one. */
export function deckProblems(deck: Deck): string[] {
  const problems: string[] = [];
  if (deck.cards.length !== 30) problems.push(`${deck.name} has ${deck.cards.length} cards, not 30`);
  const counts = new Map<string, number>();
  for (const card of deck.cards) counts.set(card.name, (counts.get(card.name) ?? 0) + 1);
  for (const [name, n] of counts) if (n > 2) problems.push(`${deck.name} has ${n} copies of ${name}`);
  return problems;
}
