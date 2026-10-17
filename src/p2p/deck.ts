/**
 * The **owner's** side of a hidden deck (docs/design/20-secret-choices-and-dice.md,
 * "Peer-to-peer hidden zones").
 *
 * The owner is the only one who knows what each card is, so the owner:
 *
 * 1. gives every physical card a secret `s`, and **commits** to the whole deck before
 *    play — a Merkle root over `H('leaf', s, card)` — so a card cannot later be claimed
 *    to be something else;
 * 2. names each card on the table by an **id** `H('id', s, generation)`: an opaque
 *    string that reveals nothing, and that the shuffler can shuffle without knowing
 *    what it is;
 * 3. publishes `H('idhash', id)` for the ids it hands over, so the shuffler can later
 *    be shown not to have added a stranger or dropped a card;
 * 4. when a card is looked at and put back (a scry), **renames** it — the next
 *    generation's id — so the shuffler cannot tell which of the looked-at cards went
 *    where; and
 * 5. opens everything at the end for the audit.
 */
import { H, merkleProof, merkleRoot, randomHex, type MerkleStep, type RandomHex } from './hash.js';

export interface DeckCommitment {
  /** Merkle root over the deck, published before play. */
  readonly root: string;
  readonly size: number;
}

/** A claim, during play, about what a card is — checkable against the commitment. */
export interface CardClaim {
  /** The card's position in the original deck order (the Merkle leaf). */
  readonly index: number;
  readonly secret: string;
  readonly card: string;
  readonly proof: readonly MerkleStep[];
}

/** Everything, opened at the end of the game. */
export interface DeckOpening {
  readonly secrets: readonly string[];
  readonly cards: readonly string[];
  /** The newest generation each card's id reached. */
  readonly generations: readonly number[];
}

export class OwnerDeck {
  readonly #secrets: string[];
  readonly #cards: string[];
  readonly #generations: number[];
  readonly #leaves: string[];
  readonly #random: RandomHex;
  /** Every id ever issued, to the card (by original index) and generation it names. */
  readonly #known = new Map<string, { index: number; generation: number }>();
  readonly root: string;

  private constructor(cards: readonly string[], secrets: string[], leaves: string[], root: string, random: RandomHex) {
    this.#cards = [...cards];
    this.#secrets = secrets;
    this.#generations = cards.map(() => 0);
    this.#leaves = leaves;
    this.root = root;
    this.#random = random;
  }

  /** Commits to `cards` (their order here is the deck's identity, not the play order). */
  static async create(cards: readonly string[], options: { random?: RandomHex } = {}): Promise<OwnerDeck> {
    const random = options.random ?? randomHex;
    const secrets = cards.map(() => random(16));
    const leaves = await Promise.all(cards.map((card, i) => H('leaf', secrets[i]!, card)));
    const deck = new OwnerDeck(cards, secrets, leaves, await merkleRoot(leaves), random);
    for (let i = 0; i < cards.length; i += 1) deck.#known.set(await deck.#idOf(i, 0), { index: i, generation: 0 });
    return deck;
  }

  get size(): number {
    return this.#cards.length;
  }

  commitment(): DeckCommitment {
    return { root: this.root, size: this.size };
  }

  async #idOf(index: number, generation: number): Promise<string> {
    return H('id', this.#secrets[index]!, generation);
  }

  /** The id each card currently goes by, in original order — what the shuffler is handed. */
  async currentIds(): Promise<string[]> {
    return Promise.all(this.#cards.map((_, i) => this.#idOf(i, this.#generations[i]!)));
  }

  /** `H('idhash', id)` for each id: published before they are handed over. */
  async idHashes(ids?: readonly string[]): Promise<string[]> {
    return Promise.all((ids ?? (await this.currentIds())).map((id) => H('idhash', id)));
  }

  /** What card an id names — the owner alone can say. Undefined for an id that is not theirs. */
  lookup(id: string): { index: number; card: string; generation: number } | undefined {
    const known = this.#known.get(id);
    return known ? { index: known.index, card: this.#cards[known.index]!, generation: known.generation } : undefined;
  }

  /**
   * Renames cards that were looked at: each gets its next-generation id. The new ids are
   * returned **in a random order**, so that handing them to the shuffler as a set does
   * not say which old id each replaced.
   */
  async rename(retiredIds: readonly string[]): Promise<string[]> {
    const fresh: string[] = [];
    for (const id of retiredIds) {
      const known = this.#known.get(id);
      if (!known) throw new Error('rename: that id is not one of this deck\'s');
      if (known.generation !== this.#generations[known.index]) {
        throw new Error('rename: that id was already retired');
      }
      this.#generations[known.index] = known.generation + 1;
      const next = await this.#idOf(known.index, known.generation + 1);
      this.#known.set(next, { index: known.index, generation: known.generation + 1 });
      fresh.push(next);
    }
    // Fisher–Yates with the injected randomness.
    for (let i = fresh.length - 1; i > 0; i -= 1) {
      const j = Number.parseInt(this.#random(4), 16) % (i + 1);
      [fresh[i], fresh[j]] = [fresh[j]!, fresh[i]!];
    }
    return fresh;
  }

  /** A claim that the card at original position `index` is what it is, with its proof. */
  async claim(index: number): Promise<CardClaim> {
    return {
      index,
      secret: this.#secrets[index]!,
      card: this.#cards[index]!,
      proof: await merkleProof(this.#leaves, index),
    };
  }

  /** The claim for the card an id names. */
  async claimFor(id: string): Promise<CardClaim> {
    const known = this.#known.get(id);
    if (!known) throw new Error('claimFor: that id is not one of this deck\'s');
    return this.claim(known.index);
  }

  /** Opens the whole deck, for the end-of-game audit. */
  open(): DeckOpening {
    return { secrets: [...this.#secrets], cards: [...this.#cards], generations: [...this.#generations] };
  }
}
