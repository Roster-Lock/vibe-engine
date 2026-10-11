/**
 * A Character is the basic game entity. Every character has:
 *
 * - an **HP gauge** and a **Mana gauge**
 * - a **status list** holding buffs *and* skills, sorted by weight ascending
 *   (lower weight first — lower weights are also applied first in the action
 *   pipeline), owned by a **StatusManager** — the Character delegates all
 *   status work to it instead of handling the list directly
 * - a **form** — skills, gauge maxes, name, icon — that a `transform` action
 *   can swap without replacing the identity (this object), see `pushTransform`
 *
 * Skills are permanent (given at creation, never removable); buffs can be
 * added at runtime, and removal is the default — though a buff may opt out
 * with `removable: false` (an aura's permanent mark). Both are in the
 * *same* sorted list, so a skill and a buff with the same weight interleave
 * by insertion order — except that a status declared `direction: 'out to in'`
 * is inserted *before* same-weight `'in to out'`/direction-less statuses (on
 * the outside of its weight group; the lightest weights sit at the very
 * outside of the list), no matter when it was cast (see
 * `StatusManager.insert`).
 */
import { Gauge, gaugeFrom, type GaugeDef } from './gauge.js';
import type { Ability, ManualAbility } from './ability/index.js';
import type { TransformForm } from './actions.js';
import type { EventSource } from './events.js';
import type { Player } from './player.js';
import { Buff, Skill, StatusManager, type SkillDef, type Status } from './status/index.js';

/**
 * What `Character.handleDamage` / `handleHeal` are told: the change as it
 * stands at the write point, already modified and clamped, plus where it
 * was aimed.
 */
export interface GaugeLanding {
  /** The gauge the pipeline aimed at — `lifeGauge`'s, unless a modifier redirected it. */
  readonly gauge: Gauge;
  /**
   * The change about to be applied, signed as the gauge sees it — negative
   * for damage, positive for healing. Already past the `intent` floor, so
   * its sign always matches the intent that routed it here.
   */
  readonly delta: number;
  /** Who is responsible, when anyone is. */
  readonly source: EventSource | undefined;
}

/** One write a landing hook asks for: this much, on this gauge. */
export interface GaugeLandingWrite {
  readonly gauge: Gauge;
  /** Signed, as the gauge sees it — negative takes the gauge down. */
  readonly delta: number;
}

export interface CharacterDef {
  /**
   * The character's gauges, declared as data (or as pre-built `Gauge`
   * instances). This is the **primary** API: a gauge is a component of a
   * character, and nothing about `'hp'` or `'mana'` is special to the engine.
   *
   * A gauge that carries a `GaugeSba` whose `then` destroys this character is
   * a **life gauge** — that rule, not the gauge's id, is what makes a
   * character die. Declaring two such gauges is legal (either can kill).
   */
  readonly gauges?: readonly (GaugeDef | Gauge)[];
  /**
   * The id of the gauge whose depletion means defeat — what the convenience
   * predicate `Character.isDefeated` reads (name it, and `'stamina'` or
   * `'loyalty'` works exactly like `'hp'`).
   *
   * This is a **reading** convenience, not the engine's death rule. What
   * actually kills a character is a `GaugeSba` attached to a gauge whose
   * `then` destroys it, and that is what the engine's authoritative predicate
   * consults (`GameEngine.wouldBeDestroyed`) — a character can be destroyed
   * with a full life gauge, or survive at zero under an `indestructible`
   * restriction. The two answers differ on purpose; see the doc on
   * `isDefeated`.
   *
   * Defaults to `'hp'` when the character is built from the deprecated
   * `maxHp`/`hp` sugar, and is otherwise unset (a character with no life
   * gauge is defeated only by rules or an explicit `destroy`).
   */
  readonly lifeGauge?: string;
  /**
   * The base value of the character's `'speed'` stat — read with
   * `character.speed`, rewritable by `stat` contributions like any other.
   *
   * The engine puts **no** meaning on it: it defines no round and no ordering,
   * so this is simply a convenient starting value for a stat a game may sort
   * by. Defaults to `0`; a game that wants "normal is 10" supplies its own
   * default (see `src/games/turn-based/initiative.ts`).
   */
  readonly speed?: number;
  /**
   * Base values for **custom** named stats (see `Character.stat` and the
   * `stat` ability) — e.g. `{ power: 2, toughness: 3 }`. The built-in
   * built-in stat (`speed`) is not allowed here — it has its own field. A custom stat's effective value is derived from this
   * base plus the attached `stat` contributions.
   */
  readonly stats?: Readonly<Record<string, number>>;
  /** Permanent skills. A fresh instance is created for this character. */
  readonly skills?: readonly SkillDef[];
}

