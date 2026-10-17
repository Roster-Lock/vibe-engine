/**
 * Cards authored in the **Card Document** language, made playable.
 *
 * `src/english/card.ts` compiles a player's document into `CompiledCard`s —
 * engine-level content (a `cast` ability, triggers, a stat line). This file
 * is the one card-game-shaped step: it wraps those engine pieces in the
 * `Card` data the game layer plays (`cards.ts`).
 *
 * The effect wrapper is deliberately thin. A compiled card's ability *is* an
 * engine manual ability, so a spell's effect is just its `cast` called with
 * the card layer's context; battlecries are the same cast, invoked the
 * moment the creature lands. Every card authored here therefore travels the
 * same action pipeline as the hand-written catalog.
 */
import { compileCardDocument, type CardCompileResult, type CompiledCard } from '../../src/english/card.js';
import { ZoneDictionary, type BuffDictionary, type Diagnostic } from '../../src/english/index.js';
import { ACTIVE, DECK, HAND, STACK, STOLEN } from '../../src/games/cards/zones.js';
import type {
  Ability,
  Action,
  ManualAbility,
  Targeting,
} from '../../src/games/turn-based/index.js';
import type { Card, CardContext, CreatureCard, SpellCard } from './cards.js';

/** Prefixes ids so an authored card never collides with the catalog. */
const AUTHORED_PREFIX = 'authored';

/** Calls a compiled ability's cast, passing any mid-effect question through. */
function cast(ability: ManualAbility, ctx: CardContext, targeting: Targeting): Action[] | Promise<Action[]> {
  return ability.cast(ctx, targeting);
}

/** Turns one compiled card into a playable `Card`. */
export function toGameCard(card: CompiledCard): Card {
  const id = `${AUTHORED_PREFIX}-${card.id || card.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const text = card.rulesText.length > 0 ? { text: card.rulesText } : {};
  const ability = card.ability;
  const targeting = card.targeting;
  const handAbilities = (card.handAbilities ?? []).map((own) => own.ability);

  if (card.kind === 'creature') {
    const creature: CreatureCard = {
      kind: 'creature',
      id,
      name: card.name,
      cost: card.cost,
      power: card.power ?? 0,
      health: card.health ?? 1,
      ...(card.keywords.length > 0 ? { keywords: [...card.keywords] } : {}),
      ...(card.entry ? { entry: card.entry } : {}),
      ...(handAbilities.length > 0 ? { handAbilities } : {}),
      ...text,
      // An arrival effect that picks a target offers a pattern; one that finds its
      // own victims (or takes none) does not.
      ...(ability && targeting
        ? { onPlayTargeting: targeting, onPlay: (ctx, picked) => cast(ability, ctx, picked) }
        : {}),
      ...(ability && !targeting ? { onPlay: (ctx) => cast(ability, ctx, { targets: [] }) } : {}),
      // `when this enters play from <zone>` — the card layer fires the
      // play-time effect only when the creature really arrived from there.
      ...(card.entersFrom !== undefined ? { arrivesFrom: card.entersFrom } : {}),
      ...(card.triggers.length > 0
        ? { grants: (): Ability[] => [...card.triggers] }
        : {}),
    };
    return creature;
  }

  const spell: SpellCard = {
    kind: 'spell',
    ...(handAbilities.length > 0 ? { handAbilities } : {}),
    id,
    name: card.name,
    cost: card.cost,
    ...text,
    ...(targeting ? { targeting } : {}),
    effect: (ctx, picked) =>
      ability ? cast(ability, ctx, targeting ? picked : { targets: [] }) : [],
  };
  return spell;
}

export interface AuthoredCards {
  /** Creature definitions (`Creature Giant Golem 6/6`) that effects make; hand them to `CardGame.installCreatures`. */
  readonly creatures: Card[];
  /** Zones the document declares; hand them to `CardGame.installZones` with the bindings. */
  readonly zoneDefs: readonly import('../../src/engine/index.js').ZoneDef[];
  readonly zoneBindings: readonly import('../../src/ir/index.js').ZoneBinding[];
  /** Every playable card the document declares, in document order. */
  readonly cards: Card[];
  readonly diagnostics: Diagnostic[];
  /** The full compile result, for the editor's preview panes. */
  readonly compiled: CardCompileResult;
}

/**
 * The zones a card document may name. The engine ships `play` and
 * `graveyard`; these are the card game's own — where a card sits while it
 * resolves (`active`), where a spell waits (`stack`), and the piles.
 */
export const CARD_LANGUAGE_ZONES = new ZoneDictionary([DECK.id, HAND.id, STACK.id, ACTIVE.id, STOLEN.id]);

/**
 * Compiles a card document and converts every card it declares into
 * playable content. Cards are returned even when the document has
 * diagnostics, so a half-written document still previews; the editor gates
 * *saving* on a clean compile.
 */
export function playableCards(source: string, dictionary?: BuffDictionary): AuthoredCards {
  const compiled = compileCardDocument(source, {
    zones: CARD_LANGUAGE_ZONES,
    // The language says `library`; this game calls it `deck`. `Draw(…)` itself
    // runs this game's own draw (fatigue, a ten-card hand) — see `Side`.
    bind: { aliases: { library: DECK.id } },
    ...(dictionary ? { dictionary } : {}),
  });
  return {
    cards: compiled.cards.filter((card) => !card.token).map(toGameCard),
    creatures: compiled.cards.filter((card) => card.token).map(toGameCard),
    zoneDefs: compiled.zoneDefs,
    zoneBindings: compiled.zones,
    diagnostics: compiled.diagnostics,
    compiled,
  };
}
