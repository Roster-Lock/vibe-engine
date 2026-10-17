/**
 * Votes in English — the five kinds (docs/design/20-secret-choices-and-dice.md):
 *
 * ```
 * Each player commits a vote for Attack or Retreat face down.
 * Starting with you, each player votes for Attack or Retreat.
 * Ending with you, each player votes for Attack or Retreat.
 * Starting with a random player, each player votes for Attack or Retreat.
 * In reverse order, each player votes for Attack or Retreat.
 * ```
 *
 * and the tally, `votes for Attack`, read like any other amount.
 */
import { describe, expect, it } from 'vitest';
import { compileDocument, lowerDocument, parseDocument, renderDocument, wordDoc } from '../src/english/index.js';
import {
  Character,
  Player,
  createEngine,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';

const lower = (text: string) => lowerDocument(parseDocument(text).doc);
const errors = (text: string) =>
  compileDocument(text).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

class Voter extends Player {
  constructor(
    name: string,
    characters: readonly Character[],
    private readonly vote: string,
    private readonly log: string[],
  ) {
    super(name, characters);
  }
  async decide(): Promise<Decision[]> {
    return [];
  }
  override async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    this.log.push(this.name);
    return request.kind === 'label' ? { kind: 'label', value: this.vote } : { kind: 'confirm', yes: true };
  }
}

/** Four seats A–D, `votes[i]` their vote, `caster` the seat using the ability. */
async function run(text: string, votes: readonly string[], options: { caster?: number; die?: number } = {}) {
  const compiled = compileDocument(text);
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const ability = compiled.abilities[0]!;
  const log: string[] = [];
  const events: GameEvent[] = [];
  const engine = createEngine({
    seed: 's',
    onEvent: (event: GameEvent) => events.push(event),
    roller: () => [options.die ?? 1],
  });
  const heroes: Character[] = [];
  for (const [index, name] of ['A', 'B', 'C', 'D'].entries()) {
    const hero = new Character(`${name}'s hero`, {
      gauges: [{ id: 'hp', max: 100 }],
      skills: [{ name: ability.name, weight: 1, abilities: [ability] }],
    });
    engine.registerPlayer(new Voter(name, [hero], votes[index]!, log));
    heroes.push(hero);
  }
  await engine.useAbility(heroes[options.caster ?? 0]!, ability, { targets: [] });
  return { log, events, hp: (i = 0) => heroes[i]!.findGauge('hp')!.current };
}

const BODY = `
If votes for Attack is higher than votes for Retreat, Deal 10 damage to this character.
If votes for Attack is lower than votes for Retreat, Deal 20 damage to this character.
If votes for Attack is the same as votes for Retreat, Deal 1 damage to this character.`;
const MIXED = ['Attack', 'Retreat', 'Attack', 'Attack'];

describe('the five kinds of vote — parsing', () => {
  const effectOf = (line: string) => lower(`Ability V\n${line}`).abilities[0]!.steps[0]!.effects[0];
  const pick = { kind: 'label', options: ['Attack', 'Retreat'] };

  it('commit / reveal', () => {
    expect(effectOf('Each player commits a vote for Attack or Retreat face down.')).toEqual({
      kind: 'choose',
      round: 'choice',
      players: 'each',
      secret: true,
      pick,
    });
  });

  it('the caster goes first', () => {
    expect(effectOf('Starting with you, each player votes for Attack or Retreat.')).toMatchObject({
      secret: false,
      order: 'caster-first',
      pick,
    });
  });

  it('the caster goes last', () => {
    expect(effectOf('Ending with you, each player votes for Attack or Retreat.')).toMatchObject({
      order: 'caster-last',
      secret: false,
    });
  });

  it('a random player goes first', () => {
    expect(effectOf('Starting with a random player, each player votes for Attack or Retreat.')).toMatchObject({
      order: 'random',
      secret: false,
    });
  });

  it('reverse order', () => {
    expect(effectOf('In reverse order, each player votes for Attack or Retreat.')).toMatchObject({
      order: 'reverse',
      secret: false,
    });
  });

  it('reads three options, a trailing comma before "or", and quoted names', () => {
    const options = (line: string) => {
      const effect = effectOf(line);
      return effect?.kind === 'choose' && effect.pick.kind === 'label' ? effect.pick.options : [];
    };
    expect(options('Starting with you, each player votes for Red, Green or Blue.')).toEqual(['Red', 'Green', 'Blue']);
    expect(options('Starting with you, each player votes for Red, Green, or Blue.')).toEqual(['Red', 'Green', 'Blue']);
    expect(options('Starting with you, each player votes for "Hold fire" or "Open fire".')).toEqual(['Hold fire', 'Open fire']);
  });

  it('reads the tally as an amount', () => {
    const ir = lower(`Ability V\nStarting with you, each player votes for Attack or Retreat.\nDeal votes for Attack damage to this character.`);
    expect(ir.abilities[0]!.steps[1]!.effects[0]).toMatchObject({ amount: { kind: 'votes', option: 'Attack' } });
  });
});

