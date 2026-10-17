/**
 * Shared ability types: what a target looks like, the contexts an ability
 * sees while it runs, and the result shape a cast produces. Plus
 * `deriveId`, the tiny slug helper every builder uses (internal — the
 * `index.ts` does not re-export it).
 */
import type { Action } from '../actions.js';
import type { TargetWho } from '../contracts.js';
import type { Character } from '../character.js';
import type { GameEngine } from '../engine.js';
import type { GameEvent } from '../events.js';
import type { Status } from '../status/index.js';
import type { Entity } from '../zone.js';

/**
 * Who an ability may target, relative to its owner — derived from the open
 * `TargetWhoMap` (contracts.ts), so a game can declare its own values
 * (`'ally'`, `'enemy'`, …). The engine answers only `'self'` and `'any'`
 * itself; everything else is a resolver the game registers.
 */
export type { TargetWho } from '../contracts.js';

/** Context available while a targeting match condition runs. */
export interface TargetingContext {
  /** The character that owns the ability being targeted. */
  readonly self: Character;
  readonly engine: GameEngine;
}

/**
 * A custom targeting condition: a predicate over each candidate character.
 * Runs after the `who` filter, on every candidate in the pool.
 */
export type TargetCondition = (ctx: TargetingContext, candidate: Character) => boolean;

/** Describes what the player is allowed to pick for a manual/prompt ability. */
export interface TargetPattern {
  readonly who: TargetWho;
  /** Number of targets, or a `[min, max]` range. Defaults to 1. */
  readonly count?: number | [number, number];
  /** Allow picking the same character more than once. Defaults to false. */
  readonly allowDuplicates?: boolean;
  /**
   * Custom condition every candidate must satisfy to be a valid target.
   * Without one, only the `who` filter applies.
   */
  readonly match?: TargetCondition;
  /**
   * Negation: flips the targeting from *inclusive* to *exclusive*.
   * With a `match`, candidates that satisfy it are removed from the pool
   * instead of kept ("every enemy except taunters"). Without a `match`,
   * the `who` filter itself is inverted ("everyone who is not an enemy").
   */
  readonly negate?: boolean;
  /**
   * Specific characters that are always valid targets, regardless of
   * `who`/`match`/`negate` — e.g. a spell that must also hit the
   * marked target. Only registered characters take effect.
   */
  readonly include?: readonly Character[];
}

/** The targeting information an ability receives. */
export interface Targeting {
  readonly targets: Character[];
}

/** What an ability can see while it runs. */
export interface AbilityContext {
  /** The character that owns this ability — or, for a card-hosted one, the one using it. */
  readonly self: Character;
  readonly engine: GameEngine;
  /**
   * The **card** this ability belongs to, when it is not a character's own: an
   * ability a zone or an effect gave a card (a Boxed Present's *Open Present*).
   * "This card" in such an ability is `host`. Absent for an ability a character
   * carries itself.
   */
  readonly host?: Entity;
}

/** Context for a trigger, with the event narrowed to the subscribed type. */
export type TriggerContext<E extends GameEvent['type']> = AbilityContext & {
  readonly event: Extract<GameEvent, { type: E }>;
  /**
   * The status (buff or skill) that **owns** the triggered ability running.
   * Lets a `buff:destroyed` self-trigger match its own instance —
   * `when: (ctx) => ctx.event.buff.uid === ctx.status.uid` — so with
   * stacked copies of a buff, removing one detonates only that copy.
   */
  readonly status: Status;
};

export type CastResult = Action[] | Promise<Action[]>;

/** Turns an ability name into a stable id (used by the builders). */
export function deriveId(name: string, fallback: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}
