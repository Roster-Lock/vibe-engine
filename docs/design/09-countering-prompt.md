# Countering — Discussion Prompt

> **How to use:** copy everything below the divider into a fresh discussion.
> It is self-contained — the project context and current engine model are
> summarized here, so the new discussion does not need any prior context.

---

## Project context

I'm designing **TinyQuest**, a tiny, content-creator-friendly game engine
(TypeScript) for a turn-based hero/creature battle game. Design inspirations:
Magic: The Gathering (rules depth, exceptions, triggered abilities) and
Warcraft 3 (heroes, buffs, active/passive abilities). A long-term goal is an
English-readable DSL so creators can write cards/heroes like
"Fireball — deal 3 damage to target enemy."

Engine goals: **flexible enough for unique abilities**, built from a small
set of composable primitives.

## Current engine model (brief)

- **Actions** are the only way game state changes (5 kinds: gauge current,
  add/remove buff, win, lose — a gauge's **max** is never an action, it is
  derived from attached statuses' `maxModifier` contributions).
- Every action flows through **transformers** (passive modifiers) on the
  source (outgoing) then the target (incoming), ordered by weight — the
  replacement-effect mechanism.
- **Triggers** — abilities listen to events (auto/prompt), gated by a
  prestack filter, run in seeded-shuffled order, depth-capped against
  infinite loops.
- **Statuses** — buffs (addable/removable, lifecycle hooks) and skills
  (permanent) attach abilities to a character.
- **Turn loop** — each round players decide; moves run in speed order
  (descending, ties seeded); then `turn:end` → next round.
- **Targeting** — patterns (`who` / `match` / `negate` / `include`) filter
  the pool.
- **Win/lose** — state-based: a player loses when their owned characters are
  dead; last team standing wins; simultaneous wins/losses are draws.
- Determinism guarantee: same seed + same state ⇒ same outcome.

## Decisions already made (context, not up for debate)

1. **Time-based counterplay, not a stack.** No MTG-style priority/responses.
   Instead, abilities become counterable by creating *time*: charge-ups,
   channels, and timers give defenders room to react with ordinary game
   actions.
2. One **pending-effects registry** is the shared subsystem for: charge-up,
   channeled actions, summon expiration timers, transform duration,
   countdown win/lose effects, and delayed/scheduled effects.
3. Seed ideas to explore (from an earlier discussion):
   - **Charge-up**: using an ability doesn't resolve it; it charges for N
     turns, then resolves. Defenders can react during the window.
   - **Channeled**: the action re-fires each turn (Rain of Fire waves).
   - **Stun**: a status that blocks acting and cancels the owner's
     charging/pending effects.
   - **"Balloon pop"**: dispelling/removing a charge wastes the turns spent
     charging.
   - **Temporary weakness / invulnerability**: ordinary buffs applied with
     timing (already supported).

## What I want from this discussion

1. **Design the pending-effects registry.** Shape, lifecycle, how it ticks
   with the turn loop, how it interacts with speed/initiative (does a charge
   resolve at the start or end of a turn? before or after that round's
   moves?), how it is cancelled/removed, and what events it emits (UI:
   "Goblin is charging Fireball — 2 turns").
2. **Charge-up semantics.** What can interrupt a charge (stun only? damage?
   the caster's death?), what happens to a charge if the caster is
   control-swapped or transformed, whether charges persist across turns
   without acting, and whether multiple charges can run at once.
3. **Channeled semantics.** How waves are scheduled, what interrupts a
   channel (same interruptors as charges?), and whether the channeler can
   act while channeling.
4. **Stun semantics.** Full scope: block acting only, or also block
   triggered abilities? Does stun cancel charges permanently or pause them?
   Stacking, duration, and removal by cleanse?
5. **Counterbalance.** These mechanics must be fun, not frustrating: how do
   defenders learn what's coming (visibility), how do casters protect
   charges (uninterruptible charges? shields?), and what are the failure
   modes (stun-locks, uninteractive wins)?
6. **Edge cases.** Two charges expiring at the same tick, charges whose owner
   dies, game-end during a charge (win/lose resolves first — already
   decided), seeded reproducibility (charges must not add nondeterminism),
   and the action-depth guard (no infinite charge→resolve→charge loops).
7. **Scope check.** What is *not* counterable and why — and what should be
   explicitly excluded to keep the engine simple.

## Constraints

- Content-creator-friendly: primitives must be small and composable; the
  DSL (later) should express "charges for 2 turns" as a keyword.
- Determinism: same seed + same state ⇒ same outcome (existing guarantee —
  preserve it).
- No infinite loops: everything depth-capped like existing triggers.
- Fits the existing architecture (actions / transformers / triggers / status
  list) rather than replacing it.

## Deliverable

A design for the pending-effects subsystem plus charge/channel/stun rules
that I can turn into design docs and implement incrementally.
