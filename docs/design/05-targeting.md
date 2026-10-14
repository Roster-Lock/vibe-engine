# 05 — Targeting & Zones

> Status: ✅ direction decided.

## Decisions

- ✅ **Targeting pools draw from the play zone only.** Dead characters live
  in the garbage and are not in the pool — no per-spell "cannot target
  dead" checks, and the "fireball a corpse" problem dies by construction.
- ✅ **Revive is the explicit exception**: a dedicated effect moves a
  character garbage → play (see 01-entities). If garbage-scoped
  abilities ever need it, a pattern-level `allowGraveyard` flag can be added
  — the zone abstraction keeps that door open without special-casing.
- ✅ **Targetability is part of the "cannot be X if Y" restriction system**
  (see 11-restrictions): a status declares `on: 'target'` with a condition —
  "cannot be targeted if the source is an enemy" (hexproof-style), "cannot
  be targeted at all" (shroud-style) — enforced as a hard filter in
  `validTargets`, **after** the existing `include` override.
- ✅ **Named overrides**: a rule can only be broken by an exception that
  explicitly names it ("can be targeted even if it has hexproof"). The
  existing `include` field is the primitive that punches through; rule gates
  must decide whether `include` punches through them or whether the override
  must be explicit — proposal: explicit, so immunity is meaningful.
- ✅ **Ally/enemy is derived at use time from controllers** (see
  01-entities), so a control swap re-derives teams without re-targeting
  anything. Patterns are evaluated when an ability is used, so they always
  see current control.

## Open

- 🔶 **Graveyard-scoped abilities** (reanimate from the garbage, count dead
  characters) — future. The zone abstraction should stay queryable
  (`engine.charactersIn('garbage')`) so these are easy to add.

## Engine implications

- `engine.ts`: `validTargets` filters to the play zone and gains a
  `canBeTargetedBy` gate after `include`; a hard rule filter with named
  overrides.
- Zones: minimal `play` / `garbage` containers owned by the engine;
  characters move between them on destroy / summon / revive.