/**
 * One transform on a character's form stack — the character's base form
 * with every entry's form applied over it, in stack order. **Live ties
 * (buff-keyed entries whose buff was attached when pushed) pin the form**
 * above every non-tie entry — the "the hex holds" rule — folding last in
 * **buff-stack order** (by the keying buff's `weight` ascending, stable),
 * so the *most outgoing* tie — the strongest hex — is the character's form.
 * Stack *manipulation* (searching, reordering, replacing entries) is a
 * future feature.
 */
export interface TransformEntry {
  /**
   * Who the transform is keyed by:
   * - a **Buff** — when that buff is removed (dispelled, dies with its
   *   wearer, taken by the cascade) the entry pops and the form reverts;
   * - a **Character** — a permanent transform cast by that character;
   * - `undefined` — a permanent transform applied with no source.
   */
  readonly source: EventSource | undefined;
  readonly form: TransformForm;
  /**
   * Whether this entry is a **tie**: keyed by a buff that was attached (to
   * any character) when the entry was pushed — e.g. a `transformModifier`
   * buff's form, or a buff's own ability transforming its wearer. Tied
   * entries pin the character's form above every non-tie entry while they
   * are in the stack. The engine pops a tie's entry when its buff is
   * removed, so `tied` ≈ live; the form-stack SBA step cleans any dangling
   * entry (a tie whose buff is gone by a bypass path).
   */
  readonly tied: boolean;
}

/** What a form swap did to the skill list: which instances left, which arrived. */
export interface SkillSwap {
  readonly removed: Skill[];
  readonly added: Skill[];
}

/**
 * The result of a form push or pop: the skill swap (empty when the
 * effective form did not change — a push suppressed by a live tie swaps
 * nothing) and whether the character's **effective form** (name, icon,
 * skills, gauge base maxes) actually changed.
 */
export interface FormChange {
  readonly swap: SkillSwap;
  readonly changed: boolean;
}

/** What popping a transform entry did: the form that left, and the change it made. */
export interface TransformPop extends FormChange {
  readonly form: TransformForm;
}

export class Character {
  /** Discriminator: this entity is a character (as opposed to a `buff`). */
  readonly type = 'character' as const;

  /**
   * The character's current name — part of the **form**: a `transform`
   * action swaps it (reverting when the transform's source buff is
   * removed). The original name is kept in `#baseName` for the revert.
   */
  name: string;
  /** Optional icon (SVG URL/data URI). Part of the form, like `name`. */
  icon: string | undefined;
  /** The speed the character was constructed with — the derived `speed` base. */
  readonly #baseSpeed: number;
  /** Optional team tag used by the engine's ally/enemy helpers. */
  team: string | undefined;

  /**
   * Whether the character has been **destroyed** (moved to the graveyard by
   * the engine's destroy phase). Distinct from `isDefeated`, which is
   * HP-derived — a character destroyed by an explicit `destroy` action may
   * still have full HP. Set by the engine; cleared by a future revive.
   */
  destroyed = false;

  /**
   * The player that controls this character, when one does. Stamped by the
   * `Player` constructor; the engine uses it to attribute wins and losses.
   */
  controller: Player | undefined;

  /**
   * Owns the status list — buffs and skills, sorted by weight ascending.
   * The Character delegates every status operation here; see StatusManager.
   */
  readonly statusManager: StatusManager = new StatusManager();

