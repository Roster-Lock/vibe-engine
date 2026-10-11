/**
 * Compiles a `BatchEvent<Trigger>` (docs/free-write/triggered.md) — the
 * declared shape a "when N things happen then ..." sentence translates
 * into — into an ordinary `TriggeredAbility`.
 *
 * This is the translation boundary: past this point `trigger-stack.ts` can't
 * tell a compiled ability from a hand-written `auto(...)` one, so it runs
 * through the exact same prepare-stack, seeded shuffle, and queue as
 * everything else (docs/spec/06-events-triggers.md).
 *
 * `event` names one of the engine's `:batch` events (`character:destroyed:batch`,
 * `character:survived:batch`, `gauge:changed:batch`, `buff:destroyed:batch`)
 * — the "when one or more ... then ..." primitive from
 * docs/creator/01-ability-language.md. `willTrigger` is the runtime form of
 * that doc's count-phrase table (`one or more`, `n or more`, `n to m`; even/odd
 * is a `% 2` compare — see the example in src/examples/execution.ts).
 */
import { auto, type TriggeredAbility } from '../../engine/ability/index.js';
import type { Action } from '../../engine/actions.js';
import type { GameEvent } from '../../engine/events.js';
import { evaluateDeclaredFn, type DeclaredFn, type DeclaredFnContext } from '../declared-fn/index.js';

export interface BatchEvent<Trigger> {
  readonly name: string;
  /** One of the engine's `:batch` event types, e.g. `'character:survived:batch'`. */
  readonly event: string;
  /**
   * Per-instance filter: which of the batch's individual events count as a
   * trigger. "While a whole board may be dealt damage by something like
   * Pyroclasm, only characters owned by opponents might be valid triggers —
   * if your opponent has no characters, this returns an empty array, and
   * this doesn't continue" (an empty filtered array skips `willTrigger`
   * entirely — see `compileBatchEvent` below).
   */
  readonly triggerFilter: DeclaredFn<Trigger, boolean>;
  /** Gates on the filtered batch as a whole — the count-phrase check. */
  readonly willTrigger: DeclaredFn<readonly Trigger[], boolean>;
  /** What happens, given the filtered batch. */
  readonly actions: readonly DeclaredFn<readonly Trigger[], readonly Action[]>[];
}

/** Reads a `:batch` GameEvent's `events: Trigger[]` payload. */
function eventsOf<Trigger>(event: unknown): readonly Trigger[] {
  return (event as { events: readonly Trigger[] }).events;
}

export function compileBatchEvent<Trigger>(def: BatchEvent<Trigger>): TriggeredAbility {
  const triggersOf = (ctx: DeclaredFnContext & { readonly event: unknown }): Trigger[] =>
    eventsOf<Trigger>(ctx.event).filter((event) => evaluateDeclaredFn(def.triggerFilter, event, ctx));

  return auto({
    name: def.name,
    // The event name is compiled data, not a `GameEvent['type']` literal —
    // the same widening `english/compile.ts` does when it turns parsed AST
    // into real engine content.
    event: def.event as GameEvent['type'],
    when: (ctx) => {
      const triggers = triggersOf(ctx);
      return triggers.length > 0 && evaluateDeclaredFn(def.willTrigger, triggers, ctx);
    },
    cast: (ctx) => def.actions.flatMap((fn) => evaluateDeclaredFn(fn, triggersOf(ctx), ctx)),
  });
}
