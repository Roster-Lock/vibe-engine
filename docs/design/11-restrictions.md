# 11 — Restrictions: "Cannot be X if Y"

> Status: ✅ built (slice 3).

## The idea

Instead of a flat "cannot be targeted" flag, rules are **restrictions**: a
status declares *what* is blocked and *under what condition*. The condition
(the "if Y") considers **why X is happening** — who the source is, what kind
of attempt it is, and (for gauge changes) whether it is damage, healing, or a
set.

Examples of the family:

```
Cannot be targeted     if the source is an enemy        (hexproof / spell immunity)
Cannot be destroyed    if the destroy would come from a spell
Cannot have HP changed if the change is damage          (but healing is fine)
Cannot have HP changed at all
Cannot be buffed       if the buff is an enemy's
Cannot be controlled
Cannot be revived
Cannot lose the game   (player-level gate — see 03-win-lose)
Cannot win the game    (the opponent's side)
```

> Note: "cannot lose / cannot win" here are **simple blocks**. The stronger
> form — "if you would lose, *prevent that loss instead*" (last breath) — is
> a replacement effect, not a restriction: see
> [12-replacement-effects.md](12-replacement-effects.md) (deferred).

## Shape

A restriction is a **kind of ability**: statuses carry it in their
`abilities` list, built with `restriction(...)` like any other ability
(transform hooks, event listeners, restriction predicates — one list, one
story: "what this status does").

```ts
import { restriction, buff } from 'tinyquest';

buff({
  name: 'Indestructible',
  weight: 1,
  abilities: [restriction({ on: 'destroy' })],
});
```

```ts
interface RestrictionDef {
  /** What is being blocked. */
  on: 'target' | 'destroy' | 'gauge' | 'buff' | 'control' | 'revive' | 'lose' | 'win' | ...;
  /** The "if Y" — absent means always. */
  when?: (ctx: AttemptContext) => boolean;
}

interface AttemptContext {
  self: Character;                             // the gate's subject (the would-be target)
  source: EventSource | undefined;             // who is doing X
  sourceCharacter: Character | undefined;      // the source's character (or buff's caster)
  // gauge attempts:
  gauge?: Gauge;
  intent?: 'damage' | 'heal' | 'set' | 'other';    // see 06-damage
  // targeting attempts:
  pattern?: TargetPattern;
  ability?: Ability;
  engine: GameEngine;
}
```

Why an ability? A restriction is conceptually a *passive gate* — "attempts
against my wearer matching this predicate are refused" — which is exactly
the same grant shape as the other ability kinds (the status lends it to its
wearer while attached). The one real difference is that a restriction never
*runs*: it is a pure, synchronous, side-effect-free predicate (no RNG —
determinism holds) consulted by the engine's gates, so it returns a verdict
instead of actions. Keeping it an ability means content authors write one
`abilities` list instead of juggling a parallel `restrictions` list; the
gate machinery (`firstBlockingRestriction` in `src/engine/restrictions.ts`)
is what walks that list differently.

The engine consults them at each gate:

- `validTargets` / `useAbility` — for `on: 'target'`;
- the destroy phase and `destroy` actions — for `on: 'destroy'`;
- the action pipeline (before transformers) — for `on: 'gauge'`, `'buff'`,
  `'control'`, `'revive'`, …;
- the win/lose resolution — for `on: 'lose'` / `'win'` (see 03-win-lose).

## Resolution rules

- **"Can't beats can"** — a matching restriction blocks the attempt,
  period. Blocked `destroy` ⇒ the character stays (and the HP→destroy rule
  is gated too). Blocked gauge ⇒ a no-op write. Blocked targeting ⇒ the
  character leaves the pool.
- **Named exceptions pierce** — an effect may explicitly say "this gets
  through anyway" ("can be targeted even if it has hexproof", "destroy it
  anyway"). The existing `include` targeting field is the primitive for
  targeting; destroy/gauge exceptions declare the same way, and the
  exception **must name the rule it beats** — that is what keeps the
  priority checkable.
- **Restrictions gate before transformers** — if a character cannot take
  damage, armor has nothing to absorb. "Can't beats can" stays global; a
  blocked action is a no-op, and transformers never see it.

## Engine implications

- `actions.ts`: gauge actions gain a declared `intent` (`damage` / `heal` /
  `set` / `other`) so "cannot be damaged but healing is fine" is checkable.
  The sugar builders (`damage`, `heal`, `setGauge`, `changeGaugeBy`) stamp
  it; raw `{ type: 'gauge', update }` actions default to `other`.
- A single gate function on the engine — `attemptBlocked({ kind, target,
  ctx })` — collects the target's restrictions and returns the blocking
  one. Every gate above uses it, and the UI/log uses it for "why can't I do
  that" feedback.
- A blocked attempt is a **no-op, not an error** — same spirit as today's
  "non-stackable duplicate buffs are silently ignored". (Blocked targeting
  at `useAbility` should still explain itself to the player.)

## Implementation

