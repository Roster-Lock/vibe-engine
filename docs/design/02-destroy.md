# 02 — Destroy

> Status: ✅ decided.

## The model

**Create/Destroy is the primitive lifecycle rule.** Damage and mana are a
character-specific *input* to destruction, not the definition of death. A
future entity kind with HP defines its own consequence for damage.

## Decisions

- ✅ **`destroy` is an action kind** (`{ type: 'destroy', target, source }`) —
  one sink for every removal: board wipes, summon timers, "destroy target",
  control cleanup, kill-effects.
- ✅ **"HP ≤ 0 ⇒ destroyed" is a rule (a state-based action)** for
  characters, gated by the "cannot be destroyed" rule below. **HP is the
  life gauge**: mana reaching 0 or below destroys nothing — mana is an
  ordinary resource (spell costs, shields) that never kills.
- ✅ **Death rules are `GaugeSba`s — removable, re-attachable, per-gauge.**
  The built-in death rules ("current ≤ min → destroy", "derived max ≤ 0 →
  destroy") are ordinary gauge-attached state-based actions that every
  character's **HP gauge** carries by default (attached at construction);
  content can **prevent** them (`character.hp.removeSba(...)`), attach the
  same definitions to another gauge (a mana-death game moves them to mana),
  or register arbitrary conditions ("destroy when HP is exactly 4") — see
  04-sba. The win/lose dead predicate consults the same rules, so
  destruction and defeat never disagree.
- ✅ **Simultaneous destruction (confirmed).** All pending destructions in
  one SBA pass happen **together** — "destroy multiple at the same time
  where we can": characters move to the graveyard as one phase, on-defeat
  buffs cleaned per `removedOnDefeat`, then one `character:destroyed` event
  per character, then death triggers run in the **seeded-shuffled order** —
  no defined order, only reproducibility between players. A board wipe is
  one phase, not N sequential deaths. (A lone `destroy` action with nothing
  to batch with is fine — simultaneity is "where we can", not mandatory.)
- ✅ **The same-batch principle extends to buffs.** The death's triggers are
  collected *before* the on-defeat cleanup, so a buff that dies with its
  wearer still hears the `character:destroyed` (and the
  `character:destroyed:batch`) — a "when I die" curse on the dying
  character itself needs no `removedOnDefeat: false`. Execution stays
  deferred by the trigger queue, so the trigger still sees the settled
  world; only the `onEvent` observers hear the event after the cleanup.
- ✅ **Game-end ordering (confirmed): win/lose resolves FIRST — before
  destruction and before any death triggers.** A killing blow ends the game
  immediately: no `character:destroyed` events, no death triggers. This
  preserves the engine's current documented behavior and avoids trigger
  loops at game end. Board wipes that do *not* end the game still resolve as
  destroy-all → death triggers.
- ✅ **The "dead" predicate consults the destroy-gate.** A character at
  HP ≤ 0 *tries* to be destroyed; if a destroy restriction blocks it, it is
  **not destroyed** — and since the player still has that character, they
  **do not lose**. "Dead for win/lose" = HP ≤ 0 **and** the HP→destroy
  rule is not gated (an indestructible character at 0 HP keeps its owner in
  the game).
- ✅ **A buff that dies with its wearer still hears the death — as a
  queued trigger.** A buff's `buff:destroyed` event is emitted while its
  own trigger listeners are still attached, so "when this buff dies" is a
  plain `buff:destroyed` self-listening trigger (the same-batch principle,
  like characters dying together). It fires at the trigger drain — after
  the wipe settles — and the event carries a `reason`
  (`'wearer-destroyed'` vs `'removed'` + `source`). There is no special
  `onRemoved` hook anymore.
- ✅ **Self-triggers are matched per instance.** Every status instance
  carries a unique `uid` (distinct from the kind `id` — `'poison'`,
  `'corpse-trap'`, …), and the trigger context exposes the owning status
  (`ctx.status`), so a bomb's self-trigger can filter
  `when: (ctx) => ctx.event.buff.uid === ctx.status.uid`. With stacked
  copies of a buff, removing **one** detonates only that copy — the coarser
  kind-id filter (`ctx.event.buff.id === 'bomb'`) would detonate every copy
  on the character. `removeBuff` by **instance** likewise matches the `uid`,
  removing exactly that instance rather than the first of its kind.
- ✅ **Expired summons fire death triggers** (MTG-token style). Expiration is
  a destroy like any other; "despawn" is not a separate rule.
- ✅ **"Cannot be destroyed" is a restriction** (see 11-restrictions), with
  two distinct flavors:
  - *damage clamp* — "cannot be reduced below 1 HP" (a transformer on
    incoming HP writes);
  - *indestructible* — takes the damage, sits at 0 HP, but the HP→destroy
    rule is vetoed by a `on: 'destroy'` restriction consulted by the SBA
    pass. A later mana refill saves it.
  The restriction vetoes `destroy` actions and blocks the mana-based destroy;
  a named exception ("destroy it anyway") can pierce it.

## Where destroy runs (the SBA pass)

See [04-sba.md](04-sba.md) for the full ordering. In short:

```
gauge writes land (netted)
  → 1. win/lose check — dead = HP ≤ 0 AND destroy not gated; game over short-circuits
  → 2. destroy/create — all pending destructions simultaneously
  → events + triggers (if the game continues; triggers are queued, see 04)
  → loop (depth-capped) while state changed
```

## Naming

- ✅ **`character:destroyed`** is the entity-level event (replaces
  `character:defeated` for characters). "Defeated" keeps its meaning at the
  player/team level (a player whose defeat condition is met).
- ✅ **The event carries a `reason`** — death triggers need to know *why*:
  - `'hp:current-reached-minimum'` — HP writes drove the gauge to `min`
    (payload: the batch's `GaugeWrite[]`);
  - `'hp:maximum-reached-0'` — a status drove the gauge's **derived max**
    to 0 (payload: the `GaugeMaxChange[]` the re-derivation produced — a
    `maxModifier` buff added, or a buff removal that keeps a stack at 0);
  - `'direct-action'` — a `destroy` action caused it (payload: `source`, a
    character or buff).
- ✅ **`character:destroyed:batch`** — one event per settle instead of one
  per character, carrying `characters` + the individual `events`: the
  "whenever one or more characters die" primitive. Fires even for a single
  destruction. `character:survived:batch` is the symmetric variant.

## Engine implications

- `actions.ts`: add `DestroyAction`.
- `engine.ts`: replace the per-character defeat path in `#applyGaugeBatch`
  with a collect-then-destroy phase. The game-end check stays **before** it
  and judges from **post-write mana** (`mana ≤ min` counts as dead), not from
  the `dead` flag — the flag is only set in the destroy phase, and win/lose
  runs first.
- `events.ts`: `character:destroyed` carries the batch context (who/what
  killed the character), like today's `character:defeated`.
