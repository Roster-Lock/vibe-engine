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
 *
 * ## The stack
 *
 * Casting a card does not resolve it — it **puts it on the stack** and hands
 * priority around (`CardStack.runPriority`). Every player may answer before
 * the top object resolves, which is what makes an instant an instant: the
 * timing is `canPut`'s (`speed.ts`'s marker says which cards are instant),
 * and the answer is a `PriorityResponse`.
 *
 * A **permanent** resolves by arriving: the stack moves it to `active`, then
 * its `resolve` moves it into `play` (the standing rules, summoning sickness among them, apply as it arrives) and fires its
 * play-time effect. A **spell** resolves into `garbage`.
 *
 * ## Triggered abilities are respondable to as well
 *
 * The engine is pointed at `CardStack.scheduler()`, so a triggered ability
 * no longer runs the instant it fires — it is wrapped as a stack object,
 * queued, and put on the stack at the next priority window (rule 603.3).
 * Everyone may answer a death trigger before it draws its card, exactly as
 * they may answer a spell.
 *
 * That makes it the game's job to *open* those windows: anything a move does
 * outside the stack — an attack, a hero power, a turn start — can trigger,
 * so `settleTriggers()` runs the priority loop whenever the queue or the
 * stack is non-empty. Attacks and the hero power are still immediate and
 * still not respondable; they are combat, not spells.
 */
import { setEngineCast, setEngineCastable } from '../../src/games/cards/cast.js';
import { setEngineCreate } from '../../src/games/cards/create.js';
import { setEngineDraw } from '../../src/games/cards/draw.js';
import {
  Game,
  GameEndInterrupt,
  GameEngine,
  addBuff,
  setGauge,
  changeGaugeBy,
  type Action,
  type Character,
  type Decision,
  type GameEvent,
  type Player,
  type ZoneDef,
} from '../../src/engine/index.js';
import type { ZoneBinding } from '../../src/ir/index.js';
import { createEngine } from '../../src/games/round-based/index.js';
import { GARBAGE } from '../../src/engine/index.js';
import { ACTIVE, CARD_ZONES, DECK, STOLEN } from './zones.js';
import {
  CardStack,
  type SpellObject,
  type StackDestination,
} from '../../src/games/cards/stack.js';
import { chosenCharacters, type ManualAbility, type TriggerScheduler } from '../../src/engine/index.js';
import type { Card, CreatureCard } from './cards.js';
import { HAND_ABILITIES, PermanentCard, SpellCardObject, instantiate, type CardObject } from './objects.js';
import type { CardPlayer } from './ai.js';
import { ATTACK_PATTERN, attack, heroPower } from './combat.js';
import { Side } from './side.js';
import { playableCards, type RuleCard } from './english.js';
import { CARD_RULES, RULE_BUFFS } from './rules.js';
import { endTurn, startTurn } from '../../src/games/round-based/index.js';

/** One thing a player does during their main phase. */
export type Move =
  | { readonly kind: 'play'; readonly card: CardObject; readonly targets: Character[] }
  | { readonly kind: 'attack'; readonly attacker: Character; readonly target: Character }
  | { readonly kind: 'hero-power'; readonly target: Character }
  /**
   * Use an ability a card has been **given** by its zone or an effect — a Boxed
   * Present's *Open Present*. The card is not in hand (that is a `play`), and what
   * it does is whatever the ability says, so it names the ability as well.
   */
  | {
      readonly kind: 'use';
      readonly card: CardObject;
      readonly ability: ManualAbility;
      readonly targets: Character[];
    }
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
  /**
   * The standing rules to start from, as a card document of `"type": "rule"` cards. Defaults to
   * `CARD_RULES`; a variant (or a test) supplies its own.
   */
  readonly rules?: string;
}

/** Moves allowed in one turn before the game calls it a loop and passes. */
const MOVE_LIMIT = 40;

/**
 * Where a played card sits while it resolves. Staging a creature here and
 * moving it to `play` is what makes "enters play from active" true rather
 * than assumed.
 */
