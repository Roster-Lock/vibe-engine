/**
 * Boolean nodes: literals, the `and`/`or`/`not` combinators, and a numeric
 * comparison. `compare`'s operands are typically a `get` (variable.ts) or a
 * `math` (math.ts) node, but any `DeclaredFn<Input, number>` works.
 */
import type { DeclaredFn } from './index.js';
import type { DeclaredFnContext, Evaluate } from './types.js';

export type BooleanNode<Input> =
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'and' | 'or'; readonly clauses: readonly DeclaredFn<Input, boolean>[] }
  | { readonly kind: 'not'; readonly expression: DeclaredFn<Input, boolean> }
  | {
      readonly kind: 'compare';
      readonly op: '<' | '<=' | '>' | '>=' | '=' | '!=';
      readonly left: DeclaredFn<Input, number>;
      readonly right: DeclaredFn<Input, number>;
    };

export function evaluateBooleanNode(fn: BooleanNode<unknown>, input: unknown, ctx: DeclaredFnContext, evaluate: Evaluate): unknown {
  switch (fn.kind) {
    case 'bool':
      return fn.value;
    case 'and':
      return fn.clauses.every((clause) => evaluate(clause, input, ctx));
    case 'or':
      return fn.clauses.some((clause) => evaluate(clause, input, ctx));
    case 'not':
      return !evaluate(fn.expression, input, ctx);
    case 'compare': {
      const left = evaluate(fn.left, input, ctx) as number;
      const right = evaluate(fn.right, input, ctx) as number;
      switch (fn.op) {
        case '<': return left < right;
        case '<=': return left <= right;
        case '>': return left > right;
        case '>=': return left >= right;
        case '=': return left === right;
        case '!=': return left !== right;
      }
    }
  }
}
