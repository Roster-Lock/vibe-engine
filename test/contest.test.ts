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
import { lowerDocument, parseDocument, renderDocument } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import { GameEndInterrupt, type ChoiceAnswer, type ChoiceRequest } from '../src/engine/index.js';

const RPS = `Contest Rock Paper Scissors
Players 2.
All players commit Rock, Paper or Scissors face down.
When they are ready, reveal.
If all players committed the same option, it is a tie.
If player 1 committed Rock and player 2 committed Scissors, player 1 win and player 2 lose.
If player 1 committed Scissors and player 2 committed Paper, player 1 win and player 2 lose.
If player 1 committed Paper and player 2 committed Rock, player 1 win and player 2 lose.
Otherwise player 2 win and player 1 lose.`;

const SHOWDOWN = `${RPS}

Card Showdown
{ "cost": 3, "type": "spell" }
You and target opponent play Rock Paper Scissors.
Draw(the winners, 2).
Deal 5 damage to all characters owned by the losers.`;

class Idle extends CardPlayer {
  async chooseMove(): Promise<Move> {
    return { kind: 'end' };
  }
}

/** A contest section read by the language's own parser: the contest as data, and what is wrong with it. */
const rulesOf = (text: string) => {
  const result = parseDocument(text);
  return {
    contest: result.doc.contests[0]?.contest,
    problems: result.diagnostics.filter((d) => d.severity === 'error'),
  };
};
const RULES = rulesOf(RPS).contest!;
const parse = (text: string) => parseDocument(text, { zones: new ZoneDictionary(['hand']), contests: [RULES] });
const lower = (text: string) => lowerDocument(parse(text).doc);
const errors = (text: string) => parse(text).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

describe('a contest, as a rulebook states it', () => {
  it('reads the player count, the commit (its options) and the rules in order', () => {
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
    const bad = (line: string) => rulesOf(`Contest X\nAll players commit A or B face down.\nWhen they are ready, reveal.\n${line}`).problems[0]?.message;
    expect(bad('If player 1 committed C, player 1 win.')).toMatch(/"C" is not one of the options \(A, B\)/);
    expect(bad('If player 1 committed a, player 1 win.')).toMatch(/matched exactly/);
    expect(bad('Whoever is faster wins.')).toMatch(/does not start a line of a contest/);
    expect(rulesOf('Contest X\nPlayers 2.\nAll players commit A or B face down.\nWhen they are ready, reveal.\nIf player 1 committed A, player 3 win.').problems[0]?.message).toMatch(/there is no player 3/);
    expect(rulesOf('Contest X\nPlayers 2.').problems[0]?.message).toMatch(/needs the players to commit/);
  });

  it('commits face down, so the reveal must follow; the old forms are not lines of a contest', () => {
    const problems = (text: string) => rulesOf(text).problems.map((p) => p.message);
    expect(problems('Contest X\nAll players commit A or B face down.\nOtherwise player 1 win and player 2 lose.')[0]).toMatch(/needs "When they are ready, reveal."/);
    expect(problems('Contest X\nWhen they are ready, reveal.')[0]).toMatch(/nothing to reveal/);
    for (const old of [
      'The player count must be 2.',
      'Players commit an option from "A" and "B".',
      'If both players choose the same option, they draw.',
    ]) {
      expect(problems(`Contest X\nAll players commit A or B face down.\nWhen they are ready, reveal.\n${old}`)[0]).toMatch(/does not start a line of a contest|expected|a tie is/);
    }
    expect(problems('Contest X\nAll players commit A or B face down.\nWhen they are ready, reveal.\nIf player 1 committed A, player 1 wins.')[0]).toMatch(/"win" or "lose"/);
  });

  it('reports a mistake on the word that caused it', () => {
    const source = 'Contest X\nAll players commit A or B face down.\nWhen they are ready, reveal.\nIf player 1 committed A, player 1 wins.';
    const [problem] = rulesOf(source).problems;
    expect(source.slice(problem!.start, problem!.end)).toBe('wins');
  });

  it('is a section of the ordinary parser: it sits in a document with abilities, and a sentence above it can play it', () => {
    const source = `Ability Duel
You and target opponent play Chess.

Contest Chess
All players commit White or Black face down.
When they are ready, reveal.
Otherwise player 1 win and player 2 lose.

Ability After
Deal 1 damage to this.`;
    const result = parseDocument(source);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.doc.abilities.map((ability) => ability.name)).toEqual(['Duel', 'After']);
    expect(result.doc.contests.map((section) => section.name)).toEqual(['Chess']);
    expect(lowerDocument(result.doc).abilities[0]!.steps[0]!.effects[0]).toMatchObject({ kind: 'play', contest: { name: 'Chess' } });
  });

  it('accepts "it is a tie" and unquoted options', () => {
    const { contest, problems } = rulesOf('Contest X\nAll players commit Heads or Tails face down.\nWhen they are ready, reveal.\nIf all players committed the same option, it is a tie.\nOtherwise player 1 win and player 2 lose.');
    expect(problems).toEqual([]);
    expect(contest!.options).toEqual(['Heads', 'Tails']);
  });
});

describe('playing a contest — the language', () => {
  it('hands the contest a list of players, and round-trips', () => {
    for (const [source, players] of [
      ['You and target opponent play Rock Paper Scissors.', 'you-and-opponent'],
      ['All players play Rock Paper Scissors.', 'each'],
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
All players play Rock Paper Scissors.
Draw(the winners, 1).
Deal 2 damage to all characters owned by the losers.`);
    const { text } = renderDocument(doc);
    expect(text).toContain('Draw(the winners, 1).');
    expect(text).toContain('owned by the losers');
  });

  it('says what is wrong', () => {
    expect(errors('Ability A\nAll players play Chess.')[0]).toMatch(/unknown contest "Chess" — the contests are "Rock Paper Scissors"/);
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

  it('Rock beats Scissors: player 1 (Alice) wins and draws 2, player 2 lose and is dealt 5', async () => {
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
    const authored = playableCards(`${RPS}\n\nCard Crowd\n{ "cost": 1, "type": "spell" }\nAll players play Rock Paper Scissors.`);
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

describe('rendering a contest', () => {
  const source = `${RPS}

Ability Duel
You and target opponent play Rock Paper Scissors.
Draw(the winners, 2).`;

  it('writes the Contest section back, and reads it again to the same data', () => {
    const ir = lowerDocument(parseDocument(source).doc);
    expect(ir.contests).toEqual([RULES]);
    const { text, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    for (const line of RPS.split('\n')) expect(text).toContain(line);
    const again = parseDocument(text);
    expect(again.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(lowerDocument(again.doc)).toEqual(ir);
    expect(renderDocument(lowerDocument(again.doc)).text).toBe(text);
  });

  it('quotes a name that is not one word, and leaves out the player count when there is none', () => {
    const doc = `Contest Standoff
All players commit "Hold fire" or "Open fire" face down.
When they are ready, reveal.
If all players committed the same option, it is a tie.
Otherwise player 1 win and player 2 lose.`;
    const ir = lowerDocument(parseDocument(doc).doc);
    const { text } = renderDocument(ir);
    expect(text).toContain('All players commit "Hold fire" or "Open fire" face down.');
    expect(text).not.toContain('Players ');
    expect(lowerDocument(parseDocument(text).doc)).toEqual(ir);
  });

  it('a document with no contest has no contests field', () => {
    expect(lowerDocument(parseDocument('Ability A\nDeal 1 damage to this.').doc)).not.toHaveProperty('contests');
  });
});
