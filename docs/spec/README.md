# TinyQuest — Build Spec

A complete, self-contained description of every part of the TinyQuest
engine and how it works, ordered so that an AI or a human can implement it
**from zero to completion**. Each doc covers one part: behavior,
interfaces, rules, and acceptance criteria.

> **Why this exists:** the engine serves the goal in
> [`docs/GOAL.md`](../GOAL.md) — players create heroes/abilities/buffs
> and share them. This spec is the engine half of that goal; the
> creator-surface half (language, editor, share format) is tracked there.

> **Baseline: target model.** This series describes the *target model*
> defined in [`docs/design/`](../design/README.md) — ownership-based teams,
> zones, `destroy`, restrictions, pending effects, auras — even where the
> current `src/engine` code has not caught up yet. Where this spec and the
> code disagree, **this spec is the truth**.
>
> Scope: **engine core only**. The UI, multiplayer wrappers, and example
> content are consumers of this engine, not parts of it.

## Start here

- **[00-overview.md](00-overview.md)** — the mental model, the target-model
  summary, the **build plan** (slices 0–10 with acceptance criteria), global
  invariants, and the spec defaults that resolve the design docs' open
  questions.

## The parts

| Doc | Part of the game | Slice |
| --- | --- | --- |
| [00-overview.md](00-overview.md) | Mental model, build plan, invariants, defaults | — |
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

## Design references

The decision record behind this spec: [`docs/design/`](../design/README.md)
(01 entities · 02 destroy · 03 win/lose · 04 SBA · 05 targeting · 06 damage
· 07 auras · 08 countering · 10 pending effects · 11 restrictions · 12
replacement effects). Where a spec doc says "see docs/design/NN", that doc
has the rationale; the spec has the buildable rules.
