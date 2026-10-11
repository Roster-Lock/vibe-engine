/**
 * The card game's zones, as **declarations** (docs/design/15-zones.md).
 *
 * This file is data. Nothing here is engine code — it is what a game hands
 * `engine.zones.declare(...)`, and the same shape a player-authored
 * mechanic will eventually ship inside shared content when it needs a zone
 * of its own.
 *
 * ## One zone per purpose
 *
 * Magic overloads a single Exile for suspend, adventure, foretell, "exiled
 * with ~" and plain removal, so every effect reading it has to reconstruct
 * *why* a card is there — usually from a counter or an attached tracker.
 * The decision here is the opposite: a new zone per purpose, so "when a
 * card leaves Suspended" is a precise trigger with no bookkeeping.
 *
 * The cost is that generic references fragment — "return target card from
 * exile" works in Magic *because* exile is one zone. `group` is the
 * mitigation: a zone belongs to a family, so content can name one zone
 * precisely (`'suspended'`) or the family generically (`group: 'removed'`).
 * Add the group when the zone is declared; retrofitting it once content
 * references bare zone names is expensive.
 */
import { GRAVEYARD, PLAY, type ZoneDef } from '../../engine/index.js';

/** A player's library. Ordered, and hidden **even from its owner**. */
export const DECK: ZoneDef = {
  id: 'deck',
  ordered: true,
  visibility: 'hidden',
  scope: 'per-player',
  group: 'library',
};

/** A player's hand: a bag, visible only to its owner. */
export const HAND: ZoneDef = {
  id: 'hand',
  visibility: 'owner',
  scope: 'per-player',
  group: 'hand',
};

/**
 * The stack: spells and abilities waiting to resolve, last on top.
 *
 * This is the stack as *plumbing* — an ordered public pile. Stack
 * **semantics** (priority passing, response windows, one-at-a-time
 * resolution, countering) are a separate slice, and they reverse
 * docs/design/08-countering.md's time-based decision.
 */
export const STACK: ZoneDef = {
  id: 'stack',
  ordered: true,
  visibility: 'public',
  group: 'resolving',
};

/**
 * Where an object sits **while it resolves**, pulled off the stack for the
 * duration.
 *
 * Magic leaves a resolving spell on the stack until resolution finishes,
 * which is the root of a family of rules oddities — a spell can count "the
 * spells on the stack" and include itself, and "remove it from the stack"
 * has to be special-cased. Giving resolution its own zone makes the stack
 * mean exactly "waiting to resolve", and fizzling becomes an ordinary
 * `active → garbage` move instead of a special case.
 *
 * Capacity 1: resolution does not nest. Exceeding it throws, because a
 * second object resolving while one already is would be an engine bug, not
 * a content choice.
 */
export const ACTIVE: ZoneDef = {
  id: 'active',
  visibility: 'public',
  group: 'resolving',
  capacity: 1,
};

/**
 * The game's zones. `play` and `graveyard` are the engine's own built-ins,
 * listed so one array describes the whole game.
 *
 * **Open:** the game wants a *per-player* garbage pile, but the engine's
 * `graveyard` is shared — `destroy` has no notion of whose pile a dying
 * thing belongs in. Making it per-player means teaching the destroy path
 * about ownership, which is its own change; until then `graveyard` is the
 * one shared pile.
 */
export const CARD_ZONES: readonly ZoneDef[] = [DECK, HAND, STACK, ACTIVE, PLAY, GRAVEYARD];
