# 07 — Auras

> Status: ✅ decided.

## The model

An **aura** is a buff that grants a `removable: false` mark to every
character in its **scope** (e.g. "all allies"). The existing `grantedBy`
cascade already destroys marks when the aura goes away — what is missing is
**membership recomputation** when the world changes after the aura was
applied.

## Decisions

- ✅ **Aura declares a `scope`** — a function `(self, engine) => Character[]`.
  Scope is team/type based for now (no positional ranges — there is no
  board).
- ✅ **Rescan on membership events**: `character:summoned`,
  `character:revived`, and `character:controlChanged`. The engine diffs the
  wanted set against the current marks:
  - grant the mark to new members;
  - cascade-destroy the marks of departed members (the existing cascade does
    the removal).
- ✅ **Control swaps re-derive teams** (controller-based, see 01-entities),
  so a stolen character leaves its old aura's scope and joins the new one's
  on the same event.

## Engine implications

- `status.ts` / `engine.ts`: aura buffs declare `scope`; the engine maintains
  membership on the three events above.
- New events `character:summoned`, `character:revived`,
  `character:controlChanged` — also consumed by pending effects (08) and the
  UI.
- The mark grant/remove paths already exist (`addBuff` + the removal
  cascade); only the rescan hook is new.
