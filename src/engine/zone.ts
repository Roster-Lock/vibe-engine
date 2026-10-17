/**
 * Zones — ordered or unordered containers of entities, declared as **data**
 * (docs/design/15-zones.md).
 *
 * The engine used to have zones hard-coded twice for one entity type: `play`
 * and `graveyard` as two `Set<Character>` fields. A card game needs a deck, a
 * hand, a stack, a garbage pile and whatever a new mechanic invents, so the
 * mechanism is generalized rather than duplicated — a pile system sitting
 * *beside* the engine's own play/graveyard could not be intercepted by a
 * replacement effect written against the engine's destroy, which is the whole
 * point of having one mechanism.
 *
 * Two built-in zones ship here, because the engine's own rules name them:
 * `play` (the only targetable zone by default) and `graveyard` (where
 * `destroy` puts things). Every other zone is a declaration a game adds.
 *
 * **Every registered entity is in exactly one zone.** That invariant is what
 * replaces the old "`#characters` minus `#graveyard`" arithmetic, and
 * `ZoneRegistry.entities` preserves **registration order** — trigger
 * ordering and target-pool order depend on it, so it is not derived from
 * zone membership.
 */
import type { ManualAbility } from './ability/manual.js';
import type { Player } from './player.js';
import { shuffle } from './seed.js';

/**
 * **An entity** — anything a zone can hold.
 *
 * Deliberately tiny. A zone needs identity (membership is by reference) and
 * these two fields: a `type` to narrow on, and a `name` for diagnostics.
 * Everything else — gauges, statuses, a controller — belongs to *particular
 * kinds* of entity, not to entities as such. That is the correction behind
 * this interface: gauges are a component of hero-ish cards, not a property
 * every card has, so a spell must be able to sit in a zone without
 * pretending to have hit points.
 *
 * `Character` is the entity kind with gauges and statuses (`type:
 * 'character'`). An ability waiting on the stack is another kind
 * (`src/games/cards/stack.ts`). The engine's own rules only ever reason
 * about characters, so it narrows with `type === 'character'` wherever it
 * walks a zone — see `GameEngine.registeredCharacters`.
 *
 * This is the narrow slice of docs/design/15-zones.md's `Entity` decision:
 * enough to let non-character objects live in zones, without the full
 * identity/form extraction that doc describes.
 */
export interface Entity {
  /** Discriminant — `'character'` for a `Character`. */
  readonly type: string;
  readonly name: string;
  /**
   * **A unique id for this one object** — two copies of the same card have
   * different ids. For online and computer play a card choice is just this id: it
   * names exactly one option, so it can never be vague. Optional so an entity
   * that is never chosen need not carry one; a game that lets players choose
   * cards gives every card one. Unique within a request's options, or the
   * request is refused.
   */
  readonly id?: string;
  /**
   * **A written marker that tells look-alikes apart** — the number on a token,
   * the letter on a goblin card. Two creatures both named "Goblin" are one vague
   * answer to "which?", so a commitment to either needs something a player can
   * write down. Defaults to `name` (see `markersFor`, `src/engine/choice.ts`).
   */
  readonly marker?: string;
  /**
   * **Any numeric fact a game wants asked about this entity**, by name — a
   * card's mana cost, a land flag (1/0), a printed power, a crew rating.
   *
   * This exists because the engine holds entities it knows nothing about, and
   * an effect still has to *filter* them: "reveal until you find a card with
   * cost 2 or less" is one generic sentence over one generic question. The
   * engine has no `cost` field and must not grow one — cost is the card game's
   * idea of what matters, not the engine's — so the game declares the fact and
   * the engine only reads the map.
   *
   * An absent name reads **0** rather than throwing, the way an absent gauge
   * does: content is shared between games, and a fact one game keeps and
   * another does not should narrow an effect rather than break it. A game that
   * needs to tell "no cost" from "cost 0" declares a companion fact (`land`).
   *
   * A **boolean** is not sugar for 0/1 at the type level, and the difference is
   * the point: a `land` fact is *true*, not *zero-cost*, and the very next
   * question after "is this a land" is "what does it cost".
   */
  readonly attributes?: ReadonlyMap<string, number | boolean>;
  /**
   * **The player who owns this entity** — whose it is, as opposed to who controls or
   * holds it right now. Optional: a game that never takes a card from its owner need not
   * say. Where it is set, a zone declared `ownerOnly` refuses the entity unless the zone
   * is its owner's.
   */
  readonly owner?: Player;
}