const CAST_ZONE = ACTIVE.id;

export class CardGame extends Game {
  readonly engine: GameEngine;
  /** The stack every cast goes through, and the priority windows it opens. */
  readonly cardStack: CardStack;
  /** Each player's own rule cards (`"type": "rule"`), in the order they apply. */
  readonly #rules = new Map<Player, RuleCard[]>();
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

    // The engine needs its scheduler at construction and the stack needs the
    // engine, so the scheduler is a **deferred handle**: it forwards to the
    // stack the moment there is one. Nothing can trigger before the
    // constructor returns, so the window is closed before it could be hit.
    let stack: CardStack | undefined;
    const scheduler: TriggerScheduler = {
      enqueue: (ready, event) => {
        if (!stack) throw new Error('CardGame: a trigger fired before the stack existed');
        stack.scheduler().enqueue(ready, event);
      },
      get pending(): number {
        return stack ? stack.pendingTriggered.length : 0;
      },
      drain: async (maxRuns) => {
        await stack?.scheduler().drain(maxRuns);
      },
    };

    this.engine = createEngine({
      scheduler,
      onEvent: (event) => {
        this.#observe(event);
        options.onEvent?.(event);
      },
    });
    // The card game's own zones, so a played creature can be *staged* out of
    // play and moved in — the transition `when this enters play from active`
    // answers. `play`/`graveyard` are the engine's and are listed for
    // completeness.
    for (const zone of CARD_ZONES) this.engine.zones.declare(zone);
    this.cardStack = new CardStack(this.engine);
    stack = this.cardStack;
    this.installRules(playableCards(options.rules ?? CARD_RULES, RULE_BUFFS));
    this.engine.addStateBasedRule({
      name: 'Creatures arriving in play',
      when: () => this.#newcomers().length > 0,
      then: async () => {
        await this.#noticeArrivals();
        return [];
      },
    });

