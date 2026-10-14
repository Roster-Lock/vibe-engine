/**
 * `examples/card-game` — a two-player collectible card game on tinyquest.
 *
 * This barrel is the single entry point the UI imports: the catalog, the
 * game driver, the AI, the UI players, and the bridge that turns cards
 * authored in the Card Document language (`src/english/card.ts`) into
 * playable content.
 */
export type { Card, CardContext, CardSide, CreatureCard, Keyword, SpellCard } from './cards.js';
export { PermanentCard, SpellCardObject, isPermanent, type CardObject } from './objects.js';
export { INSTANT, instant, isInstant, castSpeedOf, type CastSpeed } from '../../src/games/cards/speed.js';
export {
  ASSASSINATE,
  BLESSING,
  berserkerRage,
  blessed,
  BLOODFEN_RAPTOR,
  BOULDERFIST_OGRE,
  CONSECRATION,
  ELVEN_ARCHER,
  FIREBALL,
  GURUBASHI_BERSERKER,
  HEALING_TOUCH,
  LOOT_HOARDER,
  SHIELDBEARER,
  STARTER_DECK,
  WISP,
  WOLFRIDER,
} from './cards.js';
export { CardGame, type CardGameOptions, type Move } from './game.js';
export { CardPlayer, GreedyAI } from './ai.js';
export { HumanCardPlayer, PacedGreedyAI } from './human.js';
export { CardPile, MAX_CRYSTALS, MAX_HAND, Side } from './side.js';
export { HERO_POWER_COST, makeHero } from './combat.js';
export {
  CARD_LANGUAGE_ZONES,
  playableCards,
  toGameCard,
  type AuthoredCards,
} from './english.js';
