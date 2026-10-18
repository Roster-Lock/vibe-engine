/**
 * The **zone dictionary** — where a zone-movement trigger's zone names
 * resolve (`when this enters play from active then …`).
 *
 * Zones are game data: the engine ships exactly two (`play`, `garbage`,
 * see `src/engine/zone.ts`) and a game declares the rest — a deck, a hand,
 * a stack, a resolving `active` slot, an exile. So the language cannot
 * hard-code the list any more than it can hard-code buffs; the host supplies
 * one, exactly as it supplies a `BuffDictionary`.
 *
 * The engine's two built-in zones are always known, so an ability written
 * against a bare engine (`when a character enters garbage from play
 * then …`) type-checks without the host declaring anything.
 */
import { slug } from './dictionary.js';

/** The zones the engine itself declares (`src/engine/zone.ts`). */
export const ENGINE_ZONES: readonly string[] = ['play', 'garbage'];

/** A lookup index over the zone names a document may name. */
export class ZoneDictionary {
  readonly #names: string[] = [];
  readonly #byKey = new Map<string, string>();

  constructor(names: readonly string[] = ENGINE_ZONES) {
    for (const name of [...ENGINE_ZONES, ...names]) this.add(name);
  }

  /** Adds a zone name. Re-adding a known zone (in any spelling) is a no-op. */
  add(name: string): void {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const key = slug(trimmed);
    if (this.#byKey.has(key)) return;
    this.#byKey.set(key, trimmed);
    this.#names.push(trimmed);
  }

  /** The zone names players can reference, in insertion order. */
  get names(): readonly string[] {
    return this.#names;
  }

  has(name: string): boolean {
    return this.#byKey.has(slug(name));
  }

  /**
   * Resolves a typed name to the zone's canonical spelling — so a reference
   * is shown as the game declared it (`Garbage`, not `garbage`)
   * everywhere, including in the IR.
   */
  resolve(name: string): string | undefined {
    return this.#byKey.get(slug(name));
  }

  /** Close-name suggestions for a typo (used by the parser's diagnostics). */
  suggest(name: string): string[] {
    const wanted = slug(name);
    return this.#names
      .filter((candidate) => {
        const key = slug(candidate);
        return key.includes(wanted) || wanted.includes(key);
      })
      .slice(0, 5);
  }
}

/** A dictionary of just the engine's own zones. */
export function emptyZoneDictionary(): ZoneDictionary {
  return new ZoneDictionary([]);
}
