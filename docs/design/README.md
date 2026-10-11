# TinyQuest — Design Docs

Durable record of design decisions for the TinyQuest engine. Each file covers
one topic: what was decided, why, how it changes `src/engine`, and what is
still open.

> Looking for the **build spec** — a complete description of each part of the
> engine, ordered so it can be implemented from zero to completion? See
> [`docs/spec/`](../spec/README.md). These docs are the decision record; the
> spec is the buildable map.

> Decisions here **supersede the implementation where they conflict**. The
> engine is a living prototype — the current code still has `character.team`,
> no zones beyond play/graveyard — and these docs are the map for where it is
> heading. The README's "Design decisions worth knowing" section describes the
> engine *as built today*; these docs describe the target model.

## Implementation status

- ✅ **Slice 1 (destroy core) built** — `destroy` action, graveyard zone,
  simultaneous batch destruction, `character:destroyed` event with a
  `reason`, win/lose-first ordering, corpse-proof targeting, `canDestroy`
  gate hook (always `true` until restrictions land). Tests:
  `test/destroy.test.ts`.
- ✅ **Slice 2 (trigger queue) built** — events queue their triggers; the
  queue drains after the resolution unit (a move's apply / a turn hook) in
  seeded-shuffled FIFO order; game-end short-circuits the drain; queue-size
  depth guard. Tests: `test/trigger-queue.test.ts`.
- ✅ **Slice 3 (restrictions) built** — "cannot be X if Y": the
  `restriction(...)` ability kind (a status's `abilities` list), gauge
  `intent`, four gates (targeting / destroy / actions-before-transformers /
  win-lose), named exceptions (`include`, `bypasses`), destroy-gate-aware
  "dead" predicate (indestructible at 0 HP keeps its owner in the game).
  Tests: `test/restrictions.test.ts`.
- ✅ **Slice 4 (content SBA registry) built** — `addStateBasedRule` with
  the pass loop, no-change termination, and depth guard (Overbuff /
  Empty Mana Well). Tests: `test/sba.test.ts`.
- ✅ **Transform stack built** (01 "Identity vs form") — the `transform`
  action swaps a character's *form* (skills, gauge maxes — current clamps —
  name, icon) while the identity and buffs persist; transforms stack keyed
  by **source** (a buff key pops — reverting the form — on that buff's
  removal; a character source is permanent); the transformed base is what
  `maxModifier` contributions derive from; a `on: 'transform'` restriction
  ("cannot be transformed") gates the action before transformers. Tests:
  `test/transform.test.ts`, example: `src/examples/transform.ts`
  (`npm run example:transform`).
- ✅ **Ties, direct pop, and the "hex holds" SBA** (01 "Transform stack") —
  the `transformModifier` ability ties a buff to a form ("while attached,
  the wearer's form is this"; removal reverts); a live tie **pins** the
  form above later pushes — an attempted push under a hex is recorded but
  never shown, surfacing when the hex ends (a state-based rule: pinning is
  automatic in the form fold, ties fold in buff-stack order — the strongest
  hex shows — and the form-stack SBA step at each settle pops dangling
  ties); the `popTransform` action undoes the current effective
  transformation directly, but a live tie **refuses** it (the hex holds;
  only removing the buff ends it). Same tests/example.

## Status legend

- ✅ **Decided** — the direction is chosen; implementation may still be pending.
- 🔶 **Open** — under discussion; a call is needed.
- ⏳ **Deferred** — consciously parked; revisit later.

## Index

| Doc | Topic | Status |
| --- | --- | --- |
| [01-entities.md](01-entities.md) | Character model: owner/controller, dead state + graveyard, identity vs form, summon | ✅ direction; 🔶 revive details |
| [02-destroy.md](02-destroy.md) | `destroy` action, HP→destroy rule, simultaneous destruction, game-end ordering | ✅ |
| [03-win-lose.md](03-win-lose.md) | Teams on players, ownership-based defeat, `countsForDefeat`, countdown win/lose | ✅ |
| [04-sba.md](04-sba.md) | State-based action framework + layer ordering | ✅ direction; 🔶 "gauge changes" layer |
| [05-targeting.md](05-targeting.md) | Targeting pools over zones, rule gates, named overrides | ✅ direction |
| [06-damage.md](06-damage.md) | Multi-instance damage, armor as per-hit absorption | ✅ |
| [07-auras.md](07-auras.md) | Aura scope + membership rescan | ✅ |
| [08-countering.md](08-countering.md) | Countering: pending effects (charge/channel/stun) | ✅ direction; deep design in 10 |
| [09-countering-prompt.md](09-countering-prompt.md) | Self-contained prompt for the countering discussion | — |
| [10-pending-effects.md](10-pending-effects.md) | Pending-effects registry: charge, channel, stun, timers | ✅ |
| [11-restrictions.md](11-restrictions.md) | "Cannot be X if Y": targeting/destroy/gauge/win-lose gates, named overrides | ✅ built (slice 3) |
| [12-replacement-effects.md](12-replacement-effects.md) | "Prevent X, instead Y" (last breath); once-per-chain rule | ⏳ deferred |
| [13-restrictions-prompt.md](13-restrictions-prompt.md) | Self-contained implementation prompt for the restrictions slice (11) | — (implemented; decisions in 11) |
| [14-derived-stats.md](14-derived-stats.md) | Named stats derived from a base plus `stat` contributions — including **functions of the game state** ("toughness equals creatures you control"), and the world-state refresh schedule | ✅ built |
| [15-zones.md](15-zones.md) | Entities, zones as data, `move` as an Action (destroy becomes a special case), temporary piles, the choice protocol, and where extended vocabulary plugs in | ✅ direction; 🔶 entity weight in hidden zones |
| [17-extension-system.md](17-extension-system.md) | The extension system: open `GameEventMap`/`ActionMap` by declaration merging, the action registry, `ActionBase`, and what moves out of the core into a turn-based-combat layer | ✅ built — the engine names no game concept |

## Deferred (parked, revisit later)

- **Costs** — mana costs, taps, sacrifices as declared data. Explore after
  the action vocabulary settles.
- ~~**Zones beyond play/graveyard** — no hand/deck/exile for now.~~
  **Un-deferred** — see [15-zones.md](15-zones.md): zones generalize into the
  core (declared as data), and `move` becomes an Action.
- **Attack wrapper / per-hit events** — multi-action damage is enough; revisit
  if on-hit triggers proliferate (see 06-damage).
- **Items / equip** — no items yet; the transform stack is designed to be
  item-driven later (see 01-entities).
- **Despawn as a distinct rule** — `destroy` covers it; expired summons go
  through the normal destroy path and fire death triggers.
- **Avatar-style defeat conditions** — a summon that *becomes* the owner's
  defeat condition; noted in 03-win-lose.

## Decision log (how we got here)

1. **Exploration** — question: what creative space can the current engine not
   express? Answer: "exceptions to a rule" (cannot be targeted / cannot be
   destroyed), plus a broader action vocabulary, costs, countering, zones,
   auras, and content-defined state-based actions.
2. **The action vocabulary pass** — decisions on destroy, summon, despawn,
   revive, control swap, transformation, attach/equip (see 01/02/03).
3. **The countering pass** — direction: time-based counterplay (charge-up /
   channel / stun / balloon pop) instead of a stack; deep design deferred to
   its own discussion (see 08/09).
4. **Damage** — math-only model, no resistance tables; armor = flat
   absorption per hit (see 06).
5. **This pass** — teams move to players, ownership-based defeat,
   `countsForDefeat`, graveyard zone, transform stack, SBA layer ordering
   (see 03/04/05/07).
6. **The restrictions pass** — "cannot be X if Y" as the unified exception
   system (targeting, destroy, gauges, win/lose); content-registered SBAs
   (buff-count win, empty-mana heal); win/lose is gated (last breath =
   "if you would lose, prevent instead"); layers 3–4 proposed as automatic
   invariants (see 04/11).
7. **The countering deep-dive** — the pending-effects registry, charge /
   channel / stun semantics, events, guardrails, and the implementation
   plan (see 08/10).
8. **The destroy/SBA answers** — "dead for win/lose" consults the
   destroy-gate (indestructible at 0 HP keeps its owner alive); triggers
   are queued and drain after the current resolution completes (game-end
   short-circuits the drain); replacement effects ("prevent X, instead Y")
   are their own deferred topic with a once-per-chain rule (see
   02/03/04/12).
9. **The zones pass** — driven by building `examples/card-game/`, which had to
   invent its own deck/hand/discard because the engine's zones are two
   hard-coded `Set<Character>` fields. Decision: **generalize** rather than
   add a parallel pile mechanism — an `Entity` base, zones declared as data,
   and `move` as an Action, so replacement effects, events, restrictions and
   batching all apply to zone changes for free and `destroy` becomes a
   special case. Fact or Fiction is the acceptance test. Extended vocabulary
   is answered in the same doc: open the `DeclaredFn` node registry, keep the
   `Action` union closed for now (see 15).
