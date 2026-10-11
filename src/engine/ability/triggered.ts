/**
 * Triggered abilities — they listen to an event and fire:
 *
 * - **auto**   — computes its own targets and fires (`targeting` or `targets`).
 * - **prompt** — asks the player for targets before firing.
 */
import type { Character } from '../character.js';
import type { GameEvent } from '../events.js';
import { deriveId, type CastResult, type TargetPattern, type Targeting, type TriggerContext } from './types.js';

export interface TriggeredAbility<E extends GameEvent['type'] = GameEvent['type']> {
  readonly kind: 'trigger';
  readonly id: string;
  readonly name: string;
  /** Short human-readable description of what the ability does. */
  readonly description?: string;
  readonly event: E;
  /**
   * The **prestack filter**: when the event fires, this decides whether the
   * trigger joins the prepare stack (and eventually the active stack). Runs
   * before targeting or casting, on every listener of the event.
   */
  when?(ctx: TriggerContext<E>): boolean;
  /**
   * When present (auto abilities), the engine computes targets from this
   * pattern — `who`, `match`, `negate` and `include` all apply. Mutually
   * exclusive with `targets`.
   */
  targeting?: TargetPattern;
  /** Auto-computed targets. Omit if the trigger fires without a target. */
  targets?(ctx: TriggerContext<E>): Character[] | Promise<Character[]>;
  /** When present, the player is asked to pick targets before casting. */
  prompt?(ctx: TriggerContext<E>): TargetPattern;
  cast(ctx: TriggerContext<E>, targeting: Targeting | undefined): CastResult;
}

/** A triggered ability with the event type erased to the full union. */
export type AnyTriggeredAbility = TriggeredAbility<GameEvent['type']>;

export interface AutoDef<E extends GameEvent['type']> {
  readonly id?: string;
  readonly name: string;
  /** Short human-readable description of what the ability does. */
  readonly description?: string;
  readonly event: E;
  /** The prestack filter: gates whether the trigger joins the prepare stack. */
  when?(ctx: TriggerContext<E>): boolean;
  /**
   * Let the engine compute targets from a targeting pattern instead of
   * writing a `targets` callback by hand. Provide one or the other.
   */
  targeting?: TargetPattern;
  targets?(ctx: TriggerContext<E>): Character[] | Promise<Character[]>;
  cast(ctx: TriggerContext<E>, targeting: Targeting | undefined): CastResult;
}

/** A triggered ability that picks its own targets. */
export function auto<E extends GameEvent['type']>(def: AutoDef<E>): TriggeredAbility<E> {
  if (def.targeting && def.targets) {
    throw new Error(
      `auto("${def.name}"): provide either "targeting" or "targets", not both`,
    );
  }
  return {
    kind: 'trigger',
    id: def.id ?? deriveId(def.name, 'ability'),
    name: def.name,
    event: def.event,
    ...(def.description ? { description: def.description } : {}),
    ...(def.when ? { when: def.when } : {}),
    ...(def.targeting ? { targeting: def.targeting } : {}),
    ...(def.targets ? { targets: def.targets } : {}),
    cast: def.cast,
  };
}

export interface PromptDef<E extends GameEvent['type']> {
  readonly id?: string;
  readonly name: string;
  /** Short human-readable description of what the ability does. */
  readonly description?: string;
  readonly event: E;
  /** The prestack filter: gates whether the trigger joins the prepare stack. */
  when?(ctx: TriggerContext<E>): boolean;
  prompt(ctx: TriggerContext<E>): TargetPattern;
  cast(ctx: TriggerContext<E>, targeting: Targeting): CastResult;
}

/** A triggered ability that asks the player for targets before firing. */
export function prompt<E extends GameEvent['type']>(def: PromptDef<E>): TriggeredAbility<E> {
  return {
    kind: 'trigger',
    id: def.id ?? deriveId(def.name, 'ability'),
    name: def.name,
    event: def.event,
    ...(def.description ? { description: def.description } : {}),
    ...(def.when ? { when: def.when } : {}),
    prompt: def.prompt,
    cast: def.cast,
  };
}
