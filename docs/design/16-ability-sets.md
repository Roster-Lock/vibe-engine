# 16 — Ability Sets, Spellbooks & Toggles

> Status: 🔶 design only, nothing implemented. Motivated by input limits
> (hotkeys, and a gamepad's much smaller set) rather than by rules.
>
> Builds on `Available while …` / `GameEngine.canUse`
> ([15-zones](15-zones.md) and docs/creator/01-ability-language.md), which
> solve a *different* problem — see "Two different problems" below.

## What a spellbook is

Warcraft 3's model, which is the one to copy:

```
page 0:  [spellbook] [heal] [brilliant aura]
  click spellbook →
page 1:  [fire book] [ice book] [teleport] [exit]
    click fire book →
page 2:  [immolation] [volcano] [flame strike] [exit]
      click immolation → immolation toggles on
```

Three things follow from that, and the first is the load-bearing one.

### A spellbook changes the *view*, not the unit

Clicking a book does not add, remove, grant or revoke anything. The hero
has every one of those abilities the whole time. What changes is **which
page of them the input surface is showing**.

So the ability set is a **tree**: books are interior nodes, abilities are
leaves, and the player holds a **cursor** into it. Nesting is what buys
reach — three pages of four buttons addresses twelve abilities with four
hotkeys, and the depth costs clicks rather than bindings.

### The cursor is host state, not game state

The engine must **not** own it.

A rule should never depend on how many clicks a human needed to reach an
ability. An AI or a scripted player names the ability it wants directly;
a replay records "used Immolation", not "opened the book, opened the fire
book, clicked slot 1". If the cursor were game state, those three would
disagree and the engine would have to adjudicate navigation — which is not
a game rule.

Consequence: **navigating is not an action**, emits no event, and cannot be
intercepted. A game that *wants* navigation to cost time (a real
command-card delay) models that as a cooldown on the book's own activation,
not by making the cursor authoritative.

### The tree *is* content

It travels with the hero. Two players sharing a hero share its
organization, so the tree belongs in the IR next to the abilities — not in
a host's UI config.

That makes it an unusual category worth naming: **content the rules ignore
and the input surface obeys.** The engine stores the tree and never
consults it; `canUse` must stay true for a nested ability regardless of
where the cursor is, or an AI could not play the hero.

## Two different problems

`Available while …` and spellbooks look similar and solve opposite halves:

| | Changes | Answers |
| --- | --- | --- |
| `Available while …` | whether **this slot** is lit | "can I use it right now?" |
| a spellbook | **which slots exist** | "can I reach it right now?" |

They compose: a book may itself be `Available while …` (locking a whole
page), and a leaf inside a book has its own availability. Neither subsumes
the other.

This also refines the "stable binding" argument that motivated
availability: a slot is stable **within its page**. That is still what the
hotkey needs — page 2 slot 1 is always Immolation — and it is why a
*granted* ability is still the wrong shape even with books, since it would
shuffle the page it appears on.

## Shape

```typescript
/** A node in a unit's ability set. */
type AbilitySlotIR =
  | { kind: 'ability'; ability: AbilityIR }
  | {
      kind: 'book';
      id: string;
      name: string;
      /** A whole page can be locked, like any single ability. */
      available?: PredicateIR;
      slots: readonly AbilitySlotIR[];
    };
```

- **`exit` is generated, not authored.** Every non-root page has one; an
  author writing it would be able to forget it, and a page with no way out
  is a soft-lock rather than a design.
- The root page is the unit's kit. Depth is unbounded; a cycle is a
  compile error (the tree is declared, so it is checkable statically).
- The host keeps `cursor: string[]` — the path of book ids — and renders
  `slots` at that path. "Exit" pops. Nothing else needs to exist.

## Toggles

The example's last line is a fourth ability kind, not a variant of the
three that exist (`manual` fires once, `trigger` listens, `passive`
rewrites):

> click immolation → immolation is **toggled**

A toggle has **persistent state** and one slot that means two things. Its
natural spelling is the buff it maintains: on = the buff is attached, off =
it is not, so there is no toggle state to keep anywhere.

```
Buff Immolation Aura
when the turn starts, deal 2 damage to all enemy characters.

Ability Immolation
Toggle Immolation Aura.
```

**Status: ✅ implemented** — `Toggle <buff>.` / `Toggle <buff> on
<characters>.`, lowering to a `toggleBuff` effect
(`src/ir/ability.ts`), covered by `test/toggles.test.ts`.

It is **one effect**, not two guarded steps, and the reason is worth
keeping: steps resolve one at a time *with effects landing between them*,
so "if it has it, remove it" followed by "if it does not, add it" removes
and then immediately re-adds — the toggle is stuck on. There is a test
asserting exactly that, so the justification cannot quietly rot. Deciding
once, per entity, from the state before anything applies is what makes it
a toggle; a group toggle therefore does opposite things to two entities in
the same effect.

Worth noting what the buff then buys for free: WC3's immolation drains
mana while active, which is a `when the turn starts` trigger on that buff —
already expressible, and tested. And a toggle that should switch itself off
when the mana runs out is a `GaugeBuffGate`, which the engine already has.

## Decided

- ✅ **Opening a book is free.** No cost, no cooldown, no cast time — as in
  WC3. Costs may arrive later, so a book carries the same cost slot an
  ability will when costs exist; it is simply empty.
- ✅ **A toggle's off-switch is free.** Switching off costs nothing and
  refunds nothing. Again a later cost would go in the same place, rather
  than needing a second concept for "cost to cancel".
- ✅ **The cursor does not reset itself.** Navigation is symmetric and
  explicit: the player goes in, and the player exits. Nothing — end of
  turn, taking damage, deselecting — pops a page on their behalf. The
  virtue is predictability: a button means the same thing until the player
  changes what it means.
- ✅ **Multi-select does not merge kits.** No intersection, no flattening
  of leaves. A mixed selection lets the player pick a **unit type**, and
  the command card is then that type's tree — the WC3/SC2 model. This
  removes the problem rather than solving it: there is never more than one
  tree on screen, so a book's slots never have to agree with another
  unit's.

## Open

- 🔶 Whether the cursor is remembered **per unit** or per selection, given
  it never resets on its own. Per unit is the more useful reading of
  "go in, then exit", but it is a host decision either way.
