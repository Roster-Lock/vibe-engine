# 04 — Characters & Statuses

> Slices 0 and 2. The entities the game is about, and the buffs/skills that
> sit on them.

## 1. Character: identity and form

A **Character** is one game entity. It has a stable **identity** (the object
everyone references — buffs, triggers, targeting) and a mutable **form**
(skills, gauges, name, icon).

```ts
interface CharacterDef {
  maxHp: number;                 // required
  hp?: number;                   // starting HP; defaults to maxHp
  maxMana?: number;              // defaults to 0 (a gauge that stays empty)
  mana?: number;                 // starting mana; defaults to maxMana
  speed?: number;                // initiative; defaults to DEFAULT_SPEED (10)
  skills?: readonly SkillDef[];  // permanent skills, cloned per character
}

class Character {
  readonly type = 'character';
  readonly name: string;
  readonly hp: Gauge;
  readonly mana: Gauge;
  readonly speed: number;

  // Ownership (target model — see 08):
  owner: Player | undefined;          // who owns it for defeat purposes
  controller: Player | undefined;     // who plays it right now
  countsForDefeat: boolean;           // default true for player-created characters
  destroyed: boolean;                 // set by the engine when moved to the garbage

  // The status list (buffs *and* skills), sorted by weight ascending:
  get statuses(): readonly Status[];
  get buffs(): Buff[];
  get skills(): Skill[];
  get abilities(): Ability[];         // derived at query time, in status order
  get manualAbilities(): ManualAbility[];

  get isDefeated(): boolean;          // hp.current <= hp.min  (HP-derived, not zone-derived)
  hasStatus(id: string): boolean;
  findStatus(id: string): Status | undefined;
  findBuff(buff: Buff | string): Buff | undefined;
  addBuff(buff: Buff): boolean;       // false when a non-stackable duplicate
  removeBuff(buff: Buff | string): Buff | undefined;  // respects `removable`
  removeStatus(status: Status): boolean;  // engine cascade path — bypasses `removable`
}
```

- **Identity vs form**: the Character object is never replaced. A transform
  swaps the *form* (skills/abilities, gauge maxes — current clamps to
  `Math.min(current, newMax)` — name/icon); buffs persist across the swap
  (§6).
- **Teams live on players, not characters.** There is no `character.team`.
  Ally/enemy is derived from `controller` + player team tags at use time
  ([07-targeting-zones.md](07-targeting-zones.md) §3).
- **`owner` vs `controller`**: distinct. Control swap changes `controller`
  (and therefore which side the character fights for) but never `owner` — a
  stolen character keeps its original owner alive
  ([08-players-teams-winlose.md](08-players-teams-winlose.md) §2).
- **`destroyed` vs `isDefeated`**: `isDefeated` is HP-derived (current ≤
  min); `destroyed` is zone-derived (the engine set it in the destroy
  phase). A character destroyed by an explicit `destroy` action may still
  have full HP; `isDefeated` stays false. Win/lose judges from **post-write
  HP** before the destroy phase, so both matter
  ([09-sba-pass.md](09-sba-pass.md) §3).

## 2. Statuses: Buffs and Skills

Buffs and skills are the two kinds of "status effect" on a character's one
sorted status list. Both:

- have a **weight** (sorts the list ascending; also pipeline order),
- carry **own internal variables** (each instance gets a fresh copy),
- **add abilities** to their character,
- know **who created them** (`caster`) and **which character they are
  attached to** (`target`),
- know **what granted them** (`grantedBy`).

```ts
interface StatusBase {          // shared fields; `Status = Buff | Skill` (a
  id: string;                    // discriminated union on `type`)
  name: string;
  type: 'buff' | 'skill';        // lowercase discriminant: `status.type === 'buff'` narrows to Buff
  description?: string;
  icon?: string;                 // SVG URL/data URI
  weight: number;
  removable: boolean;            // false = permanent (skills, aura marks)
  vars: Record<string, unknown>; // this instance's own variables
  abilities: readonly Ability[];
  caster: Character | undefined;
  target: Character | undefined;
  grantedBy: Status | undefined; // the status that granted this one
}

interface StatusDef {
  id?: string; name: string; description?: string; icon?: string;
  weight: number;
  variables?: () => Record<string, unknown>;  // fresh per instance; defaults to () => ({})
  abilities?: readonly Ability[];
}

interface BuffDef extends StatusDef {
  removable?: boolean;      // false ⇒ removal is a no-op (an aura's mark); default true
  removedOnDefeat?: boolean;// removed when its *wearer* is defeated; default true
  // to react to its own end, the buff carries a buff:destroyed self-trigger
}

interface SkillDef extends StatusDef { /* permanent — given at creation, never removed */ }

buff(def: BuffDef): BuffDef;
skill(def: SkillDef): SkillDef;
```

