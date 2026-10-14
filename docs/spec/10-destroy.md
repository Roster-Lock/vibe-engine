# 10 — Destroy & the Graveyard

> Slice 6. The one sink for every removal — board wipes, summon timers,
> "destroy target", kill-effects.

## 1. The model

**Create/Destroy is the primitive lifecycle rule.** Damage and mana are a
character-specific *input* to destruction, not the definition of death. A
future entity kind with HP defines its own consequence for damage.

- **`destroy` is an Action kind** (`{ type: 'destroy', target, source }`) —
  one sink for every removal.
- **"HP ≤ 0 ⇒ destroyed" is a rule (a state-based action)** for characters,
  gated by the "cannot be destroyed" rule below. **HP is the life gauge:**
  mana reaching 0 or below destroys nothing — mana is an ordinary resource
  (spell costs, shields) that never kills.
- **The death rules are `GaugeSba`s** — gauge-attached state-based actions
  that every character's **HP gauge carries by default** (attached at
  construction). Content can **prevent** them
  (`character.hp.removeSba('HP Depleted')`), re-attach the same definitions
  to another gauge (a mana-death game moves them to mana), or register
  arbitrary conditions ("destroy when HP is exactly 4"); the win/lose dead
  predicate consults the same rules via `character.gauges` (see
  [09-sba-pass.md](09-sba-pass.md)).
- **Despawn is not a separate rule** — `destroy` covers it; expired summons
  go through the normal destroy path and fire death triggers (MTG-token
  style).

## 2. The gate and its flavors

**"Cannot be destroyed" is a restriction** ([11-restrictions.md](11-restrictions.md))
with two distinct flavors:

- **damage clamp** — "cannot be reduced below 1 HP": a transformer on
  incoming HP writes (no destroy involved; the character never reaches 0);
- **indestructible** — takes the damage, sits at 0 HP, but the HP→destroy
  rule is **vetoed** by an `on: 'destroy'` restriction consulted by the SBA
  pass. A later mana refill saves it.

The restriction vetoes `destroy` actions *and* blocks the mana-based destroy;
a **named exception** ("destroy it anyway") can pierce it.

Consequence for win/lose: **the "dead" predicate consults the destroy
gate.** A character at HP ≤ 0 *tries* to be destroyed; if a destroy
restriction blocks it, it is **not destroyed** — and since the player still
has that character, they **do not lose**
([08-players-teams-winlose.md](08-players-teams-winlose.md) §2).

## 3. Simultaneous destruction

All pending destructions in one SBA pass happen **together** — "destroy
multiple at the same time where we can":

1. characters move to the garbage as **one phase**;
2. on-defeat buffs cleaned per `removedOnDefeat` (before the move — a
   bomb-style buff explodes during the cleanup, slightly before death
   triggers; the cascade it causes is absorbed by the pass loop);
3. one `character:destroyed` event per character;
4. death triggers run in the **seeded-shuffled order** — no defined order,
   only reproducibility between players.

A board wipe is one phase, not N sequential deaths. (A lone `destroy`
action with nothing to batch with is fine — simultaneity is "where we can",
not mandatory.)

**Game-end ordering (confirmed):** win/lose resolves **first** — before
destruction and before any death triggers. A killing blow ends the game
immediately: no `character:destroyed` events, no death triggers. Board wipes
that do *not* end the game still resolve as destroy-all → death triggers.

## 4. The events

**`character:destroyed`** is the entity-level event (the old
"character:defeated" meaning is gone — "defeated" keeps its meaning at the
player/team level). It carries a **`reason`** so death triggers know *why*:

- `'hp:current-reached-minimum'` — the built-in **current-aspect**
  `GaugeSba` fired: HP writes drove the gauge to `min` (payload: the
  batch's `GaugeWrite[]`, so a last-breath trigger can find the damage
  dealer(s) with `event.changes.filter(isDamage)`);
- `'hp:maximum-reached-0'` — the built-in **max-aspect** `GaugeSba` fired:
  a status drove the gauge's **derived max** to 0 (payload: the
  `GaugeMaxChange[]` the re-derivation produced — a `maxModifier` buff
  added, or a buff removal that keeps a stack at 0);
- `'direct-action'` — a `destroy` action caused it (payload: `source`, a
  character or buff).
- **Content-registered rules report their own `reason` verbatim** — the
  reason is data, not a closed enum.

**`character:destroyed:batch`** — one event per settle instead of one per
character, carrying `characters` + the individual `events`: the "whenever
one or more characters die" primitive. Fires even for a single destruction.
`character:survived` / `character:survived:batch` are the symmetric
variants ([06-events-triggers.md](06-events-triggers.md) §5–6).

## 5. Ordering summary

```
gauge writes land (netted)
  → 1. win/lose check — dead = HP ≤ 0 AND destroy not gated; game over short-circuits
  → 2. destroy/create — all pending destructions simultaneously
  → events + triggers (if the game continues; triggers are queued, see 09)
  → loop (depth-capped) while state changed
```

## 6. Acceptance criteria (Slice 6)

1. `destroy(target)` moves the character to the garbage in the next SBA
   pass and fires `character:destroyed` with `reason: 'direct-action'` and
   the destroyer as `source`.
2. Two `destroy` actions in one apply land the victims in the garbage
   together (one phase); each fires its event, then one
   `character:destroyed:batch` fires.
3. A character at HP ≤ 0 is destroyed with `reason:
   'hp:current-reached-minimum'` and `changes` listing every HP write of
   the batch; max-HP-to-0 uses `reason: 'hp:maximum-reached-0'` and
   `maxChanges`.
4. An indestructible character (destroy-gated) at 0 HP is not destroyed,
   fires nothing, and keeps its owner in the game; "destroy it anyway"
   (named exception) pierces the gate.
5. A buff with the default `removedOnDefeat` **dies with its wearer** in
   the same batch — its `buff:destroyed` self-triggers fire (queued, at
   the drain) with `reason: 'wearer-destroyed'`; `removedOnDefeat: false`
   buffs survive.
6. A wipe that ends the game emits no destroyed events and runs no death
   triggers; a wipe that does not end the game runs them in seeded-shuffled
   order after all destructions.
7. An expired summon (pending-effect timer at 0) is destroyed through the
   normal path and fires death triggers like any other destruction.
