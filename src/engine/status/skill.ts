/**
 * The Skill — a permanent status. Given at character creation, never added
 * or removed at runtime, `removable` is always false, and it has no
 * `caster`/`grantedBy` — skills are innate.
 */
import type { Ability } from '../ability/index.js';
import type { Character } from '../character.js';
import { nextInstanceUid, slugify } from './shared.js';
import type { SkillDef, StatusBase, StatusDirection } from './types.js';

/** A skill instance attached to exactly one character (permanent). */
export class Skill implements StatusBase {
  readonly type = 'skill' as const;
  readonly id: string;
  readonly uid: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly weight: number;
  readonly removable = false;
  readonly vars: Record<string, unknown>;
  readonly abilities: readonly Ability[];
  /** Skills are innate — nobody casts them, so there is no creator. */
  readonly caster = undefined;
  readonly target: Character | undefined;
  /** Skills are innate — nothing grants them, so there is no grantor. */
  readonly grantedBy = undefined;
  readonly direction: StatusDirection | undefined;

  constructor(def: SkillDef, ctx: { target?: Character } = {}) {
    this.id = def.id ?? slugify(def.name);
    this.uid = nextInstanceUid('skill');
    this.name = def.name;
    this.description = def.description;
    this.icon = def.icon;
    this.weight = def.weight;
    this.vars = def.variables ? def.variables() : {};
    this.abilities = def.abilities ?? [];
    this.direction = def.direction;
    this.target = ctx.target;
  }
}

/** Declares a skill. Character creation clones it into a permanent instance. */
export function skill(def: SkillDef): SkillDef {
  return def;
}
