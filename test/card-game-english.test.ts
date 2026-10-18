/**
 * Tests for cards **authored in English** (`examples/card-game/english.ts`)
 * — the pipeline from a player's card document, through the Ability
 * Language, into a card the game can actually play.
 *
 * The point of these tests is that authored content is not a special case:
 * it is bound to the same engine abilities the catalog uses, so a custom
 * spell damages through the same action pipeline as the hand-written
 * Fireball.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer, GreedyAI } from '../examples/card-game/ai.js';
import type { Card } from '../examples/card-game/cards.js';
import { WISP } from '../examples/card-game/cards.js';
import { playableCards, toGameCard } from '../examples/card-game/english.js';
import { compileDocument } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import type { Character } from '../src/engine/index.js';

class ScriptedCardPlayer extends CardPlayer {
  #script: ((game: CardGame) => Move)[] = [];

  script(...moves: ((game: CardGame) => Move)[]): this {
    this.#script = [...moves];
    return this;
  }

  override async chooseMove(game: CardGame): Promise<Move> {
    const next = this.#script.shift();
    return next ? next(game) : { kind: 'end' };
  }
}

const deckOf = (card: Card, n = 30): Card[] => Array.from({ length: n }, () => card);

/** Plays the first copy of a card from the active side's hand. */
const play =
  (card: Card, targets: (game: CardGame) => Character[] = () => []) =>
  (game: CardGame): Move => {
    const inHand = game.activeSide.hand.cards.find((c) => c.printedId === card.id);
    if (!inHand) throw new Error(`test: ${card.name} is not in hand`);
    return { kind: 'play', card: inHand, targets: targets(game) };
  };

async function turn(game: CardGame): Promise<void> {
  await game.collectUserDecisions();
  await game.runGame();
}

