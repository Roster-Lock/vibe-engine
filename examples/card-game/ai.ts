/**
 * Who plays the cards.
 *
 * `CardPlayer` is the engine's `Player` with a card game's shape bolted on:
 * the hero is the one character the engine tracks for win/lose, the deck is
 * card-layer state, and the round-based `decide()` gives way to
 * `chooseMove()` — a card turn is a *sequence* of moves, each answered after
 * seeing what the last one did.
 *
 * `GreedyAI` is a deliberately simple opponent: spend all the mana, trade up,
 * hit the face when nothing better offers itself.
 */
import { Player, commitSecret, type Character, type Decision } from '../../src/engine/index.js';
import {
  PASS,
  put,
  type AbilityStackObject,
  type PriorityRequest,
  type PriorityResponse,
  type TriggerOrderRequest,
} from '../../src/games/cards/stack.js';
import { isInstant } from '../../src/games/cards/speed.js';
import { HERO_POWER_COST, makeHero } from './combat.js';
import type { Card, CreatureCard, SpellCard } from './cards.js';
import type { CardGame, Move } from './game.js';

export abstract class CardPlayer extends Player {
  /** This player's avatar — the character whose death loses the game. */
  readonly hero: Character;
  readonly deckList: readonly Card[];

  constructor(name: string, team: string, deck: readonly Card[]) {
    // The hero is the player's only registered character, so `isDefeated`
    // means "my hero died" — creatures are registered separately and never
    // count towards defeat. That is the whole win condition, for free.
    super(name, [makeHero(name)], team);
    this.hero = this.characters[0]!;
    this.deckList = deck;
  }

  /**
   * Unused. `Game`'s loop is round-based — every player decides, then the
   * round resolves — but a card turn interleaves deciding and resolving, so
   * `CardGame` drives `chooseMove` instead. See README.md, "The turn loop".
   */
  async decide(): Promise<Decision[]> {
    return [];
  }

  /**
   * The game that owns this player, set by `CardGame`. Priority is answered
   * with a *spell*, so a player holding it needs the game to build the
   * stack object — `chooseMove` gets the game passed in, and this is the
   * same dependency for a question asked at a different time.
   */
  game: CardGame | undefined;

  /** The next thing this player wants to do, or `{ kind: 'end' }` to pass. */
  abstract chooseMove(game: CardGame): Promise<Move>;

  /**
   * **Priority**, the other question a card game asks.
   *
   * `chooseMove` is "what do you do on your turn"; this is "someone has put
   * something on the stack — do you answer it?". They are separate because
   * they happen at different times and answer with different things: a move
   * is an action in your own main phase, while holding priority can put a
   * *spell* on the stack (never an attack), and passing is a real answer
   * rather than the absence of one.
   *
   * The base implementation passes, which is the right default for an AI
   * that only acts on its own turn and for a scripted opponent. `HumanCardPlayer`
   * overrides it to wait for the UI; `GreedyAI` overrides it to answer when
   * it holds an instant.
   */
  async takePriority(request: PriorityRequest): Promise<PriorityResponse> {
    void request;
    return PASS;
  }

  /**
   * **Ordering simultaneous triggers**, the third question a card game asks.
   *
   * Only the player whose triggers they are answers it, and only when there
   * are two or more. The base implementation keeps the table order — the
   * order the abilities were registered — which is deterministic, so a
   * replay of the same seed with the same players is the same game. An AI
   * that wants to be clever overrides this ("my draw trigger can wait until
   * after the damage lands").
   */
  async orderTriggers(request: TriggerOrderRequest): Promise<readonly AbilityStackObject[]> {
    return request.triggers;
  }

  /** Deterministic seed contribution: same players ⇒ same shuffle. */
  override commitSeed(): string {
    return commitSecret(`card-game:${this.id}`);
  }

  override revealSeed(): string {
    return `card-game:${this.id}`;
  }
}

export class GreedyAI extends CardPlayer {
  /**
   * Holding priority, the greedy AI answers **only something**: with an empty
   * stack its own turn is `chooseMove`'s business, so it passes. With an
   * object waiting, it fires the most expensive instant it can afford that
   * has a legal target — which is what makes a human's spells answerable.
   */
  override async takePriority(request: PriorityRequest): Promise<PriorityResponse> {
    const game = this.game;
    if (!game || request.stack.length === 0) return PASS;
    const side = game.sideOf(this);
    const playable = [...side.hand.cards]
      .filter((card) => isInstant(card) && card.cost <= side.mana)
      .sort((a, b) => b.cost - a.cost);
    for (const card of playable) {
      const targets = this.#targetsFor(game, card);
      if (targets === null) continue;
      // Pay before offering: an answer costs exactly what it costs.
      if (!(await game.chargeFor(card, this))) continue;
      return put(game.castObject(card, this, targets));
    }
    return PASS;
  }

