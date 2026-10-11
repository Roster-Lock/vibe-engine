/**
 * The watch-battle content: one folder per fighter in `./characters/` (each
 * holding its source, its SVG media and its own `CharacterDef`), and one
 * folder per buff in `./buffs/` (each holding its source and its SVG icon),
 * with everything else (the roster and the `HumanPlayer`) here.
 *
 * This module is the single entry point the tinyquest UI imports from —
 * prefer importing from here instead of reaching into `characters/` directly:
 *
 * ```ts
 * import { ROSTER, rosterById } from '../../examples/08-27-2026/index.js';
 * ```
 *
 * ## Content rules
 *
 * - **One targeting ability per user-triggered skill.** A skill the *user*
 *   triggers carries exactly **one** targeting ability — using a skill
 *   means picking targets once, not once per bundled ability. An ability
 *   that genuinely needs several targets at once — like Life Drain (drain
 *   a victim, heal a benefactor) — is its own skill whose single ability
 *   has a multi-target targeting pattern; the cast reads the targets
 *   positionally.
 * - **Abilities describe themselves.** Every ability carries its own
 *   `description` on its definition (`cast`/`auto`/…), so there is no
 *   separate blurb table to keep in sync.
 */
import {
  Character,
  Player,
  type Decision,
} from '../../../engine/index.js';
import {
  makeHero,
  strike,
  firstAid,
  heroCharacter,
  makeGoblin,
  headbutt,
  warCry,
  goblinCharacter,
  makePyromancer,
  fireball,
  arcaneBolt,
  meditate,
  pyromancerCharacter,
  makeAssassin,
  venomStrike,
  backstab,
  assassinCharacter,
  makePaladin,
  smite,
  layOnHands,
  paladinCharacter,
  makeHound,
  bite,
  howl,
  houndCharacter,
  makeVampire,
  lifeDrain,
  vampireCharacter,
  type CharacterDef,
} from './characters/index.js';

export * from './buffs/index.js';
export type { CharacterDef, CharacterMedia } from './characters/index.js';
export {
  makeHero,
  strike,
  firstAid,
  makeGoblin,
  headbutt,
  warCry,
  makePyromancer,
  fireball,
  arcaneBolt,
  meditate,
  makeAssassin,
  venomStrike,
  backstab,
  makePaladin,
  smite,
  layOnHands,
  makeHound,
  bite,
  howl,
  makeVampire,
  lifeDrain,
} from './characters/index.js';

/* ----------------------------- roster ------------------------------ */

/**
 * Every fighter the Select page offers. Each entry is the `CharacterDef`
 * its own folder exports — the roster just lists them.
 */
export const ROSTER: readonly CharacterDef[] = [
  heroCharacter,
  goblinCharacter,
  pyromancerCharacter,
  assassinCharacter,
  paladinCharacter,
  houndCharacter,
  vampireCharacter,
];

/** Looks up a roster entry by id (used by the router). */
export function rosterById(id: string): CharacterDef | undefined {
  return ROSTER.find((entry) => entry.id === id);
}

/* --------------------------- human player -------------------------- */

/**
 * A player controlled by the UI. `decide()` parks a promise; the UI calls
 * `submit(...)` with the player's choices to release it.
 */
export class HumanPlayer extends Player {
  #pending: ((decisions: Decision[]) => void) | undefined;

  async decide(): Promise<Decision[]> {
    return new Promise((resolve) => {
      this.#pending = resolve;
    });
  }

  /** The UI calls this when the player has made their choices. */
  submit(decisions: Decision[]): void {
    const resolve = this.#pending;
    this.#pending = undefined;
    resolve?.(decisions);
  }

  /** True while the game is waiting on this player. */
  get isWaiting(): boolean {
    return this.#pending !== undefined;
  }
}
