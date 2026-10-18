/**
 * Creature definitions and `Create a Giant Golem.`
 *
 *   Creature Giant Golem 6/6
 *   Taunt.
 *
 *   You and target opponent play Rock Paper Scissors.
 *   The winners create a Giant Golem.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import { WISP } from '../examples/card-game/cards.js';
import { playableCards } from '../examples/card-game/english.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { lowerDocument, parseDocument, renderDocument } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';

const RPS = `Contest Rock Paper Scissors
Players 2.
All players commit Rock, Paper or Scissors face down.
When they are ready, reveal.
If all players committed the same option, it is a tie.
If player 1 committed Rock and player 2 committed Scissors, player 1 win and player 2 lose.
If player 1 committed Scissors and player 2 committed Paper, player 1 win and player 2 lose.
If player 1 committed Paper and player 2 committed Rock, player 1 win and player 2 lose.
Otherwise player 2 win and player 1 lose.`;

const GOLEM = `Creature Giant Golem
{ "type": "creature", "creatureConfig": { "power": 6, "health": 6 } }
Taunt.`;

const DOCUMENT = `${GOLEM}

${RPS}

Card Golem Gambit
{ "cost": 3, "type": "spell" }
You and target opponent play Rock Paper Scissors.
The winners create a Giant Golem.

Card Forge
{ "cost": 5, "type": "spell" }
Create a Giant Golem.`;

class Idle extends CardPlayer {
  async chooseMove(): Promise<Move> {
    return { kind: 'end' };
  }
}

const contest = parseDocument(RPS).doc.contests[0]!.contest!;
const parse = (text: string) => parseDocument(text, { zones: new ZoneDictionary(['hand']), contests: [contest], creatures: ['Giant Golem'] });
const lower = (text: string) => lowerDocument(parse(text).doc);
const errors = (text: string) => parse(text).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

describe('Create — the language', () => {
  it.each([
    ['Create a Giant Golem.', 'you'],
    ['You create a Giant Golem.', 'you'],
    ['All players create a Giant Golem.', 'each'],
    ['All opponents create a Giant Golem.', 'opponents'],
  ])('%s', (sentence, players) => {
    const effect = lower(`Ability A\n${sentence}`).abilities[0]!.steps[0]!.effects[0];
    expect(effect).toEqual({ kind: 'create', players, creature: 'Giant Golem' });
  });

  it('the winners and the losers create, after a contest; and it round-trips', () => {
    const source = 'Ability A\nAll players play Rock Paper Scissors.\nThe winners create a Giant Golem.\nThe losers create a Giant Golem.';
    const ir = lower(source);
    const { text } = renderDocument(ir);
    expect(text).toContain('The winners create a Giant Golem.');
    expect(text).toContain('The losers create a Giant Golem.');
    expect(lower(text).abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
  });

  it('says what is wrong', () => {
    expect(errors('Ability A\nCreate a Dragon.')[0]).toMatch(/unknown creature "Dragon" — the creatures are "Giant Golem"/);
    expect(errors('Ability A\nThe winners create a Giant Golem.')[0]).toMatch(/result of a contest/);
    expect(errors('Ability A\nCreate Giant Golem.')[0]).toMatch(/expected "a"/);
  });
});

describe('Creature Giant Golem 6/6 — the definition', () => {
  it('is a creature definition, not a card for a deck', () => {
    const authored = playableCards(DOCUMENT);
    expect(authored.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(authored.cards.map((c) => c.name)).toEqual(['Golem Gambit', 'Forge']);
    expect(authored.creatures).toHaveLength(1);
    const golem = authored.creatures[0]!;
    if (golem.kind !== 'creature') throw new Error('creature');
    expect([golem.name, golem.power, golem.health, golem.keywords]).toEqual(['Giant Golem', 6, 6, ['taunt']]);
  });
});

describe('Create — playing it', () => {
  async function table() {
    const authored = playableCards(DOCUMENT);
    const [gambit, forge] = authored.cards;
    const alice = new Idle('Alice', 'a', Array.from({ length: 30 }, () => WISP));
    const bob = new Idle('Bob', 'b', Array.from({ length: 30 }, () => WISP));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    game.installCreatures(authored.creatures);
    await game.setup();
    await game.collectUserDecisions();
    const run = async (card: typeof gambit) => {
      if (card!.kind !== 'spell') throw new Error('spell');
      const a = game.sideOf(alice);
      const actions = await card!.effect({ self: a.hero, engine: game.engine, side: a as never }, { targets: [] });
      await game.engine.apply(actions);
    };
    return { game, alice, bob, gambit, forge, run };
  }

  it('Create a Giant Golem: a 6/6 in play under your control, with the rules of arriving', async () => {
    const { game, alice, forge, run } = await table();
    await run(forge);
    const board = game.sideOf(alice).board;
    expect(board.map((c) => c.name)).toEqual(['Giant Golem']);
    const golem = board[0]!;
    expect([golem.stat('power'), golem.gauge('hp').max]).toEqual([6, 6]);
    expect(golem.controller).toBe(alice);
    expect(game.engine.isInPlay(golem)).toBe(true);
    // It arrived like any creature: it cannot act this turn, and it taunts.
    expect(golem.hasStatus('summoning-sickness')).toBe(true);
    expect(game.readyAttackers(game.sideOf(alice))).not.toContain(golem);
    expect(golem.hasStatus('taunt')).toBe(true);
  });

  it('makes a new one each time', async () => {
    const { game, alice, forge, run } = await table();
    await run(forge);
    await run(forge);
    const board = game.sideOf(alice).board;
    expect(board).toHaveLength(2);
    expect((board[0] as { id?: string }).id).not.toBe((board[1] as { id?: string }).id);
  });

  it('Rock Paper Scissors: the winner gets the Golem, the loser nothing', async () => {
    const { game, alice, bob, gambit, run } = await table();
    alice.choose = async () => ({ kind: 'label', value: 'Rock' });
    bob.choose = async () => ({ kind: 'label', value: 'Scissors' });
    await run(gambit);
    expect(game.sideOf(alice).board.map((c) => c.name)).toEqual(['Giant Golem']);
    expect(game.sideOf(bob).board).toHaveLength(0);
  });

  it('a tie makes nothing', async () => {
    const { game, alice, bob, gambit, run } = await table();
    alice.choose = async () => ({ kind: 'label', value: 'Paper' });
    bob.choose = async () => ({ kind: 'label', value: 'Paper' });
    await run(gambit);
    expect(game.sideOf(alice).board).toHaveLength(0);
    expect(game.sideOf(bob).board).toHaveLength(0);
  });

  it('a game that has not installed the definition says so', async () => {
    const authored = playableCards(DOCUMENT);
    const forge = authored.cards[1]!;
    const alice = new Idle('Alice', 'a', Array.from({ length: 30 }, () => WISP));
    const bob = new Idle('Bob', 'b', Array.from({ length: 30 }, () => WISP));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    if (forge.kind !== 'spell') throw new Error('spell');
    const a = game.sideOf(alice);
    await expect(Promise.resolve(forge.effect({ self: a.hero, engine: game.engine, side: a as never }, { targets: [] }))).rejects.toThrow(
      /no way to create a creature/,
    );
  });
});
