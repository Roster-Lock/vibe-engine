# 01 — Entities & Lifecycle

> Status: ✅ direction decided; implementation pending. 🔶 a few details open.

## The model

A **Character** is one game entity. It has a stable **identity** (the object
everyone references — buffs, triggers, targeting) and a mutable **form**
(skills, gauges, name). Create/Destroy is the primitive lifecycle rule (see
02-destroy); HP is a character-specific input to it.

## Decisions

- ✅ **`Character.team` is removed.** Teams live on `Player`s. Ally/enemy is
  derived from **controllers**: same controller ⇒ ally; different controllers
  with the same player team tag ⇒ ally.
- ✅ **Characters have `owner` and `controller`** (distinct):
  - `owner` — the `Player` who owns this character **for defeat purposes**.
  - `controller` — the `Player` who plays it right now.
  - Control swap changes `controller` (and therefore which team the character
    fights for) but **never `owner`** — a stolen character keeps its original
    owner alive.
- ✅ **`countsForDefeat`** — whether this character's death counts toward its
  owner's defeat. Default `true` for player-created characters, `false` for
  summons, overridable per summon (an "Avatar" summon can count; "bugs" that
  spawn by the hundred do not). See 03-win-lose.
- ✅ **Dead state + graveyard.** Characters in **play** are alive; destroyed
  characters move to the **graveyard**. Targeting pools draw from play only —
  no per-spell "cannot target dead" checks needed. This was chosen over
  keeping dead and alive characters in one list and excluding dead ones per
  ability (the "fireball a corpse" problem dies by construction).
- ✅ **Revive is a dedicated effect**, not heal-on-corpse: moves a character
  graveyard → play, restores HP, emits `character:revived`.
- ✅ **Identity vs form (transformation).** The Character object is never
  replaced. A transform swaps the *form*: skills/abilities, gauge maxes
  (current clamps to `Math.min(current, newMax)`), name/icon. Buffs persist
  across the swap — and so does **skill state**: a form that leaves the
  effective form and returns gets its same skill instances back, `vars`
  intact, not fresh copies.
- ✅ **Transform stack.** Transforms stack, keyed by **source** — an item
  applies a transform; removing the item pops it, reverting the form. Knowing
  the original is therefore built in: the stack is applied over the base
  form. Stack *manipulation* (searching, reordering, replacing entries) is its
  own future feature.
- ✅ **Direct pop.** A `popTransform` action undoes the current effective
  transformation — an opponent pops the "Demon" state and the character
  returns to the previous state. A **live tie refuses the pop**: while a
  buff-tied form is active, the state-based rule re-asserts the buff's
  transformation — the hex holds; the buff is removed only by a removal
  action.
- ✅ **Ties pin the form (a state-based rule).** A transform keyed by a buff
  that is attached when pushed is a **tie** — "buff attached ⟺ form active".
  The declarative `transformModifier` ability ties a buff to a form directly:
  adding the buff pushes it, removing it pops it ("the hero is hexed; removal
  of the buff returns them to normal"). While a tie is active it **pins** the
  character's form above every other transformation: an opponent attempts to
  push "Demon form" on the hexed hero, the attempt is recorded underneath,
  and — because the hex's buff is active — **the buff's transformation is
  what the character is**; when the hex ends, the Demon surfaces. Pinning is
  automatic (the form fold treats live ties as dominant), and a form-stack
  SBA step at each settle pops any dangling tie (keying buff gone by a
  bypass path). Stacked ties fold in **buff-stack order** (the keying
  buff's `weight` ascending, stable): the *most outgoing* hex — the
  strongest, or the last-applied among equals — is the current
  transformation; a weaker hex pushed under a stronger one changes nothing
  and surfaces only when the stronger hex ends.
- ✅ **Summon.** A `summon` action creates a Character at runtime, lands it in
  the play zone, and emits `character:summoned` (the aura-rescan hook, see
  07-auras). Expiration is a **timer** (pending effects, see 08-countering)
  that destroys the summon at 0 through the normal destroy path — expired
  summons fire death triggers like any other destruction.
- ✅ **"Dies with summoner" is an ability**, not a built-in rule — a trigger
  on the summoner's `character:destroyed` event that destroys the summon.

## Open

- 🔶 **Buffs through death and revival** — does a character keep buffs
  declared `removedOnDefeat: false` across death and revival? Proposal: yes —
  only on-defeat buffs leave at death; the rest are still there when it
  comes back.
- 🔶 **Revive HP** — full, half, or caster-defined?
- 🔶 **Graveyard order/visibility** — proposal: a simple ordered list
  (destruction order) for now; queryable later for reanimate-style abilities.

## Engine implications

- `character.ts`: drop `team`; add `owner`, `countsForDefeat`, a `dead`
  flag, and zone membership (play/graveyard).
- `player.ts`: stamp `owner` (and `controller`) at construction; keep
  `characters` as the **ownership** list; `isDefeated` = every owned
  `countsForDefeat` character is dead.
- `engine.ts`: `isAlly`/`isEnemy` derive from controllers and player teams;
  new events `character:summoned`, `character:revived`,
  `character:controlChanged`, `character:transformed` (with the form and
  `reason: 'pushed' | 'popped'` — a push or a revert),
  `character:destroyed`; new actions `summon`, `control`, `transform`,
  `revive`.
