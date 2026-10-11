/**
 * The Hero — a balanced fighter: strikes hard, patches up.
 * Roster id: `hero`.
 *
 * This folder is the whole character: its skills, its SVG media and its
 * `CharacterDef` (identity + how to build a fresh instance).
 *
 * Content rule: a user-triggered skill carries exactly ONE targeting
 * ability, so each of the Hero's moves is its own skill.
 */
import { Character, cast, damage, heal, skill } from '../../../index.js';
import type { CharacterDef, CharacterMedia } from '../types.js';

import portrait from './portrait.svg';
import idle from './idle.svg';
import attack from './attack.svg';
import hit from './hit.svg';

/** SVG media for this fighter. */
export const media: CharacterMedia = { portrait, idle, attack, hit };

export const strike = cast({
  name: 'Strike',
  description: '20 damage to one enemy (HP — the life gauge)',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 20, ctx.self)],
});

export const firstAid = cast({
  name: 'First Aid',
  description: 'heal 10 HP to one ally',
  targeting: { who: 'ally', count: 1 },
  cast: (ctx, targeting) => [heal(targeting.targets[0]!.gauge('hp'), 10, ctx.self)],
});

export function makeHero(): Character {
  return new Character('Hero', {
    maxHp: 150,
    maxMana: 150,
    speed: 12,
    skills: [
      skill({ name: 'Fighter', weight: 1, abilities: [strike] }),
      skill({ name: 'Field Medic', weight: 1, abilities: [firstAid] }),
    ],
  });
}

/** This fighter's full definition — the roster is built from these. */
export const character: CharacterDef = {
  id: 'hero',
  name: 'Hero',
  emoji: '🛡️',
  tagline: 'Balanced fighter — strike hard, patch up.',
  make: makeHero,
  media,
};
