/**
 * Game events and how abilities hear about them.
 *
 * The engine dispatches events to **trigger listeners**: every triggered
 * ability registers a listener (with a unique id), and when an event fires
 * the matching listeners are collected into the prepare stack, gated by each
 * ability's prestack filter (`when`), sorted by listener id, shuffled with
 * the seeded PRNG, and run — see `GameEngine.emit` and `#dispatchTriggers`.
 * The `GameEngine` also reports every event to its `onEvent` observer.
 *
 * `EventBus` below remains as a standalone generic async event bus, but the
 * engine no longer uses it for triggers.
 *
 * ## No optional properties — events come in versions
 *
 * An event carries **exactly the fields it has**: nothing is optional.
 * Where a fact may or may not apply (a source, a target, max-writes), the
 * event is split into **multiple versions** — separate union members with
 * the same `type` tag, each with all-required fields. Content narrows with
 * the `in` operator, and TypeScript narrows the rest:
 *
 * ```ts
 * if ('source' in ctx.event && ctx.event.source.type === 'buff') {
 *   // ctx.event.source is a Buff here — .vars, .weight, … are visible
 * }
 * ```
 *
 * There is no dedicated "damage" or "heal" event — an HP change is just a
 * `gauge:changed` event on the character's HP gauge. The helpers below
 * (and the `EventSource` discriminant) turn that one event into the
 * vocabulary content actually cares about:
 *
 * - was the gauge **hp**? (`isHpChange`)
 * - was the gauge **mana**? (`isManaChange`)
 * - did it go **down or up** — damage or healing? (`isDamage` / `isHeal`)
 * - did a given character **deal** it? (`wasDealtBy` — the source is that
 *   character itself, not one of its buffs)
 * - did a given character **take** it? (`wasTakenBy` — their own HP gauge
 *   dropped)
 *
 * **HP is the life gauge.** The engine's death state-based checks (the
 * destroy phase and win/lose's dead predicate) watch the **HP** gauge: a
 * character whose HP crossed `min` this batch is destroyed, and a
 * character whose derived HP max is driven to 0 dies too. Mana is an
 * ordinary resource — `damage`/`heal` still move it, but it never kills
 * (a mana-death game moves the death rules to the mana gauge, see
 * `GaugeSba`). `character:destroyed` and `character:survived` both carry
 * every **HP** write that landed on the character in the same batch (see
 * `GaugeWrite`), so a revenge or last-breath trigger can filter the
 * damage dealers from `event.changes` with `isDamage`.
 *
 * The `:batch` variants (`gauge:changed:batch`, `character:destroyed:batch`,
 * `character:survived:batch`, `buff:destroyed:batch`) fire once per batch
 * and carry just the individual events — the event list is the payload.
 *
 * To add a brand-new event type, augment `GameEventMap` in `contracts.ts` —
 * triggered abilities will then be able to listen to it, and `ctx.event` will
 * narrow on it. The engine's own events are ordinary entries in the same map,
 * so a game adds events the way the engine does rather than through a
 * privileged path.
 */
import type { Ability, Targeting } from './ability/index.js';
import type { TransformForm } from './actions.js';
import type { Character } from './character.js';
import type { GameEvent, GameEventMap } from './contracts.js';
import type { Gauge } from './gauge.js';
import type { Buff } from './status/index.js';
import { GRAVEYARD, IN_PLAY, type Entity, type Zone } from './zone.js';

/** The zone an event refers to. */
export type ZoneRef = Zone;

/** Who caused an event: a fighter (`type: 'character'`), or a buff doing its thing. */
export type EventSource = Character | Buff;

/**
 * A gauge's value changed. **Versions** by what is known:
 * - no `target` — a gauge with no registered owner character;
 * - no `source` — nobody caused the write (a plain `setGauge`).
 * Narrow with `'target' in event` / `'source' in event`.
 */
export type GaugeChangedEvent =
  | { type: 'gauge:changed'; gauge: Gauge; from: number; to: number }
  | { type: 'gauge:changed'; gauge: Gauge; from: number; to: number; source: EventSource }
  | { type: 'gauge:changed'; gauge: Gauge; target: Character; from: number; to: number }
  | {
      type: 'gauge:changed';
      gauge: Gauge;
      target: Character;
      from: number;
      to: number;
      source: EventSource;
    };

/**
 * Every gauge that changed in one batch, announced once after the
 * individual `gauge:changed` events (see `#applyGaugeBatch`): the netted
 * events in first-touch order. The "whenever one or more gauges change"
 * primitive — HP, mana, or any other gauge.
 */
