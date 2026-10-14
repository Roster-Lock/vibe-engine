# 00 — Overview & Build Plan

> This series is the **build spec** for the TinyQuest engine: a complete,
> self-contained description of every part of the engine and how it works,
> ordered so that an AI or a human can implement it **from zero to
> completion**. Each doc describes one part: its behavior, its interfaces,
> the rules it obeys, and the acceptance criteria that prove it works.
>
> **Baseline: target model.** This spec describes the *target model* defined
> in [`docs/design/`](../design/README.md) — ownership-based teams, zones,
> `destroy`, restrictions, pending effects, auras — even where the current
> `src/engine` code has not caught up yet. Where this spec and the code
> disagree, **this spec (and the design docs it cites) is the truth**. The
> code is a living prototype; the spec is the map.
>
> Scope: the **engine core only** (`src/engine/` in the current repo). The
> React UI, the multiplayer wrappers, and the example content are out of
> scope — they are consumers of this engine, not parts of it.

## 1. What the engine is

TinyQuest is a tiny, content-creator-friendly **game engine** in TypeScript.
The goal: a new player should be able to write new game content — a skill, a
buff, a passive action modifier — by composing a few small declarative
pieces, without touching engine internals.

```ts
const fireball = cast({
  name: 'Fireball',
  targeting: { who: 'enemy' },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!, 40, ctx.self)],
});

const thorns = buff({
  name: 'Thorns',
  weight: 2,
  abilities: [
    auto({
      name: 'Retaliation',
      event: 'gauge:changed', // damage is derived from HP gauge changes (see 06)
      when: (ctx) => {
        if (!('source' in ctx.event)) return false;
        const source = ctx.event.source;
        return (
          wasTakenBy(ctx.event, ctx.self) &&
          source.type === 'character' &&
          source !== ctx.self
        );
      },
      targets: (ctx) => {
        if (!('source' in ctx.event)) return [];
        const source = ctx.event.source;
        return source.type === 'character' && source !== ctx.self ? [source] : [];
      },
      cast: (ctx, targeting) => {
        const attacker = targeting?.targets[0];
        return attacker ? [damage(attacker, 8, ctx.self)] : [];
      },
    }),
  ],
});
```

## 2. The mental model

**Actions are the only way the game state changes.** Abilities, buffs and
skills never touch gauges or lists directly — they produce **Actions**, and
the engine pushes every Action through a transformation pipeline before
applying it.

```
content (ability/buff/skill)
        │  produces
        ▼
     Action ──► outgoing transforms (source, by weight) ──► incoming transforms (target, by weight) ──► applied to world ──► events
```

Four ideas make the engine small:

1. **One mutation channel.** Everything a character can do reduces to a
   small closed set of Action kinds (see [03-actions.md](03-actions.md)).
   Content never mutates state directly; it returns Actions.
2. **Transformers compose.** Passive action modifiers intercept Actions on
   their way out of a source or into a target, wrapping the previous
   update. Order is weight-determined and therefore visible (see 03).
3. **Events report; triggers react later.** The engine announces every
   change as an event. Triggered abilities subscribe to events, but their
   execution is **deferred to the unit boundary** and **seeded-shuffled** —
   no defined order, only reproducibility between players (see
   [06-events-triggers.md](06-events-triggers.md)).
4. **State-based actions settle the world.** Win/lose, destruction, and
   content-registered rules run in a fixed **SBA pass** after gauge writes
   land — before events fire — and the pass loops while the state changed
   ([09-sba-pass.md](09-sba-pass.md)).

## 3. The target model (what this spec describes)

The target model is the design-doc future. The highlights — the deltas
between the current code and the model this spec specifies:

