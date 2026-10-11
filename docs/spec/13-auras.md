# 13 — Auras

> Slice 9. A buff that paints its matching allies with a permanent mark —
> and keeps the set of painted characters correct as the world changes.

## 1. The model

An **aura** is a buff that grants a `removable: false` mark to every
character in its **scope** (e.g. "all allies"). Two mechanisms make it work:

1. the existing **`grantedBy` cascade** — when the aura goes away, every
   mark it granted is destroyed with it ([04-character-status.md](04-character-status.md) §5);
2. **membership recomputation** — when the world changes after the aura was
   applied (a summon lands, a character revives, control swaps), the engine
   diffs the wanted set against the current marks and fixes the difference.

## 2. The shape

```ts
interface AuraBuffDef extends BuffDef {
  scope: (self: Character, engine: GameEngine) => Character[];  // the wanted set
  mark: BuffDef;              // removable: false, weighted, carries the granted abilities
}
```

- The aura declares a **`scope`** — a function returning the wanted
  characters. Scope is team/type based for now (no positional ranges —
  there is no board).
- The **mark** is a buff declared `removable: false`: applied at runtime
  like any buff, but permanent — every `removeBuff` (action, sugar, or
  direct call) is a no-op, and its `weight` still sorts it in the target's
  status list and orders it in the action pipeline.
- `'ally'` includes the owner, so exclude `ctx.self` in the scope/match
  when the aura should only mark *other* characters.

Content shape (using the target model's aura declaration; the built form
today is a buff whose auto ability grants the mark on an event):

```ts
const blessed = buff({
  name: 'Blessed',
  weight: 2,
  removable: false,     // applied by the aura, never dispelled
  abilities: [ /* the mark's granted abilities, e.g. a passive modifier */ ],
});

const blessingAura = buff({
  name: 'Blessing Aura',
  weight: 1,
  removedOnDefeat: true, // the aura fades when its wearer (the paladin) falls
  scope: (self, engine) => engine.validTargets({ who: 'ally' }, self)
    .filter((c) => c !== self && !c.hasStatus('blessed')),
  mark: blessed,
});
```

## 3. Membership rescan

On every **membership event** — `character:summoned`, `character:revived`,
and `character:controlChanged` — the engine rescans every aura in play:

1. compute the wanted set from `scope` (current state);
2. **grant** the mark to new members (through the normal `addBuff` path,
   with the aura as the granting status so `grantedBy` links the mark to
   this exact aura instance);
3. **cascade-destroy** the marks of departed members (the existing cascade
   does the removal, each firing `buff:destroyed`).

Control swaps re-derive teams (controller-based,
[07-targeting-zones.md](07-targeting-zones.md) §3), so a stolen character
leaves its old aura's scope and joins the new one's on the same event.

The `match`/`hasStatus` check (or the engine's duplicate-buff guard) keeps
re-scans from stacking duplicate marks.

## 4. The lifecycle

- A mark resists every dispel — its ways out are its **source** (the aura),
  or its own **wearer** (defeat removes `removedOnDefeat` buffs attached to
  it, and an aura's marks on *other* characters are untouched by the
  wearer's death — only the aura itself fading removes them).
- When the aura goes — **removed** (dispelled, stolen…) **or** its wearer
  is **defeated** (`removedOnDefeat` — the default — runs the cleanup
  before the `character:destroyed` event fires, so the death is announced
  with the world already missing the fallen aura) — every permanent mark it
  granted is destroyed with it (on any character), each firing a
  `buff:destroyed` event.
- Each mark remembers the exact aura instance that granted it
  (`buff.grantedBy`), so removing one of two paladins' auras only kills
  *its* marks.
- Make the aura a **skill** instead for the permanent variant: a skill can
  never be removed, so its marks never die.

## 5. Acceptance criteria (Slice 9)

1. An aura with scope "all allies" marks every current ally on application
   (through the normal buff path), with `grantedBy` pointing at the aura
   instance.
2. A `removeBuff` aimed at a mark is a no-op (marks are `removable: false`);
   the mark still sorts by weight and its abilities still transform actions.
3. When a new matching character appears (`character:summoned` /
   `character:revived` / `character:controlChanged`), the aura grants it a
   mark; when a character leaves the scope, its mark is cascade-destroyed
   (one `buff:destroyed` per mark).
4. Removing the aura destroys its marks on any character (each firing
   `buff:destroyed`); ordinary removable buffs the aura granted are
   untouched; a second aura's marks survive.
5. The aura fading via its wearer's defeat (`removedOnDefeat`) happens
   before the wearer's `character:destroyed` — the death is
   announced with the aura already gone.
6. Re-scans do not stack duplicate marks on the same character.
7. A skill-based aura's marks never die (skills are permanent).
