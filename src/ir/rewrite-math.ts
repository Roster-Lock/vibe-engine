/**
 * A stack of `ActionRewriteIR` entries — the rewrites several passive
 * modifiers contribute to the *same* matched action — read back as one
 * number (`applyRewriteChain`) or one piece of math (`rewriteChainToLatex`,
 * `rewriteChainSteps`), instead of N separate English sentences.
 *
 * `applyRewriteChain` mirrors `bindModifier`'s arithmetic exactly
 * (`src/ir/bind/ability.ts`): a chain composes as **pure arithmetic on a
 * signed magnitude that may go negative mid-chain** — "reduced by 10" then
 * "increased by 5" on 8 damage is `8 - 10 + 5 = 3`, not 0. Nothing here
 * floors it; the one floor in the real pipeline happens once, where the
 * fully-composed change actually reaches the gauge (`#applyGaugeBatch`),
 * which is exactly what the outer `Math.max(0, …)` in
 * `rewriteChainToLatex`'s rendering represents. `prevent` is the one
 * non-arithmetic step: it discards everything before it, forcing the
 * magnitude to exactly zero regardless of sign.
 *
 * Because nothing floors mid-chain, every op commutes the ordinary way
 * `+`/`-` do, and only `*`/`cap`/`prevent` fail to distribute over them —
 * `foldRewriteChain` merges on exactly that basis.
 */
import type { ActionRewriteIR, ValueIR } from './ability.js';
import { mathToLatex, type MathExpression } from './math-expression.js';

/* ------------------------------ reference ------------------------------ */

/** The one magnitude rewrite per op — the same four cases `bindModifier` runs. */
function rescaleOf(op: 'add' | 'subtract' | 'multiply' | 'cap', operand: number): (magnitude: number) => number {
  switch (op) {
    case 'add':
      return (magnitude) => magnitude + operand;
    case 'subtract':
      return (magnitude) => magnitude - operand;
    case 'multiply':
      return (magnitude) => magnitude * operand;
    case 'cap':
      return (magnitude) => Math.min(magnitude, operand);
  }
}

/**
 * One rewrite applied to a signed magnitude — the ground-truth arithmetic,
 * matching `bindModifier` step for step. `resolveValue` reads a `ValueIR`
 * operand down to a number (a `const` always can; a `gauge`/`count`/`expr`
 * needs a live context, which is the caller's problem, not this module's).
 */
export function applyOneRewrite(
  magnitude: number,
  rewrite: ActionRewriteIR,
  resolveValue: (value: ValueIR) => number,
): number {
  if (rewrite.kind === 'prevent') return 0;
  // A redirect moves the realized change to a different gauge — the
  // magnitude itself (how big the change is) is untouched; only where it
  // lands changes, which this single-number model has no way to show.
  if (rewrite.kind === 'redirect') return magnitude;
  const operand = resolveValue(rewrite.kind === 'cap' ? rewrite.at : rewrite.by);
  return rescaleOf(rewrite.kind === 'cap' ? 'cap' : rewrite.op, operand)(magnitude);
}

/** The chain's net effect on one magnitude — several modifiers, applied in order. */
export function applyRewriteChain(
  chain: readonly ActionRewriteIR[],
  magnitude: number,
  resolveValue: (value: ValueIR) => number,
): number {
  return chain.reduce((current, rewrite) => applyOneRewrite(current, rewrite, resolveValue), magnitude);
}

/** The realized change once a chain's result reaches the gauge — the one floor, applied once. */
export function settle(magnitude: number): number {
  return Math.max(0, magnitude);
}

/** Reads a `ValueIR` the way `applyRewriteChain`'s default resolver does: `const` only. */
export function constValue(value: ValueIR): number {
  if (value.kind !== 'const') {
    throw new Error(`rewrite-math needs a live resolver for a "${value.kind}" value`);
  }
  return value.value;
}

/* -------------------------------- folding ------------------------------- */

/** `a op b` as one `ValueIR` — a flat number when both sides are, an `expr` otherwise. */
function combineValues(a: ValueIR, b: ValueIR, op: '+' | '*'): ValueIR {
  if (a.kind === 'const' && b.kind === 'const') {
    return { kind: 'const', value: op === '+' ? a.value + b.value : a.value * b.value };
  }
  return { kind: 'expr', expression: { kind: 'binary', op, left: valueToMath(a), right: valueToMath(b) } };
}

/** `-value`, folding immediately when it's a flat constant. */
function negateValue(value: ValueIR): ValueIR {
  return value.kind === 'const'
    ? { kind: 'const', value: -value.value }
    : { kind: 'expr', expression: { kind: 'unary', op: '-', expression: valueToMath(value) } };
}

/** An `add`/`subtract` entry's contribution, signed so the two can be summed directly. */
function signedAmount(step: Extract<ActionRewriteIR, { kind: 'amount' }>): ValueIR {
  return step.op === 'add' ? step.by : negateValue(step.by);
}

/**
 * Merges what's safe to merge: a run of consecutive `add`/`subtract`
 * entries into one net `add`, and a run of consecutive `multiply` entries
 * into one. Nothing floors mid-chain any more (see the module doc), so
 * `+`/`-` commute freely with each other now, not just with themselves.
 *
 * Still **not** merged across `multiply`, `cap`, or `prevent` — those
 * don't distribute over `+`/`-` (`(x + 5) * 3 !== x * 3 + 5`), regardless
 * of flooring. `redirect` breaks a run too, for an unrelated reason: it
 * doesn't touch the magnitude at all, only where it lands.
 */
