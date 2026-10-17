/**
 * An append-only, hash-chained log of what was published (docs/design/20-secret-choices-and-dice.md).
 *
 * Each entry carries the hash of the one before it, so an entry cannot be changed,
 * dropped or reordered afterwards without breaking every hash after it. Everyone keeps
 * their own copy; at the audit the copies are compared.
 *
 * ⚠ It is a hash chain, **not a signature**: it shows that the log is intact, not who
 * wrote an entry. A real deployment signs each entry with its author's key.
 */
import { H } from './hash.js';

export type TranscriptBody =
  | { readonly type: 'deck'; readonly root: string; readonly size: number }
  | { readonly type: 'idhashes'; readonly hashes: readonly string[] }
  | { readonly type: 'shuffle'; readonly commitments: readonly string[] }
  | { readonly type: 'take'; readonly position: number; readonly commitment: string }
  | {
      readonly type: 'rearrange';
      readonly removed: number;
      readonly top: readonly string[];
      readonly bottom: readonly string[];
    }
  | { readonly type: 'claim'; readonly id: string; readonly card: string };

export type TranscriptEntry = TranscriptBody & { readonly prev: string; readonly hash: string };

const GENESIS = '0'.repeat(64);

export class Transcript {
  readonly #entries: TranscriptEntry[] = [];

  get entries(): readonly TranscriptEntry[] {
    return this.#entries;
  }

  async append(body: TranscriptBody): Promise<TranscriptEntry> {
    const prev = this.#entries[this.#entries.length - 1]?.hash ?? GENESIS;
    const entry = { ...body, prev, hash: await H('entry', prev, JSON.stringify(body)) } as TranscriptEntry;
    this.#entries.push(entry);
    return entry;
  }

  /** True when every entry's hash is right and chains to the one before. */
  static async verify(entries: readonly TranscriptEntry[]): Promise<boolean> {
    let prev = GENESIS;
    for (const entry of entries) {
      const { prev: claimedPrev, hash, ...body } = entry;
      if (claimedPrev !== prev) return false;
      if (hash !== (await H('entry', prev, JSON.stringify(body)))) return false;
      prev = hash;
    }
    return true;
  }
}
