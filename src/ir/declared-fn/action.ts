/**
 * Action nodes — the noun-based vocabulary for producing engine Actions
 * (src/engine/actions.ts): `gauge`, `buff`, `character`, `player`. No
 * `damage`/`heal`/`destroy` verbs here — `damage` is just `{ kind: 'gauge',
 * op: 'subtract' }` with `intent: 'damage'` (the default for `subtract`),
 * matching how actions.ts itself treats `damage`/`heal` as sugar over the one
 * real `GaugeAction`. Each node evaluates to `Action[]` so it composes
 * directly inside a `forEach` (iteration.ts) or an `actions` list.
 *
 * `character` and `player` only cover `destroy` and `win`/`lose` for now —
 * `transform`/`popTransform` aren't wired up yet (nothing in
 * docs/free-write/triggered.md's examples needed them).
 */
import { addBuff, changeGaugeBy, destroy, removeBuff, setGauge, type Action, type GaugeIntent } from '../../engine/actions.js';
import { lose, win } from '../../games/round-based/index.js';
import type { Character } from '../../engine/character.js';
import type { BuffDef } from '../../engine/status/index.js';
import type { DeclaredFn } from './index.js';
import type { DeclaredFnContext, Evaluate } from './types.js';

export type ActionNode<Input> =
  | {
      readonly kind: 'gauge';
      readonly target: DeclaredFn<Input, Character>;
      /**
       * Which of the target's gauges. Omitted means the target's declared
       * life gauge (`Character.lifeGauge`) — the same thing an unnamed
       * gauge means everywhere else, rather than a hard-coded `'hp'`.
       */
      readonly gauge?: string;
      readonly op: 'add' | 'subtract' | 'set';
      readonly amount: DeclaredFn<Input, number>;
      /** Overrides the op's default intent (`subtract` → `'damage'`, `add` → `'heal'`, `set` → `'set'`). */
      readonly intent?: GaugeIntent;
    }
  | { readonly kind: 'buff'; readonly op: 'add'; readonly target: DeclaredFn<Input, Character>; readonly buffDef: BuffDef }
  | { readonly kind: 'buff'; readonly op: 'remove'; readonly target: DeclaredFn<Input, Character>; readonly buffId: string }
  | { readonly kind: 'character'; readonly op: 'destroy'; readonly target: DeclaredFn<Input, Character> }
  | { readonly kind: 'player'; readonly op: 'win' | 'lose'; readonly team: string };

function defaultIntent(op: 'add' | 'subtract' | 'set'): GaugeIntent {
  return op === 'subtract' ? 'damage' : op === 'add' ? 'heal' : 'set';
}

function findGauge(target: Character, id: string) {
  const gauge = target.gauges.find((g) => g.id === id);
  if (!gauge) throw new Error(`gauge node: "${target.name}" has no gauge "${id}"`);
  return gauge;
}

export function evaluateActionNode(fn: ActionNode<unknown>, input: unknown, ctx: DeclaredFnContext, evaluate: Evaluate): readonly Action[] {
  switch (fn.kind) {
    case 'gauge': {
      const target = evaluate(fn.target, input, ctx) as Character;
      // An omitted gauge means the target's own life gauge. Loud when it
      // has none, like `findGauge` below — this layer is hand-written
      // content, where a wrong guess should surface at the point of use.
      const gaugeId = fn.gauge ?? target.lifeGauge;
      if (gaugeId === undefined) {
        throw new Error(`gauge node: "${target.name}" declares no life gauge — name one explicitly`);
      }
      const gauge = findGauge(target, gaugeId);
      const amount = evaluate(fn.amount, input, ctx) as number;
      const intent = fn.intent ?? defaultIntent(fn.op);
      const action =
        fn.op === 'set'
          ? setGauge(gauge, amount, ctx.self)
          : changeGaugeBy(gauge, fn.op === 'add' ? amount : -amount, ctx.self);
      return [{ ...action, intent }];
    }
    case 'buff': {
      const target = evaluate(fn.target, input, ctx) as Character;
      return fn.op === 'add' ? [addBuff(target, fn.buffDef, ctx.self)] : [removeBuff(target, fn.buffId, ctx.self)];
    }
    case 'character': {
      const target = evaluate(fn.target, input, ctx) as Character;
      return [destroy(target, ctx.self)];
    }
    case 'player':
      return [fn.op === 'win' ? win(fn.team, ctx.self) : lose(fn.team, ctx.self)];
  }
}