  /** The name the character was constructed with — the transform-revert base. */
  readonly #baseName: string;
  /** The skills the character was constructed with — the transform-revert base. */
  readonly #baseSkills: SkillDef[];
  /** The transform stack, in application order (top = last). */
  #transforms: TransformEntry[] = [];
  /** The defs the current skill instances were created from — by reference,
   * so a form swap that leaves the effective skills unchanged (a push
   * suppressed by a live tie) does not churn instances or reset their
   * `vars`.
   */
  #lastSkills: readonly SkillDef[];
  /**
   * The skill instances for every effective skill set this character has
   * worn — keyed by the defs array reference. A form that **leaves** the
   * effective form (pinned under a hex, replaced by a stronger tie, or
   * reverted) has its instances stashed here, and gets those **same
   * instances back** — `vars` intact — when it returns. Fresh instances are
   * created only for a set never active on this character before.
   */
  #skillCache = new Map<readonly SkillDef[], Skill[]>();
  /** Every gauge on this character, in construction order (hp, mana, …). */
  readonly #gauges: Gauge[] = [];
  /** The gauge id `isDefeated` reads — declared, never assumed (see `CharacterDef.lifeGauge`). */
  readonly #lifeGaugeId: string | undefined;
  /** Custom base stats (`CharacterDef.stats`), keyed by stat name. */
  readonly #statBases = new Map<string, number>();
  /** Derived stat values the engine wrote — the effective `stat(name)`. */
  readonly #statValues = new Map<string, number>();

  constructor(name: string, def: CharacterDef) {
    this.name = name;
    this.#baseName = name;
    this.#baseSkills = [...(def.skills ?? [])];
    this.#lastSkills = this.#baseSkills;
    // Gauges are declared as data (`CharacterDef.gauges`). The engine assigns
    // no meaning to any id — a gauge is lethal because a `GaugeSba` on *it*
    // says so, not because it is called `hp`.
    const declared = (def.gauges ?? []).map(gaugeFrom);
    // hp and mana first (their historical position), then the rest in
    // declaration order — the SBA pass and target pools enumerate this order.
    this.#gauges.push(...declared);
    // The life gauge is declared, never assumed: nothing about `'hp'` is
    // special to the engine, so a character that wants one names it.
    this.#lifeGaugeId = def.lifeGauge;
    this.#baseSpeed = def.speed ?? 0;
    if (def.stats) {
      for (const [statName, value] of Object.entries(def.stats)) {
        if (statName === 'speed') {
          throw new Error(
            `Character "${this.name}": "speed" is a built-in stat — set it with the "speed" field, not "stats"`,
          );
        }
        if (!Number.isFinite(value)) {
          throw new Error(`Character "${this.name}": stat "${statName}" must be a finite number, got ${value}`);
        }
        this.#statBases.set(statName, value);
      }
    }
    for (const skillDef of def.skills ?? []) {
      // The skill is created for this character — stamp it as its target.
      this.statusManager.insert(new Skill(skillDef, { target: this }));
    }
  }

  /**
   * Every gauge on this character (hp, mana, and any future gauge such as
   * stamina). The engine's SBA pass and ownership lookups enumerate gauges
   * through this instead of knowing the built-in kinds.
   */
  get gauges(): readonly Gauge[] {
    return this.#gauges;
  }

  /**
   * The id of the gauge this character declared as its **life**
   * (`CharacterDef.lifeGauge`), or `undefined` when it declared none.
   *
   * Content asks this instead of assuming `'hp'`: it is what lets one word
   * — "damage" — mean hp on a fighter and `'loyalty'` on a card game's
   * planeswalker, with each entity naming its own. Like `isDefeated`, this
   * is the *declared* reading, not the engine's death rule; what actually
   * kills is a `GaugeSba` (see `CharacterDef.lifeGauge`).
   */
  get lifeGauge(): string | undefined {
    return this.#lifeGaugeId;
  }

  /**
   * **How damage lands on this kind of thing**, asked once at the very end
   * — the moment the fully-composed change meets the gauge, after every
   * passive modifier, the restrictions gate and the `intent` floor have had
   * their say (`GameEngine`'s gauge settlement).
   *
   * This is the hook a **permanent type** overrides to resolve damage its
   * own way: a ward gauge that soaks the first points, a split across two
   * gauges, a counter that eats a hit whole. Return the writes to apply
   * instead, or `undefined` to take the default (the whole delta on the
   * gauge the pipeline aimed at).
   *
   * Two things it deliberately cannot do, because of *when* it runs:
   *
   * - the writes it returns do **not** re-enter the pipeline — no
   *   transformers, no restrictions gate, no second `handleDamage`. It is
   *   the last word, not a new action. Use a `redirect` modifier for
   *   something that should still flow through what comes after it.
   * - it does not choose the gauge the pipeline *aims* at on the way in;
   *   modifiers need a concrete gauge to match and rescale against long
   *   before this point, and that one comes from `lifeGauge`.
   *
   * Only `intent: 'damage'` writes are routed here — `handleHeal` is its
   * counterpart, and plain gauge movement (`intent: 'other'`/`'set'`)
   * lands as it always did, unrouted.
   */
  handleDamage(_info: GaugeLanding): readonly GaugeLandingWrite[] | undefined {
    return undefined;
  }

