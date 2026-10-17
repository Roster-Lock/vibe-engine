/**
 * The card catalog — the part a content creator writes.
 *
 * A card is **data**: a cost, a body, and either a creature's stat line or a
 * spell's effect. An effect returns `Action[]`, exactly like an ability's
 * `cast` does, so everything a card does flows through the engine's action
 * pipeline (buffs, retaliation, death triggers, win/lose) for free.
 */
import {
  addBuff,
  auto,
  buff,
  damage,
  destroy,
  heal,
  isDamage,
  maxModifier,
  stat,
  wasTakenBy,
  type Ability,
  type Action,
  type Character,
  type GameEngine,
  type TargetPattern,
  type Targeting,
} from '../../src/games/turn-based/index.js';
import { isAlly, isEnemy } from '../../src/games/round-based/index.js';
import { instant } from '../../src/games/cards/speed.js';

/* ------------------------------ the shapes ------------------------------ */

export type Keyword = 'taunt' | 'charge';

/** What a creature may do the turn it enters play, despite the standing rule (see `EntryRules`). */
export type { EntryRules } from '../../src/english/card.js';

/**
 * The slice of a player's side a card effect may touch — the card-layer
 * state the engine knows nothing about (see `zones.ts`).
 */
export interface CardSide {
  readonly heroName: string;
  /**
   * Draws cards into the hand (fatigue applies when the deck is empty).
   *
   * Async because a draw is a **move** now (`zone:changed`, so content can
   * answer it) — and it goes through the pipeline rather than being
   * hand-rolled.
   */
  draw(count?: number): Promise<void>;
}

/** What a card's effect sees while it resolves. */
export interface CardContext {
  /** The hero that played the card (a creature's own enters-play effect: the creature). */
  readonly self: Character;
  readonly engine: GameEngine;
  readonly side: CardSide;
}

/**
 * A card's **printed data** — what the creator wrote and the catalog ships.
 *
 * Deliberately not an entity: the thing that sits in a zone is the
 * *instantiated* card (`objects.ts`), and for a permanent that object is the
 * creature itself. Keeping the data separate from identity is what lets one
 * creature card be many physical cards in many decks.
 */
interface CardBase {
  readonly id: string;
  readonly name: string;
  readonly cost: number;
  /** Rules text, printed in the log. */
  readonly text?: string;
}

export interface CreatureCard extends CardBase {
  readonly kind: 'creature';
  readonly power: number;
  readonly health: number;
  readonly keywords?: readonly Keyword[];
  /** Abilities the card has while it is in the hand (`Suspend: Move this card to the Suspend zone …`). */
  readonly handAbilities?: readonly import('../../src/engine/index.js').ManualAbility[];
  /** Exceptions to "a creature cannot act the turn it enters play". `Charge` is an attack exception. */
  readonly entry?: import('../../src/english/card.js').EntryRules;
  /**
   * Abilities the creature **grants** on the board, built fresh per instance
   * so they can close over the side that played it (an on-death trigger that
   * draws). Named `grants` rather than `abilities` because the instantiated
   * entity *is* a `Character`, whose own `abilities` are the built list.
   */
  readonly grants?: (side: CardSide) => Ability[];
  /** The enters-play effect: runs once, the moment the creature lands. */
  readonly onPlay?: (ctx: CardContext, targeting: Targeting) => Action[] | Promise<Action[]>;
  /** What the enters-play effect may target. Omit for an untargeted one. */
  readonly onPlayTargeting?: TargetPattern;
  /**
   * `when this enters play from <zone>` — the zone `onPlay` insists the
   * creature arrived from. Undefined means "from anywhere". The card layer
   * stages a played creature in `active` and moves it into `play`, so an
   * effect written `from active` is the normal cast and one written `from
   * stack` is unreachable by playing the card.
   */
  readonly arrivesFrom?: string;
}