/** Who may see a zone's contents. */
export type ZoneVisibility =
  /** Everyone (play, the stack, a garbage pile). */
  | 'public'
  /** Only the zone's owner (a hand). */
  | 'owner'
  /**
   * Nobody — a deck's order is secret but real. Hidden *even from its
   * owner*, which is what makes networked play possible without trusting a
   * client.
   */
  | 'hidden'
  /**
   * **Exactly the players on the zone's viewer list** (`Zone.viewers`, set with
   * `engine.setViewers`) — "everyone but the owner can see it", "the targeted
   * player may look". The declaration is data and names no roles; the list is
   * state, built while the game runs by whatever keyword says who may look. Until
   * something sets it the list is empty and the zone behaves like `hidden`.
   */
  | 'custom';

/** One shared zone, or one instance per player. */
export type ZoneScope = 'shared' | 'per-player';

/**
 * Where an entity lands in an ordered zone.
 *
 * A bare `number` is a 0-based index from the top (0 is the top). `{ nth, from }`
 * is the way cards say it — *"third from the top"*, *"seventh from the bottom"* —
 * and is **1-based**, so `{ nth: 1, from: 'top' }` is `'top'` and
 * `{ nth: 1, from: 'bottom' }` is `'bottom'`. It names where the entity ends up,
 * and clamps: a zone too short for "seventh from the top" puts it at the bottom.
 */
export type ZonePosition = 'top' | 'bottom' | number | { readonly nth: number; readonly from: ZoneEnd };

/** Which end of an ordered zone a position or a section is counted from. */
export type ZoneEnd = 'top' | 'bottom';

/** A zone declaration — plain data, so it can travel in shared content. */
export interface ZoneDef {
  readonly id: string;
  /** Position matters (a deck) vs. a bag (a hand). Defaults to `false`. */
  readonly ordered?: boolean;
  /** Defaults to `'public'`. */
  readonly visibility?: ZoneVisibility;
  /** Defaults to `'shared'`. */
  readonly scope?: ZoneScope;
  /**
   * A per-player zone that **only holds its own player's cards** — a hand, a library, a
   * graveyard. An entity with an `owner` can only be put in the instance that belongs to
   * that owner; anything else throws before the move happens. To hold another player's
   * card (a stolen one that can be cast) a game declares a different zone.
   */
  readonly ownerOnly?: boolean;
  /** Whether `validTargets` draws from it. Defaults to `false` — only `play` does. */
  readonly targetable?: boolean;
  /**
   * A family tag, so content can name one zone precisely *or* a family
   * generically.
   *
   * This is the mitigation for one-zone-per-purpose (the decision in
   * docs/design/15-zones.md): Magic's single overloaded Exile is what lets
   * "return target card from exile" exist at all, and splitting it by
   * purpose would otherwise strand any effect reaching for "anything out of
   * play". A `group` keeps that reachable.
   */
  readonly group?: string;
  /**
   * Maximum members. `active` (the zone a spell resolves in) is capacity 1 —
   * exceeding a capacity is a content bug and throws rather than silently
   * over-filling.
   */
  readonly capacity?: number;
}

/**
 * Group tags the engine itself reasons about.
 *
 * `IN_PLAY` is what "on the battlefield" means generically: a zone whose
 * occupants are live, targetable game objects. `REMOVED` is the family of
 * out-of-play piles. Content and the engine test these rather than zone
 * ids, so a game that renames `play` or splits `garbage` by purpose keeps
 * working (docs/design/15-zones.md, one zone per purpose).
 */
