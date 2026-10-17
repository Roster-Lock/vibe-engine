/**
 * The **shuffler's** side of a hidden deck (docs/design/20-secret-choices-and-dice.md).
 *
 * The shuffler holds the order of the pile and is handed the owner's ids, so it knows
 * *where* each card is but not *what* it is; the owner knows what each id is but not
 * where it sits. Neither can learn a card without the other.
 *
 * For each position the shuffler publishes `H('slot', id, r)` with a fresh random `r`.
 * That commits it to the order — it cannot later pretend a different id was at a
 * position — without telling anyone the id. When the owner is to see a card the shuffler
 * reveals `(id, r)` and the owner checks it against the published hash.
 */
import { H, randomBelow, randomHex, type RandomHex } from './hash.js';

export interface Slot {
  readonly id: string;
  readonly r: string;
}

/** A slot as the shuffler holds it, with the commitment it published. */
export interface OpenedSlot extends Slot {
  readonly commitment: string;
}

export class Shuffler {
  /** The live pile, top first. */
  readonly #pile: OpenedSlot[] = [];
  /** Every slot ever published, in the order they were — what the audit opens. */
  readonly #history: OpenedSlot[] = [];
  readonly #random: RandomHex;

  private constructor(random: RandomHex) {
    this.#random = random;
  }

  /** Shuffles `ids` into a random order and commits to it. */
  static async shuffle(ids: readonly string[], options: { random?: RandomHex } = {}): Promise<Shuffler> {
    const random = options.random ?? randomHex;
    const shuffler = new Shuffler(random);
    const order = [...ids];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = randomBelow(i + 1, random);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const id of order) shuffler.#pile.push(await shuffler.#slot(id));
    return shuffler;
  }

  async #slot(id: string): Promise<OpenedSlot> {
    const r = this.#random(16);
    const slot = { id, r, commitment: await H('slot', id, r) };
    this.#history.push(slot);
    return slot;
  }

  get size(): number {
    return this.#pile.length;
  }

  /** The commitments in pile order, top first — public. */
  published(): string[] {
    return this.#pile.map((slot) => slot.commitment);
  }

  /** Every commitment ever published, in order (initial shuffle, then each rearrangement's additions). */
  publishedHistory(): string[] {
    return this.#history.map((slot) => slot.commitment);
  }

  /** Looks at the slot at `position` without removing it: what a scry shows the owner. */
  peek(position: number): OpenedSlot {
    const slot = this.#pile[position];
    if (!slot) throw new Error(`peek: no slot at position ${position}`);
    return slot;
  }

  /** Takes the slot at `position` out of the pile (a draw): its `(id, r)` goes to the owner. */
  take(position = 0): OpenedSlot {
    const slot = this.#pile[position];
    if (!slot) throw new Error(`take: no slot at position ${position}`);
    this.#pile.splice(position, 1);
    return slot;
  }

  /**
   * After a scry: removes the first `count` slots (the owner has looked at them and
   * retired their ids) and puts **new** slots — the owner's renamed ids — on top (in
   * the order given) and on the bottom. Returns the commitments of the new slots.
   */
  async rearrange(count: number, top: readonly string[], bottom: readonly string[]): Promise<{ top: string[]; bottom: string[] }> {
    if (count > this.#pile.length) throw new Error(`rearrange: only ${this.#pile.length} cards to look at`);
    this.#pile.splice(0, count);
    const newTop: OpenedSlot[] = [];
    for (const id of top) newTop.push(await this.#slot(id));
    const newBottom: OpenedSlot[] = [];
    for (const id of bottom) newBottom.push(await this.#slot(id));
    this.#pile.unshift(...newTop);
    this.#pile.push(...newBottom);
    return { top: newTop.map((s) => s.commitment), bottom: newBottom.map((s) => s.commitment) };
  }

  /** Opens every slot ever published, for the audit. */
  openAll(): OpenedSlot[] {
    return [...this.#history];
  }
}

/** The owner's check on a reveal: does `(id, r)` match what was published at that slot? */
export async function verifyReveal(commitment: string, slot: Slot): Promise<boolean> {
  return (await H('slot', slot.id, slot.r)) === commitment;
}
