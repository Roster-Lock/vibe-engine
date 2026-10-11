/**
 * The numeric node: wraps a `MathExpression` (src/ir/math-expression.ts)
 * rather than reinventing arithmetic — so a translated formula gets Σ,
 * dynamic array indexing, and **LaTeX rendering** (`mathNodeToLatex`) for
 * free, the same machinery `src/english`'s ability-language formulas already
 * use. `evaluate*Node` here doesn't call back into the shared `evaluate` —
 * a `MathExpression` is numbers all the way down, so it's self-contained.
 *
 * The formula resolves paths against `{ input, self, vars }` — e.g.
 * `input.power`, `self.gauge('hp').current`, `vars.stacks * 2`.
 */
import { evaluateMathExpression, mathToLatex, type MathContext, type MathExpression } from '../math-expression.js';
import type { DeclaredFnContext } from './types.js';

export interface MathNode {
  readonly kind: 'math';
  readonly expression: MathExpression;
}

function mathContext(input: unknown, ctx: DeclaredFnContext): MathContext {
  return { input, self: ctx.self, vars: ctx.status.vars };
}

export function evaluateMathNode(fn: MathNode, input: unknown, ctx: DeclaredFnContext): number {
  return evaluateMathExpression(fn.expression, mathContext(input, ctx));
}

/** Renders a math node's formula as LaTeX — for an editor to display the equation it compiled. */
export function mathNodeToLatex(fn: MathNode): string {
  return mathToLatex(fn.expression);
}
