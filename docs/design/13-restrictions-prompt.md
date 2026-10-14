# Slice 3 — Restrictions ("Cannot be X if Y") — Implementation Prompt

> **How to use:** copy everything below the divider into a fresh discussion.
> It is self-contained — the project context and current engine model are
> summarized here, so the new discussion needs no prior context.

---

## Project context

I'm designing **TinyQuest**, a tiny, content-creator-friendly game engine
(TypeScript) for a turn-based hero/creature battle game. Design inspirations:
Magic: The Gathering (rules depth, exceptions, triggered abilities) and
Warcraft 3 (heroes, buffs, active/passive abilities). A long-term goal is an
English-readable DSL so creators can write cards/heroes like
"Fireball — deal 3 damage to target enemy."

The engine's thesis: **actions are the only way state changes**; every action
flows through a transformation pipeline; events queue triggers; state-based
actions (SBAs) resolve at settle boundaries. Creators compose a few small
declarative pieces (abilities, buffs, skills, statuses) — the engine must let
them express **unique abilities**, including **exceptions to the rules**
("this character cannot be targeted", "cannot be destroyed", "cannot be
damaged by spells").

This slice is the **restrictions gate** — the unified "cannot be X if Y"
system. The design is decided (see the section below); your job is to
implement it in the engine, keep the existing test suite green, and add tests.

## Current engine model (what you will touch)

All under `src/engine/` (library entry `src/engine/index.ts`, tests in
`test/`).

- **Actions** (`actions.ts`): the only state changes — `gauge` (current
  value via `update(cur, max)`), `addBuff`, `removeBuff`, `destroy`, `win`,
  `lose`. Sugar builders: `damage`, `heal`, `setGauge`, `changeGaugeBy`,
  `addBuff`, `removeBuff`, `destroy`, `win`, `lose`. A gauge's **max** is
  never an action — it is derived from attached statuses' `maxModifier`
  contributions (`ability/max-modifier.ts`).
- **The pipeline** (`engine.ts` `apply()`): every action passes through
  **transformers** on the source (outgoing) then the target (incoming),
  ordered by status `weight`. Transformers rewrite actions
  (`ActionTransformer = (action, ctx) => Action`).
- **Statuses** (`status.ts`): `Buff` (addable/removable, `weight`,
  `variables`, `abilities`, `removedOnDefeat`, `onRemoved`) and `Skill`
  (permanent). Both attach `abilities` to their character. Defined via
  `buff({...})` / `skill({...})` declarations.
- **Abilities** (`ability/`): `cast` (manual), `auto`/`prompt` (triggers),
  `passiveActionModifier` (transformer-only). Targeting patterns:
  `{ who, count, match, negate, include }`.
- **Events** (`events.ts`): `GameEvent` union; triggers **queue and drain**
  after the resolution unit (a move's `apply` or a turn hook) — do not
  change this.
- **Destroy model** (built): `destroy` action deferred to the SBA pass;
  "HP ≤ 0 ⇒ destroyed" is a state-based rule (HP is the life gauge); all pending destructions in a
  settle land **simultaneously** into the **garbage**; `character:destroyed`
  carries a `reason` (`'hp:current-reached-minimum'` | `'hp:maximum-reached-0'`
  | `'direct-action'`); batch variants `character:destroyed:batch` /
  `character:survived:batch` exist. `Character.destroyed` flag; engine
  `#garbage`; targeting pools exclude the garbage.
- **The SBA pass** (`engine.ts` `#applyGaugeBatch` + end-of-apply leftover):
  writes land (netted) → **win/lose first** (`TeamRegistry.resolveGameEnd`,
  throws `GameEndInterrupt`) → **destroy phase** (`#destroyPhase`, gated by
  `canDestroy`) → **content state-based rules** (`#runContentSBAs`, the
  `addStateBasedRule` registry) → events → trigger drain. Game end
  short-circuits: no destroy events, no death triggers at game end.
- **Win/lose** (`teams.ts`, `player.ts`): players own characters; a player
  is defeated when every owned character is `isDefeated` (mana ≤ min) **or**
  `destroyed`; last team standing wins; simultaneous wins/losses are draws.
- **The gate stub** (`engine.ts`): `canDestroy(target, source)` currently
  returns `true` for everything — the destroy gate that restrictions will
  fill in.

## The decided design (do not re-litigate; implement it)

**Restrictions** are declared by statuses (proposed: a `restrictions?: Restriction[]`
field on buff/skill declarations). A restriction says *what* is blocked and
*under what condition*:

```ts
interface Restriction {
  /** What is being blocked. */
  on: 'target' | 'destroy' | 'gauge' | 'buff' | 'control' | 'revive' | 'lose' | 'win' | ...;
  /** The "if Y" — absent means always. */
  when?: (ctx: AttemptContext) => boolean;
}

interface AttemptContext {
  source: EventSource | undefined;             // who is doing X (Character or Buff)
  sourceCharacter: Character | undefined;      // the source's character (or buff's caster)
  // gauge attempts:
  gauge?: Gauge;
  intent?: 'damage' | 'heal' | 'set' | 'other';  // see the prerequisite below
  // targeting attempts:
  pattern?: TargetPattern;
  ability?: Ability;
  engine: GameEngine;
}
```

Example content the system must enable:

```ts
// hexproof — cannot be targeted by enemy abilities
buff({
  name: 'Hexproof',
  weight: 1,
  restrictions: [
    { on: 'target', when: (ctx) => ctx.engine.isEnemy(ctx.self, ctx.sourceCharacter!) },
  ],
});

// indestructible — cannot be destroyed
buff({ name: 'Indestructible', weight: 1, restrictions: [{ on: 'destroy' }] });

// spell-ward — cannot be damaged, but healing is fine
buff({
  name: 'Spell Ward',
  weight: 1,
  restrictions: [
    { on: 'gauge', when: (ctx) => ctx.gauge === ctx.self.hp && ctx.intent === 'damage' },
  ],
});
```

**The gates** — each interception point consults the target's restrictions:

1. **targeting** — `validTargets` / `useAbility`: a `on: 'target'` restriction
   removes the character from the pool (it is a hard filter, **after** the
   existing `include` override).
2. **destroy** — the destroy phase AND `destroy` actions: a `on: 'destroy'`
   restriction blocks the destruction (this replaces the `canDestroy` stub's
   `return true`). Blocked ⇒ the character stays; the HP→destroy rule is
   gated too.
3. **actions** — the pipeline, **before transformers**: `on: 'gauge'`,
   `'buff'`, `'control'`, `'revive'`, … block the action (a no-op write, a
   refused buff, …). Restriction-gated actions never reach transformers
   ("can't beats can" stays global).
4. **win/lose** — simple `on: 'lose'` / `on: 'win'` restrictions block a
   game-end determination ("cannot lose the game"). This is a plain block,
   **not** the "prevent instead" replacement (that is a separate, deferred
   topic — do not build it).

**Resolution rules:**

- **"Can't beats can"** — a matching restriction blocks the attempt, period.
- **Named exceptions pierce** — an effect can explicitly say "this gets
  through anyway". The exception must **name the rule it beats**. The
  existing targeting `include` field is the primitive for targeting; the
  destroy/gauge exceptions need a concrete mechanism (your call — see Open
  points; a restriction id + an explicit `bypasses` note on the effect is
  the working idea).
- **Blocked attempts are no-ops, not errors** — except targeting at
  `useAbility`, which already throws "cannot target …" (the round driver
  fizzles those moves). Keep that contract.
- **The win/lose "dead" predicate becomes destroy-gate aware** (a decided
  requirement): a character at HP ≤ 0 that is NOT destroy-gated is dead for
  win/lose; an **indestructible character at 0 HP keeps its owner in the
  game**. Today `player.isDefeated` checks `isDefeated || destroyed` without
  the gate — you must thread the gate in (the engine owns the gate; decide
  how `TeamRegistry.resolveGameEnd` learns about it — e.g. a predicate
  parameter).

**Prerequisite — gauge `intent`:** to distinguish "cannot be damaged" from
"cannot be healed", gauge actions must declare an intent. Add an optional
`intent?: 'damage' | 'heal' | 'set' | 'other'` to `GaugeAction`; the sugar
builders (`damage`, `heal`, `setGauge`, `changeGaugeBy`) stamp it; raw
`{ type: 'gauge', update }` actions default to `other`. Pass it through the
`AttemptContext` at the gauge gate.

## What to build (checklist)

1. **Restrictions on statuses** — `restrictions?: Restriction[]` on buff and
   skill declarations; instances expose them.
2. **Gauge intent** — `GaugeAction.intent` + sugar stamps + plumbing.
3. **The gate function** — one engine entry point (working name
   `attemptBlocked({ kind, target, ctx })`) that collects a target's
   restrictions and returns the blocking one (or undefined). Every gate
   above uses it.
4. **Wire the four gates** — targeting (`validTargets`), destroy
   (`#destroyPhase` + `destroy` actions, replacing the `canDestroy` stub
   body — keep `canDestroy` as the public API name), actions (in `apply()`
   before transformers), win/lose (the simple lose/win blocks + the
   destroy-gate-aware "dead" predicate).
5. **Tests** — `test/restrictions.test.ts`: hexproof (enemy can't target,
   ally can; `include` punches through), indestructible (sits at 0 HP, not
   destroyed, owner does not lose; a later heal saves it), spell-ward
   (damage blocked, healing works), "cannot lose the game" gate, a named
   exception piercing a destroy restriction, blocked actions being no-ops
   (not errors). Keep every existing test green.
6. **Docs** — update `docs/design/11-restrictions.md` with an
   "Implementation" section mirroring the style of `04-sba.md`'s.

## Constraints

- **Content-creator-friendly**: the API surface stays small and declarative;
  the DSL (later) should express "cannot be targeted" as a keyword.
- **No breaking changes** to existing content/tests: the default behavior of
  every existing ability, buff, and trigger is unchanged when no
  restrictions are present.
- **Determinism**: same seed + same state ⇒ same outcome (existing guarantee
  — restrictions are pure predicates, no RNG).
- **Fits the architecture**: gates are queries consulted at the existing
  interception points; do not restructure the SBA pass, the destroy phase,
  or the trigger queue.
- `on: 'control'` / `on: 'revive'` kinds: the `control` and `revive` actions
  do not exist yet — define the restriction kinds, but the gates for them
  arrive with the actions (note it, don't build the actions).

## Open points (make a call, document it)

- **Named-exception mechanism**: how exactly does an effect name the rule it
  beats? (Working idea: restrictions get ids derived from their status +
  index; an ability/action declares `bypasses: ['hexproof']`-style ids.)
- **Feedback for blocked attempts**: silent no-op, or an event/log line so
  the UI can explain "why can't I do that"? (Recommend: silent for gauge
  writes, explainable for targeting which already throws.)
- **Multiple matching restrictions**: first match wins, or all evaluated
  (irrelevant for blocking, but relevant for reporting).
- **Win/lose predicate plumbing**: how `resolveGameEnd` learns the
  destroy-gate (predicate parameter vs engine callback).

## Deliverable

The implemented restrictions system + gauge intent + destroy-gate-aware
win/lose predicate, with tests green (`npm test`), typecheck clean
(`npm run typecheck`), build clean (`npm run build`), and an Implementation
section added to `docs/design/11-restrictions.md`. Report the decisions you
made on the open points.

---

## Resolved during implementation (do not re-decide)

Implemented directly in the repo — see the "Implementation" section of
[`docs/design/11-restrictions.md`](11-restrictions.md). The four open
points were resolved as:

1. **Named-exception mechanism** — restriction ids are derived
   `"{statusId}:{index}"` (e.g. `hexproof:0`, `indestructible:0`); gated
   actions carry an optional `bypasses: readonly string[]` that names the
   ids it pierces (the `destroy` sugar accepts `{ bypasses }` as a third
   argument). Targeting keeps `include` as its exception primitive.
2. **Feedback for blocked attempts** — silent no-ops everywhere except
   targeting at `useAbility` (throws, as today); `attemptBlocked` returns
   the blocking restriction so the UI can explain "why can't I do that".
3. **Multiple matching restrictions** — first match wins, in status weight
   order (ascending) then declaration order; blocking is boolean either way.
4. **Win/lose predicate plumbing** — `resolveGameEnd(isDead, winBlocked)`
   takes two predicates (defaults preserve old behavior); the engine passes
   closures over its own gates (`canDestroy`, the `'lose'`/`'win'` checks).

One decision surfaced during implementation: "cannot lose the game" content
should declare `removedOnDefeat: false` — ordinary buffs fade with their
wearer, which would end the protection at the destroy phase's game-end
recheck.
