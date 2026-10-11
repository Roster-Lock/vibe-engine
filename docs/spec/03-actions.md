# 03 — Actions & the Action Pipeline

> Slice 1. The one mutation channel: every state change is an Action, and
> every Action flows through the transformation pipeline before it lands.

## 1. The principle

**Actions are the only way the game state changes.** Abilities, buffs,
skills, triggers, and hooks never touch gauges or lists directly — they
produce Actions, and the engine pushes each Action through the pipeline
(outgoing transforms on the source, incoming transforms on the target, in
ascending weight order) before applying it to the world.

## 2. The Action vocabulary

One closed union. Built today: `gauge`, `addBuff`, `removeBuff`, `destroy`,
`transform`, `win`, `lose`. Target-model additions: `summon`, `control`,
`revive`, `pendingEffect` (shapes below; detail in the cited docs). A
gauge's **maximum** is deliberately *not* an Action — it is derived from
the attached statuses' `maxModifier` contributions (see §2.1 and
[01-gauge.md](01-gauge.md) §4).

```ts
type Action =
  | GaugeAction        // type: 'gauge'        — new current value for a gauge
  | AddBuffAction      // type: 'addBuff'      — add a buff to a character
  | RemoveBuffAction   // type: 'removeBuff'   — remove a buff from a character
  | DestroyAction      // type: 'destroy'      — destroy a character (deferred to the SBA pass)
  | WinAction          // type: 'win'          — declare a team/player the winner (deferred marker)
  | LoseAction         // type: 'lose'         — mark a team/player as lost (deferred marker)
  | SummonAction       // type: 'summon'       — create a character in play (target model)
  | ControlAction      // type: 'control'      — swap a character's controller (target model)
  | TransformAction    // type: 'transform'    — push a form onto the transform stack (target model)
  | ReviveAction       // type: 'revive'       — move graveyard → play (target model)
  | PendingEffectAction// type: 'pendingEffect'— add/remove/cancel a pending effect (target model)

interface ActionFields { source?: EventSource; direction?: ActionDirection }
```

Common fields:

- **`source`** — who is responsible: a `Character`, or a `Buff` doing its
  thing. Content sets it via the sugar builders; the engine also fills it
  from the apply context when missing.
- **`direction`** — never set by content. The engine stamps it while a
  transformer runs: `'outgoing'` (leaving the source) or `'incoming'`
  (arriving at the target). See §4.

### 2.1 Gauge-changing actions

```ts
interface GaugeAction {
  type: 'gauge';
  target: Gauge;
  update: (current: number, max: number) => number;  // new current
  intent?: 'damage' | 'heal' | 'set' | 'other';      // target model — see 01 §3
}
```

- The `update` function computes freely; clamping happens at write time
  ([01-gauge.md](01-gauge.md) §2).
- Gauge actions are **batched and netted** — see §6.
- **The maximum is not an Action.** A gauge's `max` is *derived*: the
  engine recomputes it from the gauge's `baseMax` plus the `maxModifier`
  contributions of every attached status (weight-ordered, like any
  transformer — §5). Adding a status applies its contribution; any removal
  reverts it automatically. The only way to change a max is to add or
  remove a buff — see [05-abilities.md](05-abilities.md) §2 and
  [01-gauge.md](01-gauge.md) §4.

### 2.2 Buff actions

```ts
interface AddBuffAction    { type: 'addBuff';    target: Character; buff: BuffDef }
interface RemoveBuffAction { type: 'removeBuff'; target: Character; buff: Buff | string }
```

- `addBuff` creates a **fresh instance** (new `vars`) on application; a
  non-stackable duplicate id is silently ignored. `removeBuff` by instance
  or id; buffs declared `removable: false` and skills are never removed
  (no-op). Full lifecycle in [04-character-status.md](04-character-status.md).

### 2.3 Destroy (SBA-deferred)

```ts
interface DestroyAction { type: 'destroy'; target: Character }
```

- Records a pending-destroy marker; the SBA pass resolves it **together
  with every other pending destruction** (HP ≤ 0 deaths from the same
  batch). Characters the destroy gate blocks stay. See
  [09-sba-pass.md](09-sba-pass.md) and [10-destroy.md](10-destroy.md).

