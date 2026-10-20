# 15 — Zones, Entities & Movement

> Status: ✅ direction decided; implementation pending. 🔶 entity weight in
> hidden zones and ordered-zone vocabulary open.
>
> **Superseded on two points** (see "The zone list" and "The stack" below):
> the card game is now targeting **MTG-style stack-and-priority** rather
> than the time-based counterplay [08-countering](08-countering.md) decided,
> which un-defers the stack from this doc's "Open" section and makes `stack`
> one of the declared zones.
>
> Supersedes the README's deferred entry "*Zones beyond play/garbage — no
> hand/deck/exile for now*". Motivated by `examples/card-game/` — see its
> README for the gaps this doc closes.

## The model

The engine already has zones. It has them **hard-coded twice, for one entity
type**: `play` and `garbage` are two `Set<Character>` fields on the engine,
and `destroy` is a bespoke path that moves a character between them.

A card game needs a library, a hand, a discard pile, an exile pile, and
*temporary* piles conjured in the middle of an effect. So the decision is not
to bolt a second pile mechanism onto the side — it is to **generalize the one
the engine already has**, and reimplement destroy/garbage on top of it.

Three concepts, in order of dependency:

- an **Entity** is anything with an identity the game can reference — a
  character, a card, a token;
- a **Zone** is an ordered or unordered container of entities, with a
  visibility and an optional owner;
- **`move`** is an *Action*: it takes entities out of one zone and puts them
  in another, and it flows through the action pipeline like every other
  action.

## Why movement must be an Action

This is the load-bearing decision, and everything else follows from it.

The engine's pipeline already does, for actions, all the work that zone
changes need:

- **`ActionTransformer` becomes replacement effects.** *"If a card would go
  to your garbage, exile it instead"* is the single most common effect
  class in a card game, and it is `replaceAction` on a `move` — already
  shipped machinery (see [12-replacement-effects](12-replacement-effects.md),
  which this un-defers for the in-pipeline half).
- **Events come free.** A `zone:changed` event makes *"whenever a creature
  leaves the battlefield"* writable as ordinary content.
- **Restrictions come free.** A new `on: 'move'` kind gives "cannot be
  discarded", "cannot leave the battlefield" — the existing gate, a new
  verb (see [11-restrictions](11-restrictions.md)).
- **Batching comes free.** A `move` of many entities batches like consecutive
  gauge writes do, so "mill five" and a board wipe are each **one**
  simultaneous change with one batch event — the pattern
  `character:destroyed:batch` already establishes.
- **`destroy` collapses into a special case** — `move(character, play,
  garbage)`. One mechanism, not two that fail to compose.

That last point is the argument against making piles a plugin. A plugin pile
system would sit *beside* the engine's own play/garbage, so a replacement
effect written against plugin piles could not intercept the engine's own
destroy — two mechanisms, silently non-composing. Generalize first; extend
later.

## Decisions

- ✅ **`Entity` is the new base; `Character` is an entity with gauges and
  statuses.** Everything that can be referenced, targeted, moved, or owned is
  an entity. `EventSource` widens accordingly.
- ✅ **A card and the creature it becomes are one identity in two forms.**
  This is the identity-vs-form model from
  [01-entities](01-entities.md) applied across zones: moving a creature card
  from hand to play does not construct a new object, it *realizes* the
  character form on the entity that was already there. Death triggers,
  "return it to your hand", and "it remembers what happened to it" all work
  because the identity never changes.
- ✅ **`play` and `garbage` become ordinary zones.** No special fields, no
  special paths. Targeting still draws from `play` only
  ([05-targeting](05-targeting.md)); that becomes a property of the zone
  (`targetable`) rather than a hard-coded pool filter.
- ✅ **`destroy` keeps its action, its event, and its `reason` vocabulary**,
  and is implemented as a `move` to the garbage. Existing content and the
  whole destroy design ([02-destroy](02-destroy.md)) are unaffected — this is
  a reimplementation, not a rename.
