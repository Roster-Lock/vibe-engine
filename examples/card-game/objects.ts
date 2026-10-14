/**
 * **What a card is inside a game** — the entity that lives in a zone.
 *
 * This is the identity/form model from `docs/design/15-zones.md`:
 *
 * > A card and the creature it becomes are one identity in two forms. Moving
 * > a creature card from hand to play does not construct a new object, it
 * > *realizes* the character form on the entity that was already there.
 *
 * So there are two entity kinds, matching the engine's own distinction:
 *
 * - **`PermanentCard`** — a creature card. It *is* a `Character`, and it is
 *   the same object in the deck, the hand, the stack, `active` and `play`.
 *   Its gauges are realized when it enters play (the engine does that on the
 *   move), which is why a bounced-and-replayed permanent comes back fresh
 *   while the identity — and everything attached to it — survives.
 * - **`SpellCardObject`** — a spell. The engine's `Entity` doc is explicit
 *   that a spell must be able to sit in a zone "without pretending to have
 *   hit points", so this is a plain `type: 'card'` entity carrying its
 *   definition.
 *
 * Both **are `Card`s structurally** (they expose the printed fields), so the
 * rest of the card layer — the AI, the play path, the UI — keeps reading
 * `card.cost`, `card.kind` and friends without caring which kind it holds.
 */
import {
  Character,
  skill,
  type Ability,
  type Player,
  type TargetPattern,
} from '../../src/games/turn-based/index.js';
import { instant, isInstant } from '../../src/games/cards/speed.js';
import type { Card, CardSide, CreatureCard, Keyword, SpellCard } from './cards.js';
import { TAUNT_MARKER, attack, tauntRule } from './combat.js';

/**
 * A creature card, in play or not.
 *
 * Constructed **once**, when the deck is built, and never again: playing it
 * is a move, not a construction. That is what makes "this permanent
 * remembers what happened to it" true, and it is why its `onPlay` effect
 * closes over the same object its controller sees on the board.
 */
export class PermanentCard extends Character implements CreatureCard {
  readonly kind = 'creature' as const;
  readonly id: string;
  readonly cost: number;
  readonly text?: string;
  readonly keywords?: readonly Keyword[];
  /** The abilities factory, kept for inspection; the skills are already built. */
  readonly grants?: (side: CardSide) => Ability[];
  readonly onPlay?: CreatureCard['onPlay'];
  readonly onPlayTargeting?: TargetPattern;
  readonly arrivesFrom?: string;

  constructor(card: CreatureCard, controller: Player, side: CardSide) {
    super(card.name, {
      maxHp: card.health,
      stats: { power: card.power },
      skills: [
        // The same skill shape `makeCreature` used: attack, the taunt rule,
        // then whatever the card carries (an on-death trigger, a standing
        // trigger) built now, so the permanent is complete before it lands.
        skill({
          id: card.id,
          name: card.name,
          weight: 1,
          abilities: [attack, tauntRule, ...(card.grants?.(side) ?? [])],
        }),
        // A taunter is marked by a skill, which is what `hasTaunt` reads.
        ...(card.keywords?.includes('taunt') ? [TAUNT_MARKER] : []),
      ],
    });
    // A card's speed is a property of the card, not of the stack object it
    // later becomes: a creature marked `instant` is a **flash** creature.
    if (isInstant(card)) instant(this);
    this.id = card.id;
    this.cost = card.cost;
    this.controller = controller;
    this.team = controller.team;
    if (card.text !== undefined) this.text = card.text;
    if (card.keywords) this.keywords = card.keywords;
    if (card.grants) this.grants = card.grants;
    if (card.onPlay) this.onPlay = card.onPlay;
    if (card.onPlayTargeting) this.onPlayTargeting = card.onPlayTargeting;
    if (card.arrivesFrom !== undefined) this.arrivesFrom = card.arrivesFrom;
    // The `CreatureCard` discipline: printed values, not the derived ones.
    // `power`/`health` are read back off the character form, which starts at
    // the printed values and is what buffs and damage act on once in play.
  }

  /** Printed power — the derived stat before any buff (see `stat('power')`). */
  get power(): number {
    return this.stat('power') ?? 0;
  }

  /** Printed health — the HP gauge's maximum, which buffs re-derive. */
  get health(): number {
    return this.gauge('hp').max;
  }
}

/** A spell card: an entity with no gauges, exactly as the engine intends. */
export class SpellCardObject implements SpellCard {
  readonly type = 'card' as const;
  readonly kind = 'spell' as const;
  readonly name: string;
  readonly id: string;
  readonly cost: number;
  readonly text?: string;
  readonly targeting?: TargetPattern;
  readonly effect: SpellCard['effect'];

  constructor(card: SpellCard) {
    if (isInstant(card)) instant(this);
    this.name = card.name;
    // A card's speed is a property of the card, not of the stack object it
    // later becomes: a creature marked `instant` is a **flash** creature.
    if (isInstant(card)) instant(this);
    this.id = card.id;
    this.cost = card.cost;
    this.effect = card.effect;
    if (card.text !== undefined) this.text = card.text;
    if (card.targeting) this.targeting = card.targeting;
  }
}

/** Anything that can sit in a card game's zone. */
export type CardObject = PermanentCard | SpellCardObject;

/** True for the entity kind that has gauges and statuses. */
export function isPermanent(card: CardObject): card is PermanentCard {
  return card instanceof PermanentCard;
}

/**
 * Instantiates one physical card from its printed data. Called once per deck
 * entry, at deck build — never at play time.
 */
export function instantiate(card: Card, controller: Player, side: CardSide): CardObject {
  return card.kind === 'creature'
    ? new PermanentCard(card, controller, side)
    : new SpellCardObject(card);
}
