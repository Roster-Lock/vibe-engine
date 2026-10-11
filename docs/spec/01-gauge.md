# 01 — Gauge

> Slice 0. The numeric meter every character's combat stats are built from.

## 1. What it is

A **Gauge** is a numeric meter on a character — HP, Mana, Energy, anything
that has a maximum and a current value. It is the engine's only numeric
state; every number on a character lives in a Gauge.

```ts
const hp = new Gauge('hp', 100);                       // full
const mana = new Gauge('mana', 50, { current: 20 });   // partially spent
```

## 2. The interface

```ts
interface GaugeOptions {
  current?: number;   // starting current value; defaults to `max`
  min?: number;       // lowest allowed current value; defaults to 0
  clamp?: boolean;    // clamp writes to [min, max]; defaults to true
}

class Gauge {
  readonly id: string;
  readonly min: number;
  readonly baseMax: number;  // the constructed max — never changes

  get current(): number;   // read only through the getter
  set current(value: number); // writes are clamped unless clamp is off
  get max(): number;
  set max(value: number);   // engine re-derivation; re-clamps current; validates finite >= 0

  get isFull(): boolean;    // current >= max
  get isEmpty(): boolean;   // current <= min

  toString(): string;       // `${id} ${current}/${max}`
}
```

Rules:

- **Construction validates**: `max` must be a finite number `>= 0` — else
  throw (`Gauge "hp": max must be a finite number >= 0, got …`). `current`
  defaults to `max`. `min` defaults to `0`. The constructed max is frozen as
  `baseMax` — the value every derived max is computed from.
- **Clamping happens at write time.** Update functions compute freely;
  the written value is clamped to `[min, max]` when `clamp` is on (the
  default). This is what lets an Action's `update` function return an
  intermediate value like `cur - 60` on a 50-max gauge without the gauge
  being "wrong" mid-computation — the clamp is applied on assignment.
- **Raising `max` does not refill the gauge.** Setting `max` re-clamps
  `current` (so a shrink to below current clamps current down), but never
  changes `current` otherwise.
- **Lowering `max` clamps current down** to the new max (while `clamp` is
  on) — this is the target model's "transform shrinks max, current clamps"
  behavior ([04-character-status.md](04-character-status.md) §6).
- **`max` is derived, not written.** Content never sets a gauge's maximum —
  the engine re-derives it from `baseMax` plus the `maxModifier`
  contributions of every attached status (see §4). The `max` setter exists
  for that re-derivation (and clamps the derived value at 0).

## 3. Gauge intent (target model)

Gauge-changing **Actions** declare an **intent** so rules can distinguish
"damage" from "healing" from "a set" without pattern-matching numbers:

```ts
type GaugeIntent = 'damage' | 'heal' | 'set' | 'other';
```

- The sugar builders stamp it: `damage(...)` → `'damage'`, `heal(...)` →
  `'heal'`, `setGauge(...)` → `'set'`, `changeGaugeBy(...)` → `'other'` (it
  can go either way).
- A raw `{ type: 'gauge', update }` Action defaults to `'other'`.
- Consumers: **restrictions** — "cannot have HP changed if the change is
  damage, but healing is fine" is checkable because the Action declares its
  intent ([11-restrictions.md](11-restrictions.md) §4).

## 4. How the engine treats gauges

- **Every character has exactly two built-in gauges**: `hp` (required) and
  `mana` (defaults to max 0 — a gauge that stays empty). See
  [04-character-status.md](04-character-status.md).
- **`characterOf(gauge)`** — the engine can resolve the character that owns
  a gauge (it is registered and the gauge is its `hp` or `mana`). This is
  what the action pipeline uses to find the incoming-transform target of a
  gauge Action.
- **Batching.** Gauge Actions aimed at the same settle are **netted**: the
  batch applies every write in order, then reports one netted
  `gauge:changed` event per gauge, followed by a `gauge:changed:batch`
  carrying them all ([03-actions.md](03-actions.md) §6,
  [06-events-triggers.md](06-events-triggers.md) §5).
- **The maximum is derived.** The engine recomputes a gauge's `max` from
  `baseMax` plus the `maxModifier` contributions of every attached status,
  in weight order, clamped at 0 — whenever a status is added or removed
  (a skill's contribution lands at registration; a buff's lands on
  `buff:added` and reverts on any removal). There is no max-writing Action;
  the only way to change a max is to add or remove a buff. See
  [05-abilities.md](05-abilities.md) §2.
- **Events.** A settled change emits `gauge:changed` (with `from`/`to` and
  the last write's `source`); a **derived** max change — a status carrying
  a `maxModifier` being added or removed — emits `gauge:maxChanged`. HP
  gauges additionally drive `character:destroyed` / `character:survived`
  and the per-write `HpChange[]` payloads
  ([06-events-triggers.md](06-events-triggers.md), [10-destroy.md](10-destroy.md)).
- **Win/lose reads post-write values.** "Dead" is judged from the gauge's
  value *after* the batch lands, before events ([09-sba-pass.md](09-sba-pass.md)).

## 5. Acceptance criteria (Slice 0)

1. Constructing `new Gauge('hp', 100)` yields `current === 100`, `max ===
   100`, `isFull === true`; `new Gauge('mana', 50, { current: 20 })` yields
   `current === 20`, `isFull === false`.
2. Writing `current = 120` on the 100-max gauge clamps to 100; writing
   `current = -5` clamps to `min` (0).
3. With `clamp: false`, writes are stored unclamped.
4. `max = 50` on a full 100 gauge leaves `current === 100` (no refill);
   `max = 30` clamps `current` down to 30.
5. `max = -1` and `max = Infinity` throw; constructing with a non-finite or
   negative max throws.
6. `isEmpty` is true at `min`; `toString()` renders `hp 75/100`.
7. `damage(target, 10)` produces a gauge Action with `intent: 'damage'`;
   `heal(...)` → `'heal'`; `setGauge(...)` → `'set'`; a hand-built
   `{ type: 'gauge', update }` has `intent: 'other'`.