export type GaugeChangedBatchEvent = {
  type: 'gauge:changed:batch';
  events: GaugeChangedEvent[];
};

/**
 * A gauge's **max** changed (derived from statuses, never written directly).
 * Versions: with or without a `source`.
 */
export type GaugeMaxChangedEvent =
  | { type: 'gauge:maxChanged'; gauge: Gauge; from: number; to: number }
  | { type: 'gauge:maxChanged'; gauge: Gauge; from: number; to: number; source: EventSource };

/**
 * A named stat's **value** changed — a character's derived number such as
 * `'speed'` or a custom stat (`'power'`, `'toughness'`), read with
 * `character.stat(name)`. Versions: with or without a `source`.
 *
 * Only **named (non-gauge) stats** announce here — a gauge's max is not a
 * named stat and keeps announcing as `gauge:maxChanged` (it is read from
 * the gauge itself, and a max driven to 0 can destroy the character). The
 * `stat` field is the name/label the change happened to; `from`/`to` are
 * the **effective** values — base and contributions folded in — so a
 * contribution leaving is visible as a revert to the base.
 *
 * Fires when a `stat` contribution lands or leaves (a buff added/removed, a
 * form change — `source` names who caused it), or when a **function**-of-
 * state stat re-derives at a settle (the world changed — no single source).
 * Registration stays silent (setup semantics), destroyed characters are
 * skipped (no noise), and a custom stat with **no base** that comes into or
 * goes out of existence is not announced — there is no concrete `from`/`to`
 * transition; the grantor's own `buff:added`/`buff:destroyed` covers it.
 */
export type StatChangedEvent =
  | { type: 'stat:changed'; character: Character; stat: string; from: number; to: number }
  | {
      type: 'stat:changed';
      character: Character;
      stat: string;
      from: number;
      to: number;
      source: EventSource;
    };

/** A buff was applied to a character. Versions: with or without a `source`. */
export type BuffAddedEvent =
  | { type: 'buff:added'; character: Character; buff: Buff }
  | { type: 'buff:added'; character: Character; buff: Buff; source: EventSource };

/**
 * A buff left its character. Versions: with or without a `source` — see
 * `BuffDestroyReason`: `'wearer-destroyed'` carries no source; `'removed'`
 * carries one when a character or buff is responsible.
 */
export type BuffDestroyedEvent =
  | { type: 'buff:destroyed'; character: Character; buff: Buff; reason: BuffDestroyReason }
  | {
      type: 'buff:destroyed';
      character: Character;
      buff: Buff;
      reason: BuffDestroyReason;
      source: EventSource;
    };

/**
 * Every buff destroyed by one `apply` — the unit's removals (direct
 * `removeBuff` actions, the on-defeat cleanup, and the removal cascade),
 * summarized once at the apply's end. Fires even for a single removal.
 * `events` are the individual `buff:destroyed` events in the order they
 * fired.
 */
export type BuffDestroyedBatchEvent = {
  type: 'buff:destroyed:batch';
  events: BuffDestroyedEvent[];
};

/**
 * A character was destroyed. **Versions** by payload × source — the
 * `reason` is the firing gauge rule's reason (data, see `GaugeSba`):
 * - the built-ins report `hp:current-reached-minimum` (carries `changes` —
 *   every HP write) and `hp:maximum-reached-0` (carries `maxChanges` —
 *   the max writes);
 * - content rules report their own `reason`;
 * - `direct-action` — an explicit `destroy` action, no writes.
 * Each comes with or without a `source`. Narrow with `event.reason` and
 * `'source' in event`.
 */
export type CharacterDestroyedEvent =
  | {
      type: 'character:destroyed';
      character: Character;
      reason: string;
      changes: GaugeWrite[];
    }
  | {
      type: 'character:destroyed';
      character: Character;
      reason: string;
      changes: GaugeWrite[];
      source: EventSource;
    }
  | {
      type: 'character:destroyed';
      character: Character;
      reason: string;
      changes: GaugeWrite[];
      maxChanges: GaugeMaxChange[];
    }
  | {
      type: 'character:destroyed';
      character: Character;
      reason: string;
      changes: GaugeWrite[];
      maxChanges: GaugeMaxChange[];
      source: EventSource;
    };

/** A character took at least one HP write in a batch and survived. */
export type CharacterSurvivedEvent = {
  type: 'character:survived';
  character: Character;
  changes: GaugeWrite[];
};

/** Every destroyed character of one settle, announced once. */
export type CharacterDestroyedBatchEvent = {
  type: 'character:destroyed:batch';
  events: CharacterDestroyedEvent[];
};

