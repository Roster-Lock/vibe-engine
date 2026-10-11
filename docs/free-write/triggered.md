Each english trigger defintiion should probably be converted into something usable


# Batch Event

So theres two main event types, batch which considers multiple triggers at once and another where each instance triggers one time per event

```typescript
type DeclaredFn<Input, Output>

type BatchEvent<Trigger> = {
  // The actual event that is being listened to
  event: string,

  // While a whole board may be dealt damage by something like Pyroclasm
  // Only characters owned by opponents might be considered valid triggers
  // Thus if your opponent has not characters, this value will return an empty array
  // If theres an empty array then this doesn't continue
  triggerFilter: DeclaredFn<Trigger, boolean>

  // Some triggers will only activate when the trigger count are less than 5
  // Some triggers will only activate when the trigger count is even
  // Some triggers will activate when the trigger count is one or more
  // Some triggers will only activate when the count is 2 and one of the triggered character has power > 7
  willTrigger: DeclaredFn<Array<Trigger>, boolean>

  // What will actually happen
  actions: Array<DeclaredFn<Array<Trigger>, any>>
}
```


So a triggered event can look like
```
when one or more characters controlled by you survive damage then
when 5 or less characters owned by you survive damage then
when 2 to 4 characters controlled by opponents survive damage then
when an even amount of characters controlled by you survive damage then
```

A declared function is meant to be a json object that can be read and executed like a function


# Translated abilities

I think we should consider what an ability looks like after it's been translated.

`src/engine` — maybe we should add a folder for "execution".

## Fleshing it out

Three layers, cleanly separated:

- `src/english/` — text → AST. Stays exactly what it is (`ast.ts`, `parser.ts`,
  `math.ts`). Doesn't get bigger for this.
- `src/ir/` (new) — AST/declared object → a real runtime
  `Ability`. This is the new folder. It's where `DeclaredFn` and `BatchEvent`
  live, and where they get compiled into something `trigger-stack.ts` already
  knows how to run.
- `src/engine/ability/` + `trigger-stack.ts` — runtime `Ability` → actual game
  behavior. Untouched. This is the part that matters: a translated ability
  should become an ordinary `TriggeredAbility`, indistinguishable from one a
  human wrote with `auto(...)`. No special-casing in the trigger stack for
  "compiled" vs "hand-written" content.

### `DeclaredFn`

Generalizes `MathExpression` (`src/ir/math-expression.ts`) — same idea (a JSON tree
+ an evaluator, so the editor can hover/render/introspect it instead of
staring at an opaque closure) — but widened to also produce booleans and
Actions, not just numbers:

```typescript
type DeclaredFn<Input, Output> = {
  // reuses MathExpression's node kinds (number, path, binary, sum, sumArray)
  // for the numeric case, plus:
  // - comparison nodes (<, <=, >, >=, =)      — the `with hp < 10` vocabulary
  // - boolean nodes (and, or, not)            — the existing WithCondition tree
  // - array nodes (count, some, every)        — the count-phrase vocabulary
  // - call nodes: { fn: 'damage' | 'heal' | 'destroy' | 'addBuff' | ..., args }
  //   — the fixed action-sugar vocabulary from actions.ts, args are
  //   themselves DeclaredFns evaluated against Input first
}

function evaluateDeclaredFn<Input, Output>(
  fn: DeclaredFn<Input, Output>,
  input: Input,
  ctx: { self: Character; engine: GameEngine },
): Output
```

`path` nodes are how a `DeclaredFn<Trigger, boolean>` reads e.g.
`event.character.power` — same path-resolution machinery `math.ts` already
has, just pointed at richer inputs than a math context.

### `BatchEvent<Trigger>` → `TriggeredAbility`

The compile step is a thin adapter — it doesn't reimplement the trigger
stack, just feeds it:

```typescript
function compileBatchEvent<E extends GameEvent['type']>(
  def: BatchEvent<Extract<GameEvent, { type: E }>>,
): TriggeredAbility<E> {
  const triggersOf = (ctx: TriggerContext<E>) =>
    (ctx.event as any).events.filter((e: unknown) =>
      evaluateDeclaredFn(def.triggerFilter, e, ctx));

  return auto({
    name: '(translated)',
    event: def.event as E,
    // the prestack filter: empty filtered array never continues (per the
    // triggerFilter doc comment), then willTrigger gates on count/shape
    when: (ctx) => {
      const triggers = triggersOf(ctx);
      return triggers.length > 0 && evaluateDeclaredFn(def.willTrigger, triggers, ctx);
    },
    cast: (ctx) => def.actions.flatMap((fn) => evaluateDeclaredFn(fn, triggersOf(ctx), ctx)),
  });
}
```

`when` and `cast` each recompute `triggersOf` — that's fine, it matches how
`trigger-stack.ts` already rebuilds a fresh `ctx` for the prestack filter and
again for the run (`enqueue` vs `#runTrigger`), so this isn't new duplication.

The event name itself is just the existing `:batch` vocabulary
(`character:destroyed:batch`, `character:survived:batch`, `gauge:changed:batch`,
`buff:destroyed:batch`) — `willTrigger`'s count check is the runtime form of
the count-phrase table already in docs/creator/01-ability-language.md
(`one or more`, `n or more`, `n to m`, `n or less`, even/odd as a `%` node).

### The singular case

`when a character dies` (no count phrase) isn't a batch trigger — it's
per-instance, one fire per matching event, no `willTrigger`/count at all:

```typescript
type Trigger<T> = {
  event: string,               // the non-`:batch` event
  triggerFilter: DeclaredFn<T, boolean>,
  actions: Array<DeclaredFn<T, any>>,
}
```

Compiles the same way, just without the `willTrigger` gate — `when` is
`(ctx) => evaluateDeclaredFn(def.triggerFilter, ctx.event, ctx)`, `cast` maps
`def.actions` over `ctx.event` directly (not an array).

### Net effect on `src/english/compile.ts`

Once this exists, teaching the compiler to actually build triggers (instead
of the "events are the next milestone" diagnostic) is: parse the `when
... then ...` sentence into a `BatchEvent`/`Trigger` declared object (reusing
the same condition-tree parsing `with` clauses already do), then call
`compileBatchEvent`/`compileTrigger` from `src/ir/bind` to get a real
`TriggeredAbility` to hand back alongside the manual abilities. No changes
needed in `trigger-stack.ts`, `engine.ts`, or `ability/triggered.ts`.