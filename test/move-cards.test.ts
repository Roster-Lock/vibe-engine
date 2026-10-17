/**
 * `Move <cards> from <zone> to <zone>.` — taking cards out of one zone and putting them in
 * another: revive, cheat, thoughtsteal, dig, mill.
 */
import { describe, expect, it } from 'vitest';
import type { ChoiceAnswer, ChoiceRequest } from '../src/engine/index.js';
import { CardPlayer } from '../examples/card-game/ai.js';
import { WISP, BOULDERFIST_OGRE, type Card } from '../examples/card-game/cards.js';
import { playableCards } from '../examples/card-game/english.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { lowerDocument, parseDocument, renderDocument } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import { PLAY } from '../src/engine/index.js';
import { GARBAGE, HAND } from '../src/games/cards/zones.js';

const ZONES = new ZoneDictionary([HAND.id, 'deck', 'stolen']);
const lower = (text: string) => lowerDocument(parseDocument(text, { zones: ZONES }).doc);
const errors = (text: string) => parseDocument(text, { zones: ZONES }).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

describe('Move … from … to … — the language', () => {
  it.each([
    ['Move the top 3 cards from your deck to your hand.', { how: 'top', count: 3 }, { whose: 'you', zone: 'deck' }, { whose: 'you', zone: 'hand' }],
    ['Move the bottom card from your deck to your garbage.', { how: 'bottom', count: 1 }, { whose: 'you', zone: 'deck' }, { whose: 'you', zone: 'garbage' }],
    ['Move a creature card from your garbage to play.', { how: 'choose', count: 1, cardKind: 'creature' }, { whose: 'you', zone: 'garbage' }, { whose: 'shared', zone: 'play' }],
    ['Move a random card from target opponent\'s hand to your stolen zone.', { how: 'random', count: 1 }, { whose: 'opponent', zone: 'hand' }, { whose: 'you', zone: 'stolen' }],
    ['Move 2 spell cards from your garbage to your hand.', { how: 'choose', count: 2, cardKind: 'spell' }, { whose: 'you', zone: 'garbage' }, { whose: 'you', zone: 'hand' }],
    ['Move all cards from each player\'s hand to its owner\'s garbage.', { how: 'all', count: 0 }, { whose: 'each', zone: 'hand' }, { whose: 'owner', zone: 'garbage' }],
  ])('%s', (sentence, select, from, to) => {
    const ir = lower(`Ability A\n${sentence}`);
    expect(ir.abilities[0]!.steps[0]!.effects[0]).toEqual({ kind: 'moveCards', select, from, to });
    const { text } = renderDocument(ir);
    expect(text).toContain(sentence);
    expect(lower(text).abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
  });

  it('reads "their" as the owner the cards came from, and a bare zone as a shared one', () => {
    const effect = lower("Ability A\nMove the top 2 cards from target opponent's deck to their garbage.").abilities[0]!.steps[0]!.effects[0];
    expect(effect).toMatchObject({ to: { whose: 'owner', zone: 'garbage' } });
  });

  it('says what is wrong', () => {
    expect(errors('Ability A\nMove the top 3 cards to your hand.')[0]).toMatch(/expected "from <zone>"/);
    expect(errors('Ability A\nMove the top 3 cards from your deck.')[0]).toMatch(/expected "to <zone>"/);
    expect(errors('Ability A\nMove cards from your deck to your hand.')[0]).toMatch(/write "this card"/);
    expect(errors('Ability A\nMove the top 3 cards from your pocket to your hand.')[0]).toMatch(/unknown zone "pocket"/);
    expect(errors("Ability A\nMove a card from its owner's hand to your hand.")[0]).toMatch(/named outright/);
    expect(errors('Ability A\nMove the top 3 cards from your deck to your hand.')).toEqual([]);
  });

  it('still reads the older "this card" move', () => {
    expect(errors("Ability A\nMove this card to its owner's garbage.")).toEqual([]);
  });
});

class Idle extends CardPlayer {
  async chooseMove(): Promise<Move> {
    return { kind: 'end' };
  }
}

/** A game at the start of Alice's first turn; her deck and Bob's are `deck`. */
async function table(card: Card, deck: Card[] = Array.from({ length: 30 }, () => card)) {
  const alice = new Idle('Alice', 'a', deck);
  const bob = new Idle('Bob', 'b', Array.from({ length: 30 }, () => WISP));
  const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
  await game.setup();
  await game.collectUserDecisions();
  return { game, alice, bob, a: game.sideOf(alice), b: game.sideOf(bob) };
}

async function cast(text: string, game: CardGame, player: CardPlayer) {
  const { cards, diagnostics } = playableCards(text);
  expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const card = cards[0]!;
  if (card.kind !== 'spell') throw new Error('expected a spell');
  const actions = await card.effect({ self: game.sideOf(player).hero, engine: game.engine, side: game.sideOf(player) as never }, { targets: [] });
  await game.engine.apply(actions);
}

describe('Move … from … to … — playing it', () => {
  it('revives a creature from the garbage into play', async () => {
    const { game, alice, a } = await table(WISP);
    const dead = a.hand.cards[0]!;
    await game.engine.moveTo(dead, GARBAGE.id, { owner: alice });
    await cast('Card Raise Dead\nCost 4\nSpell\nMove a creature card from your garbage to play.', game, alice);
    expect(game.engine.zones.zoneOf(dead)?.id).toBe(PLAY.id);
    expect(a.garbage.size).toBe(0);
  });

  it('only takes the kind it was told to', async () => {
    const { game, alice, a } = await table(WISP);
    const [one] = a.hand.cards;
    await game.engine.moveTo(one!, GARBAGE.id, { owner: alice });
    await cast('Card Raise Dead\nCost 4\nSpell\nMove a spell card from your garbage to play.', game, alice);
    expect(a.garbage.size).toBe(1); // a Wisp is a creature card: nothing to take
  });

  it('cheats a creature from hand into play', async () => {
    const { game, alice, a } = await table(BOULDERFIST_OGRE);
    const ogre = a.hand.cards[0]!;
    await cast('Card Cheat\nCost 1\nSpell\nMove a creature card from your hand to play.', game, alice);
    expect(a.hand.has(ogre) || game.engine.zones.zoneOf(ogre)?.id === PLAY.id).toBe(true);
    expect(a.hand.size).toBe(3);
  });

  it('thoughtsteal: a card cannot go to another player\'s hand, but can go to your stolen zone, and be cast from there', async () => {
    const { game, alice, a, b } = await table(WISP);
    // A hand holds only its owner's cards.
    await expect(
      cast("Card Bad\nCost 1\nSpell\nMove a random card from target opponent's hand to your hand.", game, alice),
    ).rejects.toThrow(/belongs to Bob, so it cannot be put in Alice's hand/);
    const before = [a.hand.size, b.hand.size];
    await cast("Card Thoughtsteal\nCost 3\nSpell\nMove a random card from target opponent's hand to your stolen zone.", game, alice);
    const stolen = game.engine.zones.zone('stolen', alice)!;
    expect([a.hand.size, b.hand.size, stolen.size]).toEqual([before[0], before[1]! - 1, 1]);
    const card = stolen.members[0]!;
    expect(game.engine.canSee(alice, card)).toBe(true);
    expect(game.engine.canSee(game.players[1] as never, card)).toBe(false);
    expect(game.castableCards(alice)).toContain(card);
  });

  it('digs: the top cards of the deck, in order, into the hand', async () => {
    const { game, alice, a } = await table(WISP);
    const top = a.deck.cards.slice(0, 3);
    const handBefore = a.hand.size;
    await cast('Card Dig\nCost 2\nSpell\nMove the top 3 cards from your deck to your hand.', game, alice);
    expect(a.hand.size).toBe(handBefore + 3);
    for (const card of top) expect(a.hand.has(card)).toBe(true);
  });

  it('mills the opponent: their deck to their own garbage', async () => {
    const { game, alice, b } = await table(WISP);
    const deckBefore = b.deck.size;
    await cast("Card Mill\nCost 2\nSpell\nMove the top 3 cards from target opponent's deck to their garbage.", game, alice);
    expect(b.deck.size).toBe(deckBefore - 3);
    expect(b.garbage.size).toBe(3);
  });

  it('moves nothing, and does not fail, when there is nothing to take', async () => {
    const { game, alice, a } = await table(WISP);
    await cast('Card Reclaim\nCost 2\nSpell\nMove 2 cards from your garbage to your hand.', game, alice);
    expect(a.garbage.size).toBe(0);
  });
});

/* --------------------------------- Scry ---------------------------------- */


import { ELVEN_ARCHER, SHIELDBEARER, BLOODFEN_RAPTOR } from '../examples/card-game/cards.js';

describe('Scry(player, X)', () => {
  const deck = [ELVEN_ARCHER, SHIELDBEARER, BLOODFEN_RAPTOR, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP, WISP];

  it('parses, renders and round-trips', () => {
    const ir = lower('Ability A\nScry(you, 3).');
    expect(ir.abilities[0]!.steps[0]!.effects[0]).toEqual({ kind: 'scry', count: { kind: 'const', value: 3 }, players: 'you' });
    expect(renderDocument(ir).text).toContain('Scry(you, 3).');
    expect(errors('Ability A\nScry(3, you).')[0]).toMatch(/the player comes first/);
  });

  it('puts the chosen cards on the bottom and the rest back on top in the chosen order', async () => {
    // Alice's deck is shuffled by the game; read what is on top and decide from that.
    const alice = new Idle('Alice', 'a', deck);
    const bob = new Idle('Bob', 'b', deck);
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    const a = game.sideOf(alice);
    const [x, y, z] = a.deck.cards.slice(0, 3).map((c) => c);
    const bottomBefore = a.deck.cards[a.deck.size - 1]!;
    // Bottom y; then order the rest: z on top, then x.
    // Cards can share a name, so answer by identity.
    alice.choose = async (request: ChoiceRequest): Promise<ChoiceAnswer> => {
      if (request.kind !== 'select') throw new Error('x');
      const pick = request.options.includes(y!) && request.count instanceof Array ? [y!] : request.options.includes(z!) ? [z!] : [];
      return { kind: 'select', chosen: pick };
    };
    await cast('Card Foresight\nCost 1\nSpell\nScry(you, 3).', game, alice);
    const after = a.deck.cards;
    expect(after.slice(0, 2)).toEqual([z, x]);
    expect(after[after.length - 1]).toBe(y);
    expect(after.includes(bottomBefore)).toBe(true);
  });

  it('shows the cards only to the scrying player, and only while scrying', async () => {
    const alice = new Idle('Alice', 'a', deck);
    const bob = new Idle('Bob', 'b', deck);
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    const top = game.sideOf(alice).deck.cards[0]!;
    expect(game.engine.canSee(alice, top)).toBe(false);
    const seen: boolean[] = [];
    alice.choose = async (request: ChoiceRequest): Promise<ChoiceAnswer> => {
      seen.push(game.engine.canSee(alice, top), game.engine.canSee(bob, top));
      return { kind: 'select', chosen: request.kind === 'select' && !(request.count instanceof Array) ? [request.options[0]!] : [] };
    };
    await cast('Card Foresight\nCost 1\nSpell\nScry(you, 2).', game, alice);
    expect(seen.slice(0, 2)).toEqual([true, false]);
    expect(game.engine.canSee(alice, top)).toBe(false);
  });

  it('does nothing to an empty library', async () => {
    const alice = new Idle('Alice', 'a', deck);
    const bob = new Idle('Bob', 'b', deck);
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    for (const card of [...game.sideOf(alice).deck.cards]) await game.engine.moveTo(card, GARBAGE.id, { owner: alice });
    await cast('Card Foresight\nCost 1\nSpell\nScry(you, 3).', game, alice);
    expect(game.sideOf(alice).deck.size).toBe(0);
  });
});

/* ----------------------------- stack to play ----------------------------- */

describe('Move … from the stack to play', () => {
  const HERALD = ['Card Herald', 'Cost 3', 'Creature 2/2', 'When this enters play from stack then Deal 3 damage to all enemy characters.'].join('\n');

  async function withSpellOnStack() {
    const herald = playableCards(HERALD);
    expect(herald.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const card = herald.cards[0]!;
    const alice = new Idle('Alice', 'a', Array.from({ length: 30 }, () => card));
    const bob = new Idle('Bob', 'b', Array.from({ length: 30 }, () => WISP));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    const a = game.sideOf(alice);
    const creature = a.hand.cards[0]!;
    const object = game.castObject(creature, alice, []);
    expect(await game.cardStack.stackObject(object)).toBe(true);
    return { game, alice, bob, a, b: game.sideOf(bob), creature, object };
  }

  it('puts a creature spell straight into play, and its stack object leaves with it', async () => {
    const { game, alice, creature } = await withSpellOnStack();
    expect(game.cardStack.size).toBe(1);
    await cast('Card Flash Cheat\nCost 2\nSpell\nMove a creature card from the stack to play.', game, alice);
    expect(game.engine.zones.zoneOf(creature)?.id).toBe(PLAY.id);
    expect(game.cardStack.size).toBe(0);
  });

  it('is a real "enters play from stack": the arrival trigger fires, and the spell never resolves', async () => {
    const { game, alice, b, creature } = await withSpellOnStack();
    const hp = b.hero.gauge('hp').current;
    await cast('Card Flash Cheat\nCost 2\nSpell\nMove a creature card from the stack to play.', game, alice);
    await game.runPriority(); // the arrival trigger goes on the stack and resolves; the cheated card does not resolve again
    expect(game.engine.zones.zoneOf(creature)?.id).toBe(PLAY.id);
    expect(b.hero.gauge('hp').current).toBe(hp - 3);
  });

  it('takes nothing else off the stack: a card on it stays and still resolves', async () => {
    const { game, alice, creature } = await withSpellOnStack();
    await cast('Card Flash Cheat\nCost 2\nSpell\nMove a spell card from the stack to play.', game, alice);
    expect(game.engine.zones.zoneOf(creature)?.id).toBe('stack');
    expect(game.cardStack.size).toBe(1);
  });
});

/* --------------------------- castable by a player --------------------------- */

describe('cards castable by a player', () => {
  const PURGE = "Card Mind Purge\nCost 4\nSpell\nReveal all cards castable by target opponent.\nMove a card castable by target opponent to its owner's garbage.";

  it.each([
    ['Reveal all cards castable by target opponent.', { kind: 'revealCards', select: { how: 'all', count: 0 }, from: { castableBy: 'opponent' } }],
    ["Move a card castable by target opponent to its owner's garbage.", { kind: 'moveCards', select: { how: 'choose', count: 1 }, from: { castableBy: 'opponent' }, to: { whose: 'owner', zone: 'garbage' } }],
    ['Reveal the top 2 cards from your deck.', { kind: 'revealCards', select: { how: 'top', count: 2 }, from: { whose: 'you', zone: 'deck' } }],
  ])('%s', (sentence, effect) => {
    const ir = lower(`Ability A\n${sentence}`);
    expect(ir.abilities[0]!.steps[0]!.effects[0]).toEqual(effect);
    const { text } = renderDocument(ir);
    expect(text).toContain(sentence);
    expect(lower(text).abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
  });

  it('says what is wrong', () => {
    expect(errors('Ability A\nReveal all cards castable by.')[0]).toMatch(/castable by whom/);
    expect(errors('Ability A\nReveal all cards.')[0]).toMatch(/expected "from <zone>" or "castable by <player>"/);
  });

  it('shows everyone the cards the player could cast, then discards one — a stolen card to its real owner\'s garbage', async () => {
    const { game, alice, bob, a, b } = await table(WISP);
    // Bob steals one of Alice's cards (Alice's hand card goes to Bob's stolen pile).
    const mine = a.hand.cards[0]!;
    await game.engine.moveTo(mine, 'stolen', { owner: bob });
    const bobCastable = game.castableCards(bob);
    expect(bobCastable).toContain(mine);
    expect(bobCastable.length).toBe(b.hand.size + 1);
    expect(game.engine.canSee(alice, b.hand.cards[0]!)).toBe(false);

    // Alice casts Mind Purge on Bob: every card Bob could cast is shown to her.
    const { cards } = playableCards(PURGE);
    const spell = cards[0]!;
    if (spell.kind !== 'spell') throw new Error('spell');
    const choices: ChoiceRequest[] = [];
    alice.choose = async (request) => {
      choices.push(request);
      // Discard Alice's own stolen card.
      return { kind: 'select', chosen: request.kind === 'select' ? [request.options.find((o) => o === mine) ?? request.options[0]!] : [] };
    };
    const actions = await spell.effect({ self: a.hero, engine: game.engine, side: a as never }, { targets: [] });
    await game.engine.apply(actions);
    expect(game.engine.canSee(alice, b.hand.cards[0]!)).toBe(true);
    expect(game.engine.zones.zoneOf(mine)?.id).toBe('garbage');
    expect(game.engine.zones.zoneOf(mine)?.owner).toBe(alice); // its owner's, not Bob's
  });
});

describe('Surveil(player, X)', () => {
  const deck = Array.from({ length: 30 }, (_, i) => [ELVEN_ARCHER, SHIELDBEARER, BLOODFEN_RAPTOR][i % 3]!);

  it('parses, renders and round-trips', () => {
    const ir = lower('Ability A\nSurveil(you, 2).');
    expect(ir.abilities[0]!.steps[0]!.effects[0]).toEqual({ kind: 'scry', surveil: true, count: { kind: 'const', value: 2 }, players: 'you' });
    expect(renderDocument(ir).text).toContain('Surveil(you, 2).');
  });

  it('puts the chosen cards in the garbage and the rest back on top in the chosen order', async () => {
    const alice = new Idle('Alice', 'a', deck);
    const bob = new Idle('Bob', 'b', deck);
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    const a = game.sideOf(alice);
    const [x, y, z] = a.deck.cards.slice(0, 3);
    const deckBefore = a.deck.size;
    alice.choose = async (request: ChoiceRequest): Promise<ChoiceAnswer> => {
      if (request.kind !== 'select') throw new Error('x');
      // First question (a range): discard y. Then order the rest: z first.
      if (Array.isArray(request.count)) return { kind: 'select', chosen: [y!] };
      return { kind: 'select', chosen: [z!] };
    };
    await cast('Card Probe\nCost 1\nSpell\nSurveil(you, 3).', game, alice);
    expect(a.garbage.cards).toEqual([y]);
    expect(a.deck.size).toBe(deckBefore - 1);
    expect(a.deck.cards.slice(0, 2)).toEqual([z, x]);
  });
});

/* --------------------------- the generic form of Scry --------------------------- */

describe('Move any number of … and the rest … in the order of your choice', () => {
  const SCRY3 =
    'Move any number of the top 3 cards from your deck to the bottom of your deck and the rest on the top of your deck in the order of your choice.';
  const deck = Array.from({ length: 30 }, (_, i) => [ELVEN_ARCHER, SHIELDBEARER, BLOODFEN_RAPTOR][i % 3]!);

  it('parses and round-trips', () => {
    const ir = lower(`Ability A\n${SCRY3}`);
    expect(ir.abilities[0]!.steps[0]!.effects[0]).toEqual({
      kind: 'moveCards',
      select: { how: 'top', count: 3, any: true },
      from: { whose: 'you', zone: 'deck' },
      to: { whose: 'you', zone: 'deck', position: 'bottom' },
      rest: { to: { whose: 'you', zone: 'deck', position: 'top' }, order: 'chosen' },
    });
    const { text } = renderDocument(ir);
    expect(text).toContain(SCRY3);
    expect(lower(text).abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
  });

  it('says what is wrong', () => {
    expect(errors('Ability A\nMove the top 3 cards from your deck to your hand and the rest on the top of your deck.')[0]).toMatch(/needs "any number of/);
    expect(errors('Ability A\nMove any number of all cards from your deck to your hand.')[0]).toBeDefined();
  });

  async function scryWith(text: string) {
    const alice = new Idle('Alice', 'a', deck);
    const bob = new Idle('Bob', 'b', deck);
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    const a = game.sideOf(alice);
    const [x, y, z] = a.deck.cards.slice(0, 3);
    alice.choose = async (request: ChoiceRequest): Promise<ChoiceAnswer> => {
      if (request.kind !== 'select') throw new Error('x');
      if (Array.isArray(request.count)) return { kind: 'select', chosen: [y!] }; // bottom y
      return { kind: 'select', chosen: [z!] }; // then z first
    };
    await cast(`Card Probe\nCost 1\nSpell\n${text}`, game, alice);
    return { a, x: x!, y: y!, z: z! };
  }

  it('does what Scry(you, 3) does: bottom what you pick, the rest back on top in your order', async () => {
    const generic = await scryWith(SCRY3);
    expect(generic.a.deck.cards.slice(0, 2)).toEqual([generic.z, generic.x]);
    expect(generic.a.deck.cards[generic.a.deck.size - 1]).toBe(generic.y);
    const sugar = await scryWith('Scry(you, 3).');
    expect(sugar.a.deck.cards.slice(0, 2)).toEqual([sugar.z, sugar.x]);
    expect(sugar.a.deck.cards[sugar.a.deck.size - 1]).toBe(sugar.y);
  });

  it('can pick cards out of the pool into another zone: surveil, with no rest', async () => {
    const t = await scryWith('Move any number of the top 3 cards from your deck to your garbage.');
    expect(t.a.garbage.cards).toEqual([t.y]);
    expect(t.a.deck.cards.slice(0, 2)).toEqual([t.x, t.z]); // the rest simply stay, in their order
  });

  it('puts cards in the order of your choice in another zone', async () => {
    const t = await scryWith('Move any number of the top 3 cards from your deck to the bottom of your deck in the order of your choice.');
    expect(t.a.deck.cards.at(-1)).toBe(t.y);
  });
});

describe('"target opponent" is one player for the whole card', () => {
  it('asks which opponent once, then means the same one in every sentence', async () => {
    const alice = new Idle('Alice', 'a', Array.from({ length: 30 }, () => WISP));
    const bob = new Idle('Bob', 'b', Array.from({ length: 30 }, () => WISP));
    const cy = new Idle('Cy', 'c', Array.from({ length: 30 }, () => WISP));
    const game = new CardGame([alice, bob, cy], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    let asked = 0;
    alice.choose = async (request: ChoiceRequest): Promise<ChoiceAnswer> => {
      if (request.kind === 'label') {
        asked += 1;
        return { kind: 'label', value: 'Cy' };
      }
      return { kind: 'select', chosen: request.kind === 'select' ? [request.options[0]!] : [] };
    };
    await cast("Card Mind Purge\nCost 4\nSpell\nReveal all cards castable by target opponent.\nMove a card castable by target opponent to its owner's garbage.", game, alice);
    expect(asked).toBe(1);
    expect(game.sideOf(cy).garbage.size).toBe(1);
    expect(game.sideOf(bob).garbage.size).toBe(0);
  });
});