    for (const player of players) {
      this.#sides.set(player, new Side(player, this.engine));
      setEngineDraw(this.engine, (who, count) => this.sideOf(who).draw(count));
      setEngineCast(this.engine, (who, card, options) => this.tryCast(who as CardPlayer, card as CardObject, options));
      setEngineCastable(this.engine, (who) => this.castableCards(who as CardPlayer));
      // Priority is answered with a spell, so a player needs the game to
      // build the stack object — the same dependency `chooseMove` has.
      player.game = this;
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
        this.engine.canUse(creature, attack).usable &&
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

  /** Legal targets for a card's spell effect or enters-play effect. */
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
    for (const [index, player] of this.#order.entries()) {
      const side = this.sideOf(player);
      side.deck.shuffle(() => this.engine.random());
      // The coin, simplified: the second player draws one more.
      await side.draw(this.#openingHand + (index === 0 ? 0 : 1));
    }
    for (const binding of this.#zoneBindings) await binding.apply(this.engine);
  }

  /**
   * The turn begins: apply the standing rules for `turn:start`, then tell the
   * engine a turn started.
   *
   * There is no untap/upkeep/draw procedure here any more — a crystal, a
   * refill, waking the board and the draw are **rules**
   * (`rules.ts`), applied in declaration order. A card that changes them
   * changes this step without touching it.
   */
  async collectUserDecisions(): Promise<Decision[]> {
    this.#turn += 1;
    if (this.#turn > this.#maxTurns) throw new GameEndInterrupt([], 'turn cap reached');

    const side = this.activeSide;
    this.#log(`\n--- Turn ${this.#turn}: ${side.heroName} ---`);

    await this.applyRules('turn:start', side);
    await startTurn(this.engine, side.hero.controller);
    // "At the start of your turn" abilities fired here, and a draw can too —
    // both wait for a priority window now.
    await this.settleTriggers();
    this.#log(`    ${this.#status(side)}`);
    return [];
  }

  readonly #creatureDefinitions = new Map<string, CreatureCard>();
  #madeCreatures = 0;

  /**
   * Adds the creature definitions a card document declares (`Creature Giant Golem 6/6`), so a
   * card's `Create a Giant Golem.` can make them. A made creature is a new object each time, in play
   * under its maker's control, and arrives like any other: it is noticed, and the entry rules apply.
   */
  installCreatures(definitions: readonly { readonly kind: string; readonly name: string }[]): void {
    for (const definition of definitions) {
      if (definition.kind === 'creature') this.#creatureDefinitions.set(definition.name.toLowerCase(), definition as CreatureCard);
    }
    setEngineCreate(this.engine, async (who, name) => {
      const definition = this.#creatureDefinitions.get(name.toLowerCase());
      if (!definition) throw new Error(`CardGame: there is no creature "${name}" to create`);
      const player = who as CardPlayer;
      const side = this.sideOf(player);
      const made = instantiate(definition, player, side) as PermanentCard;
      this.#madeCreatures += 1;
      (made as { id: string }).id = `${definition.id}#made${this.#madeCreatures}`;
      // Born in its maker's library and moved into play: a real arrival, with the rules that go with it.
      this.engine.registerCharacter(made, { zone: DECK.id, owner: player });
      await this.engine.moveTo(made, 'play', { source: side.hero });
      return made;
    });
  }

  readonly #zoneBindings: ZoneBinding[] = [];

  /**
   * Adds the zones a card document declares (`Zone Suspend (per-player, public)`) and the
   * rules they keep. Call before `setup()` / `runLoop()`: the zones are declared now, their
   * rules are applied at setup, and their `When your turn starts then …` rules run each turn.
   */
  installZones(authored: {
    readonly zoneDefs: readonly ZoneDef[];
    readonly zoneBindings: readonly ZoneBinding[];
    readonly rules?: readonly RuleCard[];
  }): void {
    for (const def of authored.zoneDefs) this.engine.zones.declare(def);
    this.#zoneBindings.push(...authored.zoneBindings);
    if (authored.rules) this.installRules({ rules: authored.rules });
  }

  /**
   * The rule cards `player` plays by: what happens at the start of their turn, when their creatures
   * arrive, and anything a card document adds with `installRules`. A UI lists these.
   */
  rulesOf(player: Player): readonly RuleCard[] {
    return this.#rules.get(player) ?? [];
  }

  /** Takes a rule out of force by name — for `player`, or for everyone. Returns whether one was there. */
  removeRule(name: string, player?: Player): boolean {
    let removed = false;
    for (const owner of player ? [player] : this.#order) {
      const rules = this.#rules.get(owner) ?? [];
      const at = rules.findIndex((existing) => existing.name === name);
      if (at === -1) continue;
      rules.splice(at, 1);
      removed = true;
    }
    return removed;
  }

  /**
   * Gives rule cards to players — to everyone, or to `options.for`. Each player keeps their own copy,
   * so a card can change one player's rules and not another's. A rule with the name of one the player
   * already has **replaces** it, in place: "draw two instead" is one draw rule, not two.
   */
  installRules(authored: { readonly rules: readonly RuleCard[] }, options: { readonly for?: readonly Player[] } = {}): void {
    for (const owner of options.for ?? this.#order) {
      const rules = this.#rules.get(owner) ?? [];
      this.#rules.set(owner, rules);
      for (const rule of authored.rules) {
        const at = rules.findIndex((existing) => existing.name === rule.name);
        if (at === -1) rules.push(rule);
        else rules[at] = rule;
      }
    }
  }

  /** Creatures the game has already seen in play, so each arrival is noticed once. */
  readonly #seenInPlay = new Set<Character>();

  /** Creatures in play that the game has not noticed arriving yet. */
  #newcomers(): PermanentCard[] {
    return this.engine.registeredCharacters.filter(
      (c): c is PermanentCard => c instanceof PermanentCard && this.engine.isInPlay(c) && !this.#seenInPlay.has(c),
    );
  }

  /**
   * A creature has arrived in play — **however** it got there: cast and resolved, cheated in
   * from hand or the stack, revived from the garbage. It joins its controller's board and the
   * `creature:enters` rules apply to it (summoning sickness, by default). Creatures that left
   * play are forgotten, so coming back is a new arrival.
   */
  async #noticeArrivals(): Promise<void> {
    for (const seen of [...this.#seenInPlay]) if (!this.engine.isInPlay(seen)) this.#seenInPlay.delete(seen);
    for (const creature of this.#newcomers()) {
      this.#seenInPlay.add(creature);
      const player = creature.controller as CardPlayer | undefined;
      if (!player) continue;
      const side = this.sideOf(player);
      if (!side.board.includes(creature)) side.board.push(creature);
      // The arrival rules run now, as the creature lands: it is sick before anything else can happen.
      for (const owner of this.#order) {
        for (const rule of [...this.rulesOf(owner)]) {
          await rule.binding.trigger('enters', this.engine, this.activePlayer, [creature], owner);
        }
      }
    }
  }

  /**
   * Applies every rule that holds at `timing`: each player's own rule cards, in the order they are
   * written, with that player as "you". The zones' own rules (`Zone Suspend: When your turn starts
   * then …`) go first. Public so a variant or a test can run a timing itself.
   */
  async applyRules(timing: 'turn:start' | 'turn:end', turnOwner: Side): Promise<void> {
    const turn = turnOwner.hero.controller;
    if (timing === 'turn:start') {
      // The board may attack again; a turn's attacks are the game's bookkeeping, not a rule.
      turnOwner.attacked.clear();
      for (const binding of this.#zoneBindings) await binding.trigger('turn:start', this.engine, turn);
    }
    for (const owner of this.#order) {
      for (const rule of [...this.rulesOf(owner)]) await rule.binding.trigger(timing, this.engine, turn, [], owner);
    }
  }

  /**
   * Every ability a card has been given that `player` may use right now, with the
   * card it is on — what a UI offers beside the hand. Cards in a hand are not
   * listed unless something has given them an ability.
   */
  cardAbilities(player: CardPlayer): readonly { readonly card: CardObject; readonly ability: ManualAbility }[] {
    const found: { card: CardObject; ability: ManualAbility }[] = [];
    for (const entity of this.engine.zones.entities) {
      if (!(entity instanceof PermanentCard || entity instanceof SpellCardObject)) continue;
      for (const ability of this.engine.abilitiesFor(player, entity)) {
        // A card's own `Suspend: …` is a hand ability: it is not offered from anywhere else.
        if (HAND_ABILITIES.has(ability) && this.sideOf(player).hand.has(entity)) found.push({ card: entity, ability });
        else if (!HAND_ABILITIES.has(ability)) found.push({ card: entity, ability });
      }
    }
    return found;
  }

  /** Main phase: ask the active player for moves until it passes. */
  async runGame(): Promise<void> {
    const player = this.activePlayer;
    const side = this.sideOf(player);

    for (let moves = 0; moves < MOVE_LIMIT; moves++) {
      const move = await player.chooseMove(this);
      if (move.kind === 'end') break;
      // One move is one unit of work with a gas budget: a move that sets off a chain
      // that never ends runs out, rather than hanging the game.
      await this.engine.metered(`move ${move.kind}`, () => this.#execute(side, move));
      // An attack or a hero power can kill something; a kill triggers. Those
      // triggers wait on the stack for a window, and this is it.
      await this.settleTriggers();
    }
    await this.applyRules('turn:end', side);
    await endTurn(this.engine, side.hero.controller);
    await this.settleTriggers();
  }

  /* --------------------------- executing ----------------------------- */

  async #execute(side: Side, move: Move): Promise<void> {
    switch (move.kind) {
      case 'play':
        return this.#castCard(side, move.card, move.targets);
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
      case 'use': {
        const player = this.activePlayer;
        const offered = this.cardAbilities(player).some((o) => o.card === move.card && o.ability === move.ability);
        if (!offered) {
          throw new Error(`CardGame: ${player.name} may not use ${move.ability.name} on that card`);
        }
        // The card may be face down, so the log names the pile, never the card.
        const pile = this.engine.zones.zoneOf(move.card)?.id ?? 'the table';
        this.#log(`  ✦  ${side.heroName} uses ${move.ability.name} on a card in ${pile}`);
        return this.engine.useCardAbility(player, move.card, move.ability, { targets: move.targets });
      }
      case 'hero-power': {
        this.#log(`  ✦  ${side.heroName} uses Fireblast on ${move.target.name}`);
        return this.engine.useAbility(side.hero, heroPower, { targets: [move.target] });
      }
      case 'end':
        return;
    }
  }

  /**
   * Casts a card: pays for it, puts it **on the stack**, and runs the
   * priority window. Nothing resolves here — a spell with an answer never
   * gets this far.
   */
  async #castCard(side: Side, card: CardObject, targets: Character[]): Promise<void> {
    if (!this.castableCards(side.hero.controller as CardPlayer).includes(card)) {
      throw new Error(`CardGame: ${card.name} is not in hand`);
    }
    await this.#cast(side, card, targets);
  }

  /**
   * Every card `player` may cast from where it is: their hand, and any card of another
   * player's they are holding in their `stolen` pile.
   */
  castableCards(player: CardPlayer): readonly CardObject[] {
    const side = this.sideOf(player);
    const stolen = this.engine.zones.zone(STOLEN.id, player)?.members ?? [];
    return [...side.hand.cards, ...(stolen as readonly CardObject[])];
  }

  /**
   * **Casts a card if it can be** — the game's answer to the language's *Cast this
   * card if you can.* Used for a card that is not in hand: an ability a zone or an
   * effect gave it (a Boxed Present's *Open Present*) sets the cast going, and this
   * says whether it can go ahead.
   *
   * "Can" is what it would take from the hand: the cost is affordable and, if the
   * card picks a target, there is a legal one. The caster chooses (their own
   * `choose`, so a UI or AI answers). Nothing is done to a card that cannot be
   * cast, which is what lets the ability fall back to something else. Casting puts
   * the card on the stack, which is how it is revealed.
   *
   * Timing (sorcery speed) is not checked here: the ability that calls this is
   * already being used at a legal moment.
   */
  async tryCast(player: CardPlayer, card: CardObject, options: { readonly free?: boolean } = {}): Promise<boolean> {
    const side = this.sideOf(player);
    if (!options.free && card.cost > side.mana) return false;
    const pattern = card.kind === 'spell' ? card.targeting : card.onPlayTargeting;
    let targets: Character[] = [];
    if (pattern) {
      const pool = this.engine.validTargets(pattern, side.hero);
      if (pool.length === 0) return false;
      const count = pattern.count ?? 1;
      const answer = await player.choose({
        kind: 'select',
        prompt: `Choose a target for ${card.name}`,
        chooser: player,
        options: pool,
        count,
      });
      targets = chosenCharacters(answer);
    }
    await this.#cast(side, card, targets, options.free === true);
    return true;
  }

  /** Pays for a card and puts it on the stack, from wherever it is. */
  async #cast(side: Side, card: CardObject, targets: Character[], free = false): Promise<void> {
    if (!free && card.cost > side.mana) throw new Error(`CardGame: not enough mana for ${card.name}`);

    const at = targets.length > 0 ? ` → ${targets.map((t) => t.name).join(', ')}` : '';
    this.#log(`  ▸  ${side.heroName} casts ${card.name} (${card.cost})${at}`);

    if (!free && !(await this.chargeFor(card, this.activePlayer))) {
      throw new Error(`CardGame: not enough mana for ${card.name}`);
    }
    const object = this.castObject(card, this.activePlayer, targets);
    if (!(await this.cardStack.stackObject(object))) {
      throw new Error(`CardGame: ${card.name} could not be put on the stack`);
    }
    await this.runPriority();
  }

  /**
   * Pays a card's cost, if the player can. **The host charges, not the
   * stack**: `CardStack` deliberately answers only "is this the right
   * time?" (`canPut`), because cost is a game's business — mana here, life
   * or tapping elsewhere.
   *
   * One method so every path that puts a card on the stack pays exactly the
   * same way: a move, an AI's answer, and a click in the UI.
   */
  async chargeFor(card: CardObject, player: CardPlayer): Promise<boolean> {
    const side = this.sideOf(player);
    if (card.cost > side.mana) return false;
    await this.engine.apply([changeGaugeBy(side.hero.gauge('mana'), -card.cost)], { source: side.hero });
    return true;
  }

  /**
   * The stack object for casting `card` — what a player puts on the stack,
   * by a move or by answering. Public because **priority is answered with
   * one**: a player holding priority needs the same object the game would
   * build for them.
   */
  castObject(card: CardObject, player: CardPlayer, targets: Character[]): SpellObject {
    const side = this.sideOf(player);
    const pattern = card.kind === 'spell' ? card.targeting : card.onPlayTargeting;
    const destination: StackDestination = card.kind === 'spell' ? 'garbage' : 'play';
    return {
      kind: 'spell',
      card,
      name: card.name,
      controller: player,
      targets,
      // Targeting is relative to the caster's hero, not the card: a spell is
      // not a character and must not have to pretend to be one.
      self: side.hero,
      ...(pattern ? { targetPattern: pattern } : {}),
      destination,
      resolve: async ({ targets: legal }) =>
        card.kind === 'spell'
          ? // `await` because an effect authored in English may ask the
            // controller a question mid-resolution (`You may …`, `Repeat …`).
            card.effect({ self: side.hero, engine: this.engine, side }, { targets: [...legal] })
          : this.#arrive(side, card, legal),
    };
  }

  /**
   * A permanent resolves by **arriving**. The stack has already moved the
   * card to `active`; here the `creature:enters` rules apply (summoning sickness, by default),
   * it moves into `play`
   * (a real `active → play` transition, which is what `enters play from
   * active` answers) and fires its play-time effect.
   */
  async #arrive(side: Side, permanent: CardObject, targets: readonly Character[]): Promise<Action[]> {
    if (permanent.kind !== 'creature') return [];
    // It joins the board, and the `creature:enters` rules (summoning sickness) apply, when the
    // engine sees it in play — whichever way it arrived (see `#noticeArrivals`).
    await this.engine.moveTo(permanent, 'play', { source: side.hero });

    // The play-time arrival effect (a battlecry that picks a target) is fired
    // here, because the target was chosen as the card was cast. `arrivesFrom`
    // is the card's `from <zone>` clause.
    if (permanent.onPlay && (permanent.arrivesFrom === undefined || permanent.arrivesFrom === CAST_ZONE)) {
      const actions = await permanent.onPlay(
        { self: permanent, engine: this.engine, side },
        { targets: [...targets] },
      );
      await this.engine.apply(actions, { source: permanent });
    }
    return [];
  }

  /**
   * Gives every player the chance to answer what is on the stack, resolving
   * it once they all pass in succession. Public so a UI can drive the loop
   * itself if it ever wants finer control.
   */
  async runPriority(): Promise<void> {
    const order = this.#order;
    const active = Math.max(order.indexOf(this.activePlayer), 0);
    await this.cardStack.runPriority(order, { activePlayer: active, mainPhase: true });
  }

  /**
   * Runs the priority loop **if anything is waiting** — a trigger the engine
   * queued, or an object still on the stack.
   *
   * Needed because triggers are put on the stack rather than run, so any
   * game action that can trigger (an attack, a hero power, a turn boundary)
   * has to open the window those triggers are waiting for. A no-op when
   * nothing is pending, which is the common case for a move that triggers
   * nothing at all.
   */
  async settleTriggers(): Promise<void> {
    if (this.cardStack.size === 0 && this.cardStack.pendingTriggered.length === 0) return;
    await this.runPriority();
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
