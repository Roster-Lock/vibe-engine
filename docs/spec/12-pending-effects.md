# 12 — Pending Effects: the Time Subsystem

> Slice 8. Charge-ups, channels, stun, timers, and countdown win/lose —
> everything that should happen "later". The deep design lives in
> [`docs/design/10-pending-effects.md`](../design/10-pending-effects.md);
> this doc is the build spec.

## 1. The thesis

Counterplay is **time-based, not stack-based**. The engine creates reaction
windows instead of priority windows, and the pending-effects registry is the
*time subsystem*: a deterministic scheduler that holds everything that
should happen "later", ticks it at round boundaries, and lets ordinary game
actions reach in and cancel it.

| Rung | Counterable? | Why |
| --- | --- | --- |
| **Instant** (normal action) | No | Resolves immediately — no window exists. Fast spells trade counterability for immediacy. |
| **Charge** | Yes — N rounds of warning | Resolves at a deadline; defenders act during the window. |
| **Channel** | Yes — and the caster is locked | Re-fires each round; anyone can stop it mid-stream. |

Everything is built from the existing pieces (actions, transformers,
triggers, statuses, the SBA pass) — nothing replaces them.

## 2. The registry and its entries

One registry lives on the engine. It is **game state**: mutated only by
actions, read by triggers and the UI, serialized/compared like any other
state (same seed + same state ⇒ same outcome).

```ts
interface PendingEffect {
  id: string;                      // monotonic per game ("pe:1", …) — deterministic
  kind: 'charge' | 'channel' | 'timer' | 'countdown' | 'delayed';
  owner: Character | null;         // null = battlefield object (trap/bomb) — no caster
  sourceAbilityId: string;         // UI name + tags ("Goblin is charging Fireball")
  targets: TargetSnapshot[];       // frozen at creation (see §4); a snapshot
                                   // is a character reference plus whatever the
                                   // ability needs at resolution
                                   // (type: { character: Character; … })
  style: 'countdown' | 'expiry';   // how time runs (below)
  ticks?: number;                  // countdown style: remaining ticks
  expiresAtRound?: number;         // expiry style: removed at end of round N
  tickPhase: 'round-start' | 'round-end';
  concentration: boolean;          // stun cancels these (charges + channels)
  removable: boolean;              // false ⇒ remove/cancel are no-ops (like `removable: false` buffs)
  visible: boolean;                // default true — the UI renders it
  tags: string[];                  // 'fire', 'spell', 'summon', …
  params: Record<string, JsonValue>; // ability parameters snapshot (amounts, ids)
  createdAt: { round: number; phase: 'round-start' | 'round-end'; order: number };
}
```

Two ways time runs, chosen per entry (`style`):

- **`countdown`** — `ticks` decrements at every occurrence of `tickPhase`;
  at 0 the entry **resolves** (fires its resolution actions, emits
  `pending:resolved`, and is removed). Used by charges, channels, countdown
  win/lose, and "in N rounds" delayed effects.
- **`expiry`** — the entry simply ends at `expiresAtRound` (removed at that
  round's `tickPhase`, emitting `pending:cancelled` with reason `'expired'`
  or a `pending:removed`). Used by status durations (stun), summon timers,
  transform duration, and "after N rounds" delayed effects.

Countdowns are *deadlines*; expiries are *durations*. Default phase table:

| Entry | style | tickPhase | Why |
| --- | --- | --- | --- |
| charge | countdown | **round-start** | A deadline: "at dawn of round N, Fireball lands" — before moves, before `turn:start`. |
| channel wave | countdown | **round-end** | "Ongoing rain": the first wave lands at the end of the cast round. |
| countdown win/lose | countdown | **round-start** | Deadline (supersedes the earlier "ticks on turn:end" note). |
| stun / buff duration | expiry | **round-end** | A 1-round stun means you skip your next round of moves. |
| summon timer | expiry | **round-end** | The summon fights N full rounds, then expires through the destroy path. |
| transform duration | expiry | **round-end** | The form holds for N full rounds. |

