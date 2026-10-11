/**
 * Barrel over the roster fighters — one folder per character, each holding
 * its source (`index.ts`), its SVG media and its `CharacterDef` (`character`).
 * Every fighter's def is renamed here (`heroCharacter`, …) so the roster can
 * tell them apart.
 *
 * Prefer importing from the example's `index.ts`, but reaching in here is
 * fine when you only want a single fighter.
 */
export type { CharacterDef, CharacterMedia } from './types.js';

export { makeHero, strike, firstAid, character as heroCharacter } from './hero/index.js';
export { makeGoblin, headbutt, warCry, character as goblinCharacter } from './goblin/index.js';
export { makePyromancer, fireball, arcaneBolt, meditate, character as pyromancerCharacter } from './pyromancer/index.js';
export { makeAssassin, venomStrike, backstab, character as assassinCharacter } from './assassin/index.js';
export { makePaladin, smite, layOnHands, character as paladinCharacter } from './paladin/index.js';
export { makeHound, bite, howl, character as houndCharacter } from './hound/index.js';
export { makeVampire, lifeDrain, character as vampireCharacter } from './vampire/index.js';
