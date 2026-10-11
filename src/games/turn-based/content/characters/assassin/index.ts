/**
 * The Shadow Assassin — backstabs hard and coats blades in poison.
 * Roster id: `assassin`.
 *
 * This folder is the whole character: its skills, its SVG media and its
 * `CharacterDef` (identity + how to build a fresh instance).
 */
import { Character, addBuff, cast, damage, skill } from '../../../index.js';
import { poison } from '../../buffs/poison/index.js';
import type { CharacterDef, CharacterMedia } from '../types.js';

import portrait from './portrait.svg';
import idle from './idle.svg';
import attack from './attack.svg';
import hit from './hit.svg';

/** SVG media for this fighter. */
export const media: CharacterMedia = { portrait, idle, attack, hit };

export const venomStrike = cast({
  name: 'Venom Strike',
  description: '14 damage and apply Poison (5/round per stack)',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [
    damage(targeting.targets[0]!.gauge('hp'), 14, ctx.self),
    addBuff(targeting.targets[0]!, poison, ctx.self),
  ],
});

export const backstab = cast({
  name: 'Backstab',
  description: '30 damage to one enemy (HP — the life gauge)',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 30, ctx.self)],
});

export function makeAssassin(): Character {
  return new Character('Shadow Assassin', {
    maxHp: 110,
    maxMana: 110,
    speed: 18,
    skills: [
      skill({ name: 'Venom Arts', weight: 1, abilities: [venomStrike] }),
      skill({ name: 'Shadow Arts', weight: 1, abilities: [backstab] }),
    ],
  });
}

/** This fighter's full definition — the roster is built from these. */
export const character: CharacterDef = {
  id: 'assassin',
  name: 'Shadow Assassin',
  emoji: '🗡️',
  tagline: 'Backstabs hard and coats blades in poison.',
  make: makeAssassin,
  media,
};
