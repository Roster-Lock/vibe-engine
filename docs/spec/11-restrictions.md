# 11 — Restrictions: "Cannot be X if Y"

> Slice 7. The unified exception system — statuses declare *what* is
> blocked and *under what condition*.

## 1. The idea

Instead of flat "cannot be targeted" flags, rules are **restrictions**: a
status declares what is blocked and under what condition. The condition
(the "if Y") considers **why X is happening** — who the source is, what
kind of attempt it is, and (for gauge changes) whether it is damage,
healing, or a set.

```ts
Cannot be targeted     if the source is an enemy        (hexproof / spell immunity)
Cannot be destroyed    if the destroy would come from a spell
Cannot have HP changed if the change is damage          (but healing is fine)
Cannot have HP changed at all
Cannot be buffed       if the buff is an enemy's
Cannot be controlled
Cannot be revived
Cannot lose the game   (player-level gate — see 08)
Cannot win the game    (the opponent's side)
```

> Note: "cannot lose / cannot win" here are **simple blocks**. The stronger
> form — "if you would lose, *prevent that loss instead*" (last breath) —
> is a replacement effect, not a restriction, and is **deferred** (see
> [00 §7](00-overview.md)).

## 2. Shape

A restriction is a **kind of ability** — statuses carry it in their
ordinary `abilities` list, built with `restriction(...)`:

```ts
buff({
  name: 'Indestructible',
  weight: 1,
  abilities: [restriction({ on: 'destroy' })],
});
```

```ts
interface RestrictionDef {
  on: 'target' | 'destroy' | 'gauge' | 'buff' | 'control' | 'revive' | 'lose' | 'win' | ...;
  when?: (ctx: AttemptContext) => boolean;   // the "if Y" — absent means always
}

interface AttemptContext {
  self: Character;                            // the gate's subject (the would-be target)
  source: EventSource | undefined;            // who is doing X
  sourceCharacter: Character | undefined;     // the source's character (or buff's caster)
  gauge?: Gauge;                              // gauge attempts
  intent?: 'damage' | 'heal' | 'set' | 'other';  // gauge attempts — see 01 §3
  pattern?: TargetPattern;                    // targeting attempts
  ability?: Ability;                          // targeting attempts
  engine: GameEngine;
}
```

Unlike the other ability kinds a restriction never *runs*: it is a pure,
synchronous, side-effect-free predicate (no RNG) the engine's gates consult
when an attempt is made against its wearer — it returns a verdict, not
actions. The engine consults them at each **gate**:

| Gate | Where | `on` kinds |
| --- | --- | --- |
| Targeting | `validTargets` / `useAbility` | `'target'` |
| Destroy | the destroy phase and `destroy` actions | `'destroy'` |
| Action pipeline | before transformers, for every incoming action | `'gauge'`, `'buff'`, `'control'`, `'revive'`, … |
| Win/lose | the game-end resolution | `'lose'` / `'win'` |

## 3. Resolution rules

- **"Can't beats can"** — a matching restriction blocks the attempt,
  period. Blocked `destroy` ⇒ the character stays (and the HP→destroy rule
  is gated too). Blocked gauge ⇒ a no-op write. Blocked targeting ⇒ the
  character leaves the pool.
- **Named exceptions pierce** — an effect may explicitly say "this gets
  through anyway" ("can be targeted even if it has hexproof", "destroy it
  anyway"). The targeting `include` field is the primitive for targeting;
  destroy/gauge exceptions declare the same way, and the exception **must
  name the rule it beats** — that is what keeps the priority checkable.
- **Restrictions gate before transformers** — if a character cannot take
  damage, armor has nothing to absorb. "Can't beats can" stays global; a
  blocked action is a no-op, and transformers never see it.
- **A blocked attempt is a no-op, not an error** — same spirit as
  "non-stackable duplicate buffs are silently ignored". (Blocked targeting
  at `useAbility` should still explain itself to the player.)

## 4. Gauge intent (the enabling piece)

To make "cannot be damaged, but healing is fine" checkable, gauge-changing
Actions declare an **intent** ([01-gauge.md](01-gauge.md) §3): the sugar
builders stamp `damage` / `heal` / `set` / `other`; raw
`{ type: 'gauge', update }` actions default to `other`. A single gate
function on the engine — `attemptBlocked({ kind, target, ctx })` —
collects the target's restrictions and returns the blocking one; every gate
above uses it, and the UI/log uses it for "why can't I do that" feedback.

## 5. Acceptance criteria (Slice 7)

1. A status with `on: 'target'` + `when: (ctx) => enemy-of-owner` removes
   enemy sources from the pool but leaves allies targetable
   (hexproof-style).
2. `on: 'target'` with no `when` removes the character from every pool
   (shroud-style); "can be targeted even if it has hexproof" (a named
   exception) restores it; plain `include` does **not** pierce a rule gate.
3. `on: 'destroy'` blocks both the HP→destroy rule and `destroy` actions;
   the character stays and its owner does not lose; "destroy it anyway"
   pierces.
4. `on: 'gauge'` with `intent: 'damage'` blocks damage but allows healing
   and sets; a blocked write is a no-op and no `gauge:changed` fires.
5. `on: 'lose'` blocks a loss determination at the win/lose layer; `on:
   'win'` blocks a win.
6. Restrictions gate **before** transformers: a "cannot be damaged"
   character's armor transformer never sees a damage write.
7. The `attemptBlocked` gate returns the blocking restriction (for "why"
   feedback) rather than a bare boolean.