| Topic | Today's code | Target model (this spec) |
| --- | --- | --- |
| Teams | `character.team` tag | Teams live on `Player`s. Ally/enemy derives from **controllers** + player team tags ([08](08-players-teams-winlose.md)). |
| Ownership | `character.controller` only | **`owner`** (for defeat) and **`controller`** (who plays it now) are distinct; control swap changes `controller` only; `countsForDefeat` per character ([04](04-character-status.md), [08](08-players-teams-winlose.md)). |
| Zones | play + garbage set | Explicit **play / garbage** zones; garbage never targetable; summon/revive move characters between them ([07](07-targeting-zones.md)). |
| Removal | HP ≤ 0 path only | **`destroy`** is a first-class action; HP ≤ 0 ⇒ destroyed is a *rule* (SBA); simultaneous destruction; `character:destroyed` with a `reason` ([09](09-sba-pass.md), [10](10-destroy.md)). |
| Exceptions | ad-hoc | **Restrictions** — "cannot be X if Y" — gating targeting, destroy, gauge writes, win/lose; named exceptions pierce ([11](11-restrictions.md)). |
| Time | none | **Pending-effects registry**: charge-up, channels, stun, timers, countdown win/lose ([12](12-pending-effects.md)). |
| Auras | marks via triggers | **Aura scope** + membership rescan on `character:summoned` / `:revived` / `:controlChanged` ([13](13-auras.md)). |
| Content rules | none | **Content-registered state-based rules** with a priority, loop-while-changed contract ([09](09-sba-pass.md)). |
| Win/lose | HP-based | Ownership-based defeat; dead predicate consults the destroy gate; `win`/`lose` actions; draws ([08](08-players-teams-winlose.md)). |

The source of truth for the target is the design series
[`docs/design/`](../design/README.md); this spec makes it *buildable* by
fixing the remaining open questions (see §6) and ordering the work (§4).

## 4. The build plan (zero to completion)

The engine is built in **slices**. Each slice ends with a runnable,
test-covered milestone; the acceptance criteria at the end of each doc in
this series are the slice's definition of done. Slices are ordered so that
each only depends on earlier ones.

| Slice | What lands | Doc(s) | Acceptance (summary) |
| --- | --- | --- | --- |
| **0. Foundations** | Seed module, `Gauge`, `Character` skeleton (identity, owner/controller, zones, status list, skills), id slugging, error conventions | [01](01-gauge.md), [02](02-seed.md), [04](04-character-status.md) (core) | Deterministic PRNG; gauges clamp correctly; characters constructed with skills, queried by status id. |
| **1. Actions & pipeline** | Action kinds + sugar builders, direction stamping, transformers, `apply` with batching/netting, depth guard, gauge events | [03](03-actions.md) | Damage/heal/netting land correctly; a batch emits one netted `gauge:changed`; infinite chains throw. |
| **2. Statuses & abilities** | Buff/Skill full lifecycle (removable, `removedOnDefeat`, buff:destroyed self-triggers, cascade, cycle detection, `grantedBy`), the four ability kinds, attach/detach | [04](04-character-status.md), [05](05-abilities.md) | Buff add/remove/explode/cascade behave per rules; cycle refused with `cycle:detected`. |
| **3. Targeting & host** | `validTargets` over zones with who/match/negate/include, `GameHost` (Auto/Queue), `useAbility` enforcement | [07](07-targeting-zones.md) | Pool filters work; garbage excluded; out-of-pattern targets rejected. |
| **4. Events & triggers** | Trigger listener registry, enqueue/drain at unit boundary, seeded shuffle, batch events, `character:destroyed`/`survived` with per-write changes | [06](06-events-triggers.md) | Triggers run after the unit settles, in seeded-shuffled order; game-end short-circuits the drain. |
| **5. Players, teams, win/lose** | `Player` (owner/controller stamping, `countsForDefeat`, `decide`), `TeamRegistry`, `win`/`lose` actions, draws, `GameEndInterrupt` | [08](08-players-teams-winlose.md) | Ownership-based defeat; two winners ⇒ draw; teamless players are their own team. |
| **6. SBA pass & destroy** | Destroy action, HP→destroy rule, simultaneous destruction with reasons, content SBA registry, loop-while-changed, depth cap | [09](09-sba-pass.md), [10](10-destroy.md) | A wipe destroys together and fires one event per character; content rules loop and terminate. |
| **7. Restrictions** | Restriction system (`on`/`when`), gates at targeting/destroy/pipeline/win-lose, named exceptions, gauge `intent` | [11](11-restrictions.md) | "Cannot be targeted by enemies" blocks targeting; "destroy anyway" pierces; blocked ≠ error. |
| **8. Pending effects** | Registry + `pendingEffect` action, tick points, charges/channels/stun, cancellation table, events, snapshot rule | [12](12-pending-effects.md) | A charge resolves at the right round-start; stun cancels concentration; same seed ⇒ same tick history. |
| **9. Auras** | Aura `scope` + membership rescan on summon/revive/control-change events | [13](13-auras.md) | Marks granted on entry, cascade-destroyed on departure; removal of the aura takes its marks. |
| **10. Game loop & determinism** | `Game`/`runLoop`, seed ceremony wiring (`applySeed`), `Decision`, `sortBySpeed`, turn hooks with pending-effect ticks | [14](14-game-loop.md) | Same seed + same decisions ⇒ identical event history; a game ends with winners or a draw. |

