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
import type { Player } from './player.js';

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
  | 'hidden';

/** One shared zone, or one instance per player. */
export type ZoneScope = 'shared' | 'per-player';

/** Where an entity lands in an ordered zone. */
export type ZonePosition = 'top' | 'bottom' | number;

/** A zone declaration — plain data, so it can travel in shared content. */
export interface ZoneDef {
  readonly id: string;
  /** Position matters (a deck) vs. a bag (a hand). Defaults to `false`. */
  readonly ordered?: boolean;
  /** Defaults to `'public'`. */
  readonly visibility?: ZoneVisibility;
  /** Defaults to `'shared'`. */
  readonly scope?: ZoneScope;
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
 * ids, so a game that renames `play` or splits `graveyard` by purpose keeps
 * working (docs/design/15-zones.md, one zone per purpose).
 */
export const IN_PLAY = 'in-play';
export const REMOVED = 'removed';

/** The engine's own zones. Everything else is a game's declaration. */
export const PLAY: ZoneDef = { id: 'play', visibility: 'public', targetable: true, group: IN_PLAY };
export const GRAVEYARD: ZoneDef = { id: 'graveyard', visibility: 'public', group: REMOVED };

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
    this.owner = owner;
  }

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
  /** Every registered entity's current zone. */
  readonly #of = new Map<Entity, Zone>();
  /** Registration order — the order `entities` reports, independent of zones. */
  readonly #order: Entity[] = [];

  constructor(defs: readonly ZoneDef[] = [PLAY, GRAVEYARD]) {
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

  get definitions(): readonly ZoneDef[] {
    return [...this.#defs.values()];
  }

  /**
   * A zone instance. A `per-player` zone needs its `owner`; asking for one
   * without an owner returns undefined rather than guessing.
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

  /** Every zone instance that exists, built-ins first. */
  get zones(): readonly Zone[] {
    return [...this.#shared.values(), ...[...this.#perPlayer.values()].flatMap((m) => [...m.values()])];
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

  #pull(entity: Entity, zone: Zone): void {
    const index = zone._members.indexOf(entity);
    if (index !== -1) zone._members.splice(index, 1);
  }

  #place(entity: Entity, zone: Zone, position: ZonePosition): void {
    if (zone.capacity !== undefined && zone._members.length >= zone.capacity) {
      throw new Error(
        `Zone "${zone.key}" holds ${zone._members.length} of a maximum ${zone.capacity} — cannot add "${entity.name}"`,
      );
    }
    if (!zone.ordered || position === 'bottom') zone._members.push(entity);
    else if (position === 'top') zone._members.unshift(entity);
    else zone._members.splice(Math.max(0, Math.min(position, zone._members.length)), 0, entity);
    this.#of.set(entity, zone);
  }
}
