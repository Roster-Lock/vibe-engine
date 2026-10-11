# TinyQuest — Goal: Players Create Content, and Share It

> The north star for TinyQuest. Everything else — the engine
> (`docs/spec/`, `src/engine/`), the UI (`src/ui/`), the examples
> (`src/examples/`) — exists to serve this goal. Where a decision below
> conflicts with an engine doc, **this goal is the why** and the engine
> doc is the how.

## The goal

> **A player should be able to create their own hero — with abilities and
> buffs — and share it with other players, who can play with or against
> it without seeing engine internals.**

"Create" here means the player authors game *content*: heroes (stat
blocks + permanent skills), abilities (what a character can do), and
buffs (runtime statuses). "Share" means content produced by one player
travels to another — in the same game, in a lobby, or across a
catalog — and works identically there.

Today the engine already makes *code* content-creator-friendly: a new
player writes a skill or buff by composing a few small declarative
pieces (`cast`, `auto`, `buff`, …) without touching engine internals
(see `README.md`). This goal is the next step: that experience, as a
**player-facing surface** — not a TypeScript codebase.

## The three priorities

Three properties of the creator surface matter, in rough order of
importance:

### 1. Making creation easy — an English-based scripting language

The surface a player writes in should read like English, not like
programming. The engine's TS surface is a good substrate but not the
target surface.

- Content should be expressible as sentences: "when I take damage, deal
  2 damage to the attacker", "at the start of my turn, heal 4".
- The vocabulary is small and discoverable: a handful of events, a
  handful of actions, targeting phrases.
- A **sentence-template layer** compiles English-shaped text into the
  engine's content model (the IR below). The raw surface stays
  available as the escape hatch for anything templates can't say.

### 2. TypeScript-esque autocomplete based on types

When a player writes content, the editor should **restrict values based
on type comparisons** — exactly what TypeScript's type narrowing gives
the engine's content today, exposed in the player-facing editor.

The canonical example (now true in the engine — see the "Progress"
section):

> When a buff is destroyed by a triggered ability owned by a buff,
> writing `source.type === 'buff'` narrows `source` to the `Buff` type,
> and the editor offers the buff's properties (`.vars`, `.weight`,
> `.abilities`, …) for autocomplete.

So: the surface has a type system, the editor knows it, and narrowing
is both a **check** (the editor rejects impossible field access) and a
**discovery** tool (autocomplete shows what the narrowed type offers).

### 3. Making the canvas open

The goal is a **canvas**, not a form. Players shouldn't be limited to a
fixed menu of pre-made abilities. Anything expressible in the engine's
content model is expressible in the surface — which is why the surface
sits *on top of* the engine's full model rather than replacing it with
a closed set of slots.

Open canvas and easy creation are in tension: full freedom is what the
raw surface (or "advanced mode") is for; the template layer is the
bounded, guided path. The design must keep both.

## The core insight: the language and the share format are the same problem

"What is an ability, as data?" — a canonical, validated representation
of heroes/abilities/buffs — is simultaneously:

- the **share format**: what travels between players, is validated on
  import, and is versioned;
- the **compilation target**: what the English-sentence templates
  compile to;
- the **serialization** of the engine's content defs (today: TS
  closures; tomorrow: data + small scripted bits).

Design this IR once, carefully. Everything else (editor, templates,
import/export, a catalog) builds on it. Decisions to make: what is
declarative data (stats, gauges, targeting patterns, buff weights)
versus scripted logic (cast bodies), how scripted logic is represented
(the "script" subset of the language), and how validation reports
errors back to the author.

## Progress

- ✅ Engine core: content in TypeScript with **type narrowing already
  working** — `TriggerContext<E>` narrows `ctx.event` to the subscribed
  event type (`src/engine/ability/types.ts`); `EventSource` and
  `Status` are discriminated unions, so `source.type === 'character'`
  narrows to `Character` and `source.type === 'buff'` narrows to `Buff`
  with its fields (`src/engine/events.ts`, `src/engine/status.ts`).
- ✅ **Type vocabulary aligned to English** (this session): the
  discriminants are lowercase words — `'character'`, `'buff'`,
  `'skill'` — so the narrowing example reads like English. `Status` is
  now a real union (`Buff | Skill`) so narrowing reaches the buff-only
  fields (`stacks`, `removedOnDefeat`). Guarded by
  `test/narrowing.test.ts` (checked by `npm run typecheck`).