Build-order note: slices are sequential, but docs can be read in any order.
Each doc states which slice it belongs to and lists its acceptance
criteria, so a builder can work slice by slice and verify as they go.

## 5. Global invariants & conventions

These hold everywhere in the engine; every doc assumes them.

- **Actions are the only mutation channel.** Nothing — not an ability, not a
  trigger, not a buff hook — writes a gauge, adds/removes a status, or moves
  a character except by producing an Action that the engine applies. (The
  one exception: a status's own `vars` are private to that instance and may
  be mutated by its abilities — e.g. a stacking counter. See
  [04-character-status.md](04-character-status.md).)
- **Events fire after the world changed.** State-based resolution (win/lose,
  destroy) runs *before* events are emitted; triggers see the settled state
  of their unit.
- **Win/lose-first.** Once the game is decided, nothing else happens: no
  destruction events, no triggers, no further actions.
- **No defined order, only reproducibility.** Where order is arbitrary
  (which of two simultaneous triggers fires first), the engine makes it
  deterministic per seed instead of defining it. Same seed + same game
  state ⇒ same sequence.
- **Blocked is a no-op; misuse throws.** A rule that blocks something
  (duplicate non-stackable buff, `removable: false` removal, restriction)
  silently does nothing. A *misuse* — targeting outside a pattern, using a
  non-manual ability, `win` on a team with no players — throws an error with
  a message that names the offender.
- **Loops are guarded, not allowed.** Max action depth (default 100) caps
  nested `apply` chains; the trigger queue is bounded the same way; content
  SBA loops stop on a no-change pass and are depth-capped.
- **Ids are slugs.** Status ids, ability ids, player ids default to a slug
  of the name (`Fireball` → `fireball`, `Rain of Fire` → `rain-of-fire`);
  an explicit `id` always wins.
- **Determinism by default.** The only randomness is the seeded PRNG (see
  [02-seed.md](02-seed.md)); ticking, resolution, and ordering consume no
  RNG beyond the defined draws.

## 6. Open design questions → spec defaults

The design docs marked a few details open (🔶). This spec fixes them so a
builder is never blocked. Change them deliberately; they are noted here so
the choice is visible.