  /**
   * **How healing lands on this kind of thing** — `handleDamage`'s
   * counterpart, asked at the same point and under the same rules: after
   * every passive modifier and the `intent` floor, with whatever it
   * returns applied as-is rather than re-entering the pipeline.
   *
   * The thing it is usually for is an overflow rule: healing past the
   * life gauge's max spilling into a shield, a temporary-HP gauge, or
   * being thrown away. `info.delta` is positive here.
   *
   * Note the gauge's own `[min, max]` clamp still applies to every write
   * afterwards, so "heal 10 into a gauge 3 short of full" does not need
   * special handling to avoid overfilling — but it *does* need this hook
   * if the other 7 should go somewhere rather than vanish.
   */
  handleHeal(_info: GaugeLanding): readonly GaugeLandingWrite[] | undefined {
    return undefined;
  }

  /**
   * The gauge with this id — the generic way to reach one. Throws when the
   * character has none, so a typo or a missing declaration is loud at the
   * point of use rather than a silent `undefined` three frames later.
   *
   * The engine puts no meaning on any id: `'hp'`, `'stamina'` and a card's
   * `'loyalty'` are all just gauges. Which one is *life* is a rule attached to
   * it, and which one a game *has* is its own declaration.
   *
   * Use `findGauge` when absence is an expected answer rather than a bug.
   */
  gauge(id: string): Gauge {
    const gauge = this.findGauge(id);
    if (!gauge) {
      throw new Error(
        `Character "${this.name}" has no "${id}" gauge — declare it in CharacterDef.gauges.`,
      );
    }
    return gauge;
  }

  /** The gauge with this id, or `undefined` when the character has none. */
  findGauge(id: string): Gauge | undefined {
    return this.#gauges.find((g) => g.id === id);
  }

  /**
   * How fast the character acts: each round's moves run in **descending**
   * speed order, so the fastest character moves first. Derived like every
   * stat — the constructed value is the base; a `stat` contribution
   * rewrites it, and the engine re-derives it on status/transform changes
   * and at each settle (see `stat` in ability/stat.ts).
   */
  get speed(): number {
    return this.#statValues.get('speed') ?? this.#baseSpeed;
  }

  /**
   * The base of a named stat — the value every derivation starts from: the
   * constructed `speed`, or a `CharacterDef.stats` base. `undefined` for a
   * custom stat with no base — it exists only if a `stat` contribution
   * derives it. (A gauge's max is not a named stat — its base is the
   * gauge's `baseMax`, and its derived value is read from the gauge
   * itself: `character.hp.max`.)
   */
  statBase(name: string): number | undefined {
    if (name === 'speed') return this.#baseSpeed;
    return this.#statBases.get(name);
  }

