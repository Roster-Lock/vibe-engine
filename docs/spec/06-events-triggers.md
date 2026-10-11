# 06 — Events & the Trigger System

> Slice 4. How changes are announced, and how triggered abilities hear
> about them — deferred, seeded-shuffled, and bounded.

## 1. The event union

Every change the engine makes is announced as a **GameEvent**. Built today;
target-model additions marked.

```ts
type GameEvent =
  | { type: 'turn:start' }
  | { type: 'turn:end' }
  // Each event with optional facts comes in **versions** — one union member
  // per combination, all fields required. Narrow with `'target' in event` /
  // `'source' in event`, then the type narrows:
  //   if ('source' in event && event.source.type === 'buff') { … source is a Buff }
  | { type: 'gauge:changed';  gauge: Gauge; from: number; to: number }
  | { type: 'gauge:changed';  gauge: Gauge; from: number; to: number; source: EventSource }
  | { type: 'gauge:changed';  gauge: Gauge; target: Character; from: number; to: number }
  | { type: 'gauge:changed';  gauge: Gauge; target: Character; from: number; to: number; source: EventSource }
  | { type: 'gauge:changed:batch'; events: GaugeChangedEvent[] }
  | { type: 'gauge:maxChanged'; gauge: Gauge; from: number; to: number }
  | { type: 'gauge:maxChanged'; gauge: Gauge; from: number; to: number; source: EventSource }
  | { type: 'stat:changed'; character: Character; stat: string; from: number; to: number }
  | { type: 'stat:changed'; character: Character; stat: string; from: number; to: number; source: EventSource }
  | { type: 'buff:added';   character: Character; buff: Buff }
  | { type: 'buff:added';   character: Character; buff: Buff; source: EventSource }
  | { type: 'buff:destroyed'; character: Character; buff: Buff; reason: BuffDestroyReason }
  | { type: 'buff:destroyed'; character: Character; buff: Buff; reason: BuffDestroyReason; source: EventSource }
  | { type: 'buff:destroyed:batch'; events: BuffDestroyedEvent[] }
  | { type: 'cycle:detected'; grantor: Buff; attemptedId: string }
  // character:transformed versions by source (form always present):
  | { type: 'character:transformed'; character: Character; form: TransformForm; reason: 'pushed' | 'popped' }
  | { type: 'character:transformed'; character: Character; form: TransformForm; reason: 'pushed' | 'popped'; source: EventSource }
  | { type: 'character:transformed:batch'; events: CharacterTransformedEvent[] }
  // character:destroyed versions by reason × source (changes always present):
  | { type: 'character:destroyed'; character; reason: 'hp:current-reached-minimum'; changes: GaugeWrite[] }
  | { type: 'character:destroyed'; character; reason: 'hp:current-reached-minimum'; changes: GaugeWrite[]; source: EventSource }
  | { type: 'character:destroyed'; character; reason: 'hp:maximum-reached-0'; changes: GaugeWrite[]; maxChanges: GaugeMaxChange[] }
  | { type: 'character:destroyed'; character; reason: 'hp:maximum-reached-0'; changes: GaugeWrite[]; maxChanges: GaugeMaxChange[]; source: EventSource }
  | { type: 'character:destroyed'; character; reason: 'direct-action'; changes: GaugeWrite[] }
  | { type: 'character:destroyed'; character; reason: 'direct-action'; changes: GaugeWrite[]; source: EventSource }
  | { type: 'character:survived';  character; changes: GaugeWrite[] }
  | { type: 'character:destroyed:batch'; events: CharacterDestroyedEvent[] }
  | { type: 'character:survived:batch';  events: CharacterSurvivedEvent[] }
  | { type: 'ability:used'; character: Character; ability: Ability; targeting: Targeting }
  // target model:
  | { type: 'character:summoned'; character: Character; source?: EventSource }
  | { type: 'character:revived';  character: Character; source?: EventSource }
  | { type: 'character:controlChanged'; character: Character; from: Player; to: Player }
  | { type: 'pending:added' } | { type: 'pending:ticked' }
  | { type: 'pending:resolved' } | { type: 'pending:cancelled' }   // full shapes in 12
```

- **`EventSource = Character | Buff`** — who caused an event: a fighter, or
  a buff doing its thing.