describe('the five kinds of vote — rendering', () => {
  it('writes each kind back in its own words, and round-trips', () => {
    const source = `Ability V
Each player commits a vote for Attack or Retreat face down.
When they are ready, reveal.
Starting with you, each player votes for Attack or Retreat.
Ending with you, each player votes for Red, Green or Blue.
Starting with a random player, each player votes for "Hold fire" or "Open fire".
In reverse order, each player votes for Attack or Retreat.
Deal votes for Attack damage to this character.
If votes for Attack is higher than votes for Retreat, deal 1 damage to this character.`;
    const ir = lowerDocument(parseDocument(source).doc);
    const { text, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    for (const line of source.split('\n').slice(1)) expect(text).toContain(line);
    const again = lowerDocument(parseDocument(text).doc);
    expect(again.abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
    expect(renderDocument(again).text).toBe(text);
  });
});

describe('the five kinds of vote — playing them', () => {
  const doc = (opening: string) => `Ability Council\n${opening}${BODY}`;

  it('caster first: from the caster round the table', async () => {
    const out = await run(doc('Starting with you, each player votes for Attack or Retreat.'), MIXED, { caster: 2 });
    expect(out.log).toEqual(['C', 'D', 'A', 'B']);
  });

  it('caster last: round the table, ending with the caster', async () => {
    const out = await run(doc('Ending with you, each player votes for Attack or Retreat.'), MIXED, { caster: 2 });
    expect(out.log).toEqual(['D', 'A', 'B', 'C']);
  });

  it('random start: a die with a face per seat decides, then round the table', async () => {
    const out = await run(doc('Starting with a random player, each player votes for Attack or Retreat.'), MIXED, { die: 3 });
    expect(out.log).toEqual(['C', 'D', 'A', 'B']);
    expect(out.events.find((e) => e.type === 'roll:made')).toMatchObject({ sides: 4, results: [3] });
  });

  it('reverse order: the seating backwards, whoever casts', async () => {
    const out = await run(doc('In reverse order, each player votes for Attack or Retreat.'), MIXED, { caster: 1 });
    expect(out.log).toEqual(['D', 'C', 'B', 'A']);
  });

  it('commit / reveal: all answer, nothing is read until the reveal', async () => {
    const out = await run(
      doc('Each player commits a vote for Attack or Retreat face down.\nWhen they are ready, reveal.'),
      MIXED,
    );
    const kinds = out.events.map((e) => e.type).filter((type) => type.startsWith('choice:'));
    expect(kinds).toEqual(['choice:ready', 'choice:ready', 'choice:ready', 'choice:ready', 'choice:revealed']);
  });

  it('acts on the tally: 3 Attack to 1 Retreat means Attack wins', async () => {
    const open = await run(doc('Starting with you, each player votes for Attack or Retreat.'), MIXED);
    expect(open.hp()).toBe(90);
    const retreat = await run(doc('Starting with you, each player votes for Attack or Retreat.'), ['Retreat', 'Retreat', 'Attack', 'Retreat']);
    expect(retreat.hp()).toBe(80);
    const tie = await run(doc('Starting with you, each player votes for Attack or Retreat.'), ['Attack', 'Retreat', 'Attack', 'Retreat']);
    expect(tie.hp()).toBe(99);
  });

  it('counts the same way after a reveal', async () => {
    const out = await run(
      doc('Each player commits a vote for Attack or Retreat face down.\nWhen they are ready, reveal.'),
      MIXED,
    );
    expect(out.hp()).toBe(90);
  });
});

describe('votes — diagnostics', () => {
  const V = 'Starting with you, each player votes for Attack or Retreat.';

  it('a sealed vote needs its reveal before the tally is read', () => {
    expect(errors(`Ability A\nEach player commits a vote for Attack or Retreat face down.\nDeal votes for Attack damage to this character.\nWhen they are ready, reveal.`).join(' ')).toMatch(
      /read before the votes are revealed/,
    );
    expect(errors(`Ability A\nEach player commits a vote for Attack or Retreat face down.`)[0]).toMatch(/never revealed/);
  });

  it('the tally must be of a vote that was held, for an option on its ballot', () => {
    expect(errors('Ability A\nDeal votes for Attack damage to this character.')[0]).toMatch(/read before any vote/);
    expect(errors(`Ability A\n${V}\nDeal votes for Flee damage to this character.`)[0]).toMatch(
      /nobody can vote for "Flee" — the options are "Attack" and "Retreat"/,
    );
  });

  it('a tally in a condition is checked too', () => {
    expect(errors(`Ability A\n${V}\nIf votes for Flee is 2 or more, Deal 1 damage to this character.`)[0]).toMatch(/nobody can vote for "Flee"/);
  });

  it('an open vote must say who goes first, and everyone votes', () => {
    expect(errors('Ability A\nEach player chooses a vote for Attack or Retreat.')[0]).toMatch(/an open vote says who goes first/);
    expect(errors('Ability A\nEach opponent commits a vote for Attack or Retreat face down.')[0]).toMatch(/everyone votes/);
    expect(errors('Ability A\nStarting with them, each player votes for Attack or Retreat.')[0]).toMatch(/an open vote opens with who goes first/);
    expect(errors('Ability A\nStarting with you, each opponent votes for Attack or Retreat.')[0]).toMatch(/everyone votes/);
    expect(errors('Ability A\nIn order, each player votes for Attack or Retreat.')[0]).toMatch(/an open vote opens with who goes first/);
  });

  it('a vote needs two different options', () => {
    expect(errors('Ability A\nStarting with you, each player votes for Attack.')[0]).toMatch(/at least two options/);
    expect(errors('Ability A\nStarting with you, each player votes for Attack or attack.')[0]).toMatch(/listed twice/);
    expect(errors('Ability A\nStarting with you, each player votes for Attack or.')[0]).toMatch(/expected an option name/);
  });

  it('a commitment is still face down', () => {
    expect(errors('Ability A\nEach player commits a vote for Attack or Retreat.')[0]).toMatch(/add "face down"/);
  });

  it('an unknown ballot name used as a stored name is not a vote', () => {
    expect(errors(`Ability A\n${V}\nDeal Votes damage to this character.`)[0]).toMatch(/"Votes" has not been stored/);
  });
});

describe('votes — the words are in the glossary', () => {
  it('explains vote, votes and the order words', () => {
    expect(wordDoc('vote')).toMatch(/five kinds|Starting with you/);
    expect(wordDoc('votes')).toMatch(/votes for Attack/);
    expect(wordDoc('starting')).toMatch(/caster/);
    expect(wordDoc('ending')).toMatch(/caster/);
    expect(wordDoc('reverse')).toMatch(/seating/);
    expect(wordDoc('random')).toMatch(/die/);
  });
});