  /**
   * The stat names this character has a **base** for: `speed` plus every
   * custom `CharacterDef.stats` name, in a deterministic order. The engine
   * refreshes these (plus any name contributed by an attached status) on
   * every derivation — and re-derives every gauge's max the same way.
   */
  statBaseKeys(): string[] {
    return ['speed', ...this.#statBases.keys()];
  }

  /**
   * A named stat's **effective value** — derived by the engine from the
   * base plus the attached `stat` contributions (see `stat` in
   * ability/stat.ts). Returns the derived value when the engine has
   * computed one; otherwise the base; `undefined` when the stat does not
   * exist (no base, no contribution). A custom stat like `'power'` is
   * `undefined` until a base or a contribution defines it. Gauge maxes
   * are not named stats — read them from the gauge: `character.hp.max`.
   */
  stat(name: string): number | undefined {
    return this.#statValues.get(name) ?? this.statBase(name);
  }

  /**
   * The engine's write path: caches a derived stat value (the engine's
   * refresh). `undefined` clears the cache, so the stat falls back to its
   * base. Content reads with `stat` — it never writes here.
   */
  setDerivedStat(name: string, value: number | undefined): void {
    if (value === undefined) this.#statValues.delete(name);
    else this.#statValues.set(name, value);
  }

  /**
   * The stat names with a **cached derived value** — the engine has
   * computed one (`#statValues`). A name whose only contribution has left
   * still sits here until the engine refreshes it away; the engine's
   * refresh loops cover these too, so a custom stat with no base reverts
   * to `undefined` when its last source is removed (it is no longer in
   * `statBaseKeys`, and no status contributes it, so the declared-name
   * list alone would miss it).
   */
  statCacheKeys(): string[] {
    return [...this.#statValues.keys()];
  }

  /** Buffs and skills, sorted by weight ascending. */
  get statuses(): readonly Status[] {
    return this.statusManager.statuses;
  }

  /** Only the buffs (runtime statuses — removable or not). */
  get buffs(): Buff[] {
    return this.statusManager.buffs;
  }

  /** Only the skills (permanent statuses given at character creation). */
  get skills(): Skill[] {
    return this.statusManager.skills;
  }

  /** Every ability currently granted by buffs and skills, in status order. */
  get abilities(): Ability[] {
    return this.statusManager.abilities;
  }

  /**
   * The transform stack, in application order (top = last). The effective
   * form is the base form with every entry applied over it — **live ties
   * pin the form** above every non-tie entry, folding last in buff-stack
   * order (by the keying buff's `weight` ascending, stable — the strongest
   * hex shows); among the non-ties, the last entry that names an aspect
   * (name, icon, skills, gauge maxes) wins.
   */
  get transforms(): readonly TransformEntry[] {
    return this.#transforms;
  }

  /** The manual abilities the player can actively use. */
  get manualAbilities(): ManualAbility[] {
    return this.abilities.filter((a): a is ManualAbility => a.kind === 'manual');
  }

  /**
   * True when the character counts as **defeated** — the HP gauge is at
   * (or below) its minimum. HP is the life gauge: the engine's destroy
   * phase takes a character whose HP crossed `min` this batch, and
   * win/lose treats an HP-empty character as dead. This is the condition
   * of the engine's **built-in** death rule ("HP Depleted") — a
   * convenience predicate on the character itself; the engine's
   * authoritative dead predicate consults the `GaugeSba` rules on the
   * character's gauges, so content that re-attaches death to another
   * gauge (or adds conditions) is reflected in win/lose even though this
   * predicate still reads HP. Distinct from `destroyed`, which is set by
   * the engine's destroy phase — a character destroyed by an explicit
   * `destroy` action may still have full HP.
   */
  get isDefeated(): boolean {
    // Reads the **declared life gauge**, if the character has one. Deliberately
    // rule-independent: a character whose life gauge bottomed out reads as
    // defeated even when a restriction is keeping it alive (indestructible at
    // 0) or its death rule was removed. The authoritative, rule- and
    // restriction-aware answer is `GameEngine.wouldBeDestroyed` — a character
    // destroyed by an explicit action may still read as *not* defeated here.
    if (this.#lifeGaugeId === undefined) return false;
    const gauge = this.gauge(this.#lifeGaugeId);
    return gauge !== undefined && gauge.current <= gauge.min;
  }

  /** True when the character currently has a status with this id. */
  hasStatus(id: string): boolean {
    return this.statusManager.hasStatus(id);
  }

  /** Finds a status (buff or skill) by id. */
  findStatus(id: string): Status | undefined {
    return this.statusManager.findStatus(id);
  }

  /**
   * Finds a buff by kind id, or by **exact instance** (its `uid` — so with
   * stacked copies of the same buff, the specific instance is found, not
   * just the first of its kind).
   */
  findBuff(buff: Buff | string): Buff | undefined {
    return this.statusManager.findBuff(buff);
  }

  /**
   * Adds a buff instance to the sorted list. Returns `false` (and does
   * nothing) when a non-stackable buff with the same id is already present.
   */
  addBuff(buff: Buff): boolean {
    return this.statusManager.addBuff(buff);
  }

  /**
   * Removes a **removable** buff from the list — by kind id, or by exact
   * instance (its `uid`; with stacked copies, exactly that instance is
   * removed). Returns the removed buff. Buffs declared `removable: false` —
   * and skills — are never removed: the call is a no-op returning
   * `undefined`.
   */
  removeBuff(buff: Buff | string): Buff | undefined {
    return this.statusManager.removeBuff(buff);
  }

  /**
   * Removes a status **by instance**, regardless of `removable`. This is the
   * engine's cascade path: when a status that granted permanent marks is
   * removed, those marks are destroyed with it. Content should call
   * `removeBuff` instead — it respects `removable`.
   */
  removeStatus(status: Status): boolean {
    return this.statusManager.removeStatus(status);
  }

  /**
   * Applies a **form**: pushes it onto the transform stack (keyed by
   * `source` — a buff, a character, or nothing) and swaps the effective
   * form. Skills swap to the arriving set — a set the character wore before
   * gets its **remembered instances back** (`vars` intact); a never-seen set
   * gets fresh instances — and the name and icon update; buffs are
   * untouched. `tied` marks a buff-keyed entry whose keying buff is attached
   * — a live tie pins the form above every non-tie entry (the "hex holds"
   * rule), so a push under a tie is recorded but changes nothing observable.
   *
   * A source that already has an entry (the same buff instance, the same
   * character) has its entry **replaced**, not duplicated — the stack is
   * keyed by source.
   *
   * The form is normalized on the way in (see `normalizeTransformForm`), so
   * every path that reaches the stack — the `transform()` builder, a
   * `transformModifier` ability, a raw action — handles the deprecated
   * `maxHp`/`maxMana` aliases identically.
   */
  pushTransform(form: TransformForm, source: EventSource | undefined, tied: boolean): FormChange {
    const before = this.#snapshot();
    const existing = this.#transforms.findIndex((e) => e.source === source);
    if (existing !== -1) {
      this.#transforms[existing] = { source, form, tied };
    } else {
      this.#transforms.push({ source, form, tied });
    }
    return this.#refreshForm(before);
  }

  /**
   * Pops the transform entry keyed by `source` — the engine calls this when
   * a transform-carrying buff is removed (dispelled, dies with its wearer,
   * taken by the cascade) — and reverts the form. Returns what the pop did
   * (the form that left, and the change it made), or `undefined` when
   * `source` had no entry (a character-keyed or sourceless permanent
   * transform is never popped by this path).
   */
  popTransform(source: Buff): TransformPop | undefined {
    const index = this.#transforms.findIndex((e) => e.source === source);
    if (index === -1) return undefined;
    const before = this.#snapshot();
    const entry = this.#transforms[index]!;
    this.#transforms.splice(index, 1);
    const change = this.#refreshForm(before);
    return { form: entry.form, ...change };
  }

  /**
   * Pops the **top** entry of the stack (the direct `popTransform` action's
   * path for a stack with no live tie — the engine pops live ties by
   * removing their keying buff instead). Returns what the pop did, or
   * `undefined` when the stack is empty.
   */
  popTopTransform(): TransformPop | undefined {
    const entry = this.#transforms.at(-1);
    if (!entry) return undefined;
    const before = this.#snapshot();
    this.#transforms.pop();
    const change = this.#refreshForm(before);
    return { form: entry.form, ...change };
  }

  /**
   * The gauge's base max with every transform applied (live ties pin first;
   * among the rest the last entry that names the gauge wins), clamped at 0.
   * The engine derives the effective `gauge.max` from this — instead of the
   * gauge's construction `baseMax` — plus the attached statuses'
   * `maxModifier` contributions, so a transformed form composes with buffs
   * exactly like the original.
   */
  transformedBaseMax(gaugeId: string): number {
    const gauge = this.findGauge(gaugeId);
    if (!gauge) return 0;
    const value = this.#foldForm(gauge.baseMax, (f) => f.gauges?.[gaugeId]);
    return Math.max(0, value);
  }

  /**
   * The effective form's current state, captured **before** a push/pop so
   * `#refreshForm` can tell whether the swap actually changed anything.
   *
   * The maxes are a **map keyed by gauge id**, not a fixed pair of fields, so
   * a form can name any gauge the character carries — a stamina bar or a
   * card game's loyalty counters transform like `hp` does.
   */
  #snapshot(): {
    name: string;
    icon: string | undefined;
    gaugeMaxes: ReadonlyMap<string, number>;
    skills: readonly SkillDef[];
  } {
    return {
      name: this.name,
      icon: this.icon,
      gaugeMaxes: new Map(this.#gauges.map((g) => [g.id, this.transformedBaseMax(g.id)])),
      skills: this.#lastSkills,
    };
  }

  /**
   * Re-applies the whole stack over the base form — name, icon, skills —
   * after a push/pop/replace, and reports whether the **effective form**
   * changed against the pre-mutation snapshot. Skills are swapped only when
   * the effective skill defs actually changed (by reference): a push
   * suppressed by a live tie swaps nothing, so the tie's skill `vars`
   * survive. A swap remembers the departing set's instances and reuses a
   * returning set's (see `#swapSkills`). The maxes are not touched here:
   * the engine re-derives them from `transformedBaseMax` (that is what
   * clamps the current value down to a shrunken max).
   */
  #refreshForm(before: {
    name: string;
    icon: string | undefined;
    gaugeMaxes: ReadonlyMap<string, number>;
    skills: readonly SkillDef[];
  }): FormChange {
    this.name = this.#foldForm(this.#baseName, (f) => f.name);
    this.icon = this.#foldForm(undefined, (f) => f.icon);
    const defs = this.#foldForm(this.#baseSkills, (f) => f.skills);
    let swap: SkillSwap = { removed: [], added: [] };
    if (defs !== before.skills) {
      swap = this.#swapSkills(defs);
    }
    this.#lastSkills = defs;
    const maxesChanged = this.#gauges.some(
      (g) => this.transformedBaseMax(g.id) !== before.gaugeMaxes.get(g.id),
    );
    const changed =
      this.name !== before.name ||
      this.icon !== before.icon ||
      swap.removed.length > 0 ||
      maxesChanged;
    return { swap, changed };
  }

  /**
   * Folds the stack over `base`. **Live ties pin the form**: non-tie
   * entries fold in stack order, then tied entries fold on top — **in
   * buff-stack order**: by their keying buff's `weight` ascending (stable,
   * so equal weights fall back to application order). The *most outgoing*
   * tie — the strongest hex, the last-applied among equals — is therefore
   * the character's form while any tie is active.
   */
  #foldForm<A>(base: A, pick: (form: TransformForm) => A | undefined): A {
    let value = base;
    for (const entry of this.#transforms) {
      if (entry.tied) continue;
      const next = pick(entry.form);
      if (next !== undefined) value = next;
    }
    // Ties sort by the keying buff's weight; `Array.prototype.sort` is
    // stable, so equal-weight ties keep application order.
    const ties = this.#transforms
      .filter((e) => e.tied)
      .sort((a, b) => {
        const wa = a.source instanceof Buff ? a.source.weight : 0;
        const wb = b.source instanceof Buff ? b.source.weight : 0;
        return wa - wb;
      });
    for (const entry of ties) {
      const next = pick(entry.form);
      if (next !== undefined) value = next;
    }
    return value;
  }

