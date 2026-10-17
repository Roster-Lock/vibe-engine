/**
 * Grants — permission on **one particular card** for some players
 * (docs/design/20-secret-choices-and-dice.md, "Who may act on a card").
 *
 * A zone's rule says who may see every card in it. A grant is the same idea for
 * a single entity, for what only becomes known while an effect resolves: "look at
 * target player's hand", "you may cast the card you exiled". Seeing is just one
 * *capability*; a game declares the others (`'cast'`, `'play'`, `'activate'`) and
 * the engine reads none of them — it only remembers who holds which.
 *
 * ## Permission to act does not imply sight
 *
 * You can set a casting going on a card you cannot see: a Boxed Present is cast by
 * *opening* it, and casting it is what reveals it (the stack is public). So a
 * capability implies nothing unless the game says so
 * (`declareCapability('inspect', { implies: ['see'] })`); then granting it grants
 * the implied ones to the same players, from the same source, for the same
 * lifetime, and they end together.
 *
 * ## Lifetimes — there are four things people mean
 *
 * - `'zone-change'` (default) — while the card stays where it is. It becomes a new
 *   object when it moves, so the permission does not follow it. This is "considered
 *   in their hand".
 * - `'resolution'` — for the effect that gave it only (`engine.resolution(fn)`): a
 *   one-time look.
 * - `'turn-end'` — until the turn ends ("you may cast it this turn").
 * - `'manual'` — until `end()`, or until its source is revoked.
 *
 * ## Stacking and sources
 *
 * Several grants on a card are a **union**: a player may act if *any* live grant
 * names them. Each grant remembers its `source`, and `revokeFrom(source)` ends
 * exactly that source's grants — if one effect ends, another effect's permission
 * on the same card is untouched.
 */
import type { ManualAbility } from './ability/manual.js';
import type { EventSource } from './events.js';
import type { Player } from './player.js';
import type { Entity } from './zone.js';

export type GrantEnd = 'zone-change' | 'resolution' | 'turn-end' | 'manual';

/** The capability the engine itself understands: being able to see a card. */
export const SEE = 'see';

export interface CapabilityDef {
  /** Other capabilities granted along with this one, to the same players and for as long. */
  readonly implies?: readonly string[];
}

/** One grant. `end()` revokes it (and any capabilities it implied); safe to call twice. */
export interface Grant {
  readonly entity: Entity;
  readonly players: readonly Player[];
  readonly capability: string;
  readonly until: GrantEnd;
  readonly source: EventSource | undefined;
  /** For an ability grant: the ability the card now has, for these players. */
  readonly ability: ManualAbility | undefined;
  readonly active: boolean;
  end(): void;
}

interface Live extends Grant {
  _active: boolean;
  _implied: Live[];
}

export class Grants {
  readonly #capabilities = new Map<string, CapabilityDef>([[SEE, {}]]);
  readonly #byEntity = new Map<Entity, Set<Live>>();
  /** Open `resolution` scopes, innermost last. */
  readonly #scopes: Live[][] = [];
  readonly #onEnd: (grant: Grant) => void;

  constructor(onEnd: (grant: Grant) => void) {
    this.#onEnd = onEnd;
  }