- ✅ **Events have no optional properties — they come in versions**
  (this session): an event that may or may not carry a fact (`source`,
  `target`, `maxChanges`) is split into separate union members with
  all-required fields, narrowed with `'source' in event` before the type
  narrows (`src/engine/events.ts`). The compiler forces the presence
  check first, then narrows — `'source' in event &&
  event.source.type === 'buff'` yields the buff's fields for
  autocomplete. Guarded by `test/narrowing.test.ts` and the whole
  suite.
- ✅ **Ability Language prototype — actions, manual abilities, and an
  editor** (this session): an English-shaped sentence surface that compiles
  into engine content (`src/english/`, spec in
  `docs/creator/01-ability-language.md`). Manual abilities are written as
  "Ability \<name\>" + effect sentences ("Destroy target enemy character.",
  "Deal 20 damage to all enemy characters.", "You lose the game."); custom
  buffs are declared in the document itself (`Buff Frailty (stacks)`) and
  travel with it. A real lexer/parser produces span-accurate grammar
  diagnostics, future vocabulary ("whenever …", "this buff", summons) gets
  targeted "next milestone" hints, and every sentence compiles to engine
  Actions (`cast` bodies). **Editor**: a Create page (`src/ui/pages/`) with
  Monaco — position-aware autocomplete, squiggly errors, hover help, a
  compiled-output pane, and a headless test battle through the real engine
  (the same arena the unit tests drive). Guarded by `test/english.test.ts`
  (40 tests). Events/triggers, buff payloads, and summons are the next
  milestone — the grammar is shaped so "whenever … then …" slots in. The
  events grammar's **batch-event count vocabulary** is specced in
  `docs/creator/01-ability-language.md` (`one or more` — the default —
  plus the ranges `<n> or more`, `<n> to <m>`, `<n> or less`), and the
  editor already recognizes those phrases inside "whenever … then …"
  sentences with targeted next-milestone diagnostics and hover help
  (`BATCH_EVENT_COUNT_WORDS` in `src/english/vocabulary.ts`).
