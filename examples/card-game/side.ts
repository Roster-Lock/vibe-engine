/**
 * A player's side of the table.
 *
 * The piles are the **engine's zones**, not a card-layer copy: a deck is the
 * `deck` zone, a hand the `hand` zone, the spent pile the `garbage` zone, and
 * a card is an entity (`objects.ts`). So `engine.zones.zoneOf(card)`
 * answers, a card cannot be in two piles at once, and the visibility/scope/
 * ordering a zone declared are the ones the game gets — one zone model
 * instead of two.
 *
 * ## Casting is a move, and drawing is too
 *
 * `hand → stack → active → (garbage | play)` is the whole life of a played
 * card, each step a real `zone:changed` through the pipeline. A draw is the
 * same kind of move (`deck → hand`), so "when you draw a card" is writable
 * content — which is why `draw` is async.
 */
import {
  damage,
  type Action,
  type Character,
  type GameEngine,
  type Player,
  type Zone,
  type ZoneRegistry,
} from '../../src/engine/index.js';
import { createDraw, type DrawFn } from '../../src/games/cards/draw.js';
import { GARBAGE } from '../../src/engine/index.js';
import { ACTIVE, DECK, HAND, STACK, STOLEN } from './zones.js';
import type { Card, CardSide } from './cards.js';
import { HAND_ABILITIES, instantiate, type CardObject } from './objects.js';

/**
 * The slice of a card player a side needs. Structural rather than an import
 * of `CardPlayer`, which would make a cycle (`ai.ts` → `game.ts` → here).
 */
export interface CardOwner extends Player {
  readonly hero: Character;
  readonly deckList: readonly Card[];
}

/** Hearthstone's ceiling: ten cards in hand. */
export const MAX_HAND = 10;

/**
 * A player's view of one zone of cards. Membership lives in the registry;
 * this only names the questions the card layer asks of a pile.
 */
export class CardPile {
  readonly #registry: ZoneRegistry;
  readonly #zone: Zone;

  constructor(registry: ZoneRegistry, zone: Zone) {
    this.#registry = registry;
    this.#zone = zone;
  }

  /** The engine zone behind this pile — for content that names zones. */
  get zone(): Zone {
    return this.#zone;
  }

  get size(): number {
    return this.#zone.size;
  }

  /** The pile, top first. */
  get cards(): readonly CardObject[] {
    return this.#zone.members as readonly CardObject[];
  }

  /** The top card (a deck's next draw), without moving it. */
  get top(): CardObject | undefined {
    return this.#zone.top as CardObject | undefined;
  }

  has(card: CardObject): boolean {
    return this.#zone.contains(card);
  }

  /** Moves a card into this pile (bottom), registering it if it is new. */
  add(card: CardObject): void {
    if (!this.#registry.has(card)) {
      this.#registry.add(card, this.#zone);
      return;
    }
    this.#registry.move(card, this.#zone);
  }

  shuffle(rng: () => number): void {
    this.#registry.shuffle(this.#zone, rng);
  }
}

export class Side implements CardSide {
  readonly hero: Character;
  readonly player: CardOwner;
  readonly deck: CardPile;
  readonly hand: CardPile;
  /** Spells' spent pile; destroyed permanents go to the engine's `graveyard`. */
  readonly garbage: CardPile;
  /** Where a card sits while it resolves, off the stack and untouchable. */
  readonly active: Zone;
  readonly stack: Zone;
  /** Permanents in play, in the order they landed. */
  readonly board: Character[] = [];

  /** How many times this side has drawn from an empty deck. */
  fatigue = 0;
  /** Creatures that have already attacked this turn. */
  readonly attacked = new Set<Character>();
  #engine: GameEngine;
  readonly #drawFn: DrawFn;

  constructor(player: CardOwner, engine: GameEngine) {
    this.player = player;
    this.hero = player.hero;
    this.#engine = engine;
    // `draw(player, count)` is the shared function (`src/games/cards/draw.ts`);
    // this side supplies Hearthstone's edges: fatigue on an empty deck, a burn
    // past ten cards.
    this.#drawFn = createDraw(engine, {
      library: DECK.id,
      hand: HAND.id,
      maxHand: MAX_HAND,
      overflow: GARBAGE.id,
      onEmpty: async () => {
        this.fatigue += 1;
        await engine.apply([damage(this.hero.gauge('hp'), this.fatigue)]);
      },
    });
    const zones = engine.zones;
    // Declaring is idempotent (`ZoneRegistry.declare`), so a side is
    // self-contained whether or not its game pre-declared `CARD_ZONES`.
    for (const zone of [DECK, HAND, GARBAGE, ACTIVE, STACK, STOLEN] as const) zones.declare(zone);
    this.active = zones.zone(ACTIVE.id)!;
    this.stack = zones.zone(STACK.id)!;
    this.deck = new CardPile(zones, zones.zone(DECK.id, player)!);
    this.hand = new CardPile(zones, zones.zone(HAND.id, player)!);
    this.garbage = new CardPile(zones, zones.zone(GARBAGE.id, player)!);

    // The deck is instantiated once: a creature card becomes the permanent it
    // will be, now, so playing it is a move rather than a construction.
    // (Two copies of one card are two entities from the same printed data.)
    // Each physical card needs an id of its own (a sealed "commit a card" round names cards by
    // id), so the second copy of a printed card is `id#2`, the third `id#3`. The first keeps
    // the printed id; `printedId` is always the printed one.
    const copies = new Map<string, number>();
    for (const card of player.deckList) {
      const nth = (copies.get(card.id) ?? 0) + 1;
      copies.set(card.id, nth);
      const object = instantiate(card, player.hero.controller!, this);
      if (nth > 1) (object as { id: string }).id = `${card.id}#${nth}`;
      if (object.type === 'character') {
        engine.registerCharacter(object, { zone: DECK.id, owner: player });
      } else {
        engine.zones.add(object, zones.zone(DECK.id, player)!);
      }
      // Abilities the card gives itself (`Suspend: …`): its owner may use them while it is in their hand.
      for (const own of object.handAbilities ?? []) {
        HAND_ABILITIES.add(own);
        engine.grantAbility(object, own, [player], { until: 'manual' });
      }
    }
  }

  get heroName(): string {
    return this.hero.name;
  }

  /** Mana the side can spend right now. */
  get mana(): number {
    return this.hero.gauge('mana').current;
  }

  /**
   * Draws cards, `deck → hand` — a real move, so `zone:changed` fires and
   * content can answer it (the whole reason this is async now).
   *
   * An empty deck deals growing fatigue damage instead, through the same
   * pipeline; a full hand burns the card into the garbage.
   */
  async draw(count = 1): Promise<void> {
    await this.#drawFn(this.player, count);
  }
}

/** Kept for callers that still speak in terms of the old queue. */
export type CardAction = Action;
