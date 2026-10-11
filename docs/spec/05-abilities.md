# 05 — Abilities

> Slice 2. How characters *do things*: the ability kinds and the
> contexts they run in.

## 1. The kinds

| Kind | Builder | What it does |
| --- | --- | --- |
| **manual** | `cast(...)` | The player picks targets, then it fires. Run via `engine.useAbility(owner, ability, targeting)`. |
| **trigger · auto** | `auto(...)` | Listens to an event, computes its own targets (from a `targeting` pattern or a `targets` callback), fires. |
| **trigger · prompt** | `prompt(...)` | Listens to an event, *asks the player* (via the `GameHost`) for targets, fires. |
| **passive** | `passiveActionModifier(...)` | Never fires — transforms Actions flowing past its owner. One listener; the Action carries its direction. |
| **max** | `maxModifier({ multiply?, add?, gauge? })` | The gauge-tied max contribution — sugar for `stat({ gauge, multiply?, add? })`: while its status is attached, the wearer's gauge max is re-derived as `max = max * multiply + add` (weight-ordered with other contributions, clamped at 0; `gauge` defaults to `'hp'`, any gauge id). Produces no Actions — a gauge's maximum is never written. See [03-actions.md](03-actions.md) §5 and [01-gauge.md](01-gauge.md) §4. |
| **stat** | `stat({ gauge | stat, value?|multiply?|add? })` | The general derivation ability: **exactly one** of `gauge` (the id of a gauge whose **max** is derived — `'hp'`, `'mana'`, or any gauge the wearer carries; read from the gauge itself) or `stat` (a named stat — `speed`, or a custom name with a `CharacterDef.stats` base; read with `character.stat(name)`). The value is the base plus the attached contributions in weight order; a `value` function **replaces** the running value with its result ("this value is equal to …", read-only, must return a finite number); `multiply`/`add` rewrite it. Re-derived on status/form changes, at each settle (a function of the world, e.g. "creatures you control"), and via `engine.refreshDerivedStats()`. See [14-derived-stats.md](../design/14-derived-stats.md). |
| **tie** | `transformModifier({ form })` | The declarative buff-to-form tie: while its status is attached, the wearer's form *is* `form` — pushed keyed by the buff instance on attach, popped (reverting) on removal. A live tie **pins** the wearer's form above later pushes ("the hex holds"); see [04-character-status.md](04-character-status.md) §6. Produces no Actions. |

An ability is attached to a character through a **buff or a skill**
([04-character-status.md](04-character-status.md) §2) — the character's
`abilities` getter flattens them. (The one status-level hook is a buff's
`buff:destroyed` self-listening trigger — used when a buff must react to its own
end (a "when this buff dies" trigger).)

```ts
type Ability =
  | ManualAbility
  | TriggeredAbility
  | PassiveActionModifier
  | MaxModifierAbility
  | StatAbility
  | TransformModifierAbility
  | RestrictionAbility;
```

```ts
// manual: the player picks targets, then it fires
cast({ name: 'Strike', targeting: { who: 'enemy' }, cast: (ctx, t) => [...] })

// trigger: event, targets computed automatically
auto({ name: 'Second Wind', event: 'turn:start',
       when: (ctx) => ctx.self.hp.current < 40,   // the prestack filter
       cast: (ctx) => [heal(ctx.self, 12)] })

// trigger: event, then the player is asked for targets
prompt({ name: 'Rally', event: 'turn:start', prompt: () => ({ who: 'ally', count: 1 }),
         cast: (ctx, t) => [heal(t.targets[0]!, 6, ctx.self)] })

// passive action modifier: never fires, only transforms actions; the
// action itself carries its direction, so the modifier checks it
passiveActionModifier({ name: 'Iron Hide', transform: (action, ctx) => ... })
```

## 2. Shapes