- 🔶 Editor: **started** (this session, see above). The UI now has a
  creator page with an embedded Monaco editor for the English surface; the
  TS surface (Monaco + the engine's types) is still ahead for the
  "advanced mode" escape hatch.
- ✅ **Ability-as-data IR — the foundation for sharing** (this session):
  `src/ir/` holds the compilation target as plain JSON — abilities, buffs,
  triggers, entity queries and filters (`ability.ts`), plus the
  `DeclaredFn` expression layer for the places a declarative slot is not
  enough. `src/english/` no longer builds engine closures directly: it
  **lowers** to IR (`lower.ts`) and `src/ir/bind/` binds that to engine
  content. `CompileResult.ir` is the shareable document.
  `test/ir.test.ts` holds the pipeline to its claims — the IR round-trips
  through `JSON.stringify`, carries no closures or class instances, and the
  *deserialized* copy binds to abilities that behave identically to the
  originals (the share step, literally). The same tests bind batch and
  single triggers straight from IR, so the trigger shapes work ahead of the
  English grammar for them.
- ✅ **Gates and amounts are one expression vocabulary** (this session): a
  trigger's count phrase is not a `{min, max}` struct but a
  `PredicateIR` — a boolean over `ValueIR`s, where `count` is itself a
  value. One vocabulary therefore covers the count-phrase table, gates no
  range could express (an even count; a count *and* a property of one of
  the triggers, via `any`/`every`), amounts that read a count ("damage
  equal to how many died"), and `StepIR.when` — conditional effects, the
  "if …" half of an action. `%` joined the formula language so "an even
  number of …" is expressible.
- ✅ **One boolean vocabulary** (this session): `FilterIR` is gone —
  `PredicateIR` is the only condition type in the IR, used by a trigger's
  gate, a group's `with …`, a targeting restriction and a step's `if …`.
  Nodes are context-scoped (`compare`, `and`/`or`/`not`, `any`/`every`) or
  entity-scoped (`hasBuff`, `relation`, a `gauge` value with no `of`), and
  `any`/`every` bridge between them. `with hp < 10` is now an ordinary
  `compare` whose left side reads the candidate's gauge, which is why both
  sides can be values: comparing two of a candidate's own gauges, or a
  gauge against a board count, is expressible where the old split could
  only compare one gauge to a literal. An entity question asked with no
  entity in scope answers false rather than throwing.
- 🔶 Zones: **slice 1 part done** — `src/engine/zone.ts` generalizes the
  engine's two hard-coded `Set<Character>` piles into declared zones, and
  `destroy` is now a move to the `graveyard` zone that announces
  `zone:changed`. The card game's deck/hand/stack/active are declared as
  data (`src/games/cards/zones.ts`). `move`-as-an-`Action` — the half that
  buys replacement effects and move restrictions — is still ahead. See
  docs/design/15-zones.md.
- ✅ **Buff durations and action modifiers** (this session): `Buff Mark
  (until end of turn)` / `(for 2 turns)` — a duration is not an engine
  concept, it lowers to an ordinary triggered ability on the buff that
  removes it, so each instance expires on its own. And **action
  modifiers**: `Increase outgoing damage by 5.`, `Cap incoming damage at
  10.`, `Prevent`, `Double`, `Halve`, `Reduce` — the last content category
  the language could not express. `ModifierIR` splits the one piece of
  content that is a *function of an action* into a **match** (direction,
  damage-or-healing, gauge, a predicate on the target) and a **rewrite**
  on the change's **magnitude**, so authors never touch signs and two
  modifiers compose instead of overwriting. Stacking is free — the engine
  runs every attached instance's modifier, so a `(stacks)` buff with "+5"
  is +15 at three stacks with no per-stack arithmetic. `test/english.test.ts`
  asserts the English Rage produces **identical** results to the
  hand-written `passiveActionModifier` in
  `src/examples/08-27-2026/buffs/rage/index.ts`, at one stack and at three.
- ✅ **Trigger scheduling is interchangeable** (this session):
  `TriggerStack` keeps the registry, the `when` gate and the execution of a
  trigger; **what order they run in and when** is a `TriggerScheduler`
  (`src/engine/trigger-scheduler.ts`) — the one part of dispatch a
  turn-based game, a card game and a real-time game genuinely disagree on.
  `ImmediateScheduler` is the default (registration order, seeded shuffle,
  drained when the resolution unit completes); `CardStack.scheduler()`
  puts triggers on the stack so players may respond, replacing the earlier
  `deferTrigger` sink — a scheduler sees the whole group an event made
  ready, so it can order it, which a per-trigger sink could not.
  `test/trigger-scheduler.test.ts` demonstrates the case the default
  cannot fake: a frame-based scheduler that holds a trigger until the next
  frame, so a cascade is **bounded by the clock rather than by a depth
  guard** and never has to become an error.
- ✅ **Ability availability** (this session): `engine.canUse(owner,
  ability)` answers whether an activated ability can be used now, and why
  not — `unavailable`, `restricted` (a new `activate` restriction kind, so
  "silenced" is finally expressible), or the advisory `no-targets`.
  `useAbility` enforces it. In English: `Available while <condition>.`
  Motivated by input constraints rather than rules — an RTS binds
  abilities to hotkeys and a gamepad has very few, so an ability
  *granted* by a trigger would appear and disappear and shuffle every
  slot around it. Writing availability as a **condition** instead keeps
  the ability in its owner's kit permanently, lets one button hold its
  slot and merely light up, and means nothing has to stay in sync: the
  answer is derived from the board, so it survives a reload and a replay.
- ✅ **Toggles** (this session): `Toggle <buff>.` — an ability whose one
  slot means two things, which is a fourth kind alongside manual,
  triggered and passive because it has persistent state. The state lives
  in the buff it maintains (on = attached), so there is none kept
  elsewhere, and the same buff is what a UI reads for the lit/unlit icon.
  It is **one** `toggleBuff` effect rather than two guarded steps: steps
  resolve one at a time with effects landing between them, so
  remove-then-add-if-absent is stuck on — `test/toggles.test.ts` asserts
  that, so the reason stays visible. Spellbooks are designed but not built
  (docs/design/16-ability-sets.md).
- ✅ **`takes damage` and `the source`** (this session): triggers can
  listen to HP changes, and name whoever caused them. Damage is not its own
  event in this engine — it is a gauge losing value — so the event table
  carries the gauge and direction a phrase means, and verbs may now be
  several words. `the source` is deliberately generic rather than `the
  attacker`: one noun for every event, resolving to nobody when nothing
  caused it, the cause was not a character, or the cause was the trigger's
  own owner. `test/english.test.ts` asserts the English Thorns produces
  **identical** results to the hand-written `auto` closure in
  `src/examples/08-27-2026/buffs/thorns/index.ts` — the roster is now 13 of
  14 abilities writable in English, the remaining one being the Vampire's
  two-target Life Drain.
- ✅ **Named target bindings, and a required source kind** (this session):
  `Target 1 enemy character as victim and 1 different character as
  benefactor.` — named picks, referenced as `the victim`, which retires the
  one-target-per-ability limit and the `target-conflict` apology. Bindings
  fill positionally from the engine's single pattern and each slice is
  checked against its own `who`/filter, so a pick legal for one binding but
  not another is dropped rather than acted on. `test/target-bindings.test.ts`
  asserts the English Life Drain behaves like the hand-written two-target
  closure — **the roster is now 14 of 14**. Separately, `the source` became
  `the source character` / `the source buff`: an event's cause is a union,
  and a card that did not say which kind it answered would silently ignore
  the other. And `useAbility` now enforces the pattern's *shape* —
  duplicate picks and overcounts — not just its pool, which nothing checked
  before.
- ✅ **Modifiers became declarative, and gained a chance** (this session):
  the sentence frames are `<subject> is <rewrite>.` and `<subject> has a
  <n>% chance to be <rewrite>.` — a passive is a standing rule, not a
  command, so "incoming damage **is capped at** 50" rather than "cap
  incoming damage". The rewrite vocabulary is past participles
  (`increased by`, `reduced by`, `multiplied by`, `doubled`, `halved`,
  `capped at`, `prevented`), and a chance is rolled per action from the
  seeded PRNG so a replay rolls the same. `%` was free for this because
  parity had already taken over from remainder.
- 🔶 Template layer: not started. Depends on the IR (now in place).
- ✅ **`when … then …` grammar** (this session): triggers are writable in
  English and run through the real engine. `when <count> <subject> <verb>
  then <effect>.` — the count phrase (`one or more`, `<n> or more`, `<n> to
  <m>`, `<n> or less`) picks the batch event and lowers to the
  `PredicateIR` gate; the subject is an **ordinary character phrase**, so
  adjectives, `owned by` and `with …` filters all apply to the triggering
  characters, filtering them before the count is checked. `a character` is
  the per-event trigger, `this` the owner's own — and after `this` the noun
  is optional, since `this` names whatever is using the ability whatever
  kind of thing it is. Counts are written as digits (`1 or more`). A trigger inside
  a `Buff` is granted while attached; one outside any section travels in
  `CompileResult.triggers` for the host to place. Guarded by
  `test/english.test.ts`, including battles through the arena.
- ✅ **`If …,` conditional effects** (this session): `StepIR.when` is
  writable — `if there are <count> <characters>`, `if any|every
  <characters> has <condition>`, `if this has <condition>`. `any`/`every`
  are the array vocabulary on purpose. Checked immediately before the
  effect, so it sees the earlier sentences' results; works inside a
  trigger's effect too.
- ✅ **`You may …` and `Repeat …:`** (this session): optional effects ask
  the controller through `Player.choose`'s `confirm` — its first caller —
  and a repeat takes three independent clauses (`up to <n> times`,
  `while <condition>`, `if you choose`), any subset. Asking is a separate
  field from the predicate, not an operand inside it: `PredicateIR`'s `and`
  is pure and n-ary with no promised order, so a side-effecting operand
  would make order silently observable everywhere, including in
  synchronous targeting filters. The condition is evaluated **before** the
  question in both, so a player is never asked about something that could
  not have happened. An unbounded `repeat` is a compile error; one bounded
  only by its condition is a warning.
- ✅ **`%` freed for percent** (this session): the remainder operator is
  gone from the formula language and parity is a `parity` predicate written
  as words — `an even number of characters die`. A `%` meaning remainder
  would be misread as a percentage every time, and percent is the far more
  common need.

## What "done" looks like (eventually)

- A player opens the creator, writes a hero in English-shaped
  sentences, sees type-aware autocomplete andment errors as they type, and
  plays a test battle against an AI — all in the browser.
- The hero serializes to the IR; the player exports it (or publishes it
  to a catalog), and another player imports it and uses it in their own
  game.
- Imported content is validated and safe: it cannot touch engine
  internals beyond the content surface, and it behaves deterministically
  in any game (seed-independent).

## Non-goals (for now)

- Building the engine's remaining target-model slices (pending effects,
  aura scope, …) — engine depth serves the canvas but is secondary to
  the creator surface; revisit after the surface exists.
- A bespoke *parser and type-checker* from scratch — reuse TypeScript
  (via Monaco / the TS language server) for the editor experience
  rather than inventing one; the English layer sits on top.
- Multiplayer transport and catalog servers — the IR and editor come
  first; sharing can start as file import/export.
