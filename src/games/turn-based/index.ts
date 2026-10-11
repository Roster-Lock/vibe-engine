/**
 * **Turn-based combat** — the game layer built on the engine.
 *
 * The engine (`src/engine/`) is the game-agnostic core: gauges, actions,
 * triggers, statuses, zones, and the extension seams a game uses to declare
 * its own vocabulary. This layer is the *specific game* the repo ships: it
 * owns the words the engine deliberately does not know — `hp` as life, `mana`
 * as a resource, and the death rules that make the first one lethal.
 *
 * ## Why import from here
 *
 * It re-exports the whole engine surface, so this is the entry point content
 * uses: one import gives you `GameEngine`, `buff`, `cast`, `damage`, *and*
 * this game's `Character`. Anything the engine exports is available here
 * unchanged, so the two never drift.
 *
 * ```ts
 * import { Character, GameEngine, buff, cast } from '../games/turn-based/index.js';
 *
 * const hero = new Character('Hero', { maxHp: 20, maxMana: 5 });
 * ```
 */
export * from '../../engine/index.js';

/**
 * This game's `Character` — the engine's entity plus the `hp`/`mana`
 * shorthand (see `character.ts`). Declared after the star export so it
 * *shadows* the engine's class: content gets the game's constructor, while
 * `EngineCharacter` remains reachable for code that wants the bare entity.
 */
export { Character, type FighterDef } from './character.js';
export { Character as EngineCharacter } from '../../engine/index.js';
export {
  collapsesAtZero,
  depletesAtZero,
  hpGauge,
  manaGauge,
} from './death.js';
export { DEFAULT_SPEED, sortBySpeed } from './initiative.js';
export {
  isDamage,
  isHeal,
  isHpChange,
  isManaChange,
  wasDealtBy,
  wasTakenBy,
} from './events.js';

/**
 * This game is round-based, so it also re-exports the shared round-based layer
 * — but **by name, not by `export *`**.
 *
 * That distinction is load-bearing. A second `export *` here would re-export
 * `Character` from the engine, colliding with this layer's own `Character`.
 * TypeScript resolves the collision to the explicit export, while ESM resolves
 * the ambiguous star export differently at runtime — so the type checker and
 * the running code would disagree about which `Character` you get, and every
 * `{ maxHp }` character would silently come out with no gauges.
 */
export { TeamOutcome } from '../round-based/outcome.js';
export { createEngine } from '../round-based/index.js';
export { lose, win } from '../round-based/win-lose.js';
export { startTurn, endTurn } from '../round-based/turn.js';
