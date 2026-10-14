# 17 — The Extension System: a Game Declares Its Own Events, Actions and Entities

> **Status:** ✅ built (slices 0–4f). The engine names no game concept, and
> every game vocabulary is a seam it consults rather than a branch it
> hardcodes. Supersedes nothing; extends [15-zones.md](15-zones.md), whose
> `ZoneRegistry` is the pattern this doc generalizes.

## The problem

The engine is meant to be a game-agnostic core for **activated, triggered and
passive abilities**. Today it is not: it is the engine *of one game* that
happens to be reusable.

Three things are true at once:

1. **The vocabulary is closed.** `GameEvent` ([`src/engine/events.ts`](../../src/engine/events.ts))
   and `Action` ([`src/engine/actions.ts`](../../src/engine/actions.ts)) are
   TypeScript unions with a fixed membership. A game cannot add an event or an
   action without editing the engine. The event file says so outright: *"To add
   a brand-new event type, extend the `GameEvent` union below."*
2. **The dispatch is closed.** `GameEngine.#execute` is a
   `switch (action.type)` with no default — the engine must be edited to
   execute anything new.
3. **One game's concepts are baked into the core.** `Character` requires
   `maxHp` and always builds an `hp` and a `mana` gauge
   ([`character.ts:60`](../../src/engine/character.ts#L60),
   [`:159-160`](../../src/engine/character.ts#L159-L160)). `isHpChange`,
   `isManaChange`, `isDamage`, `isHeal`, `wasDealtBy`, `wasTakenBy` are
   HP-keyed and **exported from the package root**
   ([`index.ts`](../../src/engine/index.ts)). `DEFAULT_SPEED`, `sortBySpeed`,
   `startTurn`/`endTurn`, `win`/`lose` and `TeamRegistry` are the core's
   business.

The measured cost is already visible in the repo: `examples/rts` is a second
game that **forked the entire language layer** — its own lexer, parser,
vocabulary, AST, IR, compiler and runtime — rather than reuse `src/english`
and `src/ir`, and imports nothing from `src/engine` at all.

### The design that already works

The engine contains its own answer. `ZoneRegistry` is data-driven and injected
(`engine.zones.declare(def)`), `addStateBasedRule` takes a content rule, and
`EngineOptions` already injects a `Chooser` and a `TriggerScheduler`. The
`Entity` interface is explicit about the same idea:

> *"Deliberately tiny. … Everything else — gauges, statuses, a controller —
> belongs to particular kinds of entity, not to entities as such. … gauges are a
> component of hero-ish cards, not a property every card has, so a spell must be
> able to sit in a zone without pretending to have hit points."*
> — [`zone.ts:26-45`](../../src/engine/zone.ts#L26-L45)

The correction this doc makes is to apply that principle to the **event and
action vocabularies**, which are the only two closed sets left.

## The decision

Three seams, each mirroring a pattern already in the engine.

### Seam 1 — Open the vocabularies with declaration merging (BUILT)

`GameEvent` and `Action` are no longer unions written by hand. They are
**derived from open maps**:

```ts
export interface GameEventMap {
  'gauge:changed': GaugeChangedEvent;
  'buff:added': BuffAddedEvent;
  // … every built-in event
}
export type GameEvent = GameEventMap[keyof GameEventMap];

export interface ActionMap {
  gauge: GaugeAction;
  move: MoveAction;
  // … every built-in action
}
export type Action = ActionMap[keyof ActionMap];
```

Because the maps are plain interfaces, a game **opens them by merging** — the
same mechanism TypeScript uses for `Window`, and the reason the built-ins are
ordinary entries rather than a privileged category:

```ts
declare module 'vibe-engine/contracts' {
  interface GameEventMap {
    'turn:start': { type: 'turn:start' };
  }
  interface ActionMap {
    summon: { type: 'summon'; unit: UnitDef; source?: EventSource; direction?: ActionDirection };
  }
}
```

After which `engine.emit({ type: 'turn:start' })` type-checks, a triggered
ability may subscribe to `'turn:start'`, and `ctx.event` narrows on it exactly
like a built-in.

**Verified, not assumed.** A spike that augmented both maps through the
relative specifier and narrowed on the new tags compiled clean, and the engine
still narrowed all nine built-in actions. The full suite (750 tests) passes
with the maps in place — this slice is **non-breaking**.

### Seam 2 — Make the shared action shape explicit

The spike found a real constraint the engine had left implicit. Every built-in
action already carries the same three pipeline fields — `source`, `direction`,
`bypasses` — and the engine reads them **generically**:

- the transformer pass stamps `direction` onto every action it pushes
  ([`actions.ts:437`](../../src/engine/actions.ts#L437));
- `apply` reads `action.bypasses` off the bare union
  ([`engine.ts:891`](../../src/engine/engine.ts#L891)).

A custom action that omits them **does not compile** — verified, not assumed:
declaring `{ type: 'summon'; amount: number }` breaks the engine's own
`replaceAction` with *"Property 'direction' does not exist on type 'Action'"*.
So this is a stated contract, not a style preference:

```ts
/** The fields every action carries, whatever the game. */
export interface ActionBase {
  readonly type: string;
  readonly source?: EventSource;
  readonly direction?: ActionDirection;
  readonly bypasses?: readonly string[];
}
```

Two subtleties, both found by testing rather than reading:

1. **Structural conformance cannot be checked.** Every `ActionBase` field is
   optional, so `{ type: 'summon'; amount: number }` *structurally extends*
   `ActionBase` while having no `direction` key at all. The guard therefore
   checks the declared **keys** (`Exclude<keyof ActionBase, keyof V>`), not
   assignability.
2. **The failure value must be `false`, never `never`.** The first cut of the
   guard resolved a bad entry to `never`; `never` is assignable to everything,
   so the constraint was satisfied vacuously and the guard enforced nothing
   while looking entirely correct. With `false` it fires properly. This is
   recorded because the broken version is the one that reads as if it works.

### Seam 3 — A registry to execute what the map declares (BUILT)

Types alone cannot run a game's action. `#execute`'s closed switch is now a
lookup in an `ActionRegistry` the game populates — the `ZoneRegistry` pattern
applied to execution:

```ts
engine.actions.register('summon', (action, ctx) => {
  // `action` is narrowed to the game's own type — no cast, no switch
  ctx.engine.registerCharacter(new Character(action.unitName, { maxHp: action.maxHp }));
});
```

The engine's own eight non-gauge actions are registered in its constructor
through the same call, so nothing in the dispatch path distinguishes `move`
from a game's `summon`.

**Why this beats a `switch`.** A `switch` over an open union with no `default`,
in a `void` method, silently does *nothing* for a tag it has never heard of —
the action is accepted, piped through transformers and gates, and then dropped.
The registry instead throws, naming both the tag and the fix:

> `No handler registered for action "summon". Declare it in ActionMap
> (contracts.ts), then register one with engine.actions.register("summon", …).`

`gauge` is deliberately **not** in the registry. Its batching is an engine
invariant (writes accumulate and settle so the game-over check runs once per
batch, before any event), not a handler a game may replace, so `#execute`
guards it directly. It still declares a **subject** (below), because the
pipeline needs one.

#### The action's subject

Executing an action is only half of participating in the engine. The other half
is the pipeline every action flows through before execution: the restriction
gates and the incoming/outgoing transformer passes, all of which need to know
**which character the action acts on**.

That used to be a second closed `switch` (`actionTarget`), which meant a game's
action silently had no subject — so no passive could modify it and no
restriction could block it, with nothing to indicate why. Subject resolution is
therefore part of registration:

```ts
engine.actions.register('burn', handler, { subject: (a) => a.victim });
// or, for an action the engine executes by another path:
engine.actions.subject('gauge', (a) => this.characterOf(a.target));
```

Omitting `subject` is a deliberate, meaningful choice — passives cannot modify
a board-wide action and restrictions cannot block it — and
[`test/extension.test.ts`](../../test/extension.test.ts) pins both directions:
the same action with a `subject` **is** rewritten by a passive on its target,
and without one it is **not**.

`gauge` is the one action that needs a subject but has no handler, so the
registry exposes `subject(...)` separately for exactly that case. Without it,
removing the `actionTarget` switch would have silently stopped "cannot be
damaged" from blocking — which is why the restriction and passive suites are
the regression net for that change.

#### What the seam does not yet cover

`#gateKind` is a **third** closed switch, and `RestrictionKind` is a closed
union. A game action can be *transformed* by passives (the transformer receives
the whole `Action` and may rewrite it) but cannot be **blocked** by a
restriction, because there is no restriction kind to name it by. Making
`RestrictionKind` augmentable is the natural follow-up and is not required by
anything above; it is left open rather than guessed at.

## The consequence the spike exposed (and it is a good one)

Augmenting `ActionMap` or `GameEventMap` widens the union **program-wide**.
The spike immediately broke [`src/ui/components/log.tsx:10`](../../src/ui/components/log.tsx#L10):
`describeEvent` switches over every event with no `default`, and relies on
exhaustiveness for its return type.

This is a feature — a game that adds an event is *told* where it must render
or handle it — but it constrains how the engine and shared tooling are written:

- **Engine internals must not be exhaustive over the open unions.** `#execute`
  is the main offender; after Seam 3 it is a registry lookup, not a switch.
  Any other `switch` over `Action`/`GameEvent` needs a `default`.
- **Shared tooling needs a fallback.** `describeEvent` (the engine's own debug
  renderer) must gain a `default:` branch, since it cannot know a game's
  vocabulary in advance.
- **Game code stays exhaustive on purpose**, so adding an action surfaces every
  place that must handle it.

### Where the maps live

Augmentation must target the module that *declares* the interface — a re-export
through a barrel does not merge. So the maps live in one dedicated,
types-only module, giving every game a single documented target:

```
src/engine/contracts.ts     # GameEventMap, ActionMap, ActionBase + the well-formedness guards
package.json exports        # "./contracts" → dist/engine/contracts.{js,d.ts}
```

Internal code augments `'../src/engine/contracts.js'`; a package consumer
augments `'<package-name>/contracts'` (the package is currently still named
`tinyquest`, though the project is being renamed to Vibe Engine — the specifier
follows the rename, the seam does not). `events.ts` and `actions.ts` re-export
the maps so they remain the place each vocabulary is *described*.

`contracts.ts` is **types only** — it must never execute anything, or
augmenting a map would drag runtime code into the import graph. The type-only
cycle with `events.ts`/`actions.ts` is erased, so it costs nothing at runtime.

### The guards are tested, not asserted

Three bad augmentations were compiled against the seam to prove the guards fire,
and one good one to prove they do not produce false positives:

| Augmentation | Result |
| --- | --- |
| key `summon`, tag `'summonUnit'` | ✅ rejected — `Property 'summon' is incompatible with index signature` |
| key `'turn:phase'`, tag `'phase:turn'` | ✅ rejected |
| tag/key agree but no pipeline fields | ✅ rejected (plus downstream engine errors) |
| well-formed custom event + action | ✅ clean, and both narrow on their tags |

### The acceptance test is a permanent part of the suite

[`test/extension.test.ts`](../../test/extension.test.ts) *is* a small game: it
declares a `summon` action and a `summon:resolved` event the engine has never
heard of, registers a handler, and asserts the whole path — dispatch, async
handlers, `ctx.engine`, the missing-handler error, double-registration, and a
triggered ability whose `ctx.event` narrows to the game's own event.

It is deliberately not a throwaway spike. Its `declare module` augmentation
widens `Action` and `GameEvent` **program-wide for every typecheck**, so the
openness of the maps is exercised on every `npm run typecheck` rather than only
when a game happens to exist. If the engine ever regrows a closed `switch`, a
`switch` without `default`, or a cast that assumes a fixed vocabulary, the
build breaks here instead of in a game author's repo. That is the same property
that caught the `describeEvent` exhaustiveness bug (below).

## The gauge model: gauges are data, "life" is declared (slice 3)

The engine used to require `maxHp` and always build an `hp` and a `mana` gauge.
Now a gauge is a **declaration**:

```ts
new Character('Dancer', {
  gauges: [{ id: 'stamina', max: 5, sbas: [depletes] }],  // a GaugeDef
  lifeGauge: 'stamina',
});
```

`Gauge`/`GaugeSba`/`GaugeBuffGate` were already fully game-agnostic — a rule
never names the gauge it is attached to — so the only thing that had to change
was the engine's insistence that two *particular* gauges exist. A gauge is
lethal because a `GaugeSba` on it destroys the character, not because it is
called `hp`; that machinery already existed and is now the only path.

**`isDefeated` forced a decision the code did not make for us.**
[`test/gauge-sba.test.ts`](../../test/gauge-sba.test.ts) pins the predicate as
deliberately **rule-independent**: remove the death rule from the HP gauge, drop
to zero, and `isDefeated` is *still* true — "the convenience predicate still
reads HP". So the obvious generalization ("a gauge carrying a death rule is at
its minimum") would have silently changed documented behaviour, and the
opposite one ("whichever gauge the engine watches") has no answer without an
engine in hand.

The resolution is to **declare** the concept rather than infer it:
`CharacterDef.lifeGauge` names the gauge `isDefeated` reads. The deprecated
`maxHp` sugar implies `'hp'`, so every existing character behaves exactly as
before, while a character built from `gauges` alone has no life gauge and is
defeated only by rules or an explicit `destroy`. The authoritative,
restriction-aware predicate remains the engine's own
(`#wouldBeDestroyed`/`#isDead`) — a *different question*, documented as such: a
character destroyed by an explicit action may still read as not defeated.

**Two runtime leaks went with it.** `character:destroyed.changes` and
`character:survived` were gated on `gauge === character.hp`, so a
stamina-death game got none of the forensics `hp` always had, and
`character:survived` could never fire for another gauge at all. Both now test
`#isWatchedGauge` — does the gauge carry `GaugeSba` rules? — which is exactly
the set of gauges whose state the SBA pass watches. It reproduces the old
behaviour for `hp` and `mana` while generalizing correctly.

## Finding: excess-property checking does not reach a variable (slice 4d)

When the deprecated `TransformForm.maxHp` field was deleted, `npm run
typecheck` reported 24 call sites — and *missed* one:

```ts
const form = { name: 'Sheep', maxHp: 5 };   // no error
selfTransformingBuff('Polymorph', form);    // still no error
```

TypeScript's excess-property check applies to object *literals* in a
contextually-typed position. Assigning the literal to a `const` first widens it,
and passing the variable is an ordinary assignability check, for which the
extra property is harmless. So the field was gone, the type said it could not
exist, and this form still carried it — silently, until a test asserted the
resulting gauge.

The lesson for removing a deprecated field: the compiler's error list is a
*floor*, not a proof of coverage. Grep the field name across the repo and
confirm every remaining hit is a legitimate new use.

## Finding: two `export *` of one name diverge between types and runtime (slice 4c)

Worth recording because it is silent and the type checker actively hides it.

`turn-based` re-exported the engine with `export *` and then declared its own
`Character`. When the round-based layer was added, it was re-exported with a
*second* `export *` — which also carries the engine's `Character`. TypeScript
resolved the collision to the explicit local export, so every `{ maxHp }`
character still type-checked. ESM resolved the ambiguous star export the other
way at runtime, so every such character was built by the **engine's**
constructor and came out with no gauges at all — 337 tests failed with
"Character has no hp gauge".

The fix is to re-export a layer **by name** when your own module already
exports a colliding one:

```ts
export { TeamOutcome } from '../round-based/outcome.js';
export { lose, win } from '../round-based/win-lose.js';
```

The general rule this leaves behind: `export *` is for a layer that adds to a
surface without shadowing any of it. The moment a layer shadows a name — as
`turn-based` shadows `Character` — every additional `export *` becomes a
type/runtime divergence waiting to happen, and `npm run typecheck` will not
tell you.

## Finding: the turn loop is shared, not turn-based-combat (slice 4b)

The plan above filed the turn machinery under `turn-based-combat`. Reading the
consumers says otherwise — and it is the second game that settles it:

| Machinery | Who uses it |
| --- | --- |
| `startTurn` / `endTurn` (`turn:start` / `turn:end`) | `src/multiplayer`, `src/ui`, `src/english/simulate`, ~90 test sites, **and `examples/card-game`** |
| `Game`, `Decision`, `GameEndInterrupt` | **`examples/card-game` extends `Game`** |
| `isAlly` / `isEnemy`, teams, `win`/`lose` | **`examples/card-game`** |
| descending-`speed` initiative (`DEFAULT_SPEED`, `sortBySpeed`) | turn-based combat only |

`examples/card-game` is an MTG-style game that shares none of tinyquest's
vocabulary — no `hp` as life, its own zones, its own stack — yet it uses the
round loop, the ally/enemy test and the game-end interrupt. So those are a
**reusable round-based-game seam**, and moving them into `turn-based-combat`
would force the card game to depend on a rival game.

`sortBySpeed` and `DEFAULT_SPEED` are the opposite case: descending speed with
speed-ties broken by a seeded shuffle is *this* game's initiative, and a card
game has no use for it.

So slice 4b splits in two: a shared `round-based` layer for the loop, teams and
win/lose; and this game's initiative staying with `turn-based-combat`. This is
the same lesson as the `ZoneRegistry` one — the engine's mistake was never
having the loop, it was having *only* the loop, with no way to substitute
another. The `TriggerScheduler` seam already shows the right shape.

## What moves out of the core

The extension system is what makes the extraction possible. Once a game can
declare events, actions and entity kinds, everything below can leave
`src/engine` and become an ordinary consumer of it — the **turn-based combat
game** layer.

| Leaves the core | Where it is today |
| --- | --- |
| `maxHp`/`maxMana`/`hp`/`mana` on `Character`; the built-in HP death `GaugeSba`s; `isDefeated` | [`character.ts:41-57`](../../src/engine/character.ts#L41-L57), [`:60-66`](../../src/engine/character.ts#L60-L66), [`:159-160`](../../src/engine/character.ts#L159-L160), [`:221-226`](../../src/engine/character.ts#L221-L226), [`:377-379`](../../src/engine/character.ts#L377-L379) |
| `TransformForm.maxHp`/`maxMana` and the two-field form fold | [`actions.ts:196-198`](../../src/engine/actions.ts#L196-L198), [`character.ts:495-542`](../../src/engine/character.ts#L495-L542), [`engine.ts:1121-1125`](../../src/engine/engine.ts#L1121-L1125) |
| `damage`/`heal` builders, `isHpChange`/`isManaChange`/`isDamage`/`isHeal`/`wasDealtBy`/`wasTakenBy` | [`actions.ts:529-549`](../../src/engine/actions.ts#L529-L549), [`events.ts:400-432`](../../src/engine/events.ts#L400-L432), re-exported [`index.ts`](../../src/engine/index.ts) |
| HP-keyed runtimes: `GaugeWrite` collection and the `character:survived` check | [`engine.ts:2241`](../../src/engine/engine.ts#L2241), [`:2310-2314`](../../src/engine/engine.ts#L2310-L2314) |
| `DEFAULT_SPEED`, `sortBySpeed`, `Game`, `Decision`, `startTurn`/`endTurn` | [`character.ts:31`](../../src/engine/character.ts#L31), [`game.ts:53-188`](../../src/engine/game.ts#L53-L188), [`engine.ts:743-753`](../../src/engine/engine.ts#L743-L753) |
| ~~`win`/`lose`, `TeamRegistry`~~ **moved**; `isAlly`/`isEnemy`, `TargetWho`'s `'ally'`/`'enemy'` still here | [`actions.ts:142-164`](../../src/engine/actions.ts#L142-L164), [`teams.ts`](../../src/engine/teams.ts), [`ability/types.ts:14`](../../src/engine/ability/types.ts#L14) |
| `PLAY`/`GARBAGE` as reserved ids; `isDeath`'s garbage test | [`zone.ts:114-115`](../../src/engine/zone.ts#L114-L115), [`events.ts:463-470`](../../src/engine/events.ts#L463-L470) |
| ~~The `.svg` loader pair and the roster they serve~~ **moved** | now [`src/games/turn-based/`](../../src/games/turn-based/) (`svg-loader.mjs`, `svg-hooks.mjs`, `content/`) |

**Damage is the interesting case.** It is not one concept. What a loss of value
*means* depends on the entity kind receiving it — in Magic, damage to a player
lowers life, damage to a creature is marked and checked, damage to a
planeswalker removes loyalty counters. So `damage` is not one engine action
with one meaning; it is a **game-declared action whose handler dispatches on the
target's entity kind**. That is precisely what Seams 1–3 buy: the game declares
`EntityMap` kinds, declares a damage action, and registers the per-kind
behaviour. The engine keeps only the generic machinery it already has — the
`gauge` action, the transformer pipeline, and `GaugeSba` — which is what a
turn-based combat game builds its damage on.

The gauge primitive stays in the core. `Gauge`, `GaugeSba` and
`GaugeBuffGate` are already fully game-agnostic: the rule never names the gauge
it is attached to ([`gauge.ts:84-88`](../../src/engine/gauge.ts#L84-L88)), rules
are name-keyed and removable, and custom gauges already work end-to-end for
SBA firing, max derivation, buff gates and defeat. **Only the choice to have
`hp` and `mana`, and what the loss of `hp` means, is game-specific.**

## Migration plan

Each step keeps `tsc -p tsconfig.build.json` and `npm test` green.

- **Slice 0 — open the vocabularies. ✅ BUILT.** `GameEventMap` and `ActionMap`
  derived unions; the tag/key guard; maps on the public surface. Non-breaking,
  750 tests green.
- **Slice 1 — contracts module + `ActionBase`. ✅ BUILT.** Maps moved to the
  types-only `src/engine/contracts.ts`, published as the `./contracts` subpath;
  `ActionBase` added and enforced by the key-based guard; `describeEvent` given
  its `default` ([`log.tsx:65`](../../src/ui/components/log.tsx#L65)). Guards
  verified against three bad augmentations and one good one. 750 tests green.
  *`EntityMap` deliberately deferred to slice 3 — declaring entity kinds before
  anything consumes them would be speculative, and slice 3 is where the
  consumer appears.*
- **Slice 2 — the action registry. ✅ BUILT.** `ActionRegistry`
  ([`action-registry.ts`](../../src/engine/action-registry.ts)) replaces the
  closed switch in `#execute`; the engine's eight non-gauge actions register
  through it in the constructor; reachable as `engine.actions`. A missing
  handler throws naming the tag and the fix. The second closed switch,
  `actionTarget`, is gone too — subject resolution is part of registration, so
  a game action joins the restriction/transformer pipeline on the same terms
  as a built-in. Guarded by
  [`test/extension.test.ts`](../../test/extension.test.ts) (15 tests) — see
  below.
- **Slice 3 — the entity seam. ✅ BUILT.** `GaugeDef` makes gauges declarable
  as data ([`gauge.ts`](../../src/engine/gauge.ts)); `CharacterDef.gauges` is the
  primary path and `maxHp` is now **optional** sugar; `Character.gauge(id)`
  replaces the named fields, which survive as `@deprecated` accessors that throw
  with a clear message when absent. `TransformForm` is keyed by **gauge id**
  (`gauges: { stamina: 2 }`), `transformedBaseMax(id: string)` lost its closed
  `'hp' | 'mana'` union, and `#gaugeBase` no longer special-cases a gauge.
  `isDefeated` reads a **declared** `lifeGauge`, and the two runtime leaks —
  `GaugeWrite` collection and `character:survived` — are gated on
  `#isWatchedGauge` (a gauge carrying `GaugeSba` rules) rather than on `hp`.
  Guarded by [`test/generic-gauges.test.ts`](../../test/generic-gauges.test.ts).
  *Still in the engine, all marked `@deprecated`: the `maxHp`/`hp`/`maxMana`/
  `mana` sugar, the `hp`/`mana` accessors, `TransformForm.maxHp`/`maxMana`,
  `isHpChange`/`isManaChange`, and `maxModifier`'s `gauge ?? 'hp'` default.
  No engine **rule** reads any of them; slice 4 moves them into the game layer
  and deletes them.*
- **Slice 4a — hp/mana, damage predicates and the death rules. ✅ BUILT.**
  New `src/games/turn-based/` (`character.ts`, `death.ts`, `events.ts`).
  The engine lost: the built-in death rules (it now attaches **no** `GaugeSba`
  by default), `CharacterDef.maxHp`/`hp`/`maxMana`/`mana`, the reserved stat
  names for them, the HP-keyed event helpers, and `maxModifier`'s
  `gauge ?? 'hp'` default. Its `Character` is a bare entity; this game's is a
  subclass that turns `{ maxHp }` into a gauge declaration. 64 files migrated
  to import from the layer. Guarded by
  [`test/turn-based-layer.test.ts`](../../test/turn-based-layer.test.ts).
- **Slice 4b — initiative and the game's content. ✅ BUILT (partly).**
  `DEFAULT_SPEED` and `sortBySpeed` moved to
  [`initiative.ts`](../../src/games/turn-based/initiative.ts); the engine now
  defaults `speed` to `0` and defines no ordering. The roster — 45 files and
  all 31 `.svg` assets — moved to `src/games/turn-based/content/`, and the
  `.svg` loader pair moved beside it, so plain Node resolves them from
  `npm run ai:vs`. `examples/card-game` proved the rest of the turn machinery
  is **shared** (see the finding below): `Game`/`Decision`/`GameEndInterrupt`
  and teams/win-lose still need a `round-based` layer.
  Still in the engine: `TransformForm.maxHp`/`maxMana` (45 call sites) and
  `gaugeOf`'s bare-character default, both `@deprecated`.
- **Slice 4c — the outcome seam, win/lose and the turn boundary. ✅ BUILT.**
  `src/games/round-based/` now owns `win`/`lose` (declared by augmenting
  `ActionMap`, executed by handlers registered on `engine.actions`), the team
  outcome rules, and `startTurn`/`endTurn` (declared by augmenting
  `GameEventMap`). The engine gained `OutcomeRegistry` (`engine.outcomes`) and
  `drainTriggers()`, and lost `TeamRegistry`, its win/lose action handlers, its
  `startTurn`/`endTurn` methods, and `sortBySpeed`. It also exposes the two
  facts an outcome check needs — `deadForDefeat` and `cannotWin` — instead of
  deciding what they mean. `createEngine()` in the round-based layer is the
  batteries-included entry point; `new GameEngine()` is a game with no
  automatic game-over rule.
  **This slice is the extension system's proof**: `win`/`lose` are added to the
  engine by a game, through the same `declare module` + `actions.register`
  recipe a content author uses, with nothing privileged about them.
- **Slice 4d — `RestrictionKind`, and the last hp aliases. ✅ BUILT.**
  `RestrictionKind` is derived from an open `RestrictionKindMap` in
  `contracts.ts`, so a game declares its own attempt kinds; `win`/`lose` moved
  to `src/games/round-based/win-lose.ts` that way, and `deadForDefeat` /
  `cannotWin` moved with them — they compose `attemptBlocked`,
  `wouldBeDestroyed` and `canDestroy` (all public) with the kinds that layer
  declares. `engine.stateAttempt(character)` became public so a game can build
  the same no-actor context instead of duplicating it. The deprecated
  `TransformForm.maxHp`/`maxMana` aliases and `normalizeTransformForm` are
  **gone**, and all 64 call sites now name gauges by id.
- **Slice 4e — hp/mana out of the engine entirely. ✅ BUILT.** `Character.hp` /
  `Character.mana` are **gone**, and so is `gaugeOf`'s "a bare character means
  its hp gauge". `Character.gauge(id)` now *throws* on a missing gauge (the
  accessors' behaviour, kept), with `findGauge(id)` as the explicit optional
  form; `damage`/`heal` take a `Gauge`, not a `Character | Gauge`. 612 property
  accesses and 316 call arguments were migrated. The engine now contains **no**
  reference to `hp` or `mana` at all.
- **Slice 4f — `TargetWho`, the last closed vocabulary. ✅ BUILT.**
  `TargetWho` is derived from an open `TargetWhoMap`; the engine answers only
  `'self'` and `'any'` (neither needs a model of the world) and resolves the
  rest through `engine.targeting` (`TargetingRegistry`). A `who` with no
  resolver is a **loud error at the point of use**, not an empty pool — a
  forgotten registration must not look like "nothing in range". `isAlly` /
  `isEnemy` left the engine for
  [`round-based/targeting.ts`](../../src/games/round-based/targeting.ts), which
  declares `'ally'`/`'enemy'` and registers them in `createEngine`.

## The objective, measured

The engine names **no game concept**. Concretely, `grep` over `src/engine` for
`hp`, `mana`, `speed`-as-initiative, `sortBySpeed`, `DEFAULT_SPEED`,
`TeamRegistry`, `win`/`lose`, `ally`/`enemy` or `gaugeOf` returns **nothing** —
and the engine imports nothing from outside itself (the one `'tinyquest'`
string is a JSDoc example).

Two generic tags remain on `Character`, and both are extension points rather
than concepts: `team` (a free-form grouping label, like `stats` is a free-form
number) and `speed` (the base for a named stat). **No engine rule reads
either** — `Player` merely copies `team` onto its characters so content need
not. A game with no sides and no initiative passes neither and loses nothing.

What a game now supplies, and where: every one of these is a seam the engine
consults rather than a branch it hardcodes.

| A game declares | Through | Reference implementation |
| --- | --- | --- |
| events | `GameEventMap` | `'turn:start'` in `round-based/turn.ts` |
| actions | `ActionMap` + `engine.actions` | `win`/`lose` in `round-based/win-lose.ts` |
| restriction kinds | `RestrictionKindMap` | `'win'`/`'lose'` |
| targeting values | `TargetWhoMap` + `engine.targeting` | `'ally'`/`'enemy'` |
| entity kinds | structural `Entity` | `AbilityObject` in `examples/card-game` |
| when the game ends | `engine.outcomes` | `TeamOutcome` |
| rule scheduling | `engine.addStateBasedRule`, `GaugeSba` | the death rules |
| trigger ordering | `EngineOptions.scheduler` | `ImmediateScheduler` |
- **Slice 5 — de-couple the layers.** Point `src/ir`'s barrel at the pure half
  only, stop `src/english` value-importing the engine, move
  `english/simulate.ts` out of the language, parameterize the vocabulary's
  gauge/event tables.
- **Slice 6 — move the game content and the svg loaders** into the game layer,
  and relocate `src/games/cards` to `examples/` (it is an unpublished MTG
  reference game — not built, not published, consumed only by two tests).
- **Slice 7 — split the tests**: the 25 engine-core files gate the engine; the
  4 content and 8 layer files move with their layers; the 3 mixed files get
  their non-engine fixtures inlined.

## Open questions

1. **Does the turn-based layer ship as a second published subpath**
   (`vibe-engine/turn-based`), or does it become its own workspace package?
   The subpath is cheaper now; separate packages enforce the boundary harder.
2. **Should `Character` survive as a name in the core at all?** The entity seam
   (Slice 3) makes it "the entity kind with gauges and statuses" — which is
   generic — while its `hp`/`mana` fields are not. Split into `Entity` +
   `Gauged` mixin, or keep one class and move the gauges out?
3. **How far does `EntityMap` go?** Zones already take any `Entity`
   ([`zone.ts:46`](../../src/engine/zone.ts#L46)). Declaring entity *kinds* as
   data (with their component sets) is the natural next step, but it is a
   larger change than the event/action seams and is not required by them.
4. **Does `Game`/`Decision` belong in the turn-based layer or a separate
   "turn loop" seam?** A real-time game wants neither; a card game wants a
   different loop. The `TriggerScheduler` precedent says: make it injectable
   and ship the turn-based one as the default.
