# 10 — Pending Effects: Registry, Charge, Channel, Stun

> Status: ✅ decided (the deep design deferred by [08-countering.md](08-countering.md)).

## 1. The thesis

Counterplay is **time-based, not stack-based**. The engine creates reaction
windows instead of priority windows, and the pending-effects registry is the
*time subsystem*: a deterministic scheduler that holds everything that should
happen "later", ticks it at round boundaries, and lets ordinary game actions
reach in and cancel it.

This gives one axis with three rungs — the counterability spectrum:

| Rung | Counterable? | Why |
| --- | --- | --- |
| **Instant** (normal action) | No | Resolves immediately — no window exists. This is the *point* of time-based counterplay: fast spells trade counterability for immediacy. |
| **Charge** | Yes — N rounds of warning | Resolves at a deadline; defenders act during the window. |
| **Channel** | Yes — and the caster is locked | Re-fires each round; anyone can stop it mid-stream. |

Everything below is built from the existing pieces (actions, transformers,
triggers, statuses, the SBA pass) — nothing replaces them.

## 2. The registry

One registry lives on the engine. It is **game state**: it is mutated only by
actions, read by triggers and the UI, and serialized/compared like any other
state (same seed + same state ⇒ same outcome).

### Entry shape

```ts
interface PendingEffect {
  id: string;                      // monotonic per game ("pe:1", …) — deterministic
  kind: 'charge' | 'channel' | 'timer' | 'countdown' | 'delayed';
  owner: Character | null;         // null = battlefield object (trap/bomb) — no caster
  sourceAbilityId: string;         // UI name + tags ("Goblin is charging Fireball")
  targets: TargetSnapshot[];       // frozen at creation (see §4)
  style: 'countdown' | 'expiry';   // how time runs (below)
  ticks?: number;                  // countdown style: remaining ticks
  expiresAtRound?: number;         // expiry style: removed at end of round N
  tickPhase: 'round-start' | 'round-end';
  concentration: boolean;          // stun cancels these (charges + channels)
  removable: boolean;              // false ⇒ remove/cancel are no-ops (like `removable:false` buffs)
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

Countdowns are *deadlines*; expiries are *durations*. The two phases and the
two styles compose independently — the defaults:

| Entry | style | tickPhase | Default phase rationale |
| --- | --- | --- | --- |
| charge | countdown | **round-start** | A deadline: "at dawn of round N, Fireball lands" — before moves, before `turn:start`. |
| channel wave | countdown | **round-end** | "Ongoing rain": the first wave lands at the end of the cast round; each wave lands after that round's moves. |
| countdown win/lose | countdown | **round-start** | Deadline (see §11 for the supersession of 03). |
| delayed "in N rounds" | countdown | **round-start** | Deadline. |
| stun / buff duration | expiry | **round-end** | "Hold you": a 1-round stun means you skip your next round of moves, removed at that round's end. |
| summon timer | expiry | **round-end** | The summon fights for N full rounds, then expires through the normal destroy path. |
| transform duration | expiry | **round-end** | The form holds for N full rounds. |
| delayed "after N rounds" | expiry | **round-end** | Elapses after N full rounds have passed. |

### Time granularity

Rounds are the only time unit. **No wall-clock, no sub-round ticks** — a
move is instantaneous; only the two round boundaries tick. This is what keeps
the registry deterministic: ticking is a pure function of (state, round
counter), consuming no RNG.

### The action

Add, remove, and cancel are the three modes of **one new action kind**,
mirroring `addBuff` / `removeBuff`:

```ts
{ type: 'pendingEffect', mode: 'add' | 'remove' | 'cancel',
  entry: Partial<PendingEffect>,   // add — id assigned by the engine
  entryId: string,                 // remove — one entry, by id
  owner?: Character,               // cancel — batch, on this character
  filter?: { tags?: string[] },    // cancel — optional narrowing (default: all)
  reason?: RemovalReason,          // cancel — stamped on every pending:cancelled
  source?: EventSource, direction?: ActionDirection }