**Buff vs Skill**:

- A **Buff** is added at runtime and is **removed when its wearer (the
  character it is attached to) is defeated** by default (`removedOnDefeat:
  false` opts out). The buff's **creator** being defeated never removes it
  from its wearer — a fallen caster's buffs stick around on their targets.
  Removal is the default for dispels, but `removable: false` makes a buff
  permanent once applied: added at runtime, never dispelled, still weighted,
  and it dies only with the status that granted it (the removal cascade,
  §5) — that is its only way out.
- A **Skill** is permanent: given at character creation, never added or
  removed, `removable` is always false, `caster`/`grantedBy` are undefined.

## 3. The status list

- The list is **owned by a `StatusManager`** (`src/engine/status/manager.ts`);
  the `Character` exposes it as `statusManager` and delegates every status
  operation to it — the character never touches the list directly.
- One list per character, **sorted by weight ascending, stable** — a skill
  and a buff with the same weight interleave by insertion order.
- **Insertion by direction.** Where a status lands among equal weights is
  deliberate, not cast-timing — and it is a **declared property of the
  buff**, never derived from who cast it: a status declared
  `direction: 'out to in'` is inserted at the **front of its weight group**
  — before same-weight `'in to out'`/direction-less statuses, and before
  other same-weight `'out to in'` statuses (the newest lands first) — so it
  sits on the outside of its weight group no matter when it was cast. The
  list stays sorted by weight ascending: the lightest weights are at the
  outside (the front of the list) and the heaviest at the inside (the
  back). A status declared `direction: 'in to out'` — and any status without
  a direction — keeps the stable position **after** same-weight statuses
  (toward the inside). So the net transform order is weight first, then
  "out to in before in to out" for ties — never cast timing alone (among
  `'out to in'` statuses the newest lands first; among `'in to out'`/
  direction-less ones, insertion order).
- `character.abilities` and `character.manualAbilities` are **derived at
  query time** by flattening each status's abilities in list order — there
  is no recompute step; destroy/transform/control update the ability set
  automatically ([09-sba-pass.md](09-sba-pass.md) §2).
- `addBuff` refuses a non-stackable duplicate id (returns false, no error).
- `removeBuff` finds by instance or id and respects `removable`; skills and
  `removable: false` buffs are no-ops.
- `removeStatus` is the **engine's cascade path** — it bypasses `removable`.
  Content calls `removeBuff`.

## 4. Buff lifecycle

Adding (`addBuff` Action → engine):

1. A **fresh instance** is created: `new Buff(def, { caster, target,
   grantedBy })` — `caster` = the source character (or a buff source's
   caster); `grantedBy` = the source *status* when the source is a Buff
   (an aura granting its own mark), else undefined.
2. **Cycle detection**: a status may never grant a status that is one of
   its own ancestors (`grantedBy` chains form a forest). On a cycle the
   grant is **refused**, the offending grantor is **removed** (a bomb-style
   grantor blows up in-game via its `buff:destroyed` self-trigger), and a `cycle:detected`
   event is emitted — the recursion dies here, not at the depth guard.
3. The instance is inserted (sorted, stable). Its trigger listeners are
   attached. A `buff:added` event fires.

Removing (`removeBuff` Action, defeat cleanup, or the cascade):

1. The status comes **off the character first**.
2. The engine emits `buff:destroyed` (with the `reason` and `source`)
   **while the buff's own trigger listeners are still attached** — a
   self-listening `buff:destroyed` trigger is how a buff reacts to its own
   end ("when this buff dies"), collected now and executed at the trigger
   drain. Then the listeners are detached.
3. The removal cascade runs: every `removable: false` status this one
   granted is destroyed with it (recursively — a mark that granted further
   marks takes those down too), each through the full removal path.

Defeat cleanup: when a character is destroyed, every buff attached to it
with `removedOnDefeat` (the default) is removed **before** the
`character:destroyed` event fires, so the death is announced with the world
already missing the fallen buffs. Strictly wearer-scoped
([10-destroy.md](10-destroy.md) §3).

## 5. The removal cascade

- When a status is removed, every **permanent** (`removable: false`) status
  it **granted** (`grantedBy === it`) is destroyed with it — on any
  character. An aura being dispelled takes its marks along; that is the one
  path that can remove an unremovable mark, and the only way such marks
  ever leave.
- The cascade follows `grantedBy` chains and **skips removable buffs** —
  they have ordinary dispel rules and are unaffected by their grantor's
  fate.
- Ordinary removable buffs the aura granted are untouched (dispels handle
  those).

## 6. Target model: transform stack

- Transforms stack, keyed by **source** — an item applies a transform;
  removing the source pops it, reverting the form. Knowing the original is
  built in: the stack is applied over the base form.