export const IN_PLAY = 'in-play';
export const REMOVED = 'removed';

/**
 * The engine's own zones. Everything else is a game's declaration.
 *
 * `garbage` is **per-player**: a destroyed permanent belongs to whoever
 * controlled it, and in a card game "your graveyard" is a real object that
 * reanimation reads. It is the same pile a spent spell goes to, so there is
 * one removed pile per player rather than a shared graveyard plus a second
 * discard pile that every reader has to tell apart.
 */
export const PLAY: ZoneDef = { id: 'play', visibility: 'public', targetable: true, group: IN_PLAY };
export const GARBAGE: ZoneDef = {
  id: 'garbage',
  visibility: 'public',
  scope: 'per-player',
  ownerOnly: true,
  group: REMOVED,
};

/**
 * One zone instance. For a `per-player` declaration there is one instance
 * per player, each carrying its `owner`.
 *
 * Membership is mutated only through the `ZoneRegistry`, so the registry's
 * "every entity is in exactly one zone" invariant cannot be broken from
 * outside.
 */
export class Zone {
  readonly id: string;
  readonly ordered: boolean;
  readonly visibility: ZoneVisibility;
  readonly scope: ZoneScope;
  readonly targetable: boolean;
  readonly group: string | undefined;
  readonly capacity: number | undefined;
  /** Holds only its owner's cards (see `ZoneDef.ownerOnly`). */
  readonly ownerOnly: boolean;
  /** The player this instance belongs to, for a `per-player` zone. */
  readonly owner: Player | undefined;

  /** @internal — the registry owns mutation. */
  _members: Entity[] = [];

  constructor(def: ZoneDef, owner?: Player) {
    this.id = def.id;
    this.ordered = def.ordered ?? false;
    this.visibility = def.visibility ?? 'public';
    this.scope = def.scope ?? 'shared';
    this.targetable = def.targetable ?? false;
    this.group = def.group;
    this.capacity = def.capacity;
    this.ownerOnly = def.ownerOnly === true;
    this.owner = owner;
  }

  /**
   * The players who may see this zone's cards when its visibility is `'custom'`.
   * Empty until set; ignored for every other visibility.
   */
  get viewers(): readonly Player[] {
    return this._viewers;
  }

  /** @internal — `GameEngine.setViewers` owns mutation. */
  _viewers: Player[] = [];

  /**
   * The abilities every card in this zone has **while it is here**, though it did
   * not print them — a Boxed Present zone's *Open Present*. Empty until set with
   * `engine.setZoneAbilities`; like the viewer list, standing state set while the
   * game runs, not part of the declaration.
   */
  get abilities(): readonly ManualAbility[] {
    return this._abilities.map((entry) => entry.ability);
  }

  /** Each ability the zone gives, with the players who may use *it*. */
  get abilityEntries(): readonly { readonly ability: ManualAbility; readonly users: readonly Player[] }[] {
    return this._abilities;
  }

  /** @internal — `GameEngine.setZoneAbilities` / `addZoneAbility` own mutation. */
  _abilities: { ability: ManualAbility; users: Player[] }[] = [];

  /** The zone's contents. For an ordered zone, index 0 is the **top**. */
  get members(): readonly Entity[] {
    return this._members;
  }

  /** The zone's contents of one entity kind, narrowed. */
  of<T extends Entity>(type: T['type']): T[] {
    return this._members.filter((member): member is T => member.type === type);
  }

  get size(): number {
    return this._members.length;
  }

  contains(entity: Entity): boolean {
    return this._members.includes(entity);
  }

  /** The top of an ordered zone (a deck's next draw). */
  get top(): Entity | undefined {
    return this._members[0];
  }