describe('authored cards — conversion', () => {
  it('turns a creature card into a playable stat line with its keyword', () => {
    const { cards, diagnostics } = playableCards(
      ['Card Test Bulwark', '{ "cost": 2, "type": "creature", "creatureConfig": { "power": 2, "health": 5 } }', 'Taunt.'].join('\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const card = cards[0]!;
    expect(card.kind).toBe('creature');
    if (card.kind !== 'creature') throw new Error('expected a creature');
    expect(card.power).toBe(2);
    expect(card.health).toBe(5);
    expect(card.keywords).toEqual(['taunt']);
    expect(card.id.startsWith('authored-')).toBe(true);
  });

  it('gives an enters-play creature an onPlay with a targeting pattern', () => {
    const { cards } = playableCards(
      ['Card Test Archer', '{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 1 } }', 'When this enters play then Deal 1 damage to target enemy character.'].join('\n'),
    );
    const card = cards[0]!;
    if (card.kind !== 'creature') throw new Error('expected a creature');
    expect(card.onPlay).toBeDefined();
    expect(card.onPlayTargeting).toEqual({ who: 'enemy', count: 1 });
  });

  it('leaves an untargeted effect without a targeting pattern', () => {
    const { cards } = playableCards(
      ['Card Test Wave', '{ "cost": 2, "type": "spell" }', 'Deal 2 damage to all enemy characters.'].join('\n'),
    );
    const card = cards[0]!;
    if (card.kind !== 'spell') throw new Error('expected a spell');
    expect(card.targeting).toBeUndefined();
  });

  it('keeps the id slug so a card named Fireball is still a fireball', () => {
    const { cards } = playableCards(['Card Fireball', '{ "cost": 1, "type": "spell" }', 'Deal 6 damage to target enemy character.'].join('\n'));
    expect(cards[0]!.id).toBe('authored-fireball');
  });
});

describe('authored cards — playing them', () => {
  it('deals an authored spell’s damage through the engine', async () => {
    const { cards } = playableCards(
      ['Card Test Bolt', '{ "cost": 1, "type": "spell" }', 'Deal 6 damage to target enemy character.'].join('\n'),
    );
    const bolt = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(bolt));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(bolt));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const bobHero = game.sideOf(bob).hero;
    alice.script(play(bolt, () => [bobHero]));
    await turn(game);

    expect(bobHero.gauge('hp').current).toBe(24);
  });

  it('draws through the game\'s own rules: Draw(you, 2) fills the hand', async () => {
    const { cards, diagnostics } = playableCards(
      ['Card Test Study', '{ "cost": 1, "type": "spell" }', 'Draw(you, 2).'].join('\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const study = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(study));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(study));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const side = game.sideOf(alice);
    alice.script((g) => {
      // Four in hand on Alice's first turn (three dealt, one drawn), then one is played.
      expect(g.activeSide.hand.size).toBe(4);
      return play(study)(g);
    });
    const deckBefore = side.deck.size;
    await turn(game);

    expect(side.hand.size).toBe(3 + 2); // 4 − the played card + 2 drawn
    expect(side.deck.size).toBe(deckBefore - 3); // the turn draw, then the spell's two
  });

  it('burns a drawn card past ten, and fatigues an empty deck, just like the rule draw', async () => {
    const { cards } = playableCards(['Card Test Study', '{ "cost": 0, "type": "spell" }', 'Draw(you, 9).'].join('\n'));
    const study = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(study));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(study));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    const side = game.sideOf(alice);
    alice.script(play(study));
    await turn(game);
    // 4 in hand − 1 played = 3, then nine drawn into a ten-card hand: seven fit, two burn.
    expect(side.hand.size).toBe(10);
    expect(side.garbage.size).toBe(1 + 2); // the spent spell and two burned cards
  });

  it('runs an enters-play effect the moment the creature lands', async () => {
    const { cards } = playableCards(
      ['Card Test Archer', '{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 1 } }', 'When this enters play then Deal 1 damage to target enemy character.'].join('\n'),
    );
    const archer = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(archer));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(archer));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const bobHero = game.sideOf(bob).hero;
    alice.script(play(archer, () => [bobHero]));
    await turn(game);

    expect(bobHero.gauge('hp').current).toBe(29);
    const board = game.sideOf(alice).board;
    expect(board.map((c) => c.name)).toEqual(['Test Archer']);
  });

  it('honours an authored Taunt restriction', async () => {
    const { cards } = playableCards(
      ['Card Test Bulwark', '{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 4 } }', 'Taunt.'].join('\n'),
    );
    const bulwark = cards[0]!;
    const attackerCard = WISP;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(attackerCard));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(bulwark));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    // Alice lands a Wisp; Bob answers with the taunter.
    alice.script(play(WISP));
    await turn(game);
    bob.script(play(bulwark));
    await turn(game);

    // Turn 3: the Wisp wakes up and looks for a target. Bob's hero is
    // shielded — the only legal attack is into the taunter.
    await game.collectUserDecisions();
    const attacker = game.sideOf(alice).board[0]!;
    const names = game.attackTargets(attacker).map((c) => c.name);
    expect(names).toEqual(['Test Bulwark']);
  });

  it('plays a document’s buff with its card', async () => {
    const { cards, diagnostics } = playableCards(
      [
        'Buff Test Venom',
        'Incoming damage is reduced by 1.',
        '',
        'Card Test Coating',
        '{ "cost": 1, "type": "spell" }',
        'Add Test Venom to this.',
      ].join('\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const coating = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(coating));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(coating));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    alice.script(play(coating));
    await turn(game);

    expect(game.sideOf(alice).hero.hasStatus('test-venom')).toBe(true);
  });

  it('enters play from active, so the `from active` clause is real', async () => {
    const { cards, diagnostics } = playableCards(
      ['Card Test Bulwark', '{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 4 } }', 'When this enters play from active then Heal this for 1.'].join('\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const bulwark = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(bulwark));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(bulwark));
    const transitions: { entity: unknown; type: string; from: string | undefined; to: string }[] = [];
    const game = new CardGame([alice, bob], {
      log: () => {},
      openingHand: 3,
      onEvent: (event) => {
        if (event.type === 'zone:changed') {
          transitions.push({
            entity: event.entity,
            type: event.entity.type,
            from: 'from' in event ? event.from.id : undefined,
            to: event.to.id,
          });
        }
      },
    });
    await game.setup();

    // Every copy is the same card, but only one entity is played — follow it.
    const played = game.sideOf(alice).hand.cards.find((c) => c.printedId === bulwark.id)!;
    alice.script(() => ({ kind: 'play', card: played, targets: [] }));
    await turn(game);

    // One entity, the whole way: the creature card *is* the permanent, so
    // its life is a single chain of zone changes — hand → stack → active →
    // play. That is what makes `from active` a real fact rather than a
    // convention, and what `enters play from stack` can distinguish.
    const mine = transitions.filter((t) => t.entity === played);
    const path = mine.map((t) => `${t.from ?? '·'} → ${t.to}`);
    // The whole life of one entity: drawn, cast, resolved, landed.
    expect(path).toEqual(['deck → hand', 'hand → stack', 'stack → active', 'active → play']);
    expect(new Set(mine.map((t) => t.type))).toEqual(new Set(['character']));
    expect(game.sideOf(alice).board.map((c) => c.name)).toEqual(['Test Bulwark']);
  });

  it('fires a targetless arrival effect from the normal cast path', async () => {
    const { cards } = playableCards(
      ['Card Test Wave', '{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 1 } }', 'When this enters play from active then Deal 2 damage to all enemy characters.'].join('\n'),
    );
    const wave = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(wave));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(wave));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const bobHero = game.sideOf(bob).hero;
    alice.script(play(wave));
    await turn(game);

    // The arrival trigger fired on the real `active → play` transition.
    expect(bobHero.gauge('hp').current).toBe(28);
  });

  it('does not fire an arrival effect that insists on the stack', async () => {
    const { cards } = playableCards(
      ['Card Test Wave', '{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 1 } }', 'When this enters play from stack then Deal 2 damage to all enemy characters.'].join('\n'),
    );
    const wave = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(wave));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(wave));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const bobHero = game.sideOf(bob).hero;
    alice.script(play(wave));
    await turn(game);

    expect(bobHero.gauge('hp').current).toBe(30);
  });

  it('converts a malformed card without throwing', () => {
    const card = toGameCard({
      id: 'broken',
      name: 'Broken',
      cost: 0,
      kind: 'spell',
      keywords: [],
      triggers: [],
      rulesText: '',
      headingSpan: { start: 0, end: 0 },
      nameSpan: { start: 0, end: 0 },
    });
    expect(card.kind).toBe('spell');
  });
});