### 2.4 Win / lose (deferred markers)

```ts
interface WinAction  { type: 'win';  team: string | Player }
interface LoseAction { type: 'lose'; team: string | Player }
```

- Only record markers; the game is resolved at the batch/apply boundary —
  several teams can win (or lose) in one apply, which resolves as a draw.
  Throws if the team has no registered players. See
  [08-players-teams-winlose.md](08-players-teams-winlose.md).

### 2.5 Target-model actions (spec shapes)

```ts
interface SummonAction {
  type: 'summon';
  def: CharacterDef;              // the summon's shape (skills, gauges, speed)
  owner: Player;                  // owns it for defeat purposes
  countsForDefeat?: boolean;      // default false (summons don't count)
  // controller defaults to `owner`; the engine constructs the Character,
  // registers it, lands it in play, and emits `character:summoned`.
}

interface ControlAction {
  type: 'control';
  target: Character;
  to: Player;                     // the new controller (never the owner)
  // Re-derives teams; cancels the target's concentration pending effects
  // (reason 'control-swap'); emits `character:controlChanged`.
}

interface TransformAction {
  type: 'transform';
  target: Character;
  form: TransformForm;            // { name?, icon?, skills?, maxHp?, maxMana? }
  // Pushes the form onto the target's transform stack keyed by `source`;
  // gauge maxes apply with clamping; buffs persist; abilities re-derive.
  // Removing the source pops the form and reverts (see 04 §6). A source
  // that is a **buff** (attached when pushed) makes the entry a **tie**:
  // it pins the form above later pushes while the buff is active (04 §6).
}

interface PopTransformAction {
  type: 'popTransform';
  target: Character;
  // Pops the character's *current effective* transformation, returning them
  // to the previous state. A **live tie pins the form**: while a buff-tied
  // form is active (a `transformModifier` hex) the pop is refused — the
  // state-based rule re-asserts the buff's transformation, and the buff
  // itself is only removed by a removal action. With no tie, the top of
  // the stack pops. Gated by the same `on: 'transform'` restriction as
  // `transform`.
}

interface ReviveAction {
  type: 'revive';
  target: Character;              // must be in the graveyard (else: misuse, throw)
  hp?: number;                    // spec default: full HP
  // Moves graveyard → play, restores HP, emits `character:revived`.
}
```

Detail and rationale live in [04-character-status.md](04-character-status.md)
and [12-pending-effects.md](12-pending-effects.md) (`pendingEffect`).

## 3. Sugar builders

The everyday vocabulary for content creators. Each returns an Action with
`source` attached when given:

```ts
damage(target, 30, source)        // gauge, intent 'damage'   (Character → its HP gauge)
heal(target, 10, source)          // gauge, intent 'heal'
setGauge(gauge, 5, source)        // gauge, intent 'set'
changeGaugeBy(gauge, -10, source) // gauge, intent 'other'    (spend mana, etc.)
addBuff(target, SOME_BUFF_DEF)    // addBuff — fresh instance on apply
removeBuff(target, 'poison')      // removeBuff by id or instance
destroy(target, source)           // destroy (SBA-deferred)
transform(target, form, source?)  // transform — push a form onto the form stack (see 04 §6)
popTransform(target, source?)     // popTransform — undo the current effective transformation
win('party')                      // win — team tag or Player
lose('monsters')                  // lose
```

There is **no max-writing sugar**: a gauge's maximum is derived from
statuses, so content changes a max by applying (or removing) a buff that
carries a `maxModifier` (see §5).

Target-model sugar: `summon(def, owner, opts)`, `control(target, player)`,
`revive(target, hp?)`, and the pending-effects
family `charge` / `channel` / `setTimer` / `removePendingEffect` /
`cancelConcentration` ([12-pending-effects.md](12-pending-effects.md) §3).

Anything more interesting is a plain function:
`{ type: 'gauge', target, update: (cur, max) => cur / 2 }`.

## 4. Direction

- `ActionDirection = 'outgoing' | 'incoming'`.
- The engine stamps `direction` onto an Action only while transformers run
  (and only when the stamped value differs from the current one). Content
  never sets it.
- A single transformer can serve both directions by checking it:

