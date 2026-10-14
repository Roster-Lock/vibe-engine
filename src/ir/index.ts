/**
 * `src/ir/` — the **intermediate representation**: what a player's English
 * becomes before it becomes a runnable ability.
 *
 * Everything in this folder is plain JSON — no closures, no class
 * instances. That is the whole point (docs/GOAL.md, "the language and the
 * share format are the same problem"): an IR that survives
 * `JSON.stringify` is simultaneously
 *
 * - the **share format** (an ability written by one player travels to
 *   another and runs identically),
 * - the **compilation target** of `src/english/`,
 * - what an editor **introspects** (hover, render, explain — see
 *   `mathNodeToLatex`), and
 * - a **sandbox boundary**: imported content can only do what the node
 *   vocabulary below permits, where an imported *closure* could do
 *   anything.
 *
 * ```
 *   text ──► src/english ──► DocumentIR ──► src/ir/bind ──► engine content
 *            (lex/parse/lower)  (this folder)   (one game's binding)
 * ```
 *
 * Two layers live here:
 *
 * - **`ability.ts`** — the *declarative* layer: abilities, buffs, triggers,
 *   entity queries and filters. This is what the English surface produces
 *   and what travels between players.
 * - **`declared-fn/`** — the *expression* layer: a small typed expression
 *   tree (`get`/`compare`/`math`/`forEach`/`gauge`/…) for the places a
 *   declarative slot is not enough. `ability.ts`'s shapes lower into these.
 *
 * `bind/` is the one part that is **not** game-agnostic: it turns IR into
 * `src/engine`'s content objects. A second game (an RTS, a 2D plane) gets
 * its own binder over the same IR rather than a second language.
 */

/* ------------------------- the declarative IR ------------------------- */
export type {
  DocumentIR,
  DurationIR,
  AbilityIR,
  ActionMatchIR,
  ActionRewriteIR,
  ModifierIR,
  BuffIR,
  TriggerIR,
  TriggerZoneIR,
  TriggerScope,
  TriggerMode,
  RepeatIR,
  StepIR,
  TargetBindingIR,
  EffectIR,
  EntityQueryIR,
  PredicateIR,
  ValueIR,
  TargetingIR,
  BuffRefIR,
  ImportIR,
  GaugeOp,
  CompareOp,
} from './ability.js';
export { IR_VERSION, isEntityEffect } from './ability.js';

/* ------------------------- the expression IR -------------------------- */
export {
  evaluateDeclaredFn,
  mathNodeToLatex,
  type ActionNode,
  type BooleanNode,
  type DeclaredFn,
  type DeclaredFnContext,
  type IterationNode,
  type MathNode,
  type VariableNode,
} from './declared-fn/index.js';
export {
  evaluateMathExpression,
  mathToLatex,
  mathToSource,
  parseMathExpression,
  type MathContext,
  type MathExpression,
} from './math-expression.js';
export {
  applyOneRewrite,
  applyRewriteChain,
  constValue,
  foldRewriteChain,
  rewriteChainSteps,
  rewriteChainToLatex,
  settle,
} from './rewrite-math.js';

/* --------------------------- engine binding --------------------------- */
export {
  compileBatchEvent,
  compileTrigger,
  bindDocument,
  type BatchEvent,
  type Trigger,
  type BindOptions,
  type BindResult,
} from './bind/index.js';