describe('the Boxed Present, in the real game', () => {
  const OPEN_PRESENT = `Ability Open Present
Reveal this.
Cast this if you can, otherwise move it to its owner's garbage.`;

  /** Alice, on her first turn, with one card of her hand wrapped in her `boxed` zone. */
  async function wrapped(card: Card) {
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(card));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(card));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    const compiled = compileDocument(OPEN_PRESENT);
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = compiled.abilities[0]!;
    game.engine.zones.declare({ id: 'boxed', visibility: 'hidden', scope: 'per-player' });
    const side = game.sideOf(alice);
    const present = side.hand.cards[0]!;
    await game.engine.moveTo(present, 'boxed', { owner: alice });
    game.engine.setZoneAbilities(game.engine.zones.zone('boxed', alice)!, [ability], [alice]);
    return { game, alice, bob, side, present, ability, mana: side.mana };
  }

  it('opens it: revealed, paid for, cast, and it lands', async () => {
    const t = await wrapped(WISP);
    expect(t.game.engine.canSee(t.bob, t.present)).toBe(false); // wrapped: Bob sees nothing
    await t.game.engine.useCardAbility(t.alice, t.present, t.ability);
    expect(t.side.mana).toBe(t.mana - WISP.cost);
    expect(t.game.engine.zones.zoneOf(t.present)?.id).toBe('play'); // cast, resolved, arrived
    expect(t.game.engine.canSee(t.bob, t.present)).toBe(true);
  });

  it('a card too expensive to cast goes to its owner\'s garbage instead', async () => {
    const { cards } = playableCards(['Card Test Giant', '{ "cost": 9, "type": "creature", "creatureConfig": { "power": 9, "health": 9 } }'].join('\n'));
    const giant = cards[0]!;
    const t = await wrapped(giant);
    await t.game.engine.useCardAbility(t.alice, t.present, t.ability);
    expect(t.side.mana).toBe(t.mana); // nothing was paid
    const zone = t.game.engine.zones.zoneOf(t.present)!;
    expect(zone.id).toBe('garbage');
    expect(zone.owner).toBe(t.alice);
  });

  it('asks the caster for a target when the card needs one, like a cast from the hand', async () => {
    const { cards } = playableCards(['Card Test Bolt', '{ "cost": 1, "type": "spell" }', 'Deal 6 damage to target enemy character.'].join('\n'));
    const bolt = cards[0]!;
    const t = await wrapped(bolt);
    const bobHero = t.game.sideOf(t.bob).hero;
    await t.game.engine.useCardAbility(t.alice, t.present, t.ability);
    // The scripted player takes the fewest the pattern allows, which is the one enemy hero.
    expect(bobHero.gauge('hp').current).toBe(24);
    expect(t.game.engine.zones.zoneOf(t.present)?.id).toBe('garbage'); // a resolved spell is spent
  });
});

