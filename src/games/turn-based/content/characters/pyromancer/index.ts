/**
 * The Pyromancer — a glass cannon: big fire spells, big mana bills.
 * Roster id: `pyromancer`.
 *
 * This folder is the whole character: its skills, its SVG media and its
 * `CharacterDef` (identity + how to build a fresh instance).
 */
import { Character, cast, changeGaugeBy, damage, skill } from '../../../index.js';
import type { CharacterDef, CharacterMedia } from '../types.js';

import portrait from './portrait.svg';
import idle from './idle.svg';
import attack from './attack.svg';
import hit from './hit.svg';

/** SVG media for this fighter. */
export const media: CharacterMedia = { portrait, idle, attack, hit };

export const fireball = cast({
  name: 'Fireball',
  description: '35 damage for 12 mana (staff whack when short)',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => {
    const caster = ctx.self;
    const target = targeting.targets[0]!;
    // Out of mana? Fall back to a staff whack instead of a fizzle.
    // Damage hits HP — the life gauge — so both are lethal.
    if (caster.gauge('mana').current < 12) return [damage(target.gauge('hp'), 6, caster)];
    return [changeGaugeBy(caster.gauge('mana'), -12, caster), damage(target.gauge('hp'), 35, caster)];
  },
});

export const arcaneBolt = cast({
  name: 'Arcane Bolt',
  description: '18 damage for 4 mana (staff whack when short)',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => {
    const caster = ctx.self;
    const target = targeting.targets[0]!;
    if (caster.gauge('mana').current < 4) return [damage(target.gauge('hp'), 6, caster)];
    return [changeGaugeBy(caster.gauge('mana'), -4, caster), damage(target.gauge('hp'), 18, caster)];
  },
});

export const meditate = cast({
  name: 'Meditate',
  description: 'restore 12 mana',
  targeting: { who: 'self', count: 1 },
  cast: (ctx, targeting) => [changeGaugeBy(targeting.targets[0]!.gauge('mana'), 12, ctx.self)],
});

export function makePyromancer(): Character {
  return new Character('Pyromancer', {
    maxHp: 95,
    maxMana: 40,
    speed: 9,
    skills: [
      skill({ name: 'Fire Adept', weight: 1, abilities: [fireball] }),
      skill({ name: 'Arcanist', weight: 1, abilities: [arcaneBolt] }),
      skill({ name: 'Meditation', weight: 1, abilities: [meditate] }),
    ],
  });
}

/** This fighter's full definition — the roster is built from these. */
export const character: CharacterDef = {
  id: 'pyromancer',
  name: 'Pyromancer',
  emoji: '🔥',
  tagline: 'Glass cannon. Big fire, big mana bills.',
  make: makePyromancer,
  media,
};
