# 14 — Derived Stats

> Status: ✅ direction decided and implemented (this session).

## The problem

Some game values are **functions of the game state**, not stored numbers:
in Magic, "this creature's toughness is equal to the number of creatures
you control". The engine already had one derived value — a gauge's `max`,
folded from `baseMax` + static `maxModifier` contributions in weight order
— but:

1. **Contributions were static numbers.** Nothing could say "the value
   *is* whatever `fn(state)` returns".
2. **Re-derivation was local.** It fired on *this character's* statuses and
   forms changing; a function of the world (creature count) changes when
   *other* characters enter or leave play.
3. **Only gauge maxes were derived.** `speed` and any custom stat had no
   derivation path.

## Decisions

- ✅ **A contribution derives one of two things — a gauge's max or a named
  stat.**
  - **Gauge-tied** (`gauge: 'hp'`): the derived value *is* that gauge's
    effective `max`, for **any gauge the wearer carries** — `'hp'`,
    `'mana'`, or a future `'stamina'` (a gauge-tied contribution on a
    wearer with no such gauge does nothing). The read is the gauge:
    `character.hp.max`. No magic `'maxHp'`/`'maxMana'` stat names.
  - **Named** (`stat: 'speed'`, or a custom name like `'power'`): read
    with `character.stat(name)`; custom names can have a base from
    `CharacterDef.stats` (`{ power: 2 }`).
- ✅ **Derivation is a fold over contributions, in status order** (weight
  ascending, exactly like the action pipeline). Base → contributions. The
  gauge max's base is the **transformed base max** for hp/mana (transforms
  can name them) or the gauge's own `baseMax` for any other gauge.
- ✅ **A `value` function replaces the running value; `multiply`/`add`
  rewrite it** (`value = value * multiply + add`). "Replace, then chain":
  a low-weight `value` contribution followed by a high-weight `add` gives
  "equal to X, then +2". A later replacement discards everything before it.
  This covers both MTG "equal to" and the old +50/−30 blessing/curse.
- ✅ **One ability kind: `stat`** (`ability/stat.ts`), with `gauge` XOR
  `stat` (validated). **`maxModifier` is sugar** for a gauge-tied `stat`
  with static `multiply`/`add` (it returns a `'stat'`-kind ability; the
  `MaxModifierAbility` name is kept as a type alias for compatibility).
- ✅ **A named stat with no base and no `value`-function contribution does
  not exist** (`stat(name)` is `undefined`). Static rewrites are skipped
  while the running value is undefined.
- ✅ **Derivation functions are read-only queries** (the restriction-`when`
  contract): they must not emit actions or mutate state, and must return a
  finite number (a non-finite result throws, naming the value and status).
- ✅ **Gauge maxes clamp at 0 at the end** (unchanged); named stats are
  stored unclamped. A derived gauge max that hits 0 still drives the
  max-aspect death rule on that gauge (the built-in `hp:maximum-reached-0`).

## When derived values update

The engine re-derives:

- **status added/removed** — a contribution landing or leaving refreshes
  the wearer's every gauge max and named stat (a derived gauge max change
  emits `gauge:maxChanged` and can queue a destruction; a named stat change
  emits `stat:changed` — both carrying the change's `source` when there is
  one);
- **form transform pushed/popped** — the hp/mana maxes' base changes;
- **registration** — silently (setup semantics: no events), including a
  silent re-derivation of every *function* value across the other
  registered characters, so setup is settled in any registration order and
  a mid-game registration takes effect immediately;
- **the world changes** — at each settle (the apply tail, before *and*
  after the destroy phase): only values with at least one `value` function
  are re-derived (static contributions can only change through status/form
  changes), gated on the engine's `#stateVersion` having moved;
- **on demand** — `engine.refreshDerivedStats()` (a no-op when nothing
  changed); LocalGame calls it before each round so a derived `speed`
  feeds initiative.

A death discovered by the *post-destroy* refresh (a survivor whose
function-derived max collapsed because a creature left play) resolves at
the **next** settle's destroy phase — one settle later than a
status-driven max-0 death, which resolves in the same settle. Documented
in `test/stat.test.ts`.

## Engine implications

- `character.ts`: `CharacterDef.stats`; `statBase`, `statBaseKeys`, `stat`,
  `setDerivedStat`; `speed` becomes a getter over the derived cache. No
  `maxHp`/`maxMana` stat names — gauge maxes are read from the gauges.
- `ability/stat.ts`: `StatContext`, `StatAbility` (`gauge` XOR `stat`),
  `stat(...)`.
- `ability/max-modifier.ts`: `maxModifier(...)` now returns a gauge-tied
  `stat` (kind `'stat'`); `MaxModifierAbility` is a type alias.
- `engine.ts`: `#statValue`/`#statContributions` (named stats) and
  `#gaugeMax`/`#gaugeContributions`/`#gaugeBase` (gauge maxes, any gauge),
  `#statNames`/`#functionStatNames`/`#functionGauges`,
  `#refreshStat(Silent)`/`#refreshGaugeSilent`/`#refreshStats(Silent)`,
  `#refreshWorldStats`, public `refreshDerivedStats`; the apply tail runs
  the world refresh before and after the destroy phase; the status/transform
  hooks call `#refreshStats`; `#recomputeMax` takes any `Gauge`.
- `multiplayer/local.ts`: `collectUserDecisions` refreshes derived stats
  before the players decide and initiative reads `speed`.

## Open

- ✅ **Events for non-gauge stats** — a named stat change emits a generic
  `stat:changed` event (`stat` names the value — `'speed'` or any custom
  stat), in versions with/without a `source`, with `from`/`to` as the
  **effective** values (base included, so a contribution leaving reads as
  the revert to base). Status/form-caused changes carry the change's
  `source`; world-driven re-derivations carry none. Registration stays
  silent (setup semantics), destroyed characters announce nothing, and a
  transition into or out of `undefined` (a custom stat with no base coming
  into or going out of existence) is not announced — the grantor's own
  `buff:added`/`buff:destroyed` covers it. Gauge maxes are *not* named
  stats — they keep announcing as `gauge:maxChanged`.
- 🔶 **Cross-stat dependencies** — a `value` function reading another
  derived stat sees that stat's value from the same settle's refresh pass
  (one pass, deterministic order); a dependency-ordered fold is future
  work if content needs it.
- 🔶 **Custom stats in combat** — today only the gauge maxes feed the
  engine (damage, death); `power`/`toughness` as named stats are readable
  by content (cast bodies) but have no combat wiring of their own.
- 🔶 **Summon** (01) — when summoning lands, registration's silent refresh
  already covers the count-changing case; the settle refresh keeps it
  current thereafter. Caveat: the registration refresh is *silent* (setup
  semantics), so a max driven to 0 *by registration alone* queues no
  destruction — revisit if a summon ever has to kill on arrival.