```ts
transform: (action, ctx) =>
  action.direction !== 'incoming' ? action
    : gaugeTransform((prev) => (cur, max) => Math.max(prev(cur, max), cur - 50))(action, ctx)
```

## 5. Transformers & the pipeline

```ts
type ActionTransformer = (action: Action, ctx: ActionContext) => Action;

interface ActionContext {
  source: EventSource | undefined;   // who produced the action
  target: Character | undefined;     // the character it is aimed at
  status: Status | undefined;        // the buff/skill owning this transformer
  engine: GameEngine;
}
```

Helpers (they rewrite only the actions they care about and pass the rest
through):

- `gaugeTransform(wrap)` — wraps the `update` of `gauge` actions:
  `gaugeTransform((prev) => (cur, max) => …)`.
- `gaugeTransformCtx(wrap)` — same, but the wrapper also sees the
  `ActionContext` (for scaling off a buff's own `vars`).
- `gaugeDelta(action)` — the signed change the action would make **right
  now** (its `update` evaluated against the gauge's current values; `0` for
  non-gauge actions). The "amount" a replacement reads off the original.
- `replaceAction(match, build)` — **replaces** an action outright: when
  `match` claims an action, `build`'s return takes its place in the
  pipeline and the original never continues (the phase's `direction` is
  carried onto the replacement). A replacement is **not a new cast** — it
  does not re-enter the pipeline or the restrictions gate (those already
  ran on the original), and the rest of the phase's transformers still see
  it. This is the "prevent the old one, emit a new one" pattern — option 2
  for "turn damage into mana loss".
- `redirectGauge(from, to, opts?)` — the ready-made redirect: every `gauge`
  action aimed at `from(target)` becomes a same-size action on `to(target)`
  (the signed `gaugeDelta` moves over, keeping `source` and stamping
  `'damage'`/`'heal'` by sign). `opts.direction` (`'incoming'`/`'outgoing'`)
  and `opts.intent` filter which phase / which intents redirect:

  ```ts
  // Mana Shield: incoming damage becomes mana loss; heals still heal HP.
  redirectGauge((t) => t.hp, (t) => t.mana, { direction: 'incoming', intent: 'damage' })
  ```
- `maxModifier({ multiply?, add?, gauge? })` — the declarative
  max-changing ability. It is **not a transformer**: a gauge's maximum is
  derived, so a `maxModifier` is a contribution the engine reads straight
  off a status — while the status is attached, the wearer's gauge max is
  re-derived as `max = max * multiply + add` (weight-ordered with every
  other contribution, clamped at 0; `gauge` defaults to `'hp'`). Lives on a
  buff or skill; adding the buff applies its contribution and any removal
  reverts it automatically.

**Pipeline order** (per Action, in `apply`):

1. **Outgoing phase** — for every status on the *source* character, in
   ascending weight order, each status's abilities' transformers run
   (buff sources have no outgoing phase of their own — a buff's actions are
   attributed to the buff, but the outgoing phase belongs to the *source
   character* the pipeline was entered with, if any).
2. **Incoming phase** — for every status on the *target* character, in
   ascending weight order, each ability's transformer runs.

**Composition rules**:

- Each transformer applies **independently**, one per buff, in ascending
  weight order — nothing is grouped. A `+1` then `+50%` then `+1` on a
  10-damage hit is `10 → 11 → 16.5 → 17.5`; `+50%` first is `10 → 15 → 16 →
  17`. Equal weights fall back to the order the statuses were applied in
  (insertion order), except that a status declared `direction: 'out to in'`
  is inserted *before* same-weight `'in to out'`/direction-less statuses —
  on the outside of its weight group — regardless of when it was cast (see
  [04-character-status.md](04-character-status.md) §3).
- Transformers **wrap the previous update function** — `gaugeTransform`
  hands `prev` the update so effects compose.
- A percentage modifier scales the **delta**, not the result. "+50% damage"
  on top of `prev` is `prev(cur) - (cur - prev(cur)) * 0.5` — scaling `prev`
  itself produces a different (usually wrong) number.
- Transformers can change the Action's kind or target; the pipeline applies
  whatever comes back. (Restrictions gate *before* transformers, see
  [11-restrictions.md](11-restrictions.md) §4.)

Transformers live on **passive action modifier** abilities attached through
buffs/skills ([05-abilities.md](05-abilities.md) §2); the engine runs the
one listener in both directions.

## 6. `apply`: batching, netting, settling

```ts
engine.apply(actions: Action[], context?: { source?: EventSource }): Promise<void>
```

The full settle sequence for one `apply`:

1. **Pipeline each Action** (outgoing then incoming, §5).
2. **Batch consecutive `gauge` Actions.** Every write lands in
   order (clamped per write). A non-gauge Action in the middle **flushes**
   the pending gauge writes first, so ordering is preserved.
3. **Per batch settle** (a *unit*):
   a. writes land — net result per gauge is whatever it ends at
      (a 10-damage + 6-heal batch is a net 4 damage);
   b. **game-over check runs before any events** (`resolveGameEnd`) — a
      killing blow ends the game instead of triggering abilities;
   c. the **destroy phase** moves every pending destruction to the
      graveyard simultaneously — HP ≤ 0 deaths from the batch, queued
      `destroy` actions, and status-driven max-0 deaths ([09-sba-pass.md](09-sba-pass.md) §3);
   d. **content state-based rules** react to the settled state
      (loop-while-changed, depth-capped — [09-sba-pass.md](09-sba-pass.md) §4);
   e. **netted events** fire: one `gauge:changed` per changed gauge in
      first-touch order, with `from`/`to` and the last write's `source`
      (a max change is not netted here — it is derived and reported at the
      status change that caused it, see §2.1);
   f. **destructions are announced** — `character:destroyed` per character
      then the `:batch` variant ([10-destroy.md](10-destroy.md) §4);
   g. **survivors announced** — `character:survived` (+`:batch`) for
      characters who took damage and are still standing, even when the net
      is zero; `changes` lists every write
      ([06-events-triggers.md](06-events-triggers.md) §6).
4. **At the end of the apply**: pending destroys not flushed by a gauge
   batch (an all-non-gauge apply) resolve, win/lose markers resolve, then
   the **trigger queue drains** — unless the game ended, in which case the
   throw skips the drain (win/lose-first).

**Depth guard**: nested `apply` calls (triggers, SBA rule
actions) increment a depth counter; exceeding `maxActionDepth` (default
100) throws `Action chain exceeded max depth … — possible infinite trigger
loop.` This is the backstop for loops that don't go through status grants
(e.g. a damage ping-pong between two thorned characters).

**Netting rules** (consequences a builder must honor):

- One `gauge:changed` event per gauge per batch — not one per write — then
  one `gauge:changed:batch` carrying them all.
  Per-write data lives in the `HpChange[]` carried by
  `character:destroyed` and `character:survived`.
- Damage/healing are **derived** from the HP gauge's `gauge:changed` (and
  its intent in the target model) — there are no dedicated damage/heal
  events ([06-events-triggers.md](06-events-triggers.md) §6).

## 7. Acceptance criteria (Slice 1)

1. `apply([damage(a, 10), heal(b, 5)])` nets per gauge: `a`'s HP drops 10,
   `b`'s rises 5; exactly one `gauge:changed` fires per changed gauge.
2. A vampire draining and healing itself in one `apply` is judged on the
   net: `damage(target, 20, vamp)` + `heal(vamp, 20, vamp)` ends with both
   at their net values, and a character that dips below zero mid-batch
   survives if the batch nets positive.
3. `apply([damage(a, 5), addBuff(b, X)])` flushes the gauge write before
   the buff lands (order preserved).
4. An `Iron Hide`-style incoming transformer caps incoming damage at 50 and
   leaves outgoing actions untouched; two transformers compose in ascending
   weight order with wrapping semantics; the "scale the delta" example
   produces the documented numbers.
5. A trigger that endlessly re-queues itself throws the max-depth error
   instead of looping forever.
6. `useAbility` (or a trigger) producing a `gauge` Action never bypasses
   the pipeline: transformations always apply before the write lands.
7. `win`/`lose` markers do not end the game mid-apply; they resolve at the
   boundary (see [08](08-players-teams-winlose.md) for the full table).
