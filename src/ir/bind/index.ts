/**
 * `src/ir/bind/` — the only part of the IR that knows about `src/engine`.
 *
 * Takes the game-agnostic IR (`src/ir/ability.ts`) and produces this
 * engine's content objects: `ManualAbility`, `BuffDef`, `TriggeredAbility`.
 * A different game over the same IR (an RTS, a 2D plane — see
 * `examples/rts`) supplies its own binder here rather than forking the
 * language.
 *
 * - `ability.ts` — `DocumentIR` → `ManualAbility[]` + `BuffDef[]`.
 * - `batch-event.ts` / `trigger.ts` — the lower-level `DeclaredFn`-based
 *   trigger shapes (docs/free-write/triggered.md). `TriggerIR` is the
 *   declarative form the English surface produces and the one to reach for;
 *   these remain the escape hatch for hand-written content whose logic does
 *   not fit a declarative slot.
 */
export { compileBatchEvent, type BatchEvent } from './batch-event.js';
export { compileTrigger, type Trigger } from './trigger.js';
export { bindDocument, type BindOptions, type BindResult } from './ability.js';