- ✅ **Dying *is* a zone change — it is not a second kind of event.** The
  primitive is `zone:changed` out of an `IN_PLAY` zone into the garbage
  pile; `isDeath(event)` is that test, and it is Magic's own definition
  (rule 700.4: *"dies means 'is put into a garbage from the
  battlefield'"*). Three questions answer themselves as a result: a
  **bounce** (play → hand) leaves play without dying, an **exile** (play →
  some other `REMOVED` zone) likewise — which is precisely why
  removal-by-exile dodges death triggers — and a **discard** reaches the
  garbage having never been in play, so it is not a death either.
  `character:destroyed` stays as the *annotated* view of the same
  transition, carrying the `reason` and the gauge writes a bare move
  cannot: listen to the zone change for the fact, the destruction for the
  forensics. Guarded by `test/zones.test.ts`.
- ✅ **Zones are declared per game as data, not code.** The engine ships
  `play` and `garbage`; a card game declares `library`, `hand`, `discard`,
  `exile`. A declaration carries:

  | Field | Meaning |
  | --- | --- |
  | `ordered` | Position matters (a library) vs. a bag (a hand). Ordered zones support top/bottom/nth addressing. |
  | `visibility` | `public` / `owner` / `hidden` — who may see the contents. |
  | `scope` | One shared zone, or one **per player** (`hand` is per player). |
  | `targetable` | Whether `validTargets` draws from it. Only `play`, by default. |

- ✅ **Visibility is a first-class zone property, and changing it is an
  action.** A hand is `owner`-visible; a library is `hidden` *even from its
  owner* (its order is secret but real). "Reveal" is then either a move to a
  public zone or a visibility change on a zone — and because it is an action,
  *"whenever a card is revealed"* is writable content. Visibility is also
  what makes networked play possible without trusting the client.
- ✅ **Temporary zones ("piles") are created by a resolving effect and scoped
  to it.** An effect may conjure named piles, move entities through them, and
  the engine collects them when the effect finishes. A state-based action
  asserts a collected pile is **empty** — a card stranded in a dead pile is a
  content bug, and it should fail loudly rather than vanish.
- ✅ **The host protocol generalizes from targeting to choices, and gains a
  chooser.** `GameHost.requestTargets(request) → { targets: Character[] }`
  cannot express "an *opponent* separates these into two piles" — it has no
  notion of *who answers*. It becomes a choice protocol over entities:

  | Kind | Answer | Covers |
  | --- | --- | --- |
  | `select` | n of m entities | targeting, "discard two cards", "sacrifice a creature" |
  | `partition` | m entities → k groups | Fact or Fiction, surveil |
  | `order` | a permutation | scry, "put them back in any order" |
  | `distribute` | n spread over m entities | "divide 4 damage as you choose" |

  **Targeting is the degenerate case** (`select` with a `TargetPattern`), so
  `TargetingRequest` becomes one shape of `ChoiceRequest` and `validTargets`
  keeps its role as the legality filter.

### The chooser is per **request**, not per object or per session

Fact or Fiction is the proof: one resolving spell asks three questions with
two different choosers — reveal (nobody chooses), *an opponent* partitions,
then *the controller* selects a pile. So `chooser` is a required field on
each request and changes within a single resolution. Nothing in the engine
may default it, and no interface named for one chooser ("the active
chooser") can be right: the active player is frequently not the one being
asked.

### Simultaneity is a second axis, not a fifth kind

A round of choices has a **shape** as well as a kind — how many choosers are
asked at once, and whether their answers are hidden until everyone commits:

| Shape | Means | Example |
| --- | --- | --- |
| `single` | one chooser, one question | targeting; each step of Fact or Fiction |
| `sequential` | several choosers in APNAP order, each seeing the earlier answers | Magic's default for "each player sacrifices a creature" |
| `hidden-simultaneous` | several choosers at once, nothing revealed until **all** have locked in, then all revealed together | "each player discards a card face down, then reveal" |

`hidden-simultaneous` is the one that cannot be built out of the others: the
point is that no chooser may see another's answer before committing, which
is a property of the *protocol*, not of the question. So the unit the host
answers is a **round** of requests plus a shape, not a single request:

```typescript
interface ChoiceRound {
  readonly shape: 'single' | 'sequential' | 'hidden-simultaneous';
  readonly requests: readonly ChoiceRequest[];   // one per chooser
}

interface ChoiceHost {
  requestChoices(round: ChoiceRound): Promise<ChoiceAnswer[]>;
}
```

**The commit-reveal primitive already exists.** `commitSecret` /
`verifyCommit` in [seed.ts](../../src/engine/seed.ts) and the
`commitSeed`/`revealSeed` hooks on [Player](../../src/engine/player.ts) are
the seed ceremony: every player hands over a hash first, and only once all
commits are in does anyone reveal — "so no player can pick its contribution
after seeing the others'". That is exactly the guarantee a hidden
simultaneous choice needs, and it is the machinery a networked
`hidden-simultaneous` round should reuse rather than reinvent. A local host
can skip the hashing and simply not look.

### Status: shipped (`select` + `confirm`)

`src/engine/choice.ts` holds the protocol, and **`Player.choose(request)`**
is the whole of it — the chooser is a player, so the player answers; there
is no intermediary interface. The base implementation (`autoChoose`) takes
the fewest targets a request allows and says **yes** to a confirm, so
existing players need no implementation and a game overrides `choose` only
where the decision matters.

Two kinds ship: `select` (n of m characters — targeting *is* this request)
and `confirm` (yes/no — the `you may`). `partition`, `order` and
`distribute` are additions to that union, not changes to it.

Routing and validation are the engine's (`GameEngine.#ask`): a request's
`chooser` answers it, and only a decision **nobody owns** falls back to
`EngineOptions.chooser`, which speaks the same protocol — there is no
second interface. **`GameHost` is deleted.** The only decisions nobody owns
are those of a character registered without a player, which happens in
tests and scripted battles; a real game never produces one, because every
character has a controller. `AutoChooser` is the default and
`ScriptedChooser` replaces `QueueHost`. Validation lives in one place (`validateAnswer`) so
every path is held to the same rules, including a remote client that
answers outside the options it was offered.

`ScriptedPlayer` no longer keeps a private `AutoHost` to pick its own
targets — it calls its own `choose`. That awkwardness was the design
hinting where the method belonged.

**Priority is a capability, not a service.** `PriorityOwner` (in
`src/games/cards/stack.ts`) is an interface a `Player` implements —
`takePriority(request)` — and a player that does not implement it passes,
so a scripted or AI opponent needs no code. `runPriority` no longer takes a
host; it asks each player for itself. It lives in the card game rather than
on `Player` because priority is a card-game concept the engine has no
opinion about.

Still ahead: the three remaining kinds, the `hidden-simultaneous` shape,
and folding priority into `ChoiceRequest` — "act or pass" answers with a
stack object rather than a selection, so that needs a third request kind,
not a rename.

### Naming

The resolution: **there is no host.** Asking a player to decide is a method
on the player — `Player.choose` for choices, `PriorityOwner.takePriority`
for priority — so no intermediary needs a name, and the question of whether
"host" or "chooser" or "owner" was the right noun for it does not arise.
What remains:

- **`ChoiceRequest.chooser: Player`** — who is deciding. Required, never
  implied, and free to differ between two requests of one resolution.
- **`EngineOptions.chooser: Chooser`** — the answer of last resort for a
  decision nobody owns. Same protocol, not a parallel one.

## Worked example — Fact or Fiction

The design's stress test: *"Reveal the top five cards of your library. An
opponent separates those cards into two piles. Put one pile into your hand and
the other into your garbage."* It needs **no card-game-specific engine
code** — only the slice above.

| Step | Mechanism |
| --- | --- |
| Reveal the top five | `move` (a list, batched) from `library` to a **temporary public pile** |
| An opponent separates them into two piles | A `partition` choice whose **chooser is not the controller**; the two groups become two temporary piles |
| Put one pile into your hand | A `select` choice over the piles, chooser = controller; then `move(pile.contents → hand)` |
| The other into your garbage | `move(other.contents → garbage)` |
| The piles cease to exist | Effect scope ends; the empty-pile SBA verifies nothing leaked |

Everything a player sees along the way — the reveal, each move — is an event,
so the whole card can be logged, replayed, and networked with no extra work.

## Extended vocabulary — the three extension points

"Let games plug in their own vocabulary" is three separate changes with very
different risk. They should not ship together.

- ✅ **`DeclaredFn` node kinds → a registry.** Do this one.
  [`execution/declared-fn/index.ts`](../../src/ir/declared-fn/index.ts)
  is already a registry in all but name — its own doc note says the category
  files "know nothing about each other", and they take `evaluate` as a
  parameter. It is one `switch` away from `kind → evaluator` lookup, and it is
  the natural home for game-specific nouns (a `zone` node, a `pile` node).
  The care goes into **typing**: `DeclaredFn<Input, Output>` is a closed union
  today, and an open one must not regress the narrowing and autocomplete that
  [GOAL.md](../GOAL.md) makes priority #2 — so the union is keyed on a
  registry type parameter rather than widened to `any`.
- ⏳ **The `Action` union stays closed for now.** It is switched on in half a
  dozen places in `engine.ts`, and the pipeline's guarantees — gauge
  batching, win/lose-before-events, the destroy phase, the SBA loop — are
  stated *in terms of the known action kinds*. A plugin action that supplied
  only an applier would break those invariants silently. If it is opened
  later, a plugin action must declare **which phase it settles in**, not just
  what it does.
- ✅ **English vocabulary extends per game.**
  [`vocabulary.ts`](../../src/english/vocabulary.ts) is already table-driven;
  a game contributes words and sentence templates that compile to its
  registered `DeclaredFn` nodes.

The thread: most of what looks like "we need plugins" is "we need zones done
properly". Declaring zones as data (above) covers the bulk of a card game's
extra vocabulary **without** opening the action pipeline at all.

## Open

- 🔶 **How heavy is an entity in a hidden zone?** A `Character` carries
  gauges, a status list and derived stats. Thirty cards in a library should
  not each carry a live gauge set. Proposal: an entity holds a **definition**
  plus identity, and the character form (gauges, statuses) is realized on the
  move into `play` and torn down on the way out — with the open question of
  what persists across a round trip (hand → play → hand). The transform
  stack's "skill state survives a form round-trip" rule
  ([01-entities](01-entities.md)) is the precedent to follow.
- 🔶 **Ordered-zone vocabulary** — how content addresses top/bottom/nth, and
  whether `shuffle` is an action (it is a state change that a replacement
  effect could plausibly want to see) or a zone operation.
- 🔶 **Who may see a zone's order.** A library is hidden but ordered; the
  engine must not leak that order to a client that should not have it. This is
  the same question as fog of war, and it should be answered once.
- 🔶 **`countsForDefeat` across zones** — a character that *leaves* play
  without dying (bounced to hand). Proposal: defeat counts entities in `play`,
  so leaving play is neutral and only the garbage is death.
- ✅ **The stack and priority now exist** (`src/games/cards/stack.ts`),
  reversing [08-countering](08-countering.md)'s time-based decision for the
  card game. Casting is a `move` `hand → stack`; resolving is `stack →
  active`, run, then `active → play | garbage`; `counter` takes an object
  off the stack to the garbage, and an object whose every target became
  illegal **fizzles** (Magic's "countered on resolution"). `runPriority` is
  the round-robin: whoever adds to the stack keeps priority, all passing in
  succession resolves the top object, all passing on an empty stack ends
  the window. Guarded by `test/stack-priority.test.ts`, the counterspell
  case included.

  **Abilities are stack objects too.** `StackObject` is a union: a
  `SpellObject` carries a card and moves `hand → stack → active →
  play|garbage`; an `AbilityStackObject` carries an `AbilityObject` (an
  `Entity` with `type: 'ability'`), is **placed** on the stack rather than
  moved there, and **ceases to exist** on resolution instead of going to a
  zone — which is what Magic does with it, and why `destination` belongs
  to spells only. Its `source` permanent stays in play, so an ability
  resolves even after its source has been destroyed (tested), and its
  actions are attributed to that permanent rather than to the ability
  object (a non-character entity is not an `EventSource`).

  **Timing is in.** `CastSpeed` is `'instant' | 'sorcery'`, and `canPut`
  enforces rule 307.1: a sorcery needs its controller's own main phase and
  an **empty stack**, so it can never be a response; an instant needs only
  priority. Omitting a speed means `'sorcery'` — the restrictive default,
  so an omission cannot accidentally grant instant speed. A host that
  offers an illegal play gets a thrown error naming why, the way
  `engine.useAbility` already does for out-of-pattern targets, rather than
  a silent no-op. Triggered abilities obey neither speed: `queueTriggered`
  + `flushTriggered` put them on the stack before anyone receives
  priority, in APNAP order (rule 603.3), and a newly stacked trigger
  resets the pass count so everyone may respond to it.

  **Triggers are respondable to, and scheduling is interchangeable.**
  `TriggerStack` keeps a trigger's registry, its `when` gate and its
  execution; what order triggers run in and *when* is a
  `TriggerScheduler` (`src/engine/trigger-scheduler.ts`). A scheduler is
  handed the **whole group** one event made ready, in registration order,
  so it can order them — which a per-trigger sink could not — and it owns
  when they run. `ReadyTrigger.run()` does exactly what the engine would
  have done (targeting, cast, source attribution), so no scheduler
  reimplements trigger execution.

  `CardStack.scheduler()` is the card game's: wire it with
  `new GameEngine({ scheduler: stack.scheduler() })` and a triggered
  ability goes on the stack at the next priority window instead of
  resolving the instant it fires — where it can be **countered before it
  ever runs** (tested). A trigger whose owner has **no controller** has no
  player to hold priority, so it keeps the default behaviour and runs when
  the engine drains. Omit the option entirely and everything runs
  immediately, which is what the turn-based game wants.

  Known gap: a deferred trigger chooses its targets when it **runs**, not
  when it goes on the stack, so it cannot fizzle from its targets becoming
  illegal while it waits. Magic chooses them on announcement.

  **Passing priority is explicit.** `requestPriority` returns a
  `PriorityResponse` — `PASS` or `put(object)` — not an object-or-
  `undefined`. A bare `undefined` conflates "I choose to pass" (a game
  state) with "my host is broken or forgot to return" (a bug); naming the
  pass keeps them apart, the same reason the engine's events carry no
  optional properties and come in versions instead.

  Not covered: **costs** (no mana, no tapping — `canPut` answers "is this
  the right time", not "can I afford it"), and the `PriorityHost`
  interface, which is a stopgap that should fold into slice 2's choice
  protocol rather than live beside it.

## Engine implications

- **`zone.ts` (new)** — `Zone` (ordered/unordered, visibility, scope,
  `targetable`), a `ZoneRegistry` on the engine, per-player zone resolution,
  and temporary-zone creation scoped to a resolving effect.
- **`entity.ts` (new)** — the `Entity` base: identity, definition, current
  zone. `Character` becomes an entity with gauges and statuses; `EventSource`
  widens.
- **`actions.ts`** — a `MoveAction` (entities, from, to, position, reason);
  `destroy` reimplemented as a move to the garbage, keeping its event and
  reason vocabulary.
- **`engine.ts`** — `#characters`/`#garbage` give way to the zone registry;
  `apply` gains move batching alongside gauge batching; `validTargets` draws
  from `targetable` zones; a new SBA step verifies collected temporary zones
  are empty.
- **`events.ts`** — `zone:changed` and `zone:changed:batch`;
  `character:destroyed` becomes a reason on a move to the garbage rather
  than an independent path.
- **`restrictions.ts`** — a new `on: 'move'` restriction kind.
- **`host.ts`** — `GameHost.requestTargets` generalizes to
  `requestChoice(request)` with a **chooser** and the four choice kinds;
  `TargetingRequest` becomes a `select` request. `AutoHost`/`QueueHost` grow
  answers for the new kinds.
- **`ability/types.ts`** — `AttemptContext` gains the `ability` making the
  attempt (the card game's taunt works around its absence today by comparing
  `TargetPattern` identity — see `examples/card-game/README.md` gap #4).
- **`execution/declared-fn/index.ts`** — `kind → evaluator` registry, keyed so
  narrowing survives.

## Implementation plan

Five slices, each shippable and testable on its own. 1–3 are what make the
card game real; 4 is cheap and self-contained; 5 may never be needed.

1. **Entities, zones, and `move`** — with `destroy`/`garbage` rebuilt on
   top. The whole existing suite is the regression test: it must stay green
   without changes to its expectations.

   **Status: part done.** Shipped: `src/engine/zone.ts` (`Zone`,
   `ZoneRegistry`, declarations as data, per-player instances, ordered
   top/bottom addressing, `capacity`, `group` families); the engine's
   `#characters`/`#garbage` sets replaced by the registry, so `play` and
   `garbage` are ordinary declared zones; `zone:changed` /
   `zone:changed:batch` events; `engine.moveTo` and `engine.zones`; the
   card game's zones declared as data in `examples/card-game/zones.ts`.
   `destroy` now moves to the garbage through the registry and announces
   the transition (observed as damage → left play → died; the three
   event-sequence assertions in `test/triggered-actions.test.ts` grew the
   new events, no other expectation changed). Covered by
   `test/zones.test.ts`.

   **`move` is now an `Action`.** `MoveAction` is in the `Action` union and
   `engine.moveTo` is sugar over `apply([move(...)])`, so a move passes the
   whole pipeline: an `ActionTransformer` can redirect it (*"if it would go
   to your garbage, suspend it instead"* — tested), an `on: 'move'`
   restriction can block it outright, moves batch into one
   `zone:changed:batch`, and the destroy phase's garbage move is the same
   transition. `validTargets` now reads `targetable` off the zone instead
   of hard-coding a garbage check, and `isInPlay` is a zone-**family**
   question (`group === IN_PLAY`) rather than "registered and not dead" —
   so a bounced entity is out of the target pool without being dead.
   Defeat still counts the garbage, so **leaving play is neutral for
   win/lose**: a hero card in hand has not lost.

   **`Entity` now exists, as an interface.** `Entity` is `{ type, name }` —
   identity plus a discriminant, nothing more. Zones hold `Entity`;
   `Character` is the entity kind that has gauges and statuses
   (`type: 'character'`), and the engine narrows with
   `entitiesOf('character')` wherever its own rules walk a zone. That is
   the correction behind the interface: **gauges are a component of
   hero-ish cards, not a property every entity has**, so an ability object
   can sit on the stack without pretending to have hit points.
   `MoveAction.target` widened to `Entity` too, and the restriction gate
   and transformer pass simply skip a non-character target — it carries no
   statuses, so there is nothing to gate or transform through. New engine
   verbs: `addEntity` (first placement — announces the no-`from` version of
   `zone:changed`) and `removeEntity` (ceases to exist; no event, since
   that event names a destination).

   **Still open in this slice:**
   - The full identity/form extraction this doc describes — a card
     *realizing* a character form on the move into play, and what persists
     across a hand → play → hand round trip — is untouched. The `Entity`
     interface is the narrow slice that unblocks zones, not that model.
   - **Gauge values are live only in play.** Entering an `IN_PLAY` zone
     from anywhere else **realizes** a character's gauges — maxima
     re-derived, current set to max — silently, the way registration is
     silent, because arriving in play is setup rather than healing. So a
     card bounced to hand and replayed comes back **fresh**, and a revive
     from the garbage arrives at full. `registerCharacter` does *not*
     realize, since it is a placement rather than a move: a character
     constructed with a half-spent mana pool keeps it. A value is still
     *readable* out of play (post-death inspection works), it is simply
     not maintained there.
   - Still open: the **allocation** half. A `Character` in a deck still
     constructs its `Gauge` instances up front; not paying for them at all
     needs lazily realized gauges, which is a separate change from the
     semantics above.
   - **`destroy` still owns its phase.** Its garbage transition goes
     through the registry and announces `zone:changed`, but the deferral,
     the simultaneous-death batching and the `reason` vocabulary remain a
     dedicated path rather than a plain `move`. That is deliberate — the
     phase is what makes simultaneous deaths resolve together.
2. **The choice protocol** — chooser plus `select`/`partition`/`order`/
   `distribute`; targeting reimplemented as `select`.
3. **Per-game zone declarations** — the card game drops `zones.ts` and its
   piles become engine zones. Fact or Fiction becomes writable content, and
   is the acceptance test for slices 1–3.
4. **The `DeclaredFn` node registry** — plus the English vocabulary hook.
5. **Open the `Action` union** — only if something is genuinely left over
   after 1–4, and only with phase declarations.