```

- **`remove`** takes one entry by id.
- **`cancel`** is the *batch* form: it cancels every `concentration` entry on
  `owner` matching `filter` (all of them when no filter), each emitting
  `pending:cancelled` with `reason`. This is the **"cancel concentration"
  primitive — deliberately a separate action from any status that happens to
  trigger it** (see §6: stun *fires* it; it is not stun).
- `remove` and `cancel` both respect `removable: false` — a shielded entry
  survives dispels *and* stun-cancels. Lifecycle cancellations (death,
  control-swap, transform, game end) ignore `removable`.

Sugar: `charge(owner, spec)`, `channel(owner, spec)`, `setTimer(owner, spec)`,
`removePendingEffect(entryOrId)`, `cancelConcentration(owner, reason?)`.
Because it is an action it flows through the
**transformation pipeline** like everything else: outgoing transformers on the
creator and incoming on the entry's owner can modify it. Examples:

- *Swift Casting* (outgoing) — transformer that rewrites `entry.ticks` to
  `Math.max(1, ticks - 1)` on `mode: 'add'` charges: charges take one round
  less. (Speed does **not** accelerate charges by default — that's a
  transformer, not a rule.)
- *Counterspell Aura* (incoming) — transformer that rewrites `remove` actions
  targeting a shielded entry into a `removeBuff` no-op. Simpler sugar: the
  entry's `removable: false` flag already makes removal a no-op, exactly like
  `removable: false` buffs.

### Resolution mechanics

When a countdown hits 0, the engine:

1. emits `pending:resolved` (payload: entry, owner, cause),
2. applies the entry's resolution actions **as one batch** with `source =`
   the owner, through the normal pipeline — outgoing transformers on the
   owner (spellpower, empower) and incoming on each target apply **at
   resolution time, against current state**,
3. removes the entry,
4. runs the SBA pass (win/lose first, per [04-sba.md](04-sba.md)) — the game
   can end between entries.

What "the resolution actions" are: the **ability defines them**. The entry
stores `sourceAbilityId` + `params` + the frozen `targets`; resolution
re-invokes the ability's declared `resolve` block (see §12). The resolve block
must be a pure function of (ctx, targeting) — it reads state at resolution
and returns actions.

**Targets are frozen at cast** (§4) and validated **per-target** at
resolution: each snapshot target no longer in play is dropped individually;
if no valid targets remain the entry is removed without effect (a fizzle).
Killing the targets is therefore a counter — for multi-target charges you
must kill all of them (or the caster).

## 3. The round skeleton

Two tick points per round, hooked into the existing turn hooks. The engine's
standing rule — *state-based resolution before events* (a killing blow ends
the game before triggers fire) — extends to the registry: **ticking is an
SBA-like step and runs before the corresponding turn event.**

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

Due entries resolve in **descending owner speed** (initiative flavor —
the fastest caster's spell lands first), ties broken by **insertion order**
(entry id). Insertion order — not another seeded shuffle — keeps resolution
order stable and guessable by content authors, and consumes no RNG. (A seeded
tie-break would still be deterministic, but it makes *which* of two
simultaneous charges lands first depend on the seed; avoid.)

### The snapshot rule (anti-infinite-loop)

At the start of a tick, the due set is snapshotted. **Entries created during
a tick — by a trigger reacting to that tick's events — are not due until the
next occurrence of their phase.** Combined with the existing trigger-shuffle
and the max-action-depth guard (100), no charge→resolve→charge chain can
spiral inside one tick, and cross-round chains are just gameplay. A hard
per-owner entry cap (e.g. 32) is a cheap safety valve; create is refused
beyond it.

## 4. Charge-up

A **charge** is an ability that doesn't resolve on use: it charges for N
rounds, then resolves. Shape:

```ts
const fireball = cast({
  name: 'Fireball',
  targeting: { who: 'enemy' },
  cost: /* deferred — parked in the costs discussion */,
  charge: { rounds: 2 },                       // ← the charge keyword
  cast: (ctx, t) => [ /* immediate cast effects, if any */ ],
  resolve: (ctx, t) => [damage(t.targets[0]!, 30, ctx.self)],  // ← lands later
});
```

Semantics (decided):

- **Using the ability runs `cast` immediately** (costs, cooldowns, flavor)
  and registers one pending entry: countdown, `ticks: 2`, `tickPhase:
  'round-start'`, `concentration: true`, `removable: true`, `visible: true`.
  Cast in round R, it resolves at the **start of round R+2, before moves**
  (before the `turn:start` event). Reaction windows: every move of rounds R
  (after the caster's own) through R+1. The UI countdown reads 2, then 1,
  then it lands.
- **Targets are chosen at cast** and frozen — "Goblin is charging Fireball
  at *you* — 2 rounds" is the entire point. Effects are computed at
  resolution through the pipeline, so later buffs/transformers apply (an
  enrage mid-charge empowers the landing).
- **The caster is free while charging.** Charges do not lock the caster, do
  not require upkeep, and persist across turns without acting. A caster can
  hold several charges at once (including two of the same ability — each is a
  separate entry; no merging by default). Starting a charge is an act:
  blocked while stunned or channeling.
- **What interrupts a charge** (cancellation table, §8): stun, death,
  control-swap, transform, dispel, game end. **Damage does not interrupt by
  default** — charges are reliable once they're up; only stun/dispel/kill
  pop the balloon. An explicit `fragile` flag (damage cancels) is a future
  content option, not the default.
- **Dead target at resolution** ⇒ that target is dropped; all targets dead ⇒
  fizzle, no effect. Killing the target is a legitimate counter.
- **Balloon pop** — dispelling a charge wastes the rounds spent charging;
  the fizzle is the reward. Cancellation emits `pending:cancelled` with the
  reason, so content can pay the dispeller ("when you dispel a charge, draw
  a card"). No refund by default (the cost was already paid at cast); a
  `refund` flag is a possible extension.

## 5. Channeled actions

A **channel** re-fires each round (Rain of Fire waves) until it ends or is
interrupted. Shape:

```ts
const rainOfFire = cast({
  name: 'Rain of Fire',
  targeting: { who: 'enemy', include: [ground] },   // or a board target
  channel: { waves: 3 },                           // ← the channel keyword
  cast: (ctx, t) => [/* initial wave, or nothing */],
  perWave: (ctx, t) => [damageToAllEnemies(ctx, 10, ctx.self)],
});
```

Semantics (decided):

- **Waves are scheduled on the round-end tick**, with the first wave landing
  at the end of the cast round — "the rain starts now." A 3-wave channel
  cast in round R fires at the end of R, R+1, R+2 and ends at the end of R+2.
  Each wave is the `perWave` actions, batched and pipelined like any
  resolution, with the SBA pass after it.
- **The channeler cannot act while channeling.** The channel's cast consumed
  round R's action; the owner is locked (canAct gate, §6) for rounds R+1 …
  R+N−1 and is free the round after the final wave. This is the WC3-style
  concentration cost — channels are the *expensive* rung of the spectrum.
  A `free: true` variant ("can act while channeling") is a flagged extension,
  not the default.
- **Interrupts are the same as charges**: stun, death, control-swap,
  transform, dispel, abandonment, game end. A stun mid-round cancels the
  channel immediately — including the wave scheduled for that round's end.
  No damage-interrupt by default (the `fragile` option can apply to channels
  too).
- **No stacking, no merging** — one channel per owner at a time (the lock
  enforces it naturally; starting a second channel while channeling is
  blocked by the gate).
- **Extension (flagged, deferred):** `manual: true` channels — continuing is
  the owner's move each round; any other decision abandons the channel
  (reason `'abandoned'`). The auto-lock default keeps the core simple.

## 6. Stun — two primitives, composed

Stun is **not one built-in rule**. It composes two independent primitives:

1. **`blocksActing`** — a status-level flag. A buff (or skill) with
   `blocksActing: true` contributes to the character's `canAct` gate,
   consulted by decision execution and by `useAbility`. It blocks moves
   **and prompt-triggered abilities** (both are player choices). **Auto
   triggers still fire** — the body still reacts (passives, thorns, second
   winds); only *choices* are suppressed. This keeps defensive builds
   meaningful under a lockdown and avoids surprise passive shutdowns. A
   `hard: true` flag (auto triggers suppressed too) is a possible variant.
   The **channel lock** (§5) feeds the same gate — one query, several
   contributors.
2. **`cancelConcentration`** — the batch cancel action from §2. Cancelling
   the owner's charges and channels is a **separate action** from blocking
   acting; stun merely *fires* it. Either tooth pairs with anything:

```ts
stun({ rounds: 1 })   // blocksActing + duration + onApply → cancelConcentration(self, 'stun')
fear({ rounds: 2 })   // blocksActing only — victim keeps its charges, but can't act
disenchant({ })       // cancelConcentration only — pops charges/channels without locking
```

Timed entries (summon timers, transform duration, countdown win/lose) are
**not** touched by `cancelConcentration`: a stunned warlock's Doom keeps
ticking; a stunned polymorph stays polymorph; a stunned summoner's minions
still expire. (Those are cancelled only by their own lifecycle or a targeted
`remove`.)

3. **Duration** — an expiry entry: applied during round R with duration D,
   active through the moves of round R+D, removed at that round's end tick.
   A 1-round stun means "skip your next round of moves" (plus whatever
   remains of the application round).

Stacking and removal (decided):

- **Re-application refreshes**: a second stun sets the expiry to
  `now + D`; durations never add. (Additive durations would hand stun-lock
  to anyone with two stun spells.)
- **Cleanse works**: `removeBuff` removes the stun like any buff, and the
  cancellation already done is *not* undone — cancellation is an apply-time
  effect, one-way. A cleansed stun does not resurrect charges.
- **Duration cap** recommended (e.g. stun duration clamps to 3 rounds) as a
  guardrail; **diminishing returns** (a short stun-immunity buff applied by
  the expiry hook) is a flagged extension.
- Stun does not stack "stun-ness" — one buff instance, refreshed duration.
- `removable: false` charges **survive stun**: `cancelConcentration`
  respects `removable`, so a shielded charge resists both dispel and
  stun-cancel — but still dies with its caster (death is a lifecycle
  cancellation, not an action).

## 7. Events and visibility (UI)

New events on the trigger bus (extend the `GameEvent` union), all carrying
the entry so triggers can filter by kind/tags/owner:

- `pending:added` — "Goblin begins charging Fireball (2 rounds)."
- `pending:ticked` — countdown UI updates ("1 round").
- `pending:resolved` — "Fireball lands!" (before its actions apply).
- `pending:cancelled` — "Goblin's Fireball fizzles!" (reason: stun /
  dispelled / death / control-swap / transform / abandoned / expired).

Because they are ordinary events, triggers can react to them with the usual
prestack filters and seeded-shuffled ordering ("when an enemy's charge is
cancelled, draw a card"; "when a channel resolves, …").

**Visibility is public by default.** `visible: true` renders owner, ability
name, targets, countdown, kind — the defender always knows what's coming and
at whom; the skill is in what they do about it. `visible: false` (traps) is
a flagged extension; hidden entries still emit events to triggers, just not
to the UI. The UI also queries the registry directly
(`engine.pendingEffects`) for a panel: "Goblin — Fireball (2)" · "Hero —
Rain of Fire (3 waves)" · "Hero — stunned (1)".

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

Cancellation is one-way: nothing resurrects a cancelled charge, and undoing
the cause (cleansing the stun, ending the transform, swapping control back)
does not restore it. External cancellation (`remove`, `cancel`) respects
`removable: false`; lifecycle cancellations (death, control-swap, transform,
game end) ignore it — a shielded charge survives every action aimed at it,
but dies with its caster.

## 9. Counterbalance (fun guardrails)

- **Full information.** Targets are frozen at cast, countdowns are public,
  resolution is telegraphed. Frustration comes from *unknowns*; here the
  tension is "I know what's coming and must do something about it," which is
  a puzzle, not a gotcha.
- **Universal answers**: kill the **caster** (death cancels) — and where an
  entry has character **targets**, kill *all of them*. Targets are a list,
  validated **per-target** at resolution: a multi-target charge keeps
  landing on whoever is left (partial fizzle), and only when no valid target
  remains does it fizzle entirely. An area effect aimed at the ground has no
  character targets to kill — the answers left are stun, dispel, or the
  caster. The caster answer always exists, even with no dispel and no stun.
- **Caster protections are about *reliability*, not secrecy**: damage
  doesn't interrupt (default); `removable: false`/shielded entries resist
  dispel; multiple concurrent charges overload the dispel economy; high
  speed shrinks the same-round reaction window (a caster who acts last in
  the round denies the rest of that round as a window — the next full rounds
  remain).
- **Failure modes, explicitly designed against**:
  - *Stun-lock* — refresh-not-add durations, cleanse, duration cap;
    diminishing returns as a flagged extension.
  - *Uninteractive wins* — countdown win/lose is visible, dispellable, and
    the caster is killable ("survive the decree" per 03); game-end checks
    run first at every phase.
  - *Helpless channeler* — the lock is telegraphed and interruptible; the
    channel is a choice, and the manual-abandon flag is the escape hatch.
  - *Dispel stalemates* — fine; that's an action-economy fight, which is the
    game.
- **Fizzle feedback** — cancelled charges/channels emit `pending:cancelled`
  with a reason, so the balloon-pop is visible and satisfying, not silent.

## 10. Edge cases & rulings

1. **Two charges due at the same tick** — resolve in owner-speed order,
   ties by insertion; SBA pass between entries; if the first ends the game,
   the rest never resolve.
2. **Owner dies mid-charge** — cancelled (`death`). If an earlier resolution
   in the same tick killed the caster, their later entry is cancelled when
   reached (owner-alive and target-validity are checked at resolution).
3. **Game ends during a charge** — SBA win/lose runs first at every phase;
   the pending effects are moot (and owner death cancels anyway).
4. **Determinism** — the registry is state; ticks only at the two round
   boundaries; no wall-clock; resolution order fixed (speed + insertion);
   no RNG consumed by ticking. Same seed + same state ⇒ same outcome,
   including every tick.
5. **No infinite loops** — the snapshot rule (§3) plus the existing
   max-action-depth guard (100) plus the optional per-owner entry cap.
6. **Control-swap or transform mid-charge** — cancelled (`control-swap` /
   `transform`); not restored if the transform is later undone.
7. **Multiple charges at once** — allowed; separate entries; no merging
   (a `stack: 'merge'` flag is a possible extension).
8. **`ticks: 0` at creation** — refused (minimum 1); the snapshot rule means
   a created-now entry is never due this tick.
9. **Dispel during a resolution batch** — the due set is a snapshot; an entry
   dispelled by an earlier resolution or a trigger is skipped when reached
   (registry membership re-checked).
10. **Stun lands between channel waves** — channel cancelled; no further
    waves, including the one scheduled for the current round-end.
11. **Summon dies before its timer** — timer cancelled (`death`, owner = the
    summon); no double-destroy.
12. **Countdown win/lose vs killing blow in the same batch** — both resolve
    at the win/lose layer of the SBA pass, first (04/03; unchanged).
13. **Charge's target left play** — invalid targets are dropped; none left ⇒
    fizzle.
14. **Cleanse after stun cancelled a charge** — cancellation stands (one-way).

## 11. Scope — explicitly excluded

- **MTG-style stack, priority, instant responses** — already decided; the
  spectrum in §1 is the replacement. There are no "interrupt" actions.
- **Immediate actions are uncounterable by design** — that is the counter-
  ability tradeoff, not a bug.
- **Damage does not interrupt charges/channels by default** — the `fragile`
  flag is the extension.
- **No silence**, no resource/mana system (costs are parked), no hidden
  information by default (visibility is public; `visible: false` is a
  flagged extension).
- **No sub-round time** — rounds are the only tick; moves are atomic.
- **Stun does not block auto triggers** by default (`hard` flag deferred).
- **No charge refunds, no merge-on-stack, no charge resurrection.**
- **Countdown win/lose changes phase** — 03 said countdowns "tick on
  `turn:end`"; the deadline rule here moves them to the **round-start** tick
  (resolve at the start of round R+N before moves). One rule for all
  countdowns, and the UI countdown reads naturally. Everything else in 03
  stands.

## 12. Content shapes (DSL preview)

The current builders grow optional blocks; the raw `pendingEffect` action
remains for exotic cases:

```ts
// charge — "deals 3 damage to target enemy" but 2 rounds later
cast({
  name: 'Fireball',
  targeting: { who: 'enemy' },
  charge: { rounds: 2 },
  cast: (ctx, t) => [],                                  // costs live here (later)
  resolve: (ctx, t) => [damage(t.targets[0]!, 30, ctx.self)],
});

