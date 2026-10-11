/**
 * The War Hound — fast bites that stack up a frenzy.
 * Roster id: `hound`.
 *
 * This folder is the whole character: its skills, its SVG media and its
 * `CharacterDef` (identity + how to build a fresh instance).
 */
import { Character, addBuff, cast, damage, heal, skill } from '../../../index.js';
import { rage } from '../../buffs/rage/index.js';
import type { CharacterDef, CharacterMedia } from '../types.js';

import portrait from './portrait.svg';
import idle from './idle.svg';
import attack from './attack.svg';
import hit from './hit.svg';

/** SVG media for this fighter. */
export const media: CharacterMedia = { portrait, idle, attack, hit };

export const bite = cast({
  name: 'Bite',
  description: '16 damage to one enemy (HP — the life gauge)',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 16, ctx.self)],
});

export const howl = cast({
  name: 'Howl',
  description: 'heal yourself 10 and gain a Rage stack',
  targeting: { who: 'self', count: 1 },
  cast: (ctx, targeting) => [
    heal(ctx.self.gauge('hp'), 10, ctx.self),
    addBuff(ctx.self, rage, ctx.self),
  ],
});

export function makeHound(): Character {
  return new Character('War Hound', {
    maxHp: 130,
    maxMana: 130,
    speed: 16,
    skills: [
      skill({ name: 'Beast', weight: 1, abilities: [bite] }),
      skill({ name: 'Pack Leader', weight: 1, abilities: [howl] }),
    ],
  });
}

/** This fighter's full definition — the roster is built from these. */
export const character: CharacterDef = {
  id: 'hound',
  name: 'War Hound',
  emoji: '🐺',
  tagline: 'Fast bites that stack up a frenzy.',
  make: makeHound,
  media,
};