  /**
   * The `nth` entity (1-based) counted from one end of an ordered zone — "the
   * seventh card from the top". Undefined for an unordered zone, or one too
   * short. A bag has no ends, and picking one would be a silent lie.
   */
  nth(nth: number, from: ZoneEnd = 'top'): Entity | undefined {
    if (!this.ordered || !Number.isInteger(nth) || nth < 1 || nth > this._members.length) return undefined;
    return this._members[from === 'top' ? nth - 1 : this._members.length - nth];
  }

  /**
   * The first `count` entities from one end, **in zone order** (index 0 is the
   * top, whichever end was asked for) — the section a scry looks at. Empty for
   * an unordered zone.
   */
  section(count: number, from: ZoneEnd = 'top'): readonly Entity[] {
    if (!this.ordered || count <= 0) return [];
    const n = Math.min(count, this._members.length);
    return from === 'top' ? this._members.slice(0, n) : this._members.slice(this._members.length - n);
  }

  /** A stable key: the id, plus the owner for a per-player instance. */
  get key(): string {
    return this.owner ? `${this.id}:${this.owner.name}` : this.id;
  }

  toString(): string {
    return `${this.key} (${this.size})`;
  }
}

/** What a completed move reports — the two ends of the transition. */
export interface ZoneTransition {
  readonly entity: Entity;
  readonly from: Zone | undefined;
  readonly to: Zone;
}

export class ZoneRegistry {
  readonly #defs = new Map<string, ZoneDef>();
  /** Shared zones by id; per-player zones by `id` → player → instance. */
  readonly #shared = new Map<string, Zone>();
  readonly #perPlayer = new Map<string, Map<Player, Zone>>();
  /** Per-player zones' instance for entities whose owner is unknown. */
  readonly #unowned = new Map<string, Zone>();
  /** Every registered entity's current zone. */
  readonly #of = new Map<Entity, Zone>();
  /** Registration order — the order `entities` reports, independent of zones. */
  readonly #order: Entity[] = [];

  constructor(defs: readonly ZoneDef[] = [PLAY, GARBAGE]) {
    for (const def of defs) this.declare(def);
  }