  async chooseMove(game: CardGame): Promise<Move> {
    const side = game.sideOf(this);

    // 1. Spend mana: the most expensive card that has somewhere to go.
    const playable = [...side.hand.cards]
      .filter((card) => card.cost <= side.mana)
      .sort((a, b) => b.cost - a.cost);
    for (const card of playable) {
      const targets = this.#targetsFor(game, card);
      if (targets !== null) return { kind: 'play', card, targets };
    }

    // 2. Attack with everything that is ready.
    for (const attacker of game.readyAttackers(side)) {
      const target = this.#attackTarget(game, attacker);
      if (target) return { kind: 'attack', attacker, target };
    }

    // 3. Leftover mana goes to the hero power.
    if (side.mana >= HERO_POWER_COST) {
      const target = this.#pingTarget(game);
      if (target) return { kind: 'hero-power', target };
    }

    return { kind: 'end' };
  }

  /** Targets for a card, or `null` when there is nothing worth pointing at. */
  #targetsFor(game: CardGame, card: Card): Character[] | null {
    const options = game.targetsFor(card, this);
    if (card.kind === 'creature') return this.#creatureTargets(card, options);
    return this.#spellTargets(card, options);
  }

  #creatureTargets(card: CreatureCard, options: Character[]): Character[] | null {
    if (!card.onPlayTargeting) return []; // no enters-play effect, or an untargeted one
    if (options.length === 0) return []; // an enters-play effect with nowhere to point simply fizzles
    // An enters-play ping: finish something off, else chip the smallest.
    const sorted = [...options].sort((a, b) => a.gauge('hp').current - b.gauge('hp').current);
    return [sorted[0]!];
  }

  #spellTargets(card: SpellCard, options: Character[]): Character[] | null {
    if (!card.targeting) return []; // board-wide: always castable
    if (options.length === 0) return null; // needs a target and has none

    switch (card.id) {
      case 'fireball': {
        const kill = options.find((c) => c.gauge('hp').current <= 6 && this.#isCreature(c));
        return [kill ?? options.find((c) => !this.#isCreature(c)) ?? options[0]!];
      }
      case 'assassinate': {
        const biggest = [...options].sort((a, b) => b.gauge('hp').current - a.gauge('hp').current)[0]!;
        return [biggest];
      }
      case 'healing-touch': {
        const hurt = options.filter((c) => c.gauge('hp').current < c.gauge('hp').max);
        if (hurt.length === 0) return null; // no point
        return [hurt.sort((a, b) => a.gauge('hp').current / a.gauge('hp').max - b.gauge('hp').current / b.gauge('hp').max)[0]!];
      }
      case 'blessing': {
        const best = [...options].sort((a, b) => (b.stat('power') ?? 0) - (a.stat('power') ?? 0))[0];
        return best ? [best] : null;
      }
      default:
        return [options[0]!];
    }
  }

  /** Trade up if possible, otherwise go face. */
  #attackTarget(game: CardGame, attacker: Character): Character | undefined {
    const options = game.attackTargets(attacker);
    if (options.length === 0) return undefined;
    const power = attacker.stat('power') ?? 0;
    const creatures = options.filter((c) => this.#isCreature(c));

    const cleanKill = creatures.find(
      (c) => c.gauge('hp').current <= power && (c.stat('power') ?? 0) < attacker.gauge('hp').current,
    );
    if (cleanKill) return cleanKill;

    const face = options.find((c) => !this.#isCreature(c));
    if (face) return face;

    const anyKill = creatures.find((c) => c.gauge('hp').current <= power);
    return anyKill ?? creatures[0];
  }

  /** Where a 1-damage ping does the most good. */
  #pingTarget(game: CardGame): Character | undefined {
    const options = game.heroPowerTargets(this);
    const finisher = options.find((c) => c.gauge('hp').current === 1);
    return finisher ?? options.find((c) => !this.#isCreature(c)) ?? options[0];
  }

  /** Creatures carry a `power` stat; heroes do not. */
  #isCreature(character: Character): boolean {
    return character.stat('power') !== undefined;
  }
}
