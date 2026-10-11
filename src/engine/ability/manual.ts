/**
 * Manual abilities — the player picks targets, then the ability fires.
 * Built with `cast(...)`; the engine runs them via
 * `engine.useAbility(owner, ability, targeting)`.
 */
import { deriveId, type AbilityContext, type CastResult, type TargetPattern, type Targeting } from './types.js';

export interface ManualAbility {
  readonly kind: 'manual';
  readonly id: string;
  readonly name: string;
  /** Short human-readable description of what the ability does. */
  readonly description?: string;
  readonly targeting: TargetPattern;
  /**
   * Whether the ability can be used **right now**. Omitted means always.
   *
   * Declarative on purpose: an ability that is "enabled by a trigger" is
   * not a flag something flips, it is an ability whose condition mentions
   * what the trigger changed ("available while this has Charged"). Nothing
   * has to stay in sync, no event can be missed, and the answer is derived
   * from the board — so it is the same after a reload or a replay.
   *
   * That also keeps a **stable binding**: the ability never leaves the
   * owner's kit, so a UI (or a gamepad button) can hold one slot for it
   * and merely grey it out. An ability that appears and disappears would
   * shuffle every other slot around it.
   */
  available?(ctx: AbilityContext): boolean;
  /** Runs when the player uses the ability with chosen targets. */
  cast(ctx: AbilityContext, targeting: Targeting): CastResult;
}

export interface CastDef {
  readonly id?: string;
  readonly name: string;
  /** Short human-readable description of what the ability does. */
  readonly description?: string;
  readonly targeting: TargetPattern;
  /** Whether it can be used right now — see `ManualAbility.available`. */
  available?(ctx: AbilityContext): boolean;
  cast(ctx: AbilityContext, targeting: Targeting): CastResult;
}

/** A manual ability: the player picks targets, then it fires. */
export function cast(def: CastDef): ManualAbility {
  return {
    kind: 'manual',
    id: def.id ?? deriveId(def.name, 'ability'),
    name: def.name,
    targeting: def.targeting,
    cast: def.cast,
    ...(def.available ? { available: def.available } : {}),
    ...(def.description ? { description: def.description } : {}),
  };
}
