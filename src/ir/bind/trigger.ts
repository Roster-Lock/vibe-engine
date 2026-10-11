/**
 * Compiles a `Trigger<T>` — the per-instance sibling of `BatchEvent<Trigger>`
 * (docs/free-write/triggered.md) — into an ordinary `TriggeredAbility`.
 *
 * "When a character dies" (no count phrase) fires once per matching
 * event, not once per batch: no `willTrigger`, no count gate, and `actions`
 * runs against the single event directly rather than a filtered array.
 */
import { auto, type TriggeredAbility } from '../../engine/ability/index.js';
import type { Action } from '../../engine/actions.js';
import type { GameEvent } from '../../engine/events.js';
import { evaluateDeclaredFn, type DeclaredFn } from '../declared-fn/index.js';

export interface Trigger<T> {
  readonly name: string;
  /** One of the engine's non-`:batch` event types, e.g. `'character:survived'`. */
  readonly event: string;
  readonly triggerFilter: DeclaredFn<T, boolean>;
  readonly actions: readonly DeclaredFn<T, readonly Action[]>[];
}

export function compileTrigger<T>(def: Trigger<T>): TriggeredAbility {
  return auto({
    name: def.name,
    event: def.event as GameEvent['type'],
    when: (ctx) => evaluateDeclaredFn(def.triggerFilter, ctx.event as unknown as T, ctx),
    cast: (ctx) => def.actions.flatMap((fn) => evaluateDeclaredFn(fn, ctx.event as unknown as T, ctx)),
  });
}