// channel — Rain of Fire: a wave each round for 3 rounds, caster locked
cast({
  name: 'Rain of Fire',
  targeting: { who: 'enemy' },
  channel: { waves: 3 },
  perWave: (ctx, t) => [ /* AoE damage */ ],
});

// countdown win/lose — "you win in 5 rounds" (resolves at round-start)
cast({ name: 'Doom', targeting: { who: 'self' },
  countdown: { rounds: 5, resolve: (ctx) => [win('monsters', ctx.self)] } });

// raw timer — summon expiry / transform duration / delayed effects
setTimer(summon, { kind: 'timer', rounds: 3, resolve: (ctx) => [destroy(summon)] });
setTimer(target, { kind: 'timer', rounds: 2, resolve: (ctx) => [unTransform(...)] });
schedule({ kind: 'delayed', rounds: 2, resolve: (ctx) => [damage(...)] });

// stun — sugar over blocksActing buff + duration + cancelConcentration
addBuff(target, stun({ rounds: 1 }));

// the teeth are separable — Fear locks without popping charges;
// Disenchant pops charges without locking
const fear = buff({ name: 'Fear', blocksActing: true });   // + duration via setTimer
const disenchant = cast({
  name: 'Disenchant',
  targeting: { who: 'enemy' },
  cast: (ctx, t) => [cancelConcentration(t.targets[0]!, 'disenchant')],
});
```

The engine auto-creates the registry entry when an ability declares
`charge` / `channel` / `countdown`, so the common cases never hand-roll
`pendingEffect` actions.

## 13. Engine implications

- `src/engine/actions.ts` — new `pendingEffect` action (add/remove) +
  sugar; `Action` union grows.
- `src/engine/events.ts` — extend `GameEvent` with `pending:added` /
  `pending:ticked` / `pending:resolved` / `pending:cancelled`.
- `src/engine/engine.ts` — the registry (`#pending`), `tick(phase)` invoked
  from `startTurn()` (round-start, before the `turn:start` event) and
  `endTurn()` (round-end, before the `turn:end` event); the resolution
  runner (snapshot, order, batching, SBA pass); the `canAct` gate consulted
  at decision execution and `useAbility`.
