# 08 — Countering

> Status: ✅ decided. The full deep design lives in
> [10-pending-effects.md](10-pending-effects.md); this doc records the
> direction and the seed ideas that shaped it.

## The decision

Counterplay is **time-based, not stack-based.** Instead of priority windows
and responses (MTG), abilities become counterable by creating *time*:
charge-ups, channels, and timers give the defender room to react with
ordinary game actions. This fits the turn loop, avoids a full stack
implementation, and is WC3-native (Rain of Fire waves, interruptible
channels).

## The seed ideas (from discussion)

- **Charge-up** — using an ability doesn't resolve it; it enters a charging
  state and resolves after N turns. Defenders act during the window.
- **Channeled actions** — the ability re-fires each turn (Rain of Fire
  waves) until interrupted or its duration ends.
- **Stun** — a status that (a) blocks the owner from acting (a `canAct` gate
  in `useAbility`) and (b) cancels the owner's charging/pending effects.
- **"Balloon pop"** — charging stores energy; removing the charge wastes the
  turns spent. Pending effects are removable objects with removal hooks,
  like buffs.
- **Temporary weakness / invulnerability** — ordinary buffs applied with
  timing; fully supported once charge-up creates the window.

## The shared subsystem: pending effects

One registry powers charge-up, channeling, summon timers, transform
duration, countdown win/lose (03), and delayed effects. The registry, its
tick points, charge/channel/stun semantics, events, counterbalance
guardrails, edge cases, and scope are fully designed in
**[10-pending-effects.md](10-pending-effects.md)** — the shape sketched
below was the starting point and is superseded by 10.

```
pending effect = { id, owner, due (turns), kind, payload, removable }
```

## Where we landed (summary)

- One registry, mutated only by actions (`pendingEffect` add/remove).
- Two tick points per round (round-start: deadline countdowns — charges,
  countdown win/lose; round-end: durations — stun, summon timers, channel
  waves), each before the corresponding `turn:start` / `turn:end` event.
- Charges: targets frozen at cast, resolve before moves, caster free;
  interrupted by stun / death / control-swap / transform / dispel — not by
  damage.
- Channels: waves at round-end, caster locked while channeling, same
  interrupts.
- Stun: composes two separable primitives — a `blocksActing` status (the
  `canAct` gate) and the `cancelConcentration` action (pops the owner's
  charges/channels on apply) — plus a registry duration, refresh-not-stack,
  cleanseable.
- Targets are a list: frozen at cast, validated per-target at resolution
  (multi-target charges land on whoever is left).
- Visibility is public by default: "Goblin is charging Fireball — 2 turns"
  is a first-class UI event.