- A transform swaps the *form*: skills/abilities, gauge maxes (current
  clamps to `Math.min(current, newMax)`), name/icon. **Buffs persist**
  across the swap; the identity (the Character object) never changes.
- **Skill state survives the swap.** A form that leaves the effective form
  (pinned under a hex, replaced by a stronger tie, or reverted) keeps its
  skill **instances** — when the form returns, those same instances come
  back with their `vars` intact, not fresh copies. Only a skill set never
  active on the character gets fresh instances. (Buffs' own abilities were
  always retained: buffs persist across the swap, so a suppressed
  transformation's buff-carried timers keep ticking while its form is
  hidden.)
- **Ties.** A transform keyed by a **buff that is attached when pushed** is
  a *tie* — its invariant is "buff attached ⟺ form active": adding the buff
  pushes the form (the `transformModifier` ability declares this directly),
  removing the buff pops it, reverting the form. **A live tie pins the
  form** above every non-tie entry — a transform pushed while a hex is
  active is recorded underneath but never becomes the character's form; when
  the hex ends, the suppressed form surfaces. Ties fold in **buff-stack
  order** — by the keying buff's `weight` ascending, stable — so the *most
  outgoing* tie (the strongest hex; the last-applied among equal weights)
  is the character's form while several are active: a weaker hex pushed
  under a stronger one changes nothing, and dispelling the strongest
  reveals the next strongest. This is the *state-based* "the hex holds" rule:
  pinning is automatic (the form fold treats live ties as dominant — a
  suppressed push changes nothing and emits no event), and the form-stack
  SBA step at each settle pops any **dangling** tie (one whose keying buff
  is gone by a bypass path), the way the destroy phase keeps the garbage
  honest ([09-sba-pass.md](09-sba-pass.md) §5).
- **Pop.** The `popTransform` action pops the character's *current
  effective* transformation, returning them to the previous state. A
  **live tie pins the form**: while a buff-tied form is active the pop is
  refused — the state-based rule re-asserts the buff's transformation, and
  the buff itself is only removed by a removal action (popping cannot
  dispel). With no tie, the top of the stack pops, revealing the entry
  below or the base form. Gated by the same `on: 'transform'` restriction
  as `transform`.
- Stack *manipulation* (searching, reordering, replacing entries) is a
  future feature, not part of this spec.

## 7. Target model: summon and revive

- **Summon** (`summon` Action, [03 §2.5](03-actions.md)): constructs a
  Character from a `CharacterDef`, registers it (owner/controller stamped),
  lands it in play, and emits `character:summoned` — the aura-rescan hook
  ([13-auras.md](13-auras.md)). `countsForDefeat` defaults **false** for
  summons (an Avatar summon can opt in, [08 §2](08-players-teams-winlose.md)).
  Expiration is a **timer** (pending effects, [12](12-pending-effects.md))
  that destroys the summon at 0 through the normal destroy path — expired
  summons fire death triggers like any other destruction.
- **Revive** (`revive` Action): moves a character garbage → play,
  restores HP (spec default: **full**), emits `character:revived`. Only
  `removedOnDefeat` buffs left at death; the rest are still there when it
  comes back. Reviving a character not in the garbage is a misuse (throw).
- **"Dies with summoner" is an ability**, not a built-in rule — a trigger
  on the summoner's `character:destroyed` event that destroys the summon.

## 8. Acceptance criteria (Slice 0 core + Slice 2)

1. A character constructed with skills has them as `Skill` instances with
   fresh `vars`, sorted by weight; `manualAbilities` lists only manual
   abilities in status order.
2. `isDefeated` reflects HP only; `destroyed` is false until the engine's
   destroy phase sets it.
3. Adding a buff creates a fresh instance (separate `vars`); every add is its
   own instance, because the order instances were added in can matter.
4. `removeBuff` removes removable buffs by id or instance and is a no-op
   for `removable: false` buffs and skills.
5. A buff with `removedOnDefeat: false` survives its wearer's destruction;
   one with the default is removed *before* `character:destroyed` fires,
   and its `buff:destroyed` self-triggers fire with the buff's `vars` still readable.
6. Removing an aura (a buff that granted `removable: false` marks) destroys
   those marks on any character, each firing `buff:destroyed`; ordinary
   removable buffs it granted are untouched.
7. A status trying to grant one of its own ancestors is refused, the
   grantor is removed, and `cycle:detected` fires; no infinite recursion.
8. `summon` lands a character in play and emits `character:summoned`;
   `revive` moves a garbage character back to play at full HP and emits
   `character:revived`; `control` swaps controller without touching owner;
   a transform swaps the form, clamps maxes, and keeps buffs.