| Open question (design doc) | Spec default |
| --- | --- |
| Revive HP amount (01) | Revive restores **full** HP unless the effect says otherwise; the character lands in play and emits `character:revived`. |
| Buffs through death (01) | Only `removedOnDefeat: true` buffs leave at death; the rest persist across destruction and revival. |
| Graveyard order (01) | An **ordered list** in destruction order; queryable (`engine.charactersIn('garbage')`). |
| SBA layers 3–4 (04) | **Automatic, not explicit steps**: gauges clamp at every write; abilities are derived at query time; aura membership is event-driven. |
| SBA registry shape (04) | The sketch in [09-sba-pass.md](09-sba-pass.md) (priority, `when`/`then`, loop-while-changed). Built-in priorities: win/lose 10, destroy/create 20, 30/40 reserved, content defaults 50. |
| Gauge `intent` (06) | `damage` / `heal` / `set` / `other` on gauge-changing actions; the sugar builders stamp it; raw `{ type: 'gauge', update }` defaults to `other`. |
| Restrictions shape (11) | A **restriction ability** (`restriction({ on, when? })` in a status's `abilities`) with `AttemptContext`; see [11-restrictions.md](11-restrictions.md). |
| `include` vs rule gates (05) | Named exceptions must be **explicit**: a rule is beaten only by an exception that names it. `include` (targeting) punches through `who`/`match`/`negate` but **not** through a targetability restriction unless the effect says so. |
| Aura rescan events (07) | `character:summoned`, `character:revived`, `character:controlChanged` trigger the diff. |

## 7. Out of scope (deferred — do not build)

These are consciously parked by the design docs. A "complete" build stops
before them; the hooks that will one day support them are noted where they
appear.

- **Costs** (mana costs as declared data, taps, sacrifices) — explore after
  the action vocabulary settles.
- **Zones beyond play/garbage** (hand/deck/exile) — not needed yet; the
  zone abstraction stays queryable.
- **Attack wrapper / per-hit events** — multi-action damage is enough; the
  `GaugeWrite[]` on destroy/survived events already carries per-write data.
- **Items / equip** — the transform stack (04) is designed to be item-driven
  later.
- **Despawn as a distinct rule** — `destroy` covers it; expired summons go
  through the normal destroy path and fire death triggers.
- **Avatar-style defeat conditions** — a summon that becomes its owner's
  defeat condition; noted in [08](08-players-teams-winlose.md).
- **Replacement effects** ("prevent X, instead Y"; last breath) — deferred.
  The decided rule is recorded: **each replacement effect emits at most once
  per chain**, and after a replacement resolves the engine rechecks the
  underlying state (win/lose first). Not in any slice.
- **UI, multiplayer transport, example content** — consumers of the engine,
  out of scope here.

## 8. Reading the series

| Doc | Part of the game | Slice |
| --- | --- | --- |
| [01-gauge.md](01-gauge.md) | The numeric meter: max/current/min/clamp, write semantics, intent | 0 |
| [02-seed.md](02-seed.md) | Determinism: PRNG, hashing, shuffle, commit/reveal ceremony | 0 |
| [03-actions.md](03-actions.md) | The Action vocabulary, sugar builders, the transformation pipeline, batching/netting, depth guard | 1 |
| [04-character-status.md](04-character-status.md) | Characters (identity/form, ownership, zones) and statuses (buffs/skills) and their lifecycle | 0/2 |
| [05-abilities.md](05-abilities.md) | The four ability kinds, contexts, targeting pattern shape | 2 |
| [06-events-triggers.md](06-events-triggers.md) | The event union, the trigger listener registry, queue/drain, batch events, helpers | 4 |
| [07-targeting-zones.md](07-targeting-zones.md) | Targeting pools over zones, who/match/negate/include, enforcement | 3 |
| [08-players-teams-winlose.md](08-players-teams-winlose.md) | Players, teams, ownership-based defeat, `win`/`lose`, draws | 5 |
| [09-sba-pass.md](09-sba-pass.md) | The state-based action pass: ordering, content rules, the loop | 6 |
| [10-destroy.md](10-destroy.md) | `destroy`, the HP→destroy rule, simultaneous destruction, reasons | 6 |
| [11-restrictions.md](11-restrictions.md) | "Cannot be X if Y": shapes, gates, named exceptions | 7 |
| [12-pending-effects.md](12-pending-effects.md) | The time subsystem: registry, charge, channel, stun, timers | 8 |
| [13-auras.md](13-auras.md) | Aura scope, marks, membership rescan | 9 |
| [14-game-loop.md](14-game-loop.md) | `Game`, the round loop, decisions, initiative, hosts, seed wiring | 10 |

Design references: the decision record behind this spec lives in
[`docs/design/`](../design/README.md) (01 entities · 02 destroy · 03
win/lose · 04 SBA · 05 targeting · 06 damage · 07 auras · 08 countering ·
10 pending effects · 11 restrictions · 12 replacement effects).
