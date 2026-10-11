/**
 * The shared content types: what a fighter *is* (`CharacterDef`) and the
 * SVG media every fighter ships with (`CharacterMedia`).
 *
 * Each character folder exports its own `CharacterDef` (see `hero/`,
 * `goblin/`, …); the roster is just the list of those defs.
 */
import type { Character } from '../../../../engine/index.js';

/** The four SVG states every fighter ships with. */
export interface CharacterMedia {
  readonly portrait: string;
  readonly idle: string;
  readonly attack: string;
  readonly hit: string;
}

/**
 * The full definition of a roster fighter: identity, how to build a fresh
 * in-memory `Character`, and its SVG media.
 */
export interface CharacterDef {
  readonly id: string;
  readonly name: string;
  /** One emoji used as the fighter's portrait. */
  readonly emoji: string;
  readonly tagline: string;
  /** Builds a fresh character instance for a new match. */
  readonly make: () => Character;
  /** SVG media: portrait (select screen) + idle/attack/hit animations. */
  readonly media: CharacterMedia;
}
