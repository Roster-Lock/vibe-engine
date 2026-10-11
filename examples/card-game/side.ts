/**
 * A player's side of the table: the hero the engine knows about, and all the
 * card-layer state it does not (deck, hand, discard, board, crystals).
 */
import { damage, type Action, type Character } from '../../src/engine/index.js';
import type { Card, CardSide } from './cards.js';
import { Zone } from './zones.js';

/** Hearthstone's ceiling: ten crystals, ten cards in hand. */
export const MAX_CRYSTALS = 10;
export const MAX_HAND = 10;

export class Side implements CardSide {
  readonly hero: Character;
  readonly deck: Zone<Card>;
  readonly hand = new Zone<Card>('hand');
  readonly discard = new Zone<Card>('discard');
  /** Creatures in play, in the order they landed. */
  readonly board: Character[] = [];

  /** Mana crystals earned so far — the hero's mana max is derived from them. */
  crystals = 0;
  /** How many times this side has drawn from an empty deck. */
  fatigue = 0;
  /** Creatures that have already attacked this turn. */
  readonly attacked = new Set<Character>();
  /** Cards burned (drawn into a full hand) and fatigue damage, for the log. */
  readonly #pending: Action[] = [];

  constructor(hero: Character, deck: readonly Card[]) {
    this.hero = hero;
    this.deck = new Zone('deck', deck);
  }

  get heroName(): string {
    return this.hero.name;
  }

  /** Mana the side can spend right now. */
  get mana(): number {
    return this.hero.gauge('mana').current;
  }

  /**
   * Draws cards. Deliberately **synchronous** so a deathrattle's `cast` can
   * call it: the damage an empty deck deals is queued as an Action instead,
   * and the game flushes it through the pipeline at the next safe point
   * (`CardGame.flush`).
   */
  draw(count = 1): void {
    for (let i = 0; i < count; i++) {
      const card = this.deck.draw();
      if (!card) {
        this.fatigue += 1;
        this.#pending.push(damage(this.hero.gauge('hp'), this.fatigue));
        continue;
      }
      if (this.hand.size >= MAX_HAND) {
        this.discard.add(card); // burned
        continue;
      }
      this.hand.add(card);
    }
  }

  /** Takes the queued actions, emptying the queue. */
  takePending(): Action[] {
    return this.#pending.splice(0, this.#pending.length);
  }
}
