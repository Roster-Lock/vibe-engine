/**
 * Server views — what **one player** is allowed to know about the game
 * (docs/design/20-secret-choices-and-dice.md, "Online play: a trusted server").
 *
 * Online, the engine runs on a server and each client is sent a *view*: the game as
 * that player may see it, as plain data. This is what makes a hidden deck, a face-down
 * commitment and a wrapped present safe without trusting a client — a client cannot
 * misuse what it was never sent.
 *
 * ## The rule, in one sentence
 *
 * **A card you cannot see is not in your view** — only that it exists, and (for an
 * ordered pile) where.
 *
 * - A zone is always sent with its **size**; its cards are sent only if
 *   `engine.canSee(player, card)` (the zone's rule, or a live grant).
 * - A card you can see has a **ref**: a random handle, stable for the whole game, that
 *   the client quotes when it acts on the card.
 * - A card you cannot see has **no ref at all**. A ref that survived a shuffle would
 *   let a player who once saw a card keep track of it through the shuffle, which
 *   physically they could not do.
 * - In an **ordered** zone a hidden card keeps its place as an anonymous placeholder
 *   (the top of a deck is still the top). In an **unordered** zone — a hand — the
 *   order of the cards you cannot see is not sent either, only how many.
 *
 * ## Events
 *
 * `eventFor(player, event)` redacts an event for one recipient with the same rule:
 * any card in it the recipient cannot see is anonymous, any player is an id, any zone
 * is its key. The one deliberate exception is `choice:revealed`, whose point is to turn
 * the committed cards face up for everyone.
 *
 * A card that moves out of a zone its recipient could see keeps its ref in the event
 * (they knew which card it was; a Goblin bounced to a hidden hand is still *that*
 * Goblin to them), but a card that was already hidden never gets one.
 *
 * ## Intents
 *
 * The client names a card by ref (`resolveRef`, checked against what the player can
 * see **now**) or, for a card it cannot see, by place (`resolveSlot`). The server
 * decides what is allowed; the projector only finds the card.
 */
import { Character } from './character.js';
import type { GameEngine } from './engine.js';
import type { GameEvent } from './events.js';
import { Player } from './player.js';
import { Zone, type Entity } from './zone.js';

/** A card the recipient cannot see: that it is there, and (if they ever could see it where it came from) which card it was. */
export interface HiddenView {
  readonly hidden: true;
  readonly ref?: string;
}

/** A card the recipient can see. Anything a game's `describe` adds rides along. */
export interface EntityView {
  readonly hidden?: false;
  readonly ref: string;
  readonly type: string;
  readonly name: string;
  readonly id?: string;
  readonly marker?: string;
  readonly attributes?: Readonly<Record<string, number | boolean>>;
  /** For a character: its gauges, current and maximum. */
  readonly gauges?: readonly { readonly id: string; readonly current: number; readonly max: number }[];
  /** For a character: the id of the player who controls it. */
  readonly controller?: string;
  readonly [extra: string]: unknown;
}

export type SlotView = EntityView | HiddenView;

export interface ZoneView {
  /** `Zone.key`: the zone's id, plus its owner for a per-player instance. */
  readonly key: string;
  readonly id: string;
  /** The owning player's id, for a per-player instance. */
  readonly owner?: string;
  readonly group?: string;
  readonly visibility: string;
  readonly ordered: boolean;
  readonly capacity?: number;
  /** How many cards are in the zone — never hidden. */
  readonly size: number;
  /**
   * The cards, in the zone's order. In an **ordered** zone a card the viewer cannot
   * see is an anonymous placeholder in its place. In an **unordered** zone only the
   * cards the viewer can see are listed (their order carries no meaning) and
   * `hiddenCount` says how many more there are.
   */
  readonly members: readonly SlotView[];
  readonly hiddenCount: number;
}

export interface PlayerView {
  readonly id: string;
  readonly name: string;
  readonly team?: string;
}

export interface GameView {
  /** The player this view is for. */
  readonly viewer: string;
  readonly players: readonly PlayerView[];
  readonly zones: readonly ZoneView[];
}

/** An event after redaction: plain data, safe to send to one recipient. */
export type ViewEvent = { readonly type: string } & Readonly<Record<string, unknown>>;

export interface ViewOptions {
  /**
   * Makes a ref. Defaults to a random UUID. A server should keep it random: a ref that
   * can be guessed, or that encodes something about the card, defeats the point.
   * Tests inject a counter.
   */
  readonly makeRef?: () => string;
  /**
   * What a game adds to a visible card's view — a card's cost and text, say. Merged
   * over the default (`type`, `name`, `id`, `marker`, `attributes`, and a character's
   * gauges and controller).
   */
  readonly describe?: (entity: Entity) => Readonly<Record<string, unknown>>;
}

