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
import { GARBAGE, PLAY, type ZoneDef } from '../../src/engine/index.js';

/** A player's library. Ordered, and hidden **even from its owner**. */
export const DECK: ZoneDef = {
  id: 'deck',
  ordered: true,
  visibility: 'hidden',
  scope: 'per-player',
  ownerOnly: true,
  group: 'library',
};

/** A player's hand: a bag, visible only to its owner. */
export const HAND: ZoneDef = {
  id: 'hand',
  visibility: 'owner',
  scope: 'per-player',
  ownerOnly: true,
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
 * **Where a revealed card waits while the reveal resolves** — the holding zone
 * a "reveal until …" effect needs.
 *
 * It exists because a reveal is a *fact about the game*: the card has genuinely
 * left the library and is visible, so `zone:changed` fires and "when a card is
 * revealed, …" is answerable. A peek that never moved anything could not be
 * observed by any other effect.
 *
 * Shared rather than per-player (the reveal is public either way), unordered
 * (nothing reads a position inside a reveal), and outside the `removed` family —
 * a card here is mid-resolution, not gone. It must be **empty when a reveal
 * begins**: its members are what "the rest" means when the reveal ends.
 */
export const REVEALED: ZoneDef = {
  id: 'revealed',
  visibility: 'public',
  group: 'resolving',
};

/**
 * The game's zones. `play` and `garbage` are the engine's own built-ins,
 * listed so one array describes the whole game.
 *
 * `garbage` is per-player and is **both** piles in one: a destroyed
 * permanent lands in its controller's garbage and so does a resolved spell.
 * There is no separate discard, because "what died" and "what was cast" are
 * questions about the same pile, and a second one only forced every reader
 * to tell two removed zones apart.
 */
/**
 * Another player's card that you may look at and cast — `Thoughtsteal`'s pile. It is
 * *not* `ownerOnly`: it holds cards that belong to someone else, which a hand, a library
 * and a graveyard refuse. Only the player holding it sees it.
 */
export const STOLEN: ZoneDef = {
  id: 'stolen',
  visibility: 'owner',
  scope: 'per-player',
  group: 'castable',
};

export const CARD_ZONES: readonly ZoneDef[] = [DECK, HAND, STACK, ACTIVE, REVEALED, PLAY, GARBAGE, STOLEN];

export { GARBAGE };
