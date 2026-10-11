/**
 * `CardGame` — the driver that turns the engine into a collectible-card
 * game.
 *
 * It owns everything the engine has no concept of (turns belonging to one
 * player, a hand, mana crystals, a board) and hands everything else to the
 * engine: damage, buffs, derived stats, targeting legality, death, and
 * win/lose.
 *
 * ## The turn loop
 *
 * `Game`'s loop is round-based — *every* player decides, then the round
 * resolves (`collectUserDecisions` → `runGame`). A card turn is not like
 * that: one player acts, and each move is chosen only after seeing what the
 * previous one did. So this subclass reads the split as **upkeep → main
 * phase**: `collectUserDecisions` runs the active side's untap/draw step and
 * returns no decisions, and `runGame` runs that side's moves one at a time.
 */
import {
  Game,
  GameEndInterrupt,
  GameEngine,
  setGauge,
  changeGaugeBy,
  type Action,
  type Character,
  type Decision,
  type GameEvent,
  type Player,
} from '../../src/engine/index.js';
import { createEngine } from '../../src/games/round-based/index.js';
import type { Card } from './cards.js';
import type { CardPlayer } from './ai.js';
import { ATTACK_PATTERN, attack, heroPower, makeCreature, manaCrystal, summoningSickness } from './combat.js';
import { MAX_CRYSTALS, Side } from './side.js';
import { endTurn, startTurn } from '../../src/games/round-based/index.js';

/** One thing a player does during their main phase. */
export type Move =
  | { readonly kind: 'play'; readonly card: Card; readonly targets: Character[] }
  | { readonly kind: 'attack'; readonly attacker: Character; readonly target: Character }
  | { readonly kind: 'hero-power'; readonly target: Character }
  | { readonly kind: 'end' };

export interface CardGameOptions {
  /** Turn cap; the match is a draw once it is passed. Defaults to 60. */
  readonly maxTurns?: number;
  /** Cards drawn before the first turn. Defaults to 3 (the second player gets 4). */
  readonly openingHand?: number;
  /** Where the play-by-play goes. Defaults to `console.log`. */
  readonly log?: (line: string) => void;
  /** Extra observer for raw engine events. */
  readonly onEvent?: (event: GameEvent) => void;
}

/** Moves allowed in one turn before the game calls it a loop and passes. */
const MOVE_LIMIT = 40;

export class CardGame extends Game {
  readonly engine: GameEngine;
  readonly #sides = new Map<Player, Side>();
  readonly #order: CardPlayer[];
  readonly #maxTurns: number;
  readonly #openingHand: number;
  readonly #log: (line: string) => void;
  #turn = 0;

  constructor(players: readonly CardPlayer[], options: CardGameOptions = {}) {
    super([...players]);
    this.#order = [...players];
    this.#maxTurns = options.maxTurns ?? 60;
    this.#openingHand = options.openingHand ?? 3;
    this.#log = options.log ?? ((line) => console.log(line));

    this.engine = createEngine({
      onEvent: (event) => {
        this.#observe(event);
        options.onEvent?.(event);
      },
    });

    for (const player of players) {
      this.#sides.set(player, new Side(player.hero, player.deckList));
    }
    // Registering the players is what arms win/lose: each one owns exactly
    // one character (its hero), so a dead hero is a defeated player.
    this.engine.registerPlayers([...players]);
  }

  /* ----------------------------- queries ----------------------------- */

  sideOf(player: Player): Side {
    const side = this.#sides.get(player);
    if (!side) throw new Error(`CardGame: "${player.name}" is not in this game`);
    return side;
  }

  /** The side whose turn it is. */
  get activeSide(): Side {
    return this.sideOf(this.activePlayer);
  }

  get activePlayer(): CardPlayer {
    return this.#order[(Math.max(this.#turn, 1) - 1) % this.#order.length]!;
  }

  get turn(): number {
    return this.#turn;
  }

  /** Creatures that may still attack this turn. */
  readyAttackers(side: Side): Character[] {
    return side.board.filter(
      (creature) =>
        this.engine.isInPlay(creature) &&
        !side.attacked.has(creature) &&
        !creature.hasStatus('summoning-sickness') &&
        (creature.stat('power') ?? 0) > 0,
    );
  }

  /**
   * What a creature may attack — straight from the engine, so taunt (a
   * `restriction({ on: 'target' })`) is already applied and an illegal
   * attack is never even offered.
   */
  attackTargets(attacker: Character): Character[] {
    return this.engine.validTargets(ATTACK_PATTERN, attacker);
  }

  heroPowerTargets(player: Player): Character[] {
    return this.engine.validTargets(heroPower.targeting, this.sideOf(player).hero);
  }

  /** Legal targets for a card's spell effect or battlecry. */
  targetsFor(card: Card, player: Player): Character[] {
    const pattern = card.kind === 'spell' ? card.targeting : card.onPlayTargeting;
    if (!pattern) return [];
    return this.engine.validTargets(pattern, this.sideOf(player).hero);
  }

  /* ---------------------------- the loop ----------------------------- */

  /** Shuffles both decks with the ceremony seed and deals the opening hands. */
  protected override async applySeed(seed: string | undefined): Promise<void> {
    await this.setup(seed);
  }

