/**
 * Iteration nodes: `some`/`every` test a predicate across an array (the
 * count-phrase building block — "one of the triggered characters has power
 * > 7"), and `forEach` flattens one Action[] per element (the "do this to
 * each of them" building block an `actions` entry needs for a batch).
 */
import type { Action } from '../../engine/actions.js';
import type { DeclaredFn } from './index.js';
import type { DeclaredFnContext, Evaluate } from './types.js';

export type IterationNode<Input> =
  | {
      readonly kind: 'some' | 'every';
      readonly array: DeclaredFn<Input, readonly unknown[]>;
      readonly test: DeclaredFn<unknown, boolean>;
    }
  | {
      readonly kind: 'forEach';
      readonly array: DeclaredFn<Input, readonly unknown[]>;
      readonly body: DeclaredFn<unknown, readonly Action[]>;
    };

export function evaluateIterationNode(fn: IterationNode<unknown>, input: unknown, ctx: DeclaredFnContext, evaluate: Evaluate): unknown {
  switch (fn.kind) {
    case 'some': {
      const array = evaluate(fn.array, input, ctx) as unknown[];
      return array.some((element) => evaluate(fn.test, element, ctx));
    }
    case 'every': {
      const array = evaluate(fn.array, input, ctx) as unknown[];
      return array.every((element) => evaluate(fn.test, element, ctx));
    }
    case 'forEach': {
      const array = evaluate(fn.array, input, ctx) as unknown[];
      return array.flatMap((element) => evaluate(fn.body, element, ctx) as Action[]);
    }
  }
}
