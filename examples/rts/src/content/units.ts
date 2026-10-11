/**
 * The unit roster — stat lines, and which abilities each unit knows.
 *
 * A unit references its abilities **by id**, and those ids come from the
 * names in `abilities.rts`: `Ability Storm Bolt` is `storm-bolt`. That is
 * the whole coupling between the two files. Nothing here imports a compiled
 * ability, and nothing in `abilities.rts` knows a unit exists — so a
 * creator can rewrite a hero's kit without touching TypeScript, and a
 * designer can rebalance a stat line without touching the ability text.
 *
 * Numbers are roughly Warcraft 3's: ~90 melee range, 270 move speed, a
 * Footman around 420 hit points.
 */
import { slug } from '../ir.js';
import type { UnitDef } from '../sim/unit.js';

/** Turns the display names used in `abilities.rts` into the ids units reference. */
function abilities(...names: string[]): string[] {
  return names.map(slug);
}

export const FOOTMAN: UnitDef = {
  id: 'footman',
  name: 'Footman',
  maxHp: 420,
  hpRegen: 0.5,
  maxMana: 0,
  manaRegen: 0,
  armor: 2,
  moveSpeed: 270,
  attackDamage: 13,
  attackRange: 90,
  attackCooldown: 1.35,
  acquisitionRange: 600,
  radius: 32,
  abilities: [],
};

export const GRUNT: UnitDef = {
  id: 'grunt',
  name: 'Grunt',
  maxHp: 700,
  hpRegen: 0.7,
  maxMana: 0,
  manaRegen: 0,
  armor: 1,
  moveSpeed: 270,
  attackDamage: 19,
  attackRange: 90,
  attackCooldown: 1.4,
  acquisitionRange: 600,
  radius: 32,
  abilities: [],
};

/** A ranged unit whose attacks stack a poison — the trigger-driven passive. */
export const HEADHUNTER: UnitDef = {
  id: 'headhunter',
  name: 'Headhunter',
  maxHp: 375,
  hpRegen: 0.4,
  maxMana: 0,
  manaRegen: 0,
  armor: 0,
  moveSpeed: 290,
  attackDamage: 16,
  attackRange: 400,
  attackCooldown: 1.5,
  acquisitionRange: 700,
  radius: 28,
  abilities: abilities('Envenomed Spears'),
};

/** Retaliates against everything that touches it. */
export const MOUNTAIN_GIANT: UnitDef = {
  id: 'mountain-giant',
  name: 'Mountain Giant',
  maxHp: 1350,
  hpRegen: 1.2,
  maxMana: 0,
  manaRegen: 0,
  armor: 4,
  moveSpeed: 220,
  attackDamage: 30,
  attackRange: 90,
  attackCooldown: 2.2,
  acquisitionRange: 600,
  radius: 44,
  abilities: abilities('Thorns Aura'),
};

export const MOUNTAIN_KING: UnitDef = {
  id: 'mountain-king',
  name: 'Mountain King',
  maxHp: 950,
  hpRegen: 1.5,
  maxMana: 300,
  manaRegen: 4,
  armor: 4,
  moveSpeed: 290,
  attackDamage: 34,
  attackRange: 90,
  attackCooldown: 1.9,
  acquisitionRange: 700,
  radius: 36,
  // Cast priority is list order: the single-target nuke, then the area
  // stomp, then the panic button.
  abilities: abilities('Storm Bolt', 'Thunder Clap', 'Avatar', 'Cleave'),
};

export const SHADOW_HUNTER: UnitDef = {
  id: 'shadow-hunter',
  name: 'Shadow Hunter',
  maxHp: 820,
  hpRegen: 1.2,
  maxMana: 400,
  manaRegen: 5,
  armor: 2,
  moveSpeed: 290,
  attackDamage: 26,
  attackRange: 450,
  attackCooldown: 1.7,
  acquisitionRange: 750,
  radius: 36,
  abilities: abilities('Healing Wave', 'Rejuvenation', 'Carrion Swarm', 'Raise Dead', 'Feast'),
};

/** What `Summon 2 Skeleton Warrior near this unit.` creates. */
export const SKELETON_WARRIOR: UnitDef = {
  id: 'skeleton-warrior',
  name: 'Skeleton Warrior',
  maxHp: 180,
  hpRegen: 0,
  maxMana: 0,
  manaRegen: 0,
  armor: 0,
  moveSpeed: 270,
  attackDamage: 12,
  attackRange: 90,
  attackCooldown: 1.6,
  acquisitionRange: 600,
  radius: 26,
  abilities: [],
};

export const UNITS: readonly UnitDef[] = [
  FOOTMAN,
  GRUNT,
  HEADHUNTER,
  MOUNTAIN_GIANT,
  MOUNTAIN_KING,
  SHADOW_HUNTER,
  SKELETON_WARRIOR,
];

/** The ids `Summon` may name — passed to the compiler so a typo is an error. */
export const SUMMONABLE: readonly string[] = [SKELETON_WARRIOR.id];