  /**
   * Shuffle and deal. `runLoop` does this for you through `applySeed`; a
   * step-by-step driver (a test, a UI that pumps one turn at a time) calls
   * it directly.
   */
  async setup(seed?: string): Promise<void> {
    if (seed !== undefined) this.engine.setSeed(seed);
    this.#order.forEach((player, index) => {
      const side = this.sideOf(player);
      side.deck.shuffle(() => this.engine.random());
      side.draw(this.#openingHand + (index === 0 ? 0 : 1)); // the coin, simplified
    });
    for (const player of this.#order) await this.#flush(this.sideOf(player));
  }

  /** Upkeep: a crystal, a full mana bar, creatures wake up, draw one. */
  async collectUserDecisions(): Promise<Decision[]> {
    this.#turn += 1;
    if (this.#turn > this.#maxTurns) throw new GameEndInterrupt([], 'turn cap reached');

    const side = this.activeSide;
    this.#log(`\n--- Turn ${this.#turn}: ${side.heroName} ---`);

    if (side.crystals < MAX_CRYSTALS) {
      side.crystals += 1;
      // A gauge's max is never written by content — it is derived from
      // buffs, so a crystal *is* a buff.
      await this.engine.addBuff(side.hero, manaCrystal, side.hero);
    }
    await this.engine.apply([setGauge(side.hero.gauge('mana'), side.hero.gauge('mana').max)]);

    side.attacked.clear();
    for (const creature of [...side.board]) {
      if (creature.hasStatus('summoning-sickness')) {
        await this.engine.removeBuff(creature, 'summoning-sickness');
      }
    }

    side.draw(1);
    await this.#flush(side);
    await startTurn(this.engine);
    this.#log(`    ${this.#status(side)}`);
    return [];
  }

  /** Main phase: ask the active player for moves until it passes. */
  async runGame(): Promise<void> {
    const player = this.activePlayer;
    const side = this.sideOf(player);

    for (let moves = 0; moves < MOVE_LIMIT; moves++) {
      const move = await player.chooseMove(this);
      if (move.kind === 'end') break;
      await this.#execute(side, move);
      await this.#flush(side);
    }
    await endTurn(this.engine);
  }

  /* --------------------------- executing ----------------------------- */

  async #execute(side: Side, move: Move): Promise<void> {
    switch (move.kind) {
      case 'play':
        return this.#playCard(side, move.card, move.targets);
      case 'attack': {
        if (!this.readyAttackers(side).includes(move.attacker)) {
          throw new Error(`CardGame: ${move.attacker.name} cannot attack right now`);
        }
        this.#log(`  ⚔  ${move.attacker.name} attacks ${move.target.name}`);
        side.attacked.add(move.attacker);
        // A real ability through the real pipeline: retaliation, thorns-like
        // buffs, death triggers and win/lose all come along for the ride.
        return this.engine.useAbility(move.attacker, attack, { targets: [move.target] });
      }
      case 'hero-power': {
        this.#log(`  ✦  ${side.heroName} uses Fireblast on ${move.target.name}`);
        return this.engine.useAbility(side.hero, heroPower, { targets: [move.target] });
      }
      case 'end':
        return;
    }
  }

  async #playCard(side: Side, card: Card, targets: Character[]): Promise<void> {
    if (!side.hand.remove(card)) throw new Error(`CardGame: ${card.name} is not in hand`);
    if (card.cost > side.mana) throw new Error(`CardGame: not enough mana for ${card.name}`);

    const at = targets.length > 0 ? ` → ${targets.map((t) => t.name).join(', ')}` : '';
    this.#log(`  ▸  ${side.heroName} plays ${card.name} (${card.cost})${at}`);
    await this.engine.apply([changeGaugeBy(side.hero.gauge('mana'), -card.cost)], { source: side.hero });

    if (card.kind === 'spell') {
      side.discard.add(card);
      const actions = card.effect({ self: side.hero, engine: this.engine, side }, { targets });
      await this.engine.apply(actions, { source: side.hero });
      return;
    }

    // A creature enters play. There is no `summon` action, so the card layer
    // builds the Character and registers it itself — see README.md.
    const creature = makeCreature(card, side.hero.controller!, side);
    this.engine.registerCharacter(creature);
    side.board.push(creature);
    if (!card.keywords?.includes('charge')) {
      await this.engine.addBuff(creature, summoningSickness, side.hero);
    }
    if (card.onPlay) {
      const actions = card.onPlay({ self: creature, engine: this.engine, side }, { targets });
      await this.engine.apply(actions, { source: creature });
    }
  }

  /** Pushes the side's queued card-layer actions (fatigue) through the engine. */
  async #flush(side: Side): Promise<void> {
    const pending: Action[] = side.takePending();
    if (pending.length > 0) await this.engine.apply(pending);
  }

  /* ---------------------------- reporting ---------------------------- */

  #observe(event: GameEvent): void {
    if (event.type === 'character:destroyed') {
      for (const side of this.#sides.values()) {
        const at = side.board.indexOf(event.character);
        if (at !== -1) side.board.splice(at, 1);
      }
    }
  }

  #status(side: Side): string {
    const board = side.board.map((c) => `${c.name} ${c.stat('power') ?? 0}/${c.gauge('hp').current}`);
    return (
      `${side.hero.gauge('hp').current} hp · ${side.mana}/${side.hero.gauge('mana').max} mana · ` +
      `${side.hand.size} in hand · ${side.deck.size} in deck` +
      (board.length > 0 ? `\n    board: ${board.join(', ')}` : '')
    );
  }
}
