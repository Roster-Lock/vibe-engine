/**
 * Contests — Rock Paper Scissors is not a vote: players commit a choice face down, the choices are
 * turned over together, and the contest's own rules say who won and who lost. A contest receives a
 * list of players.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import { WISP } from '../examples/card-game/cards.js';
import { playableCards } from '../examples/card-game/english.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { parseContest } from '../src/english/contest.js';
import { lowerDocument, parseDocument, renderDocument } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import { GameEndInterrupt, type ChoiceAnswer, type ChoiceRequest } from '../src/engine/index.js';

const RPS = `Contest Rock Paper Scissors
The player count must be 2.
Players commit an option from "Rock", "Paper" and "Scissors".
If both players choose the same option, it is a tie.
If player 1 chooses Rock and player 2 chooses Scissors, player 1 wins and player 2 loses.
If player 1 chooses Scissors and player 2 chooses Paper, player 1 wins and player 2 loses.
If player 1 chooses Paper and player 2 chooses Rock, player 1 wins and player 2 loses.
Otherwise player 2 wins and player 1 loses.`;

const SHOWDOWN = `${RPS}

Card Showdown
Cost 3
Spell
You and target opponent play Rock Paper Scissors.
Draw(the winners, 2).
Deal 5 damage to all characters owned by the losers.`;

class Idle extends CardPlayer {
  async chooseMove(): Promise<Move> {
    return { kind: 'end' };
  }
}

const rulesOf = (text: string) => {
  const [heading, ...lines] = text.split('\n');
  void heading;
  return parseContest('Rock Paper Scissors', lines.map((line, i) => ({ text: line, start: i * 100, end: i * 100 + line.length })));
};
const RULES = rulesOf(RPS).contest!;
const parse = (text: string) => parseDocument(text, { zones: new ZoneDictionary(['hand']), contests: [RULES] });
const lower = (text: string) => lowerDocument(parse(text).doc);
const errors = (text: string) => parse(text).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

describe('a contest, as a rulebook states it', () => {
  it('reads the player count, the options and the rules in order', () => {
    const { contest, problems } = rulesOf(RPS);
    expect(problems).toEqual([]);
    expect(contest).toEqual({
      name: 'Rock Paper Scissors',
      playerCount: 2,
      options: ['Rock', 'Paper', 'Scissors'],
      rules: [
        { kind: 'tie' },
        { kind: 'when', picks: [{ player: 1, option: 'Rock' }, { player: 2, option: 'Scissors' }], winners: [1], losers: [2] },
        { kind: 'when', picks: [{ player: 1, option: 'Scissors' }, { player: 2, option: 'Paper' }], winners: [1], losers: [2] },
        { kind: 'when', picks: [{ player: 1, option: 'Paper' }, { player: 2, option: 'Rock' }], winners: [1], losers: [2] },
        { kind: 'otherwise', winners: [2], losers: [1] },
      ],
    });
  });

  it('says what is wrong with a rule', () => {
    const bad = (line: string) => rulesOf(`Contest X\nPlayers commit an option from "A" and "B".\n${line}`).problems[0]?.message;
    expect(bad('If player 1 chooses C, player 1 wins.')).toMatch(/"C" is not one of the options \(A, B\)/);
    expect(bad('If player 1 chooses a, player 1 wins.')).toMatch(/matched exactly/);
    expect(bad('Whoever is faster wins.')).toMatch(/not a line of a contest/);
    expect(rulesOf('Contest X\nThe player count must be 2.\nPlayers commit an option from "A" and "B".\nIf player 1 chooses A, player 3 wins.').problems[0]?.message).toMatch(/there is no player 3/);
    expect(rulesOf('Contest X\nThe player count must be 2.').problems[0]?.message).toMatch(/needs what players commit/);
  });

  it('accepts "return a tie" and unquoted options', () => {
    const { contest, problems } = rulesOf('Contest X\nPlayers commit an option from Heads and Tails.\nIf both players choose the same item, return a tie.\nOtherwise player 1 wins and player 2 loses.');
    expect(problems).toEqual([]);
    expect(contest!.options).toEqual(['Heads', 'Tails']);
  });
});

describe('playing a contest — the language', () => {
  it('hands the contest a list of players, and round-trips', () => {
    for (const [source, players] of [
      ['You and target opponent play Rock Paper Scissors.', 'you-and-opponent'],
      ['Each player plays Rock Paper Scissors.', 'each'],
    ] as const) {
      const ir = lower(`Ability A\n${source}`);
      expect(ir.abilities[0]!.steps[0]!.effects[0]).toEqual({ kind: 'play', players, contest: RULES });
      const { text } = renderDocument(ir);
      expect(text).toContain(source);
      expect(lower(text).abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
    }
  });

  it('reads the winners and the losers after a contest', () => {
    const doc = lower(`Ability A
Each player plays Rock Paper Scissors.
Draw(the winners, 1).
Deal 2 damage to all characters owned by the losers.`);
    const { text } = renderDocument(doc);
    expect(text).toContain('Draw(the winners, 1).');
    expect(text).toContain('owned by the losers');
  });

  it('says what is wrong', () => {
    expect(errors('Ability A\nEach player plays Chess.')[0]).toMatch(/unknown contest "Chess" — the contests are "Rock Paper Scissors"/);
    expect(errors('Ability A\nDraw(the winners, 1).')[0]).toMatch(/result of a contest — play one first/);
    expect(errors('Ability A\nDeal 1 damage to all characters owned by the losers.')[0]).toMatch(/result of a contest/);
  });
});

describe('Showdown — playing it', () => {
  async function table(playerCount = 2) {
    const { cards, diagnostics } = playableCards(SHOWDOWN);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const spell = cards[0]!;
    if (spell.kind !== 'spell') throw new Error('spell');
    const seats = ['Alice', 'Bob', 'Cy'].slice(0, playerCount).map((name) => new Idle(name, name, Array.from({ length: 30 }, () => WISP)));
    const game = new CardGame(seats, { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    return { game, spell, alice: seats[0]!, bob: seats[1]! };
  }
  async function showdown(aliceChooses: string, bobChooses: string) {
    const { game, spell, alice, bob } = await table();
    const seen: string[] = [];
    for (const [player, option] of [[alice, aliceChooses], [bob, bobChooses]] as const) {
      player.choose = async (request: ChoiceRequest): Promise<ChoiceAnswer> => {
        if (request.kind !== 'label') throw new Error('expected a label');
        expect([...request.options]).toEqual(['Rock', 'Paper', 'Scissors']);
        seen.push(`${player.name}:${option}`);
        return { kind: 'label', value: option };
      };
    }
    const a = game.sideOf(alice);
    const b = game.sideOf(bob);
    const handBefore = [a.hand.size, b.hand.size];
    const hpBefore = [a.hero.gauge('hp').current, b.hero.gauge('hp').current];
    const actions = await spell.effect({ self: a.hero, engine: game.engine, side: a as never }, { targets: [] });
    await game.engine.apply(actions);
    return { a, b, handBefore, hpBefore, seen };
  }

  it('Rock beats Scissors: player 1 (Alice) wins and draws 2, player 2 loses and is dealt 5', async () => {
    const t = await showdown('Rock', 'Scissors');
    expect(t.seen.sort()).toEqual(['Alice:Rock', 'Bob:Scissors']);
    expect(t.a.hand.size).toBe(t.handBefore[0]! + 2);
    expect(t.b.hero.gauge('hp').current).toBe(t.hpBefore[1]! - 5);
    expect(t.a.hero.gauge('hp').current).toBe(t.hpBefore[0]);
  });

  it('each of the three winning pairs', async () => {
    for (const [a, b] of [['Rock', 'Scissors'], ['Scissors', 'Paper'], ['Paper', 'Rock']]) {
      const t = await showdown(a!, b!);
      expect(t.a.hand.size).toBe(t.handBefore[0]! + 2);
    }
  });

  it('"Otherwise" is player 2: Paper beats Rock when Bob plays it', async () => {
    const t = await showdown('Rock', 'Paper');
    expect(t.b.hand.size).toBe(t.handBefore[1]! + 2);
    expect(t.a.hero.gauge('hp').current).toBe(t.hpBefore[0]! - 5);
  });

  it('the same choice is a tie: no winners, no losers', async () => {
    const t = await showdown('Paper', 'Paper');
    expect(t.a.hand.size).toBe(t.handBefore[0]);
    expect(t.b.hand.size).toBe(t.handBefore[1]);
    expect(t.a.hero.gauge('hp').current).toBe(t.hpBefore[0]);
    expect(t.b.hero.gauge('hp').current).toBe(t.hpBefore[1]);
  });

  it('refuses a list of the wrong size: the player count must be 2', async () => {
    const authored = playableCards(`${RPS}\n\nCard Crowd\nCost 1\nSpell\nEach player plays Rock Paper Scissors.`);
    const spell = authored.cards[0]!;
    if (spell.kind !== 'spell') throw new Error('spell');
    const seats = ['Alice', 'Bob', 'Cy'].map((name) => new Idle(name, name, Array.from({ length: 30 }, () => WISP)));
    const game = new CardGame(seats, { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    const a = game.sideOf(seats[0]!);
    await expect(spell.effect({ self: a.hero, engine: game.engine, side: a as never }, { targets: [] })).rejects.toThrow(
      /Rock Paper Scissors needs 2 players, but 3 were named/,
    );
  });
});

describe('an invalid option loses the game', () => {
  it('a player who commits something that is not an option forfeits: they lose, and the contest has no result', async () => {
    const { cards } = playableCards(SHOWDOWN);
    const spell = cards[0]!;
    if (spell.kind !== 'spell') throw new Error('spell');
    const alice = new Idle('Alice', 'a', Array.from({ length: 30 }, () => WISP));
    const bob = new Idle('Bob', 'b', Array.from({ length: 30 }, () => WISP));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    await game.collectUserDecisions();
    alice.choose = async () => ({ kind: 'label', value: 'Rock' });
    bob.choose = async () => ({ kind: 'label', value: 'rock' }); // not "Rock": options are exact
    const a = game.sideOf(alice);
    const handBefore = a.hand.size;
    const hpBefore = game.sideOf(bob).hero.gauge('hp').current;
    // Bob's invalid commitment loses him the game, right there: the game ends with Alice the winner,
    // and the contest decided nothing (nobody drew, nobody was dealt damage).
    const ended = await Promise.resolve(spell.effect({ self: a.hero, engine: game.engine, side: a as never }, { targets: [] })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(ended).toBeInstanceOf(GameEndInterrupt);
    expect((ended as GameEndInterrupt).winners).toEqual([alice]);
    expect(a.hand.size).toBe(handBefore);
    expect(game.sideOf(bob).hero.gauge('hp').current).toBe(hpBefore);
  });
});
