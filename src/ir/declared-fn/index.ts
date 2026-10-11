/**
 * DeclaredFn — a JSON expression tree standing in for a small pure function,
 * so a translated ability's logic stays data: introspectable (an editor can
 * render/hover it — `mathNodeToLatex` extracts a math node's formula as
 * LaTeX) and safe to store, instead of a compiled closure.
 *
 * The vocabulary is split by category, one file each:
 *
 * - `variable.ts` — `get`/`set`: read `input`/`self`/`vars`, write `vars`.
 * - `boolean.ts`  — `bool`/`and`/`or`/`not`/`compare`.
 * - `math.ts`     — `math`: wraps a `MathExpression` (Σ, arithmetic, dynamic
 *   indexing, and LaTeX rendering — see `math-expression.ts`).
 * - `iteration.ts`— `some`/`every`/`forEach`.
 * - `action.ts`   — `gauge`/`buff`/`character`/`player`: the noun-based
 *   vocabulary for producing real engine Actions.
 *
 * `Input`/`Output` are phantom — every node is plain data at runtime, and
 * `{ kind: 'get', root: 'input', path: [] }` is just whatever value
 * `evaluateDeclaredFn` was called with. This file is the one place that
 * assembles the category unions and knows how to dispatch on `kind`; the
 * category files know nothing about each other or about this dispatcher
 * (they take `evaluate` as a parameter instead — see `types.ts`).
 */
import { evaluateActionNode, type ActionNode } from './action.js';
import { evaluateBooleanNode, type BooleanNode } from './boolean.js';
import { evaluateIterationNode, type IterationNode } from './iteration.js';
import { evaluateMathNode, mathNodeToLatex, type MathNode } from './math.js';
import type { AnyDeclaredFn, Phantom } from './types.js';
import { evaluateVariableNode, type VariableNode } from './variable.js';

export type { DeclaredFnContext, Evaluate } from './types.js';
export type { VariableNode } from './variable.js';
export type { BooleanNode } from './boolean.js';
export type { MathNode } from './math.js';
export type { IterationNode } from './iteration.js';
export type { ActionNode } from './action.js';
export { mathNodeToLatex };

import type { DeclaredFnContext } from './types.js';

type DeclaredFnBody<Input> = VariableNode<Input> | BooleanNode<Input> | MathNode | IterationNode<Input> | ActionNode<Input>;

export type DeclaredFn<Input, Output> = DeclaredFnBody<Input> & Phantom<Input, Output>;

/**
 * Runs a DeclaredFn against one `input` value. `Output` is phantom — nothing
 * at runtime checks that a node's declared `Output` matches what it actually
 * produces. That's the same trade `english/compile.ts` makes at its own
 * translation boundary: past this point, correctness is the compiler's job,
 * not the type checker's.
 */
export function evaluateDeclaredFn<Input, Output>(
  fn: DeclaredFn<Input, Output>,
  input: Input,
  ctx: DeclaredFnContext,
): Output {
  return evaluateNode(fn as unknown as AnyDeclaredFn, input, ctx) as Output;
}

function evaluateNode(fn: AnyDeclaredFn, input: unknown, ctx: DeclaredFnContext): unknown {
  switch (fn.kind) {
    case 'get':
    case 'set':
      return evaluateVariableNode(fn as never, input, ctx, evaluateNode);
    case 'bool':
    case 'and':
    case 'or':
    case 'not':
    case 'compare':
      return evaluateBooleanNode(fn as never, input, ctx, evaluateNode);
    case 'math':
      return evaluateMathNode(fn as never, input, ctx);
    case 'some':
    case 'every':
    case 'forEach':
      return evaluateIterationNode(fn as never, input, ctx, evaluateNode);
    case 'gauge':
    case 'buff':
    case 'character':
    case 'player':
      return evaluateActionNode(fn as never, input, ctx, evaluateNode);
    default:
      throw new Error(`evaluateDeclaredFn: unhandled node kind "${(fn as { kind: string }).kind}"`);
  }
}
