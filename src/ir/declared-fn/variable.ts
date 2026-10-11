/**
 * Variable nodes: read or write a nested property off one of three roots —
 * `'input'` (the value `evaluateDeclaredFn` was called with), `'self'` (the
 * ability's owner), or `'vars'` (the owning buff/skill's `Status.vars` — the
 * same mutable bag Explosion's `ticker` lives in, see
 * `src/examples/explosion.ts`).
 *
 * `vars` is the *only* writable root: `set` mutates it directly rather than
 * producing an Action, exactly like hand-written content already does
 * (`vars.ticker += 1`) — a status's own variables aren't game state the
 * Action pipeline governs (docs/engine/actions.ts's "Actions are the only
 * way game state changes" is about characters/gauges/buffs, not a status's
 * private scratch space). Because `set` sits in an `actions` list alongside
 * gauge/buff/character/player nodes, it evaluates to `[]` — a side effect
 * with no Action to show for it.
 */
import type { Action } from '../../engine/actions.js';
import type { DeclaredFn } from './index.js';
import type { DeclaredFnContext, Evaluate } from './types.js';

type Root = 'input' | 'self' | 'vars';

export type VariableNode<Input> =
  | { readonly kind: 'get'; readonly root: Root; readonly path: readonly (string | number)[] }
  | { readonly kind: 'set'; readonly path: readonly (string | number)[]; readonly value: DeclaredFn<Input, unknown> };

function rootValue(root: Root, input: unknown, ctx: DeclaredFnContext): unknown {
  switch (root) {
    case 'input': return input;
    case 'self': return ctx.self;
    case 'vars': return ctx.status.vars;
  }
}

/** Walks `path` off `value`, returning `undefined` as soon as it runs off the edge of the data. */
function get(value: unknown, path: readonly (string | number)[]): unknown {
  for (const part of path) {
    if (value == null) return undefined;
    value = Array.isArray(value) && part === 'length' ? value.length : (value as Record<string, unknown>)[String(part)];
  }
  return value;
}

/** Walks all but the last segment of `path`, then writes the last segment. A no-op on an empty path. */
function set(root: Record<string, unknown>, path: readonly (string | number)[], value: unknown): void {
  if (path.length === 0) return;
  let target: unknown = root;
  for (const part of path.slice(0, -1)) {
    if (target == null || typeof target !== 'object') return;
    target = (target as Record<string, unknown>)[String(part)];
  }
  if (target == null || typeof target !== 'object') return;
  (target as Record<string, unknown>)[String(path[path.length - 1])] = value;
}

export function evaluateVariableNode(fn: VariableNode<unknown>, input: unknown, ctx: DeclaredFnContext, evaluate: Evaluate): unknown {
  switch (fn.kind) {
    case 'get':
      return get(rootValue(fn.root, input, ctx), fn.path);
    case 'set': {
      const value = evaluate(fn.value, input, ctx);
      set(ctx.status.vars, fn.path, value);
      return [] as readonly Action[];
    }
  }
}