**Time granularity**: rounds are the only time unit — no wall-clock, no
sub-round ticks. Ticking is a pure function of (state, round counter),
consuming **no RNG**.

### The action

Add, remove, and cancel are the three modes of **one new action kind**,
mirroring `addBuff` / `removeBuff`:

```ts
{ type: 'pendingEffect', mode: 'add' | 'remove' | 'cancel',
  entry?: Partial<PendingEffect>,   // add — id assigned by the engine
  entryId?: string,                 // remove — one entry, by id
  owner?: Character,                // cancel — batch, on this character
  filter?: { tags?: string[] },     // cancel — optional narrowing (default: all)
  reason?: RemovalReason,           // cancel — stamped on every pending:cancelled
  source?: EventSource, direction?: ActionDirection }
```

- **`remove`** takes one entry by id.
- **`cancel`** is the *batch* form: cancels every `concentration` entry on
  `owner` matching `filter`, each emitting `pending:cancelled` with
  `reason`. This is the **"cancel concentration" primitive — deliberately a
  separate action from any status that happens to trigger it** (stun *fires*
  it; it is not stun).
- `remove`/`cancel` respect `removable: false` — a shielded entry survives
  dispels *and* stun-cancels. **Lifecycle cancellations** (death,
  control-swap, transform, game end) ignore `removable`.

Sugar: `charge(owner, spec)`, `channel(owner, spec)`, `setTimer(owner,
spec)`, `removePendingEffect(entryOrId)`, `cancelConcentration(owner,
reason?)`. Because it is an action it flows through the **transformation
pipeline** like everything else — outgoing transformers on the creator and
incoming on the entry's owner can modify it (e.g. *Swift Casting* rewrites
`entry.ticks` down on `mode: 'add'`).

### Resolution mechanics

When a countdown hits 0, the engine:

1. emits `pending:resolved` (payload: entry, owner, cause);
2. applies the entry's resolution actions **as one batch** with `source =
   the owner`, through the normal pipeline — outgoing transformers on the
   owner (spellpower, empower) and incoming on each target apply **at
   resolution time, against current state**;
3. removes the entry;
4. runs the SBA pass (win/lose first) — the game can end between entries.

What "the resolution actions" are: the **ability defines them**. The entry
stores `sourceAbilityId` + `params` + the frozen `targets`; resolution
re-invokes the ability's declared `resolve` block — a pure function of
(ctx, targeting) that reads state at resolution and returns actions.

**Targets are frozen at cast** and validated **per-target** at resolution:
each snapshot target no longer in play is dropped individually; if no valid
targets remain the entry is removed without effect (a fizzle). Killing the
targets is therefore a counter — for multi-target charges you must kill all
of them (or the caster).

## 3. The round skeleton

Two tick points per round, hooked into the existing turn hooks. **Ticking
is an SBA-like step and runs before the corresponding turn event.**

```
ROUND R
  START (engine.startTurn):
    1. tick pending effects with tickPhase 'round-start'
       - decrement countdowns; due entries resolve in order (below),
         SBA pass after each
    2. emit 'turn:start'                         (existing — auras, regens)
    3. collect decisions; sort by speed (ties: seeded, as today)
  MOVES:
    4. each decision executes in order
       - the canAct gate (§6) is consulted at execution; SBA pass after each move
  END (engine.endTurn):
    5. tick pending effects with tickPhase 'round-end'
       - channel waves fire, expiries end, resolutions apply, SBA pass
    6. emit 'turn:end'                            (existing)
    7. next round