  /**
   * Declares a zone. Re-declaring the same id with an identical shape is a
   * no-op (a game may list the built-ins); a conflicting re-declaration
   * throws rather than silently rebinding a zone content already references.
   */
  declare(def: ZoneDef): Zone | undefined {
    const existing = this.#defs.get(def.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(def)) {
        throw new Error(`ZoneRegistry: zone "${def.id}" is already declared with a different shape`);
      }
      return this.#shared.get(def.id);
    }
    this.#defs.set(def.id, def);
    if ((def.scope ?? 'shared') === 'per-player') {
      this.#perPlayer.set(def.id, new Map());
      return undefined;
    }
    const zone = new Zone(def);
    this.#shared.set(def.id, zone);
    return zone;
  }

  /**
   * Removes a zone that was declared for a moment — a temporary pile an effect made. It must
   * be empty (move its cards out first); a zone content references by name is never removed.
   */
  undeclare(id: string): boolean {
    const zone = this.#shared.get(id);
    if (zone && zone._members.length > 0) throw new Error(`ZoneRegistry: zone "${id}" still holds ${zone._members.length} card(s)`);
    this.#shared.delete(id);
    this.#perPlayer.delete(id);
    return this.#defs.delete(id);
  }

  get definitions(): readonly ZoneDef[] {
    return [...this.#defs.values()];
  }

  /**
   * A zone instance. A `per-player` zone needs its `owner`; asking for one
   * without an owner returns undefined rather than guessing — use
   * `unownedZone` when "no owner" is a real answer rather than an omission.
   */
  zone(id: string, owner?: Player): Zone | undefined {
    const def = this.#defs.get(id);
    if (!def) return undefined;
    if ((def.scope ?? 'shared') !== 'per-player') return this.#shared.get(id);
    if (!owner) return undefined;
    const byPlayer = this.#perPlayer.get(id)!;
    let zone = byPlayer.get(owner);
    if (!zone) {
      zone = new Zone(def, owner);
      byPlayer.set(owner, zone);
    }
    return zone;
  }

  /**
   * The instance a `per-player` zone uses for entities with **no owner** —
   * a character registered without a controller, whose destruction still
   * has to put it somewhere.
   *
   * Distinct from `zone(id)` returning undefined: that is "you forgot the
   * owner", this is "there is no owner", and a shared pile for the
   * ownerless is the honest answer to the second.
   */
  unownedZone(id: string): Zone | undefined {
    const def = this.#defs.get(id);
    if (!def) return undefined;
    if ((def.scope ?? 'shared') !== 'per-player') return this.#shared.get(id);
    let zone = this.#unowned.get(id);
    if (!zone) {
      zone = new Zone(def);
      this.#unowned.set(id, zone);
    }
    return zone;
  }

  /** Every zone instance that exists, built-ins first. */
  get zones(): readonly Zone[] {
    return [
      ...this.#shared.values(),
      ...this.#unowned.values(),
      ...[...this.#perPlayer.values()].flatMap((m) => [...m.values()]),
    ];
  }

  /** Every instance of one zone id, across every owner. */
  instancesOf(id: string): readonly Zone[] {
    return this.zones.filter((zone) => zone.id === id);
  }

  /** Every zone of a family (`group`) — the generic-reference escape hatch. */
  group(group: string): readonly Zone[] {
    return this.zones.filter((zone) => zone.group === group);
  }

  /** The zone an entity is in, or undefined when it is not registered. */
  zoneOf(entity: Entity): Zone | undefined {
    return this.#of.get(entity);
  }

  has(entity: Entity): boolean {
    return this.#of.has(entity);
  }

  /** Every registered entity, in registration order. */
  get entities(): readonly Entity[] {
    return this.#order;
  }

  /** Every registered entity of one kind, in registration order. */
  entitiesOf<T extends Entity>(type: T['type']): T[] {
    return this.#order.filter((entity): entity is T => entity.type === type);
  }

  /** The entities in a zone, in that zone's order. */
  members(id: string, owner?: Player): readonly Entity[] {
    return this.zone(id, owner)?.members ?? [];
  }

  /**
   * First placement. Registers the entity (appending to `entities`) and puts
   * it in `zone`. A second call for an already-registered entity is a no-op —
   * use `move`.
   */
  add(entity: Entity, zone: Zone, position: ZonePosition = 'bottom'): boolean {
    if (this.#of.has(entity)) return false;
    this.#admit(entity, zone);
    this.#order.push(entity);
    this.#place(entity, zone, position);
    return true;
  }

  /**
   * Moves an entity to another zone. Returns the transition, or undefined
   * when the entity is unregistered or already there (so a caller can tell a
   * real change from a no-op — events announce changes).
   */
  move(entity: Entity, to: Zone, position: ZonePosition = 'bottom'): ZoneTransition | undefined {
    const from = this.#of.get(entity);
    if (!from) return undefined;
    if (from === to) return undefined;
    this.#admit(entity, to);
    this.#pull(entity, from);
    this.#place(entity, to, position);
    return { entity, from, to };
  }

  /** Unregisters an entity entirely (engine disposal, not a game move). */
  remove(entity: Entity): boolean {
    const zone = this.#of.get(entity);
    if (!zone) return false;
    this.#pull(entity, zone);
    this.#of.delete(entity);
    const index = this.#order.indexOf(entity);
    if (index !== -1) this.#order.splice(index, 1);
    return true;
  }

  /**
   * Shuffles an **ordered** zone in place (a deck) with the game's PRNG.
   *
   * This announces nothing: a move is a game event, but a shuffle is not —
   * no player learns the order, so there is nothing to trigger on. An
   * unordered zone is left alone, because it has no order to lose.
   */
  shuffle(zone: Zone, rng: () => number): void {
    if (!zone.ordered) return;
    shuffle(zone._members, rng);
  }

  /**
   * Moves an entity to a new position **within the zone it is already in** —
   * top to bottom, bottom to top, "put it third from the top".
   *
   * Not a `move`: it never leaves its zone, so there is no `zone:changed` to
   * announce, and like a shuffle it only changes what is hidden. Returns false
   * for an unregistered entity or an unordered zone (a bag has no positions).
   */
  reposition(entity: Entity, position: ZonePosition): boolean {
    const zone = this.#of.get(entity);
    if (!zone?.ordered) return false;
    this.#pull(entity, zone);
    this.#place(entity, zone, position);
    return true;
  }

  /**
   * **Rearranges the first `count` entities** of an ordered zone (from either
   * end) — the commit step of a scry. `top` are put back at the top in the
   * order given; `bottom` go to the bottom in the order given. Together they
   * must be exactly that section, no more and no less: dropping a card or
   * smuggling one in from deeper is a content bug, so it throws.
   *
   * The two lists are the *new* order of the section, so "scry 3, keep the first
   * on top, bottom the others" is `{ top: [a], bottom: [b, c] }`. Returns the
   * section as it was, for the caller's log.
   */
  arrange(
    zone: Zone,
    count: number,
    placement: { readonly top?: readonly Entity[]; readonly bottom?: readonly Entity[] },
    from: ZoneEnd = 'top',
  ): readonly Entity[] {
    const before = zone.section(count, from);
    const top = placement.top ?? [];
    const bottom = placement.bottom ?? [];
    const placed = [...top, ...bottom];
    const valid =
      placed.length === before.length &&
      new Set(placed).size === placed.length &&
      placed.every((entity) => before.includes(entity));
    if (!valid) {
      throw new Error(`arrange: the placement must be exactly the ${before.length} entities of the section`);
    }
    // Pull the whole section, then re-place: the top ones in reverse onto the
    // top (so the first listed ends up first), the bottom ones in order.
    for (const entity of placed) this.#pull(entity, zone);
    for (let i = top.length - 1; i >= 0; i -= 1) zone._members.unshift(top[i]!);
    for (const entity of bottom) zone._members.push(entity);
    return before;
  }

  #pull(entity: Entity, zone: Zone): void {
    const index = zone._members.indexOf(entity);
    if (index !== -1) zone._members.splice(index, 1);
  }

  /** Throws, before anything moves, if `zone` may not hold `entity` (see `ZoneDef.ownerOnly`). */
  #admit(entity: Entity, zone: Zone): void {
    if (zone.ownerOnly && zone.owner && entity.owner && entity.owner !== zone.owner) {
      throw new Error(
        `"${entity.name}" belongs to ${entity.owner.name}, so it cannot be put in ${zone.owner.name}'s ${zone.id} — ` +
          `a ${zone.id} holds only its own player's cards`,
      );
    }
  }

  #place(entity: Entity, zone: Zone, position: ZonePosition): void {
    if (zone.capacity !== undefined && zone._members.length >= zone.capacity) {
      throw new Error(
        `Zone "${zone.key}" holds ${zone._members.length} of a maximum ${zone.capacity} — cannot add "${entity.name}"`,
      );
    }
    if (!zone.ordered) zone._members.push(entity);
    else zone._members.splice(indexFor(position, zone._members.length), 0, entity);
    this.#of.set(entity, zone);
  }
}

/** The insertion index for `position` in an ordered zone currently holding `length`. */
function indexFor(position: ZonePosition, length: number): number {
  const clamp = (index: number): number => Math.max(0, Math.min(index, length));
  if (position === 'top') return 0;
  if (position === 'bottom') return length;
  if (typeof position === 'number') return clamp(position);
  // Ends up `nth` from the chosen end: from the bottom, that is `nth - 1`
  // entities below it.
  return clamp(position.from === 'top' ? position.nth - 1 : length - (position.nth - 1));
}