  /**
   * Replaces the effective skill list: every current `Skill` (base or from a
   * previous form) leaves, and the arriving set's instances are inserted in
   * sorted order. The departing instances are **remembered** for their defs,
   * and an arriving set that was active before gets its **same instances
   * back** — a form that returns (a hex dispelled, a reverted base form)
   * keeps its skills' `vars` instead of starting over. Only a set never
   * active on this character gets fresh instances. Buffs — whatever they
   * grant — are untouched.
   */
  #swapSkills(defs: readonly SkillDef[]): SkillSwap {
    const removed: Skill[] = [];
    for (const status of [...this.statuses]) {
      if (status.type !== 'skill') continue;
      removed.push(status);
      this.statusManager.removeStatus(status);
    }
    // `#lastSkills` is still the departing set here (`#refreshForm` updates
    // it after this returns) — stash those instances for when the form
    // comes back.
    this.#skillCache.set(this.#lastSkills, removed);
    const added: Skill[] = [];
    const cached = this.#skillCache.get(defs);
    if (cached) {
      for (const instance of cached) {
        this.statusManager.insert(instance);
        added.push(instance);
      }
    } else {
      for (const def of defs) {
        const instance = new Skill(def, { target: this });
        this.statusManager.insert(instance);
        added.push(instance);
      }
      this.#skillCache.set(defs, added);
    }
    return { removed, added };
  }

  toString(): string {
    // Every gauge, not just hp: a character need not have one, and stringifying
    // one used to throw through the deprecated accessor.
    return `${this.name} (${this.#gauges.map((g) => g.toString()).join(', ')})`;
  }
}