```

### Resolution order within a tick

Due entries resolve in **descending owner speed** (initiative flavor — the
fastest caster's spell lands first), ties broken by **insertion order**
(entry id). Insertion order — not another seeded shuffle — keeps resolution
order stable and guessable by content authors, and consumes no RNG.

### The snapshot rule (anti-infinite-loop)

At the start of a tick, the due set is **snapshotted**. Entries created
during a tick — by a trigger reacting to that tick's events — are **not due
until the next occurrence of their phase**. Combined with the trigger
shuffle and the max-action-depth guard (100), no charge→resolve→charge chain
can spiral inside one tick. A hard per-owner entry cap (e.g. 32) is a cheap
safety valve; create is refused beyond it.

## 4. Charge-up

A **charge** is an ability that doesn't resolve on use: it charges for N
rounds, then resolves.

```ts
const fireball = cast({
  name: 'Fireball',
  targeting: { who: 'enemy' },
  charge: { rounds: 2 },                       // ← the charge keyword
  cast: (ctx, t) => [ /* immediate cast effects, if any */ ],
  resolve: (ctx, t) => [damage(t.targets[0]!, 30, ctx.self)],  // ← lands later
});
```

Semantics:

- **Using the ability runs `cast` immediately** (costs, cooldowns, flavor)
  and registers one pending entry: countdown, `ticks: 2`, `tickPhase:
  'round-start'`, `concentration: true`, `removable: true`, `visible: true`.
  Cast in round R, it resolves at the **start of round R+2, before moves**
  (before `turn:start`). Reaction windows: every move of rounds R (after
  the caster's own) through R+1.
- **Targets are chosen at cast and frozen** — "Goblin is charging Fireball
  at *you* — 2 rounds". Effects are computed at resolution through the
  pipeline, so later buffs/transformers apply (an enrage mid-charge
  empowers the landing).
- **The caster is free while charging.** Charges do not lock the caster,
  need no upkeep, and persist across turns without acting. Several charges
  may be held at once (each a separate entry; no merging by default).
  Starting a charge is an act: blocked while stunned or channeling.
- **What interrupts a charge**: stun, death, control-swap, transform,
  dispel, game end. **Damage does not interrupt by default** — charges are
  reliable once up; only stun/dispel/kill pop the balloon. An explicit
  `fragile` flag (damage cancels) is a future content option, not the
  default.
- **Dead target at resolution** ⇒ that target is dropped; all targets dead
  ⇒ fizzle, no effect. Killing the target is a legitimate counter.
- **Balloon pop** — dispelling a charge wastes the rounds spent charging;
  the fizzle is the reward. Cancellation emits `pending:cancelled` with the
  reason. No refund by default.

## 5. Channeled actions

A **channel** re-fires each round (Rain of Fire waves) until it ends or is
interrupted.

```ts
const rainOfFire = cast({
  name: 'Rain of Fire',
  targeting: { who: 'enemy' },
  channel: { waves: 3 },                       // ← the channel keyword
  cast: (ctx, t) => [ /* initial wave, or nothing */ ],
  perWave: (ctx, t) => [ /* AoE damage */ ],
});
```

Semantics:

- **Waves are scheduled on the round-end tick**, with the first wave
  landing at the end of the cast round. A 3-wave channel cast in round R
  fires at the end of R, R+1, R+2 and ends at the end of R+2. Each wave is
  batched and pipelined like any resolution, with the SBA pass after it.
- **The channeler cannot act while channeling.** The channel's cast
  consumed round R's action; the owner is locked (canAct gate, §6) for
  rounds R+1 … R+N−1 and is free the round after the final wave. A
  `free: true` variant is a flagged extension, not the default.
- **Interrupts are the same as charges**: stun, death, control-swap,
  transform, dispel, abandonment, game end. A stun mid-round cancels the
  channel immediately — including the wave scheduled for that round's end.
- **No stacking, no merging** — one channel per owner at a time (the lock
  enforces it naturally).

## 6. Stun — two primitives, composed

Stun is **not one built-in rule**. It composes two independent primitives:

1. **`blocksActing`** — a status-level flag. A buff (or skill) with
   `blocksActing: true` contributes to the character's `canAct` gate,
   consulted by decision execution and `useAbility`. It blocks moves **and
   prompt-triggered abilities** (both are player choices). **Auto triggers
   still fire** — the body still reacts (passives, thorns, second winds);
   only *choices* are suppressed. A `hard: true` flag (auto triggers
   suppressed too) is a possible variant. The **channel lock** feeds the
   same gate — one query, several contributors.
2. **`cancelConcentration`** — the batch cancel action from §2. Cancelling
   the owner's charges and channels is a **separate action** from blocking
   acting; stun merely *fires* it. Either tooth pairs with anything:

```ts
stun({ rounds: 1 })   // blocksActing + duration + onApply → cancelConcentration(self, 'stun')
fear({ rounds: 2 })   // blocksActing only — victim keeps its charges, but can't act
disenchant({ })       // cancelConcentration only — pops charges/channels without locking
```

Timed entries (summon timers, transform duration, countdown win/lose) are
**not** touched by `cancelConcentration` — a stunned warlock's Doom keeps
ticking.

3. **Duration** — an expiry entry: applied during round R with duration D,
   active through the moves of round R+D, removed at that round's end tick.
   A 1-round stun means "skip your next round of moves".

Stacking and removal:

- **Re-application refreshes**: a second stun sets the expiry to
  `now + D`; durations never add.
- **Cleanse works**: `removeBuff` removes the stun like any buff, and the
  cancellation already done is **not** undone — cancellation is an
  apply-time effect, one-way. A cleansed stun does not resurrect charges.
- **Duration cap** recommended (e.g. stun duration clamps to 3 rounds);
  diminishing returns is a flagged extension.
- `removable: false` charges **survive stun**: `cancelConcentration`
  respects `removable`, so a shielded charge resists both dispel and
  stun-cancel — but still dies with its caster (death is a lifecycle
  cancellation, not an action).

## 7. Events and visibility

New events on the trigger bus (extend the `GameEvent` union), all carrying
the entry so triggers can filter by kind/tags/owner:

- `pending:added` — "Goblin begins charging Fireball (2 rounds)."
- `pending:ticked` — countdown UI updates ("1 round").
- `pending:resolved` — "Fireball lands!" (before its actions apply).
- `pending:cancelled` — "Goblin's Fireball fizzles!" (reason: stun /
  dispelled / death / control-swap / transform / abandoned / expired).

Because they are ordinary events, triggers can react to them with the usual
prestack filters and seeded-shuffled ordering.

**Visibility is public by default.** `visible: true` renders owner, ability
name, targets, countdown, kind — the defender always knows what's coming and
at whom. `visible: false` (traps) is a flagged extension; hidden entries
still emit events to triggers, just not to the UI. The UI also queries the
registry directly (`engine.pendingEffects`).

## 8. Cancellation & removal

| Trigger | Effect | Reason |
| --- | --- | --- |
| Stun applied | fires `cancelConcentration(self, 'stun')` — the stun *content's* `onApply`, not an engine rule | `stun` |
| Owner dies | cancels owner-keyed entries (incl. summon timers on a dead summon) | `death` |
| Control-swap | cancels `concentration` entries (mind-controlled caster loses the spell) | `control-swap` |
| Transform | cancels `concentration` entries (polymorph breaks casting; identity unchanged) | `transform` |
| `removePendingEffect` (dispel) | removes any entry with `removable: true` | `dispelled` |
| Countdown reaches 0 | resolves (fires actions, then removed) | `resolved` |
| Expiry passes | removed without firing | `expired` |
| Channel abandoned (manual flag) | removed | `abandoned` |
| Game ends | moot — the loop stops; SBA win/lose runs first at every phase | — |

Cancellation is **one-way**: nothing resurrects a cancelled charge, and
undoing the cause (cleansing the stun, ending the transform, swapping
control back) does not restore it. External cancellation (`remove`,
`cancel`) respects `removable: false`; lifecycle cancellations (death,
control-swap, transform, game end) ignore it.

## 9. Counterbalance guardrails

- **Full information.** Targets frozen at cast, countdowns public,
  resolution telegraphed. The tension is "I know what's coming and must do
  something about it" — a puzzle, not a gotcha.
- **Universal answers**: kill the **caster** (death cancels) — and where an
  entry has character **targets**, kill *all of them* (per-target
  validation; partial fizzle). The caster answer always exists.
- **Failure modes designed against**: stun-lock (refresh-not-add, cleanse,
  cap), uninteractive wins (countdown win/lose is visible, dispellable, the
  caster killable), helpless channeler (the lock is telegraphed and
  interruptible), fizzle feedback (`pending:cancelled` with a reason).

## 10. Key edge cases (rulings)

1. **Two charges due at the same tick** — resolve in owner-speed order,
   ties by insertion; SBA pass between entries; if the first ends the game,
   the rest never resolve.
2. **Owner dies mid-charge** — cancelled (`death`); owner-alive and
   target-validity are checked at resolution.
3. **Game ends during a charge** — SBA win/lose runs first at every phase.
4. **Determinism** — the registry is state; ticks only at the two round
   boundaries; no wall-clock; resolution order fixed (speed + insertion);
   no RNG consumed by ticking.
5. **No infinite loops** — the snapshot rule + max-action-depth guard (100)
   + the optional per-owner entry cap.
6. **Control-swap or transform mid-charge** — cancelled; not restored if the
   transform is later undone.
7. **Multiple charges at once** — allowed; separate entries; no merging.
8. **`ticks: 0` at creation** — refused (minimum 1); the snapshot rule
   means a created-now entry is never due this tick.
9. **Dispel during a resolution batch** — the due set is a snapshot; an
   entry dispelled earlier is skipped when reached (membership re-checked).
10. **Stun lands between channel waves** — channel cancelled; no further
    waves, including the one scheduled for the current round-end.
11. **Summon dies before its timer** — timer cancelled (`death`); no
    double-destroy.
12. **Countdown win/lose vs killing blow in the same batch** — both resolve
    at the win/lose layer of the SBA pass, first.
13. **Charge's target left play** — invalid targets dropped; none left ⇒
    fizzle.
14. **Cleanse after stun cancelled a charge** — cancellation stands
    (one-way).

## 11. Content shapes (DSL)

The builders grow optional blocks; the raw `pendingEffect` action remains
for exotic cases:

```ts
charge(owner, { abilityId: 'fireball', rounds: 2, targets: [...], resolve: (...) => [...] });
channel(owner, { abilityId: 'rain-of-fire', waves: 3, perWave: (...) => [...] });
setTimer(summon, { kind: 'timer', rounds: 3, resolve: (ctx) => [destroy(summon)] });
cancelConcentration(target, 'disenchant');
addBuff(target, stun({ rounds: 1 }));
```

The engine auto-creates the registry entry when an ability declares
`charge` / `channel` / `countdown`, so the common cases never hand-roll
`pendingEffect` actions.

## 12. Acceptance criteria (Slice 8)

1. A plain timer entry (expiry) added in round R ends at round R+D's
   round-end tick and emits its removal event; a countdown entry decrements
   at each occurrence of its phase and resolves at 0, firing
   `pending:resolved` before its actions apply.
2. A charge with `rounds: 2` cast in round R resolves at the **start** of
   round R+2, before moves and before `turn:start`; its target was frozen
   at cast, and its damage is computed through the pipeline at resolution.
3. Killing all of a charge's targets fizzles it (no effect); a multi-target
   charge with one target dead lands on the survivor.
4. A channel's waves fire at the end of the cast round and each subsequent
   round; the channeler's `canAct` gate is closed while channeling; a stun
   mid-channel cancels it (including the scheduled wave).
5. `stun({ rounds: 1 })` blocks the victim's moves and prompt triggers but
   **not** auto triggers; it fires `cancelConcentration(self, 'stun')`;
   re-applying refreshes the duration; cleansing removes it; a second stun
   does not add durations.
6. A `removable: false` charge resists dispel and stun-cancel but dies with
   its caster; a lifecycle cancellation (death, control-swap, transform)
   ignores `removable`.
7. Entries created during a tick are not due until the next occurrence of
   their phase (snapshot rule); two due charges resolve in owner-speed
   order with insertion-order ties; ticking consumes no RNG.
8. Same seed + same state ⇒ identical tick history (determinism test with
   concurrent charges/channels/stuns).
9. `pending:added` / `pending:ticked` / `pending:resolved` /
   `pending:cancelled` carry the entry, and triggers can filter on them.
