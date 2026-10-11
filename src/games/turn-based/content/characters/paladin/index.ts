/**
 * The Paladin — tanky; smites foes and lays on hands.
 * Roster id: `paladin`.
 *
 * This folder is the whole character: its skills, its SVG media and its
 * `CharacterDef` (identity + how to build a fresh instance).
 */
import { Character, cast, damage, heal, skill } from '../../../index.js';
import type { CharacterDef, CharacterMedia } from '../types.js';

import portrait from './portrait.svg';
import idle from './idle.svg';
import attack from './attack.svg';
import hit from './hit.svg';

/** SVG media for this fighter. */
export const media: CharacterMedia = { portrait, idle, attack, hit };

export const smite = cast({
  name: 'Smite',
  description: '20 damage (HP) and heal yourself for 8',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [
    damage(targeting.targets[0]!.gauge('hp'), 20, ctx.self),
    heal(ctx.self.gauge('hp'), 8, ctx.self),
  ],
});

export const layOnHands = cast({
  name: 'Lay on Hands',
  description: 'heal one ally for 25',
  targeting: { who: 'ally', count: 1 },
  cast: (ctx, targeting) => [heal(targeting.targets[0]!.gauge('hp'), 25, ctx.self)],
});

export function makePaladin(): Character {
  return new Character('Paladin', {
    maxHp: 170,
    maxMana: 170,
    speed: 8,
    skills: [
      skill({ name: 'Holy Order', weight: 1, abilities: [smite] }),
      skill({ name: 'Cleric', weight: 1, abilities: [layOnHands] }),
    ],
  });
}

/** This fighter's full definition — the roster is built from these. */
export const character: CharacterDef = {
  id: 'paladin',
  name: 'Paladin',
  emoji: '⚜️',
  tagline: 'Tanky; smites foes and lays on hands.',
  make: makePaladin,
  media,
};