```ts
interface ManualAbility {
  kind: 'manual';
  id: string;                       // explicit or slug of the name
  name: string;
  description?: string;
  targeting: TargetPattern;         // what the player may pick
  cast(ctx: AbilityContext, targeting: Targeting): CastResult;
}

interface TriggeredAbility<E extends GameEvent['type']> {
  kind: 'trigger';
  id: string; name: string; description?: string;
  event: E;                         // the event type it listens to
  when?(ctx: TriggerContext<E>): boolean;   // prestack filter — gates the prepare stack
  targeting?: TargetPattern;        // auto: engine computes targets from the pattern
  targets?(ctx: TriggerContext<E>): Character[] | Promise<Character[]>;
  prompt?(ctx: TriggerContext<E>): TargetPattern;  // ask the host for targets
  cast(ctx: TriggerContext<E>, targeting: Targeting | undefined): CastResult;
}

interface PassiveActionModifier {
  kind: 'passive';
  id: string; name: string; description?: string;
  transform: ActionTransformer;     // the one listener, both directions
}

interface MaxModifierAbility {
  kind: 'maxModifier';
  id: string; name: string; description?: string;
  gauge: 'hp' | 'mana';             // which built-in gauge it re-derives
  multiply: number;                 // max = max * multiply + add
  add: number;
}
```

- `auto(...)` with **both** `targeting` and `targets` throws at build time —
  provide one or the other. With neither, the trigger fires without targets
  (`targeting` stays undefined in `cast`).
- `cast(...)`: `targeting` is required; the engine enforces it in
  `useAbility` ([07-targeting-zones.md](07-targeting-zones.md) §5).

## 3. Contexts

```ts
interface AbilityContext { self: Character; engine: GameEngine }
type TriggerContext<E> = AbilityContext & { event: Extract<GameEvent, { type: E }> };
interface TargetingContext { self: Character; engine: GameEngine }  // for match conditions
interface Targeting { targets: Character[] }
type CastResult = Action[] | Promise<Action[]>;
```

- `ctx.self` is always the character that **owns the ability**.
- `ctx.event` is the narrowed event — typed to the subscribed `event`, so
  content reads `ctx.event.source`, `ctx.event.changes`, etc. without casts.
- The `engine` is embedded so content can query (`engine.validTargets`,
  `engine.isInPlay`, …) — but content must **not** mutate through it; it
  returns Actions.

## 4. Invocation paths

| Ability | How it runs |
| --- | --- |
| manual | `engine.useAbility(owner, ability, { targets })` — validates ownership + pattern, runs `cast`, emits `ability:used`, applies the actions with `source = owner`. |
| auto | On its event: prestack filter `when` passes → joined the prepare stack → seeded-shuffled → queued → drained at the unit boundary. Targets from `targeting` (resolved via `validTargets`) or `targets()`. `cast` result applied with `source =` the owning status if it is a buff, else the owner. |
| prompt | Same trigger path, but the engine asks the `GameHost` for targets (`requestTargets` with the options the pattern allows) and **rejects** an answer outside the pattern. |
| passive | Every Action flowing past the owner (outgoing or incoming) is handed to `transform` with its `direction` stamped ([03-actions.md](03-actions.md) §4–5). |

Trigger execution details — the queue, the shuffle, the unit boundary — are
in [06-events-triggers.md](06-events-triggers.md) §4; the host contract is
in [14-game-loop.md](14-game-loop.md) §4.

## 5. Derived ids

Every builder computes `id = id ?? slugify(name)` with a fallback; explicit
ids win. Slugs: lowercase, non-alphanumerics → `-`, trimmed.

## 6. Acceptance criteria (Slice 2)

1. `cast`, `auto`, `prompt`, and `passiveActionModifier` produce abilities
   with the right `kind`, a stable id, and the declared fields.
2. `auto` with both `targeting` and `targets` throws; with neither, `cast`
   receives `targeting === undefined`.
3. A manual ability used through `useAbility` runs `cast` with the given
   targets, emits `ability:used`, and applies the resulting actions through
   the pipeline with the owner as source.
4. An `auto` ability on `turn:start` with a failing `when` never fires; with
   a passing `when` it fires after the unit settles, in seeded-shuffled
   order relative to other triggers.
5. A `prompt` ability receives host-chosen targets; a host answer outside
   the pattern throws.
6. A `passiveActionModifier` transforms both directions of flowing Actions;
   an incoming-only check leaves outgoing Actions untouched.
7. Ability ids are stable slugs; explicit ids are respected.