  /**
   * Declares a capability. Re-declaring the same shape is a no-op; a different one
   * throws. Everything it `implies` must already be declared.
   */
  declare(name: string, def: CapabilityDef = {}): void {
    for (const implied of def.implies ?? []) {
      if (!this.#capabilities.has(implied)) {
        throw new Error(`declareCapability: "${name}" implies "${implied}", which is not declared yet`);
      }
    }
    const existing = this.#capabilities.get(name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(def)) {
      throw new Error(`declareCapability: "${name}" is already declared with a different shape`);
    }
    this.#capabilities.set(name, def);
  }

  has(name: string): boolean {
    return this.#capabilities.has(name);
  }

  /** Grants `capability` (and what it implies) to `players` on `entity`. */
  add(
    entity: Entity,
    players: readonly Player[],
    capability: string,
    until: GrantEnd,
    source: EventSource | undefined,
    ability?: ManualAbility,
  ): Grant {
    if (!this.#capabilities.has(capability)) {
      throw new Error(`grant: "${capability}" is not a declared capability — declare it first with declareCapability`);
    }
    if (until === 'resolution' && this.#scopes.length === 0) {
      throw new Error('grant: an "until the effect ends" grant needs a resolution — call it inside engine.resolution(...)');
    }
    const main = this.#make(entity, players, capability, until, source, ability);
    for (const implied of this.#capabilities.get(capability)!.implies ?? []) {
      main._implied.push(this.#make(entity, players, implied, until, source));
    }
    return main;
  }

  /** True when a live grant lets `player` do `capability` to `entity`. */
  allows(player: Player, entity: Entity, capability: string): boolean {
    for (const grant of this.#byEntity.get(entity) ?? []) {
      if (grant.capability === capability && grant.players.includes(player)) return true;
    }
    return false;
  }

  /** The abilities `player` has been granted on `entity`, oldest grant first. */
  abilitiesFor(player: Player, entity: Entity): ManualAbility[] {
    const found: ManualAbility[] = [];
    for (const grant of this.#byEntity.get(entity) ?? []) {
      if (grant.ability && grant.players.includes(player) && !found.includes(grant.ability)) found.push(grant.ability);
    }
    return found;
  }

  /** The entity left its zone: every `zone-change` grant on it ends. */
  entityLeftZone(entity: Entity): void {
    for (const grant of [...(this.#byEntity.get(entity) ?? [])]) {
      if (grant.until === 'zone-change') this.#end(grant);
    }
  }

  /** The entity is gone entirely: every grant on it ends, whatever its lifetime. */
  entityRemoved(entity: Entity): void {
    for (const grant of [...(this.#byEntity.get(entity) ?? [])]) this.#end(grant);
  }

  /** The turn ended: every `turn-end` grant ends. */
  turnEnded(): void {
    for (const live of [...this.#byEntity.values()]) {
      for (const grant of [...live]) if (grant.until === 'turn-end') this.#end(grant);
    }
  }

  /** Ends every grant `source` made — and only those. */
  revokeFrom(source: EventSource): void {
    for (const live of [...this.#byEntity.values()]) {
      for (const grant of [...live]) if (grant.source === source) this.#end(grant);
    }
  }

  /** Runs `fn` as one resolution; every `resolution` grant made inside ends after it. */
  async scope<T>(fn: () => Promise<T> | T): Promise<T> {
    const made: Live[] = [];
    this.#scopes.push(made);
    try {
      return await fn();
    } finally {
      this.#scopes.pop();
      for (const grant of made) this.#end(grant);
    }
  }

  #make(
    entity: Entity,
    players: readonly Player[],
    capability: string,
    until: GrantEnd,
    source: EventSource | undefined,
    ability?: ManualAbility,
  ): Live {
    const grant: Live = {
      entity,
      players: [...new Set(players)],
      capability,
      until,
      source,
      ability,
      _active: true,
      _implied: [],
      get active() {
        return this._active;
      },
      end: () => this.#end(grant),
    };
    let live = this.#byEntity.get(entity);
    if (!live) this.#byEntity.set(entity, (live = new Set()));
    live.add(grant);
    if (until === 'resolution') this.#scopes[this.#scopes.length - 1]!.push(grant);
    return grant;
  }

  #end(grant: Live): void {
    if (!grant._active) return;
    grant._active = false;
    const live = this.#byEntity.get(grant.entity);
    live?.delete(grant);
    if (live?.size === 0) this.#byEntity.delete(grant.entity);
    this.#onEnd(grant);
    for (const implied of grant._implied) this.#end(implied);
  }
}
