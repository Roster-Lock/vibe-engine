/**
 * Zones — the one thing the engine has no opinion about.
 *
 * The engine owns exactly two *character* zones (play and graveyard, see
 * docs/spec/07-targeting-zones.md) and nothing else: a deck, a hand and a
 * discard pile hold **cards**, which are not characters, so they live here
 * in the card layer.
 */
import { shuffle } from '../../src/engine/index.js';

/** An ordered pile of cards. The "top" of the pile is index 0. */
export class Zone<T> {
  readonly name: string;
  #cards: T[];

  constructor(name: string, cards: readonly T[] = []) {
    this.name = name;
    this.#cards = [...cards];
  }

  get size(): number {
    return this.#cards.length;
  }

  get isEmpty(): boolean {
    return this.#cards.length === 0;
  }

  /** The pile, top first. */
  get cards(): readonly T[] {
    return this.#cards;
  }

  /** Takes the top card, or `undefined` when the pile is empty. */
  draw(): T | undefined {
    return this.#cards.shift();
  }

  add(card: T): void {
    this.#cards.push(card);
  }

  /** Removes one card by identity. Returns whether it was there. */
  remove(card: T): boolean {
    const at = this.#cards.indexOf(card);
    if (at === -1) return false;
    this.#cards.splice(at, 1);
    return true;
  }

  /**
   * Shuffles in place with the game's PRNG — pass `() => engine.random()` so
   * a match replays identically from its seed (the engine's commit/reveal
   * ceremony, see `Game.collectSeed`).
   */
  shuffle(rng: () => number): void {
    shuffle(this.#cards, rng);
  }
}