/** Every surviving character of one settle, announced once. */
export type CharacterSurvivedBatchEvent = {
  type: 'character:survived:batch';
  events: CharacterSurvivedEvent[];
};

/**
 * A character's **form** changed — a `transform` action pushed a form onto
 * its stack, or a pop (a keying buff's removal, the `popTransform` action,
 * the form-stack SBA step) removed one. Carries the form that was
 * pushed/popped and whether it was a push or a pop. Versions: with or
 * without a `source` (who caused the change — the transform action's
 * source, or the buff-removal source; a wearer-destroyed pop carries no
 * source). Note the numeric part of a form change is also announced as
 * `gauge:maxChanged`; this event covers the whole swap (name/icon/skills
 * included). A push **suppressed by a live tie** (a hex pinning the form)
 * changes nothing and fires nothing — events announce changes. Every form
 * change of one `apply` is also summarized as a single
 * `character:transformed:batch` at the apply's end.
 */
export type CharacterTransformedEvent =
  | {
      type: 'character:transformed';
      character: Character;
      form: TransformForm;
      reason: TransformReason;
    }
  | {
      type: 'character:transformed';
      character: Character;
      form: TransformForm;
      reason: TransformReason;
      source: EventSource;
    };

/** Why a `character:transformed` event fired: a form was pushed or popped. */
export type TransformReason = 'pushed' | 'popped';

/**
 * Every form change of one `apply` — pushes and pops from `transform`
 * actions, buff-tied forms landing and leaving, and the form-stack SBA
 * step — summarized once at the apply's end, in the order the individual
 * `character:transformed` events fired. Fires even for a single change.
 */
export type CharacterTransformedBatchEvent = {
  type: 'character:transformed:batch';
  events: CharacterTransformedEvent[];
};

/**
 * An entity changed zones (zone.ts). `from` is absent on a first
 * placement — a registration, or an entity conjured mid-effect — so narrow
 * with `'from' in event` before reading it, like every other versioned
 * event here.
 *
 * `destroy` is a move to the graveyard, so a destruction announces **both**
 * this and `character:destroyed`: this one is the mechanical transition
 * ("left play"), the other carries the death's `reason` and gauge writes.
 * Content that cares about leaving play — bounce, exile, death alike —
 * listens here; content that cares about *dying* listens there.
 */
export type ZoneChangedEvent =
  | { type: 'zone:changed'; entity: Entity; to: ZoneRef }
  | { type: 'zone:changed'; entity: Entity; from: ZoneRef; to: ZoneRef };

/**
 * Every zone change of one settle, announced once after the individual
 * events — the "whenever one or more cards are discarded" primitive. Fires
 * even for a single move, like the other `:batch` events.
 */
export type ZoneChangedBatchEvent = {
  type: 'zone:changed:batch';
  events: ZoneChangedEvent[];
};

/**
 * The event map — the extension seam — is declared in `contracts.ts` and
 * re-exported here so this file stays the place events are *described*.
 * Augment `GameEventMap` (from `contracts.js`) to add a game's own events.
 */
export type { GameEvent, GameEventMap } from './contracts.js';

/**
 * A `gauge:changed` event on a character's **own** gauge (HP or mana — the
 * `changes` entries in `character:destroyed` / `character:survived` are the
 * life gauge's, i.e. HP). Versions: with or without a `source`.
 */
export type GaugeWrite =
  | { type: 'gauge:changed'; gauge: Gauge; target: Character; from: number; to: number }
  | {
      type: 'gauge:changed';
      gauge: Gauge;
      target: Character;
      from: number;
      to: number;
      source: EventSource;
    };

/**
 * One gauge write applied to a character (see `character:survived`).
 *
 * A gauge batch may contain several writes to the same gauge; each is
 * reported with its own `from`/`to`/`source` so content can see who really
 * drained the character — the netted `gauge:changed` event only carries the
 * last write's source. Shaped like a `gauge:changed` event so the helpers
 * below (`isManaChange`, `wasDealtBy`, …) apply to it directly.
 */

/**
 * One write to a character's **max** gauge (see `character:destroyed` with
 * `reason: 'hp:maximum-reached-0'` — a status drove the derived HP max
 * to 0). Shaped like a `gauge:maxChanged` event with the owning character
 * attached. Versions: with or without a `source`.
 */
export type GaugeMaxChange =
  | { type: 'gauge:maxChanged'; gauge: Gauge; target: Character; from: number; to: number }
  | {
      type: 'gauge:maxChanged';
      gauge: Gauge;
      target: Character;
      from: number;
      to: number;
      source: EventSource;
    };