- To add a brand-new event type, **extend the union** — a one-line,
  type-only change — and triggered abilities can listen to it.

## 2. Damage and healing are derived, not events

There is **no dedicated "damage" or "heal" event**. An HP change is a
`gauge:changed` event on the character's HP gauge. The helpers below turn
that one event into the vocabulary content cares about:

```ts
isGaugeChange(event)   // is it a gauge:changed?
isHpChange(event)      // gauge:changed on a character's HP gauge
isDamage(event)        // HP change that lost value (to < from)
isHeal(event)          // HP change that gained value (to > from)
amountOf(event)        // |to - from| of a gauge change, else 0
wasDealtBy(event, who) // isDamage && event.source is the character itself
wasTakenBy(event, who) // isDamage && the victim's own HP gauge dropped
```

(They also apply to the per-write `HpChange[]` on destroy/survived events —
those are shaped like `gauge:changed` events with the target attached.)

## 3. The trigger listener registry

- Every **triggered ability** on an attached status registers a **listener**
  with a **unique id** (assigned at registration, monotonically). One
  listener per (status, ability), keyed by the event type it subscribes to.
- `attachStatus(status, owner)` — called when a status is applied (buff
  added, character registered with skills); `detachStatus(status)` — called
  when the status leaves (buff removed, defeat cleanup, cascade).
- A trigger already collected still runs even if its status is removed
  while earlier queued triggers resolve (listeners are captured at
  collection time).

## 4. `emit` → enqueue → drain

**`emit(event)`** (called by the engine at every announcement):

1. the external **`onEvent` observer** (logging, UI) hears it immediately;
2. the matching trigger listeners are collected and **queued** — nothing
   runs inline.

**`enqueue(event)`** — the collection algorithm:

1. every listener of that event type whose **prestack filter** (`when`)
   passes joins the **prepare stack**;
2. the prepare stack is **sorted by listener id** (deterministic base
   order);
3. it is **shuffled with the seeded PRNG** ([02-seed.md](02-seed.md) §4) —
   no defined order, only reproducibility;
4. the shuffled listeners are **appended to the queue**, in that order.

