/**
 * The Vampire Lord — the example of a *multi-target* user-triggered skill.
 * Roster id: `vampire`.
 *
 * This folder is the whole character: its skills, its SVG media and its
 * `CharacterDef` (identity + how to build a fresh instance).
 *
 * Content rule: a user-triggered skill carries exactly ONE targeting
 * ability. When an ability needs to target several characters at once (as
 * Life Drain does — a victim to drain, a benefactor to heal), that is its
 * own skill, with one ability whose targeting pattern asks for multiple
 * targets. The cast reads them positionally: `targets[0]` is the victim,
 * `targets[1]` is the benefactor.
 */
import { Character, cast, damage, heal, skill } from '../../../index.js';
import type { CharacterDef, CharacterMedia } from '../types.js';

import portrait from './portrait.svg';
import idle from './idle.svg';
import attack from './attack.svg';
import hit from './hit.svg';
import { isAlly, isEnemy } from '../../../../round-based/index.js';

/** SVG media for this fighter. */
export const media: CharacterMedia = { portrait, idle, attack, hit };

export const lifeDrain = cast({
  name: 'Life Drain',
  description: 'drain 18 HP (life) from a victim, heal a benefactor for 18',
  targeting: {
    // One ability, two targets: pick a victim first, then a benefactor.
    who: 'any',
    count: 2,
    // Only the caster and their enemies are legal picks, so the player
    // can't drain from a teammate.
    match: (ctx, candidate) =>
      candidate === ctx.self || isEnemy(ctx.self, candidate),
  },
  cast: (ctx, targeting) => {
    const [victim, benefactor] = targeting.targets;
    if (!victim || !benefactor) return [];
    // The drain hits HP — the life gauge — so it is the lethal part.
    return [damage(victim.gauge('hp'), 18, ctx.self), heal(benefactor.gauge('hp'), 18, ctx.self)];
  },
});

export function makeVampire(): Character {
  return new Character('Vampire Lord', {
    maxHp: 120,
    maxMana: 120,
    speed: 14,
    skills: [skill({ name: 'Blood Magic', weight: 1, abilities: [lifeDrain] })],
  });
}

/** This fighter's full definition — the roster is built from these. */
export const character: CharacterDef = {
  id: 'vampire',
  name: 'Vampire Lord',
  emoji: '🧛',
  tagline: 'Life Drain — two targets, one skill.',
  make: makeVampire,
  media,
};