/**
 * Why a buff left its character (see `buff:destroyed`):
 *
 * - `'wearer-destroyed'` — the buff died with its wearer;
 * - `'removed'` — dispelled, taken by the cascade, or cycle-refused.
 *
 * For `'removed'`, the `source` names who: a `Character` (a skill or a
 * direct action) or a `Buff` (a buff/aura's ability, including the
 * cascade's grantor).
 */
export type BuffDestroyReason = 'wearer-destroyed' | 'removed';

/**
 * Why a character was destroyed (see `character:destroyed`). The built-in
 * gauge rules report:
 *
 * - `'hp:current-reached-minimum'` — HP writes drove the gauge to `min`;
 * - `'hp:maximum-reached-0'` — max-HP writes drove the gauge to 0;
 * - `'direct-action'` — a `destroy` action caused it.
 *
 * Content-registered gauge rules (`GaugeSba`) report their own `reason`
 * verbatim, so the reason is an open string.
 */
export type DestroyReason = string;

/* ------------------------------ helpers ------------------------------ */

/** True when the event is a `gauge:changed` (any version). */
export function isGaugeChange(event: GameEvent): event is GaugeChangedEvent {
  return event.type === 'gauge:changed';
}

/**
 * How much a gauge changed (the damage or heal amount).
 *
 * Gauge-generic on purpose: the engine does not know what a loss *means*, only
 * that a number moved. A game that calls it "damage" layers its own predicates
 * on top (see `src/games/turn-based/events.ts`).
 */
export function amountOf(event: GameEvent): number {
  return isGaugeChange(event) ? Math.abs(event.to - event.from) : 0;
}

/** True when the event is a zone change (any version). */
export function isZoneChange(event: GameEvent): event is ZoneChangedEvent {
  return event.type === 'zone:changed';
}

/**
 * **Dying is leaving play for the garbage pile.** Not a separate kind of
 * event — the same `zone:changed` every other move produces, with the two
 * ends that mean death: out of a zone in the `IN_PLAY` family, into the
 * graveyard.
 *
 * This is the definition to reason from, and it is Magic's own (rule
 * 700.4: *"dies means 'is put into a graveyard from the battlefield'"*).
 * It settles a class of questions by construction:
 *
 * - a **bounce** (play → hand) is a zone change and not a death, so
 *   "whenever a creature leaves play" and "whenever a creature dies" are
 *   different listeners rather than one with a flag;
 * - **exile** (play → a `REMOVED` zone that is not the graveyard) is also
 *   not a death, which is exactly why removal-by-exile dodges death
 *   triggers;
 * - a thing that was **never in play** going to the graveyard (a discard
 *   from hand) is not a death either.
 *
 * `character:destroyed` remains the **annotated** view of the same
 * transition: it carries why it happened (`reason`) and the gauge writes
 * that did it (`changes`), which a bare move cannot. Listen here for the
 * fact, there for the forensics.
 */
export function isDeath(event: GameEvent): event is Extract<ZoneChangedEvent, { from: Zone }> {
  return (
    isZoneChange(event) &&
    'from' in event &&
    event.from.group === IN_PLAY &&
    event.to.id === GRAVEYARD.id
  );
}

/**
 * True when the event took an entity **out of play** without killing it —
 * a bounce, an exile, a tuck into a deck. The complement of `isDeath` over
 * the moves that leave an `IN_PLAY` zone.
 */
export function leftPlay(event: GameEvent): event is Extract<ZoneChangedEvent, { from: Zone }> {
  return isZoneChange(event) && 'from' in event && event.from.group === IN_PLAY;
}

export type EventHandler = (event: GameEvent) => void | Promise<void>;

/**
 * A minimal async event bus. Handlers run in subscription order and are
 * awaited. The engine's trigger dispatch no longer uses this — it keeps its
 * own listener registry with unique ids and a shuffled stack (see
 * `src/engine/engine.ts`); `EventBus` remains available as a generic utility
 * for custom plumbing.
 */
export class EventBus {
  readonly #handlers = new Map<string, Set<EventHandler>>();

  /** Subscribes a handler to one event type. Returns an unsubscribe function. */
  on(type: GameEvent['type'], handler: EventHandler): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set<EventHandler>();
      this.#handlers.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  off(type: GameEvent['type'], handler: EventHandler): void {
    this.#handlers.get(type)?.delete(handler);
  }

  /** Fires an event. Resolves after every subscribed handler has run. */
  async emit(event: GameEvent): Promise<void> {
    const set = this.#handlers.get(event.type);
    if (!set) return;
    // Copy so handlers can subscribe/unsubscribe while we iterate.
    for (const handler of [...set]) {
      await handler(event);
    }
  }
}