**`drain()`** — runs the queue **after the current resolution unit
completes** (a move's `apply`, or a turn hook):

- one trigger at a time, **FIFO**; triggers queued while draining (by a
  trigger's own actions) are appended and run after the current ones;
- **nested applies never re-enter the drain** — a `#draining` flag ensures
  the queue only drains at the unit boundary;
- bounded by `maxRuns` (default 100): a trigger that endlessly re-queues
  itself throws a max-depth error instead of looping forever;
- **game-end short-circuits the drain**: if a settle ends the game, the
  throw skips the drain — queued death triggers never run at game end
  (win/lose-first, [09-sba-pass.md](09-sba-pass.md) §3).

Consequences (the point of deferral):

- every trigger sees its unit's **settled state** — a board wipe's death
  triggers run after all destructions and their events, not interleaved;
- a game-ending blow never runs its queued triggers.

## 5. Batch variants

Every `:batch` event carries just its individual events — the event list is
the payload (there is no separate `characters`/`buffs` list to keep in
sync):

- `gauge:changed:batch` — fires **once per gauge batch**, after the
  individual netted `gauge:changed` events, carrying them in first-touch
  order. The "whenever one or more gauges change" primitive — HP, mana, or
  any other gauge. Fires even for a single changed gauge.
- `character:destroyed:batch` — fires **once per settle** (one gauge batch
  + its destroy phase) instead of once per character, carrying the
  individual events in destruction order. Fires even for a single
  destruction. Symmetric: `character:survived:batch`. These are the
  "whenever one or more characters die / survive" primitives.
- `buff:destroyed:batch` — fires **once per apply** (a move, a trigger's
  actions), at the apply's end, carrying every `buff:destroyed` event the
  apply produced — direct `removeBuff` actions, the on-defeat cleanup, and
  the removal cascade — in the order they fired. Fires even for a single
  removal (Dismiss). The "whenever one or more buffs leave" primitive.
- `character:transformed:batch` — fires **once per apply**, at the apply's
  end, carrying every `character:transformed` event the apply produced —
  `transform` action pushes, buff-tied forms landing and leaving, and the
  form-stack SBA step's dangling-tie pops — in the order they fired. Fires
  even for a single form change. The "whenever one or more transformations
  happen" primitive.
- The individual `gauge:changed` / `character:destroyed` /
  `character:survived` / `buff:destroyed` / `character:transformed` events
  still fire for every gauge/character/buff/form change; triggers choose
  which to listen to.

## 6. Event payload details

**`character:transformed`** — a character's **form** changed:

- `reason: 'pushed'` — a `transform` action pushed a form onto the target's
  form stack; `form` is the pushed form ([03-actions.md](03-actions.md) §2.5).
- `reason: 'popped'` — a keying buff's removal popped the entry and reverted
  the form; `form` is the form that left ([04-character-status.md](04-character-status.md) §6).
- The numeric part of the change is *also* announced as `gauge:maxChanged`
  (the transformed base feeds the derived max); this event covers the whole
  swap — name/icon/skills included — and fires *before* that re-derivation.
- Every change of one `apply` is also summarized once as
  `character:transformed:batch` (§5) — the "whenever one or more
  transformations happen" primitive.

**`character:destroyed`** carries `reason` and the batch context:

- `reason: 'hp:current-reached-minimum'` — HP writes drove the gauge to
  `min`; `changes` lists every HP write in the batch (a death trigger can
  find the damage dealer(s) with `event.changes.filter(isDamage)`).
- `reason: 'hp:maximum-reached-0'` — a status drove the gauge's **derived
  max** to 0; `maxChanges` lists the max change the re-derivation produced.
- `reason: 'direct-action'` — a `destroy` action caused it; `source` names
  the destroyer.

**`character:survived`** — fires after a batch in which a character's **HP**
took a damaging write and is still standing — even when the net is zero
(damage and heal cancelled). `changes` lists every write with its own
`from`/`to`/`source`, so revenge-style triggers can filter the damage
dealers with `isDamage`.

```ts
type GaugeWrite = /* gauge:changed on a character's own gauge (HP or mana), with target */;
type GaugeMaxChange = /* gauge:maxChanged with target */;
```

**`stat:changed`** — a character's named (non-gauge) stat changed. The
`stat` field names it — `'speed'` or any custom stat (`'power'`,
`'toughness'`). `from`/`to` are the **effective** values (base plus every
attached contribution), so a contribution leaving reads as the revert to
the base. Fires when a `stat` contribution lands or leaves (a buff
added/removed or a form change — carrying the change's `source` when there
is one) and when a *function*-of-state stat re-derives at a settle (the
world changed — no single source, so the source-less version). Registration
is silent (setup semantics) and destroyed characters announce nothing; a
custom stat with no base that comes into or goes out of existence is not
announced — the grantor's own `buff:added`/`buff:destroyed` covers it.
Gauge maxes are **not** named stats: they keep announcing as
`gauge:maxChanged` (the max is read from the gauge, and a max driven to 0
can destroy the character).

## 7. Acceptance criteria (Slice 4)

1. An `auto` ability on `turn:start` with a passing `when` fires after
   `startTurn`'s emit completes; a failing `when` never fires.
2. Two triggers on the same event run in seeded-shuffled order — the same
   seed reproduces the same order, and every event in a unit is settled
   before the first trigger runs.
3. A board wipe (multiple destructions in one settle) fires
   `character:destroyed` per character **then** one
   `character:destroyed:batch`; death triggers see the full wipe.
4. A killing blow that ends the game fires no `character:destroyed` events
   and no queued triggers (win/lose-first).
5. A trigger that re-queues itself from its own actions throws the
   max-depth error (queue bound), not an infinite loop.
6. A trigger whose status is removed while earlier queued triggers resolve
   still runs (captured at collection).
7. `character:destroyed` carries the documented `reason` and the batch's
   HP writes (`changes`/`maxChanges`); `character:survived` fires even for
   a zero-net batch, with every write listed.
8. Helpers: `wasDealtBy`/`wasTakenBy`/`isDamage`/`isHeal` classify events
   correctly, including per-write `HpChange[]` entries.
9. Extending `GameEvent` with a new type lets a triggered ability listen to
   it (type-only change works).
10. A `stat` contribution landing/leaving emits `stat:changed` with the
    effective `from`/`to` and the status change's `source` when there is
    one; a world-driven re-derivation emits the source-less version;
    registration and destroyed characters stay silent.