export function foldRewriteChain(chain: readonly ActionRewriteIR[]): readonly ActionRewriteIR[] {
  const folded: ActionRewriteIR[] = [];
  const additive = (step: ActionRewriteIR): boolean =>
    step.kind === 'amount' && (step.op === 'add' || step.op === 'subtract');
  for (const step of chain) {
    const last = folded.at(-1);
    if (last && additive(last) && additive(step)) {
      folded[folded.length - 1] = {
        kind: 'amount',
        op: 'add',
        by: combineValues(
          signedAmount(last as Extract<ActionRewriteIR, { kind: 'amount' }>),
          signedAmount(step as Extract<ActionRewriteIR, { kind: 'amount' }>),
          '+',
        ),
      };
      continue;
    }
    if (last?.kind === 'amount' && step.kind === 'amount' && last.op === 'multiply' && step.op === 'multiply') {
      folded[folded.length - 1] = { kind: 'amount', op: 'multiply', by: combineValues(last.by, step.by, '*') };
      continue;
    }
    folded.push(step);
  }
  return folded;
}

/* -------------------------------- display ------------------------------- */

/** A `ValueIR` as math: a flat number, its own formula, or a labeled placeholder. */
function valueToMath(value: ValueIR): MathExpression {
  switch (value.kind) {
    case 'const':
      return { kind: 'number', value: value.value };
    case 'expr':
      return value.expression;
    case 'gauge':
      return { kind: 'path', parts: [value.gauge] };
    case 'attribute':
      // A game's own fact reads as a named path, like a gauge — the display
      // layer needs no idea what `cost` means.
      return { kind: 'path', parts: [value.attribute] };
    case 'count':
      return { kind: 'path', parts: ['count'] };
  }
}

/**
 * A multiply step's factor, preferring a small fraction over a decimal —
 * "merge ×3 and ×0.5 into one ×1.5" reads worse than "×3/2". Only kicks in
 * for a flat constant; a symbolic factor renders as-is.
 */
function multiplierToMath(value: ValueIR): MathExpression {
  if (value.kind !== 'const' || Number.isInteger(value.value)) return valueToMath(value);
  for (let denominator = 2; denominator <= 20; denominator += 1) {
    const numerator = value.value * denominator;
    if (Math.abs(numerator - Math.round(numerator)) < 1e-9) {
      return {
        kind: 'binary',
        op: '/',
        left: { kind: 'number', value: Math.round(numerator) },
        right: { kind: 'number', value: denominator },
      };
    }
  }
  return valueToMath(value);
}

/** An already-rendered LaTeX fragment, re-entering the tree as one atomic leaf. */
function verbatim(latex: string): MathExpression {
  return { kind: 'path', parts: [latex] };
}

/**
 * The chain's net effect as **one** LaTeX formula — folded first, then
 * nested left to right as ordinary arithmetic (`+`, `-`, `*`, reusing
 * `mathToLatex`, so a merged multiply run renders as a fraction rather
 * than a decimal). `cap` renders as `\min`; `prevent` collapses
 * everything before it to `0`, since that is its real effect regardless
 * of what came before.
 *
 * The whole result is wrapped in one outer `\max(0, \cdot)` by default —
 * the floor the real pipeline applies exactly once, where the change
 * finally reaches the gauge (`settle`). Pass `settled: false` to see the
 * chain's pure arithmetic instead, with no floor at all.
 */
export function rewriteChainToLatex(
  chain: readonly ActionRewriteIR[],
  options: { readonly variable?: string; readonly settled?: boolean } = {},
): string {
  const variable = options.variable ?? 'x';
  let expr: MathExpression = { kind: 'path', parts: [variable] };
  let prevented = false;
  for (const step of foldRewriteChain(chain)) {
    if (step.kind === 'prevent') {
      prevented = true;
      continue;
    }
    if (step.kind === 'cap') {
      expr = verbatim(`\\min\\left(${mathToLatex(expr)}, ${mathToLatex(valueToMath(step.at))}\\right)`);
      continue;
    }
    // A redirect doesn't change the magnitude — only which gauge the
    // realized change lands on, which a formula over one number can't
    // show (see `rewriteChainSteps` for that half of the story).
    if (step.kind === 'redirect') continue;
    // A folded run of add/subtract may net to a negative constant (see
    // `foldRewriteChain`) — render that as `- n`, not the technically-
    // correct but ugly `+ -n`.
    if (step.op === 'add' && step.by.kind === 'const' && step.by.value < 0) {
      expr = { kind: 'binary', op: '-', left: expr, right: { kind: 'number', value: -step.by.value } };
      continue;
    }
    expr = {
      kind: 'binary',
      op: step.op === 'add' ? '+' : step.op === 'subtract' ? '-' : '*',
      left: expr,
      right: step.op === 'multiply' ? multiplierToMath(step.by) : valueToMath(step.by),
    };
  }
  if (prevented) return '0';
  const rendered = mathToLatex(expr);
  return options.settled === false ? rendered : `\\max\\left(0, ${rendered}\\right)`;
}

/**
 * The chain as a list, one entry per **original** (unfolded) rewrite, in
 * application order — the trace back to what each modifier actually wrote,
 * as opposed to `rewriteChainToLatex`'s merged net result.
 */
export function rewriteChainSteps(
  chain: readonly ActionRewriteIR[],
  resolveValue: (value: ValueIR) => number = constValue,
): string[] {
  return chain.map((step) => {
    if (step.kind === 'prevent') return 'prevented';
    if (step.kind === 'cap') return `capped at ${resolveValue(step.at)}`;
    if (step.kind === 'redirect') return `redirected to ${step.gauge}`;
    const amount = resolveValue(step.by);
    switch (step.op) {
      case 'add':
        return `+${amount}`;
      case 'subtract':
        return `−${amount}`;
      case 'multiply':
        return amount === 2 ? 'doubled' : amount === 0.5 ? 'halved' : `×${amount}`;
    }
  });
}
