# 06 — Damage

> Status: ✅ decided.

## Decisions

- ✅ **No damage types, no resistance tables.** Damage is a number on a
  gauge; armor is arithmetic. (The WC3 piercing/chaos matrix is explicitly
  out.)
- ✅ **Multi-hit = multiple damage actions** in one `apply` (kept — no
  `attack` wrapper for now). Each action is transformed individually *before*
  the batch nets, which is exactly what makes per-hit armor work.
- ✅ **Armor = flat absorption per hit**, implemented as an incoming
  transformer: each damage-dealing update is pulled back toward "no change"
  by the armor amount (capped so it never heals).
- 🔶 **Gauge actions declare intent** — `damage` / `heal` / `set` / `other` —
  so restrictions can say "cannot be damaged" without blocking healing (see
  11-restrictions). The sugar builders (`damage`, `heal`, `setGauge`,
  `changeGaugeBy`) stamp it; raw `{ type: 'gauge', update }` actions default
  to `other`. Confirm?

## Why the math example works

An attack "1 damage × 3 hits" = three `damage` actions in one `apply`. With
armor 1 as an incoming transformer, each action's update absorbs 1, so the
batch nets 3 × 0 = 0. With damage 2 per hit and armor 1: 3 × (2 − 1) = 3
net.

- "+1 damage" ⇒ +3 net (one per hit).
- "+1 absorption" ⇒ −3 net (one per hit).

Both fall out of per-action transformation; the engine's batch netting does
the rest. No new primitive required.

## Known granularity limit (deferred)

- A batch nets into one `gauge:changed` event per gauge, so "on hit"
  triggers see one event per batch, not one per hit. (The
  `gauge:changed:batch` groups them; `character:survived` already carries
  per-write `changes`, so per-hit *data* partially exists.)
  Revisit an `attack` wrapper with per-hit events only if on-hit effects
  (lifesteal, thorns-per-hit, crit) become common content.

## Engine implications

- None required today. Example armor buff (content):

  ```ts
  // Incoming HP-damaging updates are pulled back by 1, never past "no change".
  passiveActionModifier({
    name: 'Armor',
    transform: (action, ctx) =>
      action.direction !== 'incoming' || action.type !== 'gauge' ||
      ctx.target?.hp !== action.target
        ? action
        : gaugeTransform((prev) => (cur, max) => {
            const r = prev(cur, max);
            return r < cur ? Math.min(r + 1, cur) : r;
          })(action, ctx),
  })
  ```

## Redirecting damage (mana shield)

A passive action modifier can **replace** an action outright — swallow the
old one, emit a new one that does the same thing elsewhere ("prevent X,
instead Y" at the action level). That's how *damage becomes mana loss* is
built, with the `replaceAction` / `redirectGauge` helpers
([spec 03 §5](../spec/03-actions.md#5-transformers--the-pipeline)):

```ts
const manaShield = passiveActionModifier({
  name: 'Mana Shield',
  transform: redirectGauge((t) => t.hp, (t) => t.mana, {
    direction: 'incoming',
    intent: 'damage',
  }),
});
```

Semantics to know:

- **Per action, before the batch nets** — each hit is converted
  individually, exactly like armor.
- **A replacement is not a new cast** — it stays in the same pipeline
  position, so it does not re-enter the restrictions gate, and later
  incoming transformers see the converted (mana) action.
- **The amount comes from the original action** (`gaugeDelta` — the signed
  change it would make, evaluated against HP), so "the same thing" means
  the same absolute effect. Retargeting the same action to the mana gauge
  (option 1) instead keeps the original `update` closure, which is only
  equivalent for flat amounts.
- **Mana is the new buffer** — damage beyond the current mana is lost (the
  gauge clamps at 0), not spilled onto HP. (With HP as the life gauge this
  shield is purely defensive; a mana-death game that re-attaches the death
  rules to mana makes it lethal instead.) Overflow-to-HP shields would need
  a multi-action transform and are out of scope for the single-action
  transformer.
- **`intent: 'damage'` filters** — only damage converts; heals still heal
  HP, and `changeGaugeBy` / `setGauge` writes (intent `'other'` / `'set'`)
  pass through. Drop the filter to redirect every HP movement.
- **`direction` picks the side** — `'incoming'` is a defensive shield;
  `'outgoing'` is an offensive drain (the owner's attacks burn the target's
  mana instead of its HP).