- `src/engine/status.ts` — the `blocksActing` status flag contributing to
  `canAct`; the stun buff factory (`stun({ rounds })`) composing
  blocksActing + duration + an `onApply` that fires `cancelConcentration`.
- `src/multiplayer/local.ts` (+ any `Game`) — unchanged: the ticks live
  inside the engine's turn hooks; the round loop keeps its shape.
- `src/ui/` — pending-effects panel and fizzle/landing log lines from the
  new events.

## 14. Implementation plan (incremental)

1. **Registry core** — entry type, `pendingEffect` action, tick points,
   snapshot rule, events, UI panel. Nothing charges yet; a plain timer
   demo proves the loop.
2. **Charge-up** — `charge`/`resolve` ability blocks, auto-created entries,
   frozen targets, fizzle on dead targets, `pending:cancelled` on removal.
3. **Channels** — `channel`/`perWave`, round-end wave scheduling, the
   channel lock through `canAct`.
4. **Stun** — buff factory, gate, cancel hook, expiry duration, cleanse,
   refresh-not-stack, duration cap.
5. **Timers onto the registry** — summon expiry (01), transform duration
   (01), countdown win/lose phase move (03), delayed effects.
6. **Determinism & edge-case suite** — same-seed replay with concurrent
   charges/channels/stuns asserting identical event histories and order;
   the §10 rulings as tests.
