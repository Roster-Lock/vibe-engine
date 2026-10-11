/**
 * The Goblin Chieftain — headbutts you and roars into a rage.
 * Roster id: `goblin`.
 *
 * This folder is the whole character: its skills, its SVG media and its
 * `CharacterDef` (identity + how to build a fresh instance).
 */
import { Character, addBuff, cast, damage, skill } from '../../../index.js';
import { rage } from '../../buffs/rage/index.js';
import type { CharacterDef, CharacterMedia } from '../types.js';

import portrait from './portrait.svg';
import idle from './idle.svg';
import attack from './attack.svg';
import hit from './hit.svg';

/** SVG media for this fighter. */
export const media: CharacterMedia = { portrait, idle, attack, hit };

export const headbutt = cast({
  name: 'Headbutt',
  description: '22 damage to one enemy (HP — the life gauge)',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 22, ctx.self)],
});

export const warCry = cast({
  name: 'War Cry',
  description: 'gain a Rage stack (+5 outgoing damage each)',
  targeting: { who: 'self', count: 1 },
  cast: (ctx, targeting) => [addBuff(targeting.targets[0]!, rage, ctx.self)],
});

export function makeGoblin(): Character {
  return new Character('Goblin Chieftain', {
    maxHp: 110,
    maxMana: 110,
    speed: 10,
    skills: [
      skill({ name: 'Chieftain', weight: 1, abilities: [headbutt] }),
      skill({ name: 'Berserker', weight: 1, abilities: [warCry] }),
    ],
  });
}

/** This fighter's full definition — the roster is built from these. */
export const character: CharacterDef = {
  id: 'goblin',
  name: 'Goblin Chieftain',
  emoji: '👺',
  tagline: 'Headbutts you and roars into a rage.',
  make: makeGoblin,
  media,
};