/** How deep a redacted event is followed before it is cut off. */
const MAX_DEPTH = 8;

export class ViewProjector {
  readonly #engine: GameEngine;
  readonly #makeRef: () => string;
  readonly #describe: ((entity: Entity) => Readonly<Record<string, unknown>>) | undefined;
  readonly #refOf = new WeakMap<Entity, string>();
  readonly #byRef = new Map<string, Entity>();

  constructor(engine: GameEngine, options: ViewOptions = {}) {
    this.#engine = engine;
    this.#makeRef = options.makeRef ?? (() => globalThis.crypto.randomUUID());
    this.#describe = options.describe;
  }

  /* -------------------------------- the view -------------------------------- */

  /**
   * The whole game as `player` may see it.
   *
   * Every player has an instance of every per-player zone in the view, empty or not:
   * a client needs the structure (that Bo has a hand, with nothing in it yet), and the
   * registry only creates an instance when something first asks for it.
   */
  viewFor(player: Player): GameView {
    for (const def of this.#engine.zones.definitions) {
      if ((def.scope ?? 'shared') !== 'per-player') continue;
      for (const owner of this.#engine.players) this.#engine.zones.zone(def.id, owner);
    }
    return {
      viewer: player.id,
      players: this.#engine.players.map((p) => ({ id: p.id, name: p.name, ...(p.team ? { team: p.team } : {}) })),
      zones: this.#engine.zones.zones.map((zone) => this.zoneView(player, zone)),
    };
  }

  /** One zone as `player` may see it. */
  zoneView(player: Player, zone: Zone): ZoneView {
    const slots = zone.members.map((member) => this.#slot(player, member));
    const hidden = slots.filter((slot) => slot.hidden === true).length;
    return {
      key: zone.key,
      id: zone.id,
      ...(zone.owner ? { owner: zone.owner.id } : {}),
      ...(zone.group ? { group: zone.group } : {}),
      visibility: zone.visibility,
      ordered: zone.ordered,
      ...(zone.capacity !== undefined ? { capacity: zone.capacity } : {}),
      size: zone.size,
      // A hand's order means nothing, so the cards the viewer cannot see are only counted.
      members: zone.ordered ? slots : slots.filter((slot) => slot.hidden !== true),
      hiddenCount: hidden,
    };
  }

  /** One card as `player` may see it: in full, or as an anonymous placeholder. */
  viewOf(player: Player, entity: Entity): SlotView {
    return this.#slot(player, entity);
  }

  /* --------------------------------- events --------------------------------- */

  /**
   * An event as `recipient` may see it, or `undefined` for one they must not hear of.
   * Plain data — a server serializes it straight onto the wire.
   */
  eventFor(recipient: Player, event: GameEvent): ViewEvent | undefined {
    switch (event.type) {
      case 'zone:changed': {
        const moved = event as Extract<GameEvent, { type: 'zone:changed' }>;
        return {
          type: 'zone:changed',
          entity: this.#movedEntity(recipient, moved.entity, 'from' in moved ? moved.from : undefined),
          ...('from' in moved ? { from: moved.from.key } : {}),
          to: moved.to.key,
        };
      }
      case 'zone:changed:batch': {
        const batch = event as Extract<GameEvent, { type: 'zone:changed:batch' }>;
        return {
          type: 'zone:changed:batch',
          events: batch.events.map((inner) => this.eventFor(recipient, inner)),
        };
      }
      case 'choice:revealed': {
        // The reveal turns what was committed face up for everyone — that is its job.
        const revealed = event as Extract<GameEvent, { type: 'choice:revealed' }>;
        return {
          type: 'choice:revealed',
          answers: revealed.answers.map(({ player, answer }) => ({
            player: player.id,
            answer: this.#plain(recipient, answer, 0, new WeakSet(), true),
          })),
        };
      }
      default:
        return this.#plain(recipient, event, 0, new WeakSet(), false) as ViewEvent;
    }
  }

  /**
   * Sends an event to every player, each their own redacted copy — the one line a
   * server needs in its `onEvent`:
   *
   * ```ts
   * const engine = createEngine({ onEvent: (event) => projector.broadcast(event, send) });
   * ```
   *
   * A player who must not hear of the event is skipped.
   */
  broadcast(event: GameEvent, send: (player: Player, event: ViewEvent) => void): void {
    for (const player of this.#engine.players) {
      const redacted = this.eventFor(player, event);
      if (redacted) send(player, redacted);
    }
  }

  /* -------------------------------- intents --------------------------------- */

  /**
   * The card a client's ref names — **only if `player` can see it now**. A ref for a
   * card they once saw but no longer can resolves to nothing, so a stale or forged ref
   * cannot reach a hidden card.
   */
  resolveRef(player: Player, ref: string): Entity | undefined {
    const entity = this.#byRef.get(ref);
    return entity && this.#engine.canSee(player, entity) ? entity : undefined;
  }

  /**
   * The card in a place the player cannot see into. In an **ordered** zone `index` is
   * the position, as the view lists it; in an **unordered** zone it is the n-th card
   * the player cannot see, in the server's own order — the client cannot tell them
   * apart, so any fixed numbering will do.
   */
  resolveSlot(player: Player, zoneKey: string, index: number): Entity | undefined {
    const zone = this.#engine.zones.zones.find((candidate) => candidate.key === zoneKey);
    if (!zone || !Number.isInteger(index) || index < 0) return undefined;
    if (zone.ordered) return zone.members[index];
    return zone.members.filter((member) => !this.#engine.canSee(player, member))[index];
  }

  /** The ref of a card, making one if it has none. Server-side use only: never sent for a hidden card. */
  refOf(entity: Entity): string {
    let ref = this.#refOf.get(entity);
    if (ref === undefined) {
      ref = this.#makeRef();
      this.#refOf.set(entity, ref);
      this.#byRef.set(ref, entity);
    }
    return ref;
  }

  /* ------------------------------- internals -------------------------------- */

  #slot(player: Player, entity: Entity): SlotView {
    return this.#engine.canSee(player, entity) ? this.#entityView(entity) : { hidden: true };
  }

  #entityView(entity: Entity): EntityView {
    const view: Record<string, unknown> = {
      ref: this.refOf(entity),
      type: entity.type,
      name: entity.name,
    };
    if (entity.id !== undefined) view.id = entity.id;
    if (entity.marker !== undefined) view.marker = entity.marker;
    if (entity.attributes) view.attributes = Object.fromEntries(entity.attributes);
    if (entity instanceof Character) {
      view.gauges = entity.gauges.map((gauge) => ({ id: gauge.id, current: gauge.current, max: gauge.max }));
      if (entity.controller) view.controller = entity.controller.id;
    }
    return { ...view, ...(this.#describe?.(entity) ?? {}) } as EntityView;
  }

  /**
   * A card in a `zone:changed`. Visible now → in full. Hidden now → anonymous, but it
   * keeps its ref if the recipient could see it where it came from.
   */
  #movedEntity(recipient: Player, entity: Entity, from: Zone | undefined): SlotView {
    if (this.#engine.canSee(recipient, entity)) return this.#entityView(entity);
    const knew = from !== undefined && this.#engine.zoneShows(recipient, from);
    return knew ? { hidden: true, ref: this.refOf(entity) } : { hidden: true };
  }

  /** Anything inside an event, as plain data: cards you cannot see anonymous, players ids, zones keys. */
  #plain(recipient: Player, value: unknown, depth: number, seen: WeakSet<object>, reveal: boolean): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value !== 'object') return value;
    if (value instanceof Player) return { player: value.id, name: value.name };
    if (value instanceof Zone) return { zone: value.key };
    if (this.#isEntity(value)) {
      return reveal || this.#engine.canSee(recipient, value) ? this.#entityView(value) : { hidden: true };
    }
    if (depth >= MAX_DEPTH) return '[too deep]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => this.#plain(recipient, item, depth + 1, seen, reveal));
      if (value instanceof Set) return [...value].map((item) => this.#plain(recipient, item, depth + 1, seen, reveal));
      if (value instanceof Map) {
        return [...value].map(([k, v]) => [
          this.#plain(recipient, k, depth + 1, seen, reveal),
          this.#plain(recipient, v, depth + 1, seen, reveal),
        ]);
      }
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        if (key.startsWith('_') || key.startsWith('#')) continue;
        const plain = this.#plain(recipient, inner, depth + 1, seen, reveal);
        if (plain !== undefined) out[key] = plain;
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }

  #isEntity(value: object): value is Entity {
    const candidate = value as Partial<Entity>;
    return typeof candidate.type === 'string' && typeof candidate.name === 'string' && this.#engine.zones.has(value as Entity);
  }
}
