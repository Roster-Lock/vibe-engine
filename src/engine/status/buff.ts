/**
 * The Buff — a status that can be added to a character at runtime and
 * removed again (unless `removable: false`). Each application creates a
 * fresh instance with its own `vars`; `stacks: true` lets several copies
 * of the same id sit side by side.
 */
import type { Ability } from '../ability/index.js';
import type { Character } from '../character.js';
import { nextInstanceUid, slugify } from './shared.js';
import type { BuffDef, Status, StatusBase, StatusDirection } from './types.js';

/** A buff instance attached to exactly one character. */
export class Buff implements StatusBase {
  readonly type = 'buff' as const;
  readonly id: string;
  readonly uid: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly weight: number;
  readonly removable: boolean;
  readonly removedOnDefeat: boolean;
  readonly stacks: boolean;
  readonly vars: Record<string, unknown>;
  readonly abilities: readonly Ability[];
  readonly caster: Character | undefined;
  readonly target: Character | undefined;
  readonly grantedBy: Status | undefined;
  readonly direction: StatusDirection | undefined;

  constructor(
    def: BuffDef,
    ctx: { caster?: Character; target?: Character; grantedBy?: Status } = {},
  ) {
    this.id = def.id ?? slugify(def.name);
    this.uid = nextInstanceUid('buff');
    this.name = def.name;
    this.description = def.description;
    this.icon = def.icon;
    this.weight = def.weight;
    this.removable = def.removable ?? true;
    this.removedOnDefeat = def.removedOnDefeat ?? true;
    this.stacks = def.stacks ?? false;
    this.vars = def.variables ? def.variables() : {};
    this.abilities = def.abilities ?? [];
    this.direction = def.direction;
    this.caster = ctx.caster;
    this.target = ctx.target;
    this.grantedBy = ctx.grantedBy;
  }
}

/**
 * Declares a buff. A fresh instance is created each time it is applied.
 *
 * Buffs **fade when their wearer is defeated** by default (`removedOnDefeat:
 * false` opts out) — the creator's defeat never removes a buff from its
 * wearer. An aura grants `removable: false` marks: applied at runtime,
 * never dispelled, still weighted, and destroyed with the aura (by the
 * removal cascade) whenever the aura goes, however it goes. A buff that
 * must react to its own end — a bomb that explodes — carries a buff:destroyed self-trigger
 * ability.
 */
export function buff(def: BuffDef): BuffDef {
  return def;
}