Built (slice 3). The restriction **ability** lives in
`src/engine/ability/restriction.ts` (the `restriction(...)` builder, plus
`RestrictionKind` and `AttemptContext`); the gate machinery that walks it
lives in `src/engine/restrictions.ts`, and the gates themselves on
`GameEngine` (`src/engine/engine.ts`):

- The `restriction(...)` ability on buff **and** skill declarations —
  statuses carry it in their ordinary `abilities` list (`status.ts`). A
  restriction's `when` reads an `AttemptContext` whose `self` is the
  character whose restrictions are consulted — the gate's subject (the
  would-be target). Every `when` is a pure predicate: no RNG, so
  determinism holds.
- Gauge `intent` on `GaugeAction` (`'damage' | 'heal' | 'set' | 'other'`).
  The sugar builders stamp it: `damage` → `'damage'`, `heal` → `'heal'`,
  `setGauge` → `'set'`, `changeGaugeBy` → `'other'` (a generic movement —
  use `damage`/`heal` for those semantics); raw `{ type: 'gauge', update }`
  actions normalize to `'other'` at the gate.
- `GameEngine.attemptBlocked({ kind, target, bypasses?, ctx })` — the one
  gate entry point; returns the first blocking restriction (with its id) or
  `undefined`. Every gate below consults it.
- **The four gates:**
  - **targeting** (`validTargets` / `useAbility`): `on: 'target'` removes
    the character from the pool, after `who`/`match`/`negate`; characters
    listed in `include` are appended afterwards and are exempt — `include`
    is the named-exception primitive for targeting (hexproof listed in
    `include` is still targetable). `useAbility` keeps throwing "cannot
    target …" for out-of-pool picks (the round driver fizzles those moves).
  - **destroy** (`canDestroy`, the public name — consulted by the destroy
    phase for HP ≤ 0 deaths *and* queued `destroy` actions): `on: 'destroy'`
    blocks the destruction. The HP→destroy rule is gated with **no source**:
    state-based death is not attributed to an actor, so a "cannot be
    destroyed by spells" restriction gates direct destroy actions but not
    lethal damage (the damage itself is the gauge gate's business).
  - **actions** (`apply`, before transformers): `on: 'gauge'` (current-value
    writes) and `on: 'buff'` (add **and** remove) block the action — a
    blocked write never lands, a refused buff never attaches, and
    transformers never see the action ("can't beats can" stays global). A
    gauge's **max** is never an action: it is derived from statuses, so a
    "cannot change max" rule is a `on: 'buff'` restriction (blocking the
    max-modifying buff from attaching).
    `on: 'control'` / `on: 'revive'` kinds are defined but not wired: those
    actions do not exist yet (their gates arrive with the actions).
  - **win/lose** (`#execute` + `resolveGameEnd` predicates): `on: 'lose'` /
    `on: 'win'` block a game-end determination — a plain block, not the
    "prevent instead" replacement (12 is still deferred). A blocked `lose`
    action leaves no marker; the standing check is gate-aware too (below).
- **The "dead" predicate is destroy-gate aware** — `resolveGameEnd` learns
  it through a predicate parameter (`isDead`, plus `winBlocked`); the
  engine passes closures over its own gates. A character at HP ≤ 0 that the
  HP→destroy rule **can** take is dead for win/lose (the win/lose check
  runs before the destroy phase); an indestructible character at 0 HP is
  **not** dead and keeps its owner in the game. `on: 'lose'` keeps a
  character from counting toward defeat even when destroyed — but note
  ordinary buffs fade with their wearer (`removedOnDefeat` defaults to
  `true`), so "cannot lose the game" content typically declares
  `removedOnDefeat: false` (a pact, not a mortal's last wish). `Player.isDefeated`
  stays as the ungated view.

### Decisions on the open points

1. **Named exceptions** — restriction ids are derived `"{statusId}:{index}"`
   (e.g. `hexproof:0`, `indestructible:0`); the index counts the status's
   restriction abilities in declaration order (non-restriction abilities are
   skipped). Gated actions carry an optional `bypasses: readonly string[]`
   naming the ids they pierce (the `destroy` sugar accepts `{ bypasses }` as
   a third argument). Targeting keeps `include` as its exception primitive.
2. **Feedback for blocked attempts** — silent no-ops everywhere except
   targeting at `useAbility` (throws, as today). `attemptBlocked` returns
   the blocking restriction, so the UI can explain "why can't I do that".
3. **Multiple matching restrictions** — first match wins, in status weight
   order (ascending) then declaration order; blocking is boolean either way.
4. **Win/lose plumbing** — `TeamRegistry.resolveGameEnd(isDead, winBlocked)`
   takes two predicates (defaults preserve the old behavior); the engine
   passes closures over `canDestroy` and the `'lose'`/`'win'` checks.
   `winBlocked` blocks only *that team's* crowning: a lone standing team
   that may not win simply does not end the game (a stalemate until the
   state changes), and other standing teams are unaffected.

Tests: `test/restrictions.test.ts` (hexproof + include punch-through,
indestructible at 0 HP, spell-ward intent split, blanket gauge block,
refused buffs, "cannot lose the game", "cannot win the game", a named
exception piercing a destroy restriction, blocked actions as no-ops).
