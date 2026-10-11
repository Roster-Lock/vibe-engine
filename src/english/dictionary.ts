/**
 * The buff dictionary: where `Add <buff>` / `Remove <buff>` sentences
 * resolve their names to real engine `BuffDef`s.
 *
 * The language has no built-in content. Hosts provide entries through this
 * dictionary or the import resolver; document declarations are local defs.
 */
import { buff, type BuffDef } from '../engine/index.js';

export interface DictionaryEntry {
  /** The name as players type it (display case). */
  readonly name: string;
  readonly def: BuffDef;
}

/** A lookup index over dictionary entries, keyed by lowercased name and slug. */
export class BuffDictionary {
  readonly #entries: DictionaryEntry[] = [];
  readonly #byKey = new Map<string, DictionaryEntry>();

  constructor(entries: readonly DictionaryEntry[]) {
    for (const entry of entries) {
      this.#entries.push(entry);
      this.#byKey.set(entry.name.toLowerCase(), entry);
      this.#byKey.set(slug(entry.name), entry);
    }
  }

  /** The names players can reference, in insertion order. */
  get names(): string[] {
    return this.#entries.map((e) => e.name);
  }

  /** Every entry, in insertion order. */
  get entries(): readonly DictionaryEntry[] {
    return this.#entries;
  }

  hasName(name: string): boolean {
    return this.#byKey.has(name.toLowerCase()) || this.#byKey.has(slug(name));
  }

  /**
   * Resolves a typed name: exact lowercased match first, then a slug
   * (case/hyphen-insensitive) match.
   */
  resolve(name: string): BuffDef | undefined {
    return this.entryOf(name)?.def;
  }

  /**
   * Resolves a typed name to its dictionary entry — the entry carries the
   * display name (as declared / as built in), which references are shown
   * with regardless of how they were typed.
   */
  entryOf(name: string): DictionaryEntry | undefined {
    const exact = this.#byKey.get(name.toLowerCase());
    if (exact) return exact;
    return this.#byKey.get(slug(name));
  }

  /** Close-name suggestions for a typo (used by the checker diagnostics). */
  suggest(name: string): string[] {
    const lower = name.toLowerCase();
    const slugged = slug(name);
    return this.#entries
      .filter((e) => {
        const n = e.name.toLowerCase();
        return (
          n.includes(lower) ||
          lower.includes(n) ||
          slugged.includes(slug(e.name)) ||
          slug(e.name).includes(slugged)
        );
      })
      .map((e) => e.name)
      .slice(0, 5);
  }
}

/** An empty language dictionary; content is always host- or document-provided. */
export function emptyDictionary(): BuffDictionary {
  return new BuffDictionary([]);
}

/** Lowercases and hyphenates a name — matches the engine's default status ids. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export { buff };
export type { BuffDef };