export interface SpellCard extends CardBase {
  readonly kind: 'spell';
  /** Abilities the card has while it is in the hand. */
  readonly handAbilities?: readonly import('../../src/engine/index.js').ManualAbility[];
  /** Omit for a spell that picks no targets (a board-wide effect). */
  readonly targeting?: TargetPattern;
  /**
   * The effect. Async because authored effects can — a `You may …` or a
   * `Repeat …` sentence asks the controller mid-resolution, so a card
   * compiled from English returns a promise. The catalog's hand-written
   * effects return plain arrays.
   */
  readonly effect: (ctx: CardContext, targeting: Targeting) => Action[] | Promise<Action[]>;
}

export type Card = CreatureCard | SpellCard;

/* -------------------------------- buffs --------------------------------- */

/** +2/+2 — power is a derived **stat**, health a derived gauge **max**. */
export const blessed = buff({
  id: 'blessed',
  name: 'Blessed',
  description: '+2/+2',
  weight: 5,
  stacks: true,
  abilities: [
    stat({ name: 'Blessed', stat: 'power', add: 2 }),
    maxModifier({ name: 'Blessed', gauge: 'hp', add: 2 }),
  ],
});

/** Gurubashi's rage: +3 power, once per wound, stacking. */
export const berserkerRage = buff({
  id: 'berserker-rage',
  name: 'Berserker Rage',
  description: '+3 power',
  weight: 5,
  stacks: true, // one rage per wound
  abilities: [stat({ name: 'Berserker Rage', stat: 'power', add: 3 })],
});

/* ------------------------------ the catalog ----------------------------- */

export const WISP: CreatureCard = {
  kind: 'creature',
  id: 'wisp',
  name: 'Wisp',
  cost: 0,
  power: 1,
  health: 1,
};

export const ELVEN_ARCHER: CreatureCard = {
  kind: 'creature',
  id: 'elven-archer',
  name: 'Elven Archer',
  cost: 1,
  power: 1,
  health: 1,
  text: 'When this enters play: deal 1 damage.',
  onPlayTargeting: { who: 'enemy', count: 1 },
  onPlay: (ctx, targeting) => {
    const target = targeting.targets[0];
    return target ? [damage(target.gauge('hp'), 1, ctx.self)] : [];
  },
};

export const SHIELDBEARER: CreatureCard = {
  kind: 'creature',
  id: 'shieldbearer',
  name: 'Shieldbearer',
  cost: 2,
  power: 1,
  health: 4,
  keywords: ['taunt'],
  text: 'Taunt.',
};

export const LOOT_HOARDER: CreatureCard = {
  kind: 'creature',
  id: 'loot-hoarder',
  name: 'Loot Hoarder',
  cost: 2,
  power: 2,
  health: 1,
  text: 'When this dies: draw a card.',
  grants: (side) => [
    auto({
      name: 'On death: Draw',
      event: 'character:destroyed',
      when: (ctx) => ctx.event.character === ctx.self,
      // A draw is card-layer state, not an engine Action — the trigger does
      // it as a side effect and returns nothing. See README.md.
      cast: () => {
        side.draw(1);
        return [];
      },
    }),
  ],
};

export const BLOODFEN_RAPTOR: CreatureCard = {
  kind: 'creature',
  id: 'bloodfen-raptor',
  name: 'Bloodfen Raptor',
  cost: 2,
  power: 3,
  health: 2,
};

export const WOLFRIDER: CreatureCard = {
  kind: 'creature',
  id: 'wolfrider',
  name: 'Wolfrider',
  cost: 3,
  power: 3,
  health: 1,
  keywords: ['charge'],
  text: 'Charge.',
};

export const GURUBASHI_BERSERKER: CreatureCard = {
  kind: 'creature',
  id: 'gurubashi-berserker',
  name: 'Gurubashi Berserker',
  cost: 5,
  power: 2,
  health: 7,
  text: 'Whenever this takes damage, gain +3 power.',
  grants: () => [
    auto({
      name: 'Berserk',
      event: 'gauge:changed',
      // A wound that killed it is not a wound it rages about: the trigger
      // is collected before the creature leaves play, so check.
      when: (ctx) =>
        isDamage(ctx.event) && wasTakenBy(ctx.event, ctx.self) && ctx.engine.isInPlay(ctx.self),
      cast: (ctx) => [addBuff(ctx.self, berserkerRage, ctx.self)],
    }),
  ],
};

