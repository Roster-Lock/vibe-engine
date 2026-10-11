# 12 — Replacement Effects: "Prevent X, Instead Y"

> Status: 🔶 deferred — the direction is recorded here; not part of the
> destroy/SBA slice.

## The idea

A replacement effect rewrites an event that *would* happen:

- *last breath* — "if you would lose the game, prevent that loss instead";
- *redirect* — "if damage would be dealt to you, prevent it and gain life
  instead" (MTG);
- *sacrifice swap* — "if a character would be destroyed, destroy its
  summoner instead".

This is distinct from restrictions (11): restrictions **block** ("cannot be
X"); replacements **redirect** ("X becomes Y instead").

## The problems (from discussion)

1. **Multiple watchers** — several effects can watch the same event: two
   "prevent loss" effects, or one on each side of the conflict.
2. **Chains** — replacement effects can feed each other:

   ```
   prevent damage, summon golem
   prevent summon, deal damage
   ```

   The two effects ping-pong forever — an infinite loop of replacements.

## The decided rule

**Each replacement effect emits at most once per chain.** When a would-be
event is being rewritten, every eligible replacement effect may apply, but
each individual effect applies **at most once** to that event's chain of
rewrites. A chain is therefore bounded by the number of distinct eligible
effects — no infinite loops by construction (the engine's depth cap remains
as a backstop).

TBD when implemented: how competing replacements choose among themselves.
Proposal (mirroring MTG): the affected player/owner chooses, with a
deterministic seeded tie-break.

## The recheck rule (decided)

After a replacement effect resolves, the engine **rechecks the underlying
state** — the pass re-runs, win/lose first. A replacement only prevents a
loss if it *changes the state that caused it*:

- **Board-wipe loss** — "you lose: no living characters". Last breath
  "prevent instead: revive your last character at 1 HP" changes the state →
  the recheck finds a living character → saved.
- **Condition loss** — "you lose when death counters ≥ max" (a warlock
  curse). Last breath fires, but the replacement did not touch the death
  counters → the recheck finds death counters still ≥ max → **you still
  lose**.

So a last-breath effect that does not fix the cause is a delay at best, and
usually nothing at all — it cannot launder a condition-based loss into a
survival. Last breath is for *state-based* losses (a board wipe) whose cause
the replacement actually removes.

## Scope

- **Deferred**: not in the destroy/SBA slice; last-breath mechanics are not
  being built yet.
- The motivating case ("if you would lose, prevent instead") is a *future*
  capability; plain "cannot lose the game" gates (no "instead" clause)
  remain simple restrictions (11).
- The action pipeline's transformers already rewrite actions without
  re-entering the pipeline, so they cannot self-loop; the once-per-chain
  rule applies to **event-level** replacements.
- **In-pipeline replacement is shipped**: `replaceAction(match, build)`
  swallows the old action and emits a new one in its place (the original
  never continues; the replacement stays in the same pipeline position —
  no re-entry, no re-gating). The ready-made `redirectGauge(from, to,
  opts)` turns damage into mana loss with `direction` / `intent` filters.
  See [spec 03 §5](../spec/03-actions.md#5-transformers--the-pipeline).
