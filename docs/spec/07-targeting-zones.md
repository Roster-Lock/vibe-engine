# 07 — Targeting & Zones

> Slice 3. Who can be pointed at, and the two zones that make "cannot
> target a corpse" true by construction.

## 1. Zones

The engine owns two character zones:

- **play** — registered characters that can act and be targeted;
- **graveyard** — destroyed characters, in destruction order (ordered list;
  queryable, e.g. `engine.charactersIn('graveyard')` or the `graveyard`
  getter).

Rules:

- **Targeting pools draw from the play zone only.** A graveyard character is
  not in any pool — no per-spell "cannot target dead" checks, and the
  "fireball a corpse" problem dies by construction.
- Characters move between zones on **destroy** (play → graveyard),
  **summon** (creation → play), and **revive** (graveyard → play).
- If graveyard-scoped abilities are ever needed, a pattern-level
  `allowGraveyard` flag can be added — the zone abstraction keeps that door
  open without special-casing.

## 2. The pattern

```ts
interface TargetPattern {
  who: 'self' | 'ally' | 'enemy' | 'any';
  count?: number | [min, max];        // defaults to 1
  allowDuplicates?: boolean;          // pick the same character more than once; default false
  match?: (ctx: TargetingContext, candidate: Character) => boolean;
  negate?: boolean;
  include?: readonly Character[];
}
```

- **`who`** — the base filter, resolved through the team helpers:
  - `'self'` — the owner only;
  - `'ally'` — the owner and characters on its side (`isAlly`); **includes
    the owner** — exclude `ctx.self` in `match` when the intent is "other
    allies" (e.g. an aura, [13-auras.md](13-auras.md));
  - `'enemy'` — everyone on the other side (`isEnemy`; no team = everyone
    else is an enemy);
  - `'any'` — everyone in play.
- **`match`** — a custom condition that runs **after** the `who` filter on
  every candidate (`ctx.self` and `ctx.engine` available).
- **`negate`** — flips the pattern from *inclusive* to *exclusive*:
  with a `match`, candidates that satisfy it are **removed** instead of
  kept ("every enemy except taunters"); with no `match`, the `who` filter
  itself is inverted ("everyone who is not an enemy").
- **`include`** — specific characters that are always valid whatever the
  rest of the pattern says (only registered, in-play characters take
  effect; duplicates skipped).

**Team derivation (target model):** there is no `character.team`.
Ally/enemy is derived **at use time** from `controller` and the players'
team tags — same controller ⇒ ally; different controllers with the same
player team tag ⇒ ally. A control swap therefore re-derives teams without
re-targeting anything.

## 3. `validTargets` — the resolution order

```ts
engine.validTargets(pattern: TargetPattern, self: Character): Character[]
```

1. Filter the pool to the **play zone** (graveyard excluded).
2. Filter by `who` (via `isAlly`/`isEnemy`).
3. Apply `match` — or, when `negate` is set, exclude candidates that match
   (with no `match`, invert the `who` filter).
4. **Targetability restrictions** gate the pool (target model):
   `on: 'target'` restrictions — "cannot be targeted if the source is an
   enemy" (hexproof-style), "cannot be targeted at all" (shroud-style) —
   are a **hard filter**, applied after `include` (see §4).
5. Append `include` characters (registered, in play, deduped).

## 4. Targetability restrictions & named overrides (target model)

- Targetability is part of the **"cannot be X if Y"** restriction system
  ([11-restrictions.md](11-restrictions.md)): a status declares
  `on: 'target'` with a condition; the engine enforces it as a hard filter
  in `validTargets`.
- **Named overrides**: a rule can only be broken by an exception that
  explicitly names it ("can be targeted even if it has hexproof"). The
  `include` field is the primitive that punches through `who`/`match`/
  `negate` — but a **rule gate is not punched through by `include`** unless
  the exception explicitly names the rule, so immunity is meaningful.
  (Spec default, [00 §6](00-overview.md).)

## 5. Enforcement

The pattern is enforced wherever the engine picks targets:

- **`useAbility`** — a manual ability's `cast` runs only after the engine
  validates that every given target is in `validTargets(ability.targeting,
  owner)`; a target outside the pattern throws
  (`"<ability>": cannot target "<name>" — outside its targeting pattern`).
  (A caller may treat the "cannot target" error as a **fizzle** — the move
  does nothing — rather than an abort; see the local game loop convention.)
- **`prompt` triggers** — the options offered to the `GameHost` are already
  filtered; a host answer outside them throws.
- **`auto` triggers** — with `targeting`, the engine computes targets via
  `validTargets`; with `targets`, the callback's result is used as-is.

`count` is advisory data for the host (how many to pick); the engine
enforces membership, not cardinality.

## 6. Acceptance criteria (Slice 3)

1. `validTargets` returns only in-play characters; a destroyed character
   never appears, in any pattern.
2. `who` filters resolve via controllers/player teams: `'ally'` includes
   the owner; `'enemy'` excludes allies; teamless characters treat everyone
   else as enemies.
3. `match` narrows after `who`; `negate` with a match removes matches;
   `negate` with no match inverts `who`; `include` adds forced characters
   (registered, in play, deduped).
4. An `on: 'target'` restriction removes candidates from the pool; a named
   exception ("can be targeted even if …") pierces it; plain `include`
   does not pierce a rule gate.
5. `useAbility` rejects out-of-pattern targets with the documented error
   and accepts in-pattern targets; a `prompt` host answer outside the
   pattern throws; an `auto` ability with `targeting` receives the computed
   pool as its targeting.