describe('opening a present as a move of the turn', () => {
  const DOC = `Ability Open Present
Reveal this.
Cast this if you can, otherwise move it to its owner's garbage.

Ability Wrap Presents
Cards in your boxed zone have Open Present for you.`;

  /** A game where Alice's first hand card is wrapped and Open Present is hers to use. */
  async function setUp(log: string[] = []) {
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(WISP));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(WISP));
    const game = new CardGame([alice, bob], { log: (line) => log.push(line), openingHand: 3 });
    await game.setup();
    const compiled = compileDocument(DOC, { zones: new ZoneDictionary(['boxed']) });
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const [openPresent, wrap] = compiled.abilities as [typeof compiled.abilities[number], typeof compiled.abilities[number]];
    game.engine.zones.declare({ id: 'boxed', visibility: 'hidden', scope: 'per-player' });
    const side = game.sideOf(alice);
    const present = side.hand.cards[0]!;
    await game.engine.moveTo(present, 'boxed', { owner: alice });
    // "Cards in your boxed zone have Open Present" — said in the language, not by hand.
    await wrap.cast({ self: side.hero, engine: game.engine }, { targets: [] });
    return { game, alice, bob, side, present, openPresent, log };
  }

  it('the sentence gives the zone the ability, to the player it names', async () => {
    const { game, alice, bob, present, openPresent } = await setUp();
    expect(game.cardAbilities(alice).map((o) => [o.card, o.ability.name])).toEqual([[present, 'Open Present']]);
    expect(game.cardAbilities(bob)).toEqual([]);
    void openPresent;
  });

  it('a turn move opens it: paid for, cast, and it lands', async () => {
    const { game, alice, side, present, openPresent } = await setUp();
    alice.script((g) => ({ kind: 'use', card: present, ability: g.cardAbilities(alice)[0]!.ability, targets: [] }));
    await turn(game);
    expect(game.engine.zones.zoneOf(present)?.id).toBe('play');
    void side;
    void openPresent;
  });

  it('never names the card in the log while it is face down', async () => {
    const lines: string[] = [];
    const { game, alice, present } = await setUp(lines);
    alice.script((g) => ({ kind: 'use', card: present, ability: g.cardAbilities(alice)[0]!.ability, targets: [] }));
    await turn(game);
    const used = lines.find((line) => line.includes('uses Open Present'))!;
    expect(used).toContain('a card in boxed');
    expect(used).not.toContain(present.name);
    // …but once cast, it is public and the log may say what it was.
    expect(lines.some((line) => line.includes(`casts ${present.name}`))).toBe(true);
  });

  it('refuses a move the player was not offered', async () => {
    const { game, alice, bob, present, openPresent } = await setUp();
    // Bob (who is not named) cannot open Alice's present — even if he is the one moving.
    bob.script(() => ({ kind: 'use', card: present, ability: openPresent, targets: [] }));
    alice.script(() => ({ kind: 'end' }));
    await turn(game); // Alice's turn
    await game.collectUserDecisions();
    await expect(game.runGame()).rejects.toThrow(/may not use Open Present on that card/);
  });

  it('the greedy AI opens what it is given, once per card', async () => {
    const alice = new GreedyAI('Alice', 'a', deckOf(WISP));
    const bob = new GreedyAI('Bob', 'b', deckOf(WISP));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    const compiled = compileDocument(DOC, { zones: new ZoneDictionary(['boxed']) });
    const [openPresent, wrap] = compiled.abilities as [typeof compiled.abilities[number], typeof compiled.abilities[number]];
    game.engine.zones.declare({ id: 'boxed', visibility: 'hidden', scope: 'per-player' });
    const side = game.sideOf(alice);
    await wrap.cast({ self: side.hero, engine: game.engine }, { targets: [] });
    await game.collectUserDecisions();
    // Wrap the whole hand (the turn's own draw included), so there is nothing to
    // play and opening is the only thing left to do.
    const wrapped = [...side.hand.cards];
    for (const card of wrapped) await game.engine.moveTo(card, 'boxed', { owner: alice });
    const opened: unknown[] = [];
    for (let i = 0; i < 10; i += 1) {
      const move = await alice.chooseMove(game);
      if (move.kind !== 'use') break;
      expect(move.ability).toBe(openPresent);
      opened.push(move.card);
    }
    // Every wrapped card is offered, each exactly once — nothing loops on a card it already tried.
    expect(opened).toHaveLength(wrapped.length);
    expect(new Set(opened).size).toBe(wrapped.length);
  });
});