export const BOULDERFIST_OGRE: CreatureCard = {
  kind: 'creature',
  id: 'boulderfist-ogre',
  name: 'Boulderfist Ogre',
  cost: 6,
  power: 6,
  health: 7,
};

export const BLESSING: SpellCard = {
  kind: 'spell',
  id: 'blessing',
  name: 'Blessing of Kings',
  cost: 1,
  text: 'Give a friendly creature +2/+2.',
  targeting: { who: 'ally', count: 1, match: (ctx, candidate) => candidate !== ctx.self },
  effect: (ctx, targeting) => {
    const target = targeting.targets[0];
    // Raising a max never refills, so the +2 health is healed in as well.
    return target ? [addBuff(target, blessed, ctx.self), heal(target.gauge('hp'), 2, ctx.self)] : [];
  },
};

/**
 * An **instant**: castable whenever its controller holds priority, not just
 * in their own main phase. The marker is the symbol from `speed.ts` — the
 * same one an activated ability can carry.
 */
export const FIREBALL: SpellCard = instant({
  kind: 'spell',
  id: 'fireball',
  name: 'Fireball',
  cost: 4,
  text: 'Deal 6 damage.',
  targeting: { who: 'enemy', count: 1 },
  effect: (ctx, targeting) => {
    const target = targeting.targets[0];
    return target ? [damage(target.gauge('hp'), 6, ctx.self)] : [];
  },
});

export const HEALING_TOUCH: SpellCard = {
  kind: 'spell',
  id: 'healing-touch',
  name: 'Healing Touch',
  cost: 3,
  text: 'Restore 8 health.',
  targeting: { who: 'ally', count: 1 },
  effect: (ctx, targeting) => {
    const target = targeting.targets[0];
    return target ? [heal(target.gauge('hp'), 8, ctx.self)] : [];
  },
};

export const ASSASSINATE: SpellCard = {
  kind: 'spell',
  id: 'assassinate',
  name: 'Assassinate',
  cost: 5,
  text: 'Destroy an enemy creature.',
  targeting: {
    who: 'enemy',
    count: 1,
    // Heroes have no power stat; creatures do — that tells them apart.
    match: (_ctx, candidate) => candidate.stat('power') !== undefined,
  },
  effect: (ctx, targeting) => {
    const target = targeting.targets[0];
    return target ? [destroy(target, ctx.self)] : [];
  },
};

export const CONSECRATION: SpellCard = {
  kind: 'spell',
  id: 'consecration',
  name: 'Consecration',
  cost: 4,
  text: 'Deal 2 damage to all enemies.',
  // No `targeting`: the effect finds its own victims, so nothing is
  // "targeted" and taunt/hexproof-style restrictions do not apply.
  effect: (ctx) =>
    ctx.engine.registeredCharacters
      .filter((c) => ctx.engine.isInPlay(c) && isEnemy(ctx.self, c))
      .map((c) => damage(c.gauge('hp'), 2, ctx.self)),
};

/* ------------------------------- the decks ------------------------------ */

/**
 * Repeats a card `n` times — decks run two copies of most things.
 *
 * The *data* is shared on purpose: identity belongs to the instantiated
 * entity (`objects.ts`), so two copies of one card are two entities built
 * from the same printed data.
 */
const copies = (card: Card, n: number): Card[] => Array.from({ length: n }, () => card);

export const STARTER_DECK: readonly Card[] = [
  ...copies(WISP, 2),
  ...copies(ELVEN_ARCHER, 2),
  ...copies(SHIELDBEARER, 2),
  ...copies(LOOT_HOARDER, 2),
  ...copies(BLOODFEN_RAPTOR, 2),
  ...copies(WOLFRIDER, 2),
  ...copies(GURUBASHI_BERSERKER, 1),
  ...copies(BOULDERFIST_OGRE, 1),
  ...copies(BLESSING, 2),
  ...copies(FIREBALL, 2),
  ...copies(HEALING_TOUCH, 1),
  ...copies(ASSASSINATE, 1),
  ...copies(CONSECRATION, 1),
];
