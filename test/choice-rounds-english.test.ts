/**
 * **Choice rounds in English** — the sentences a table would follow with no
 * software (docs/design/20-secret-choices-and-dice.md):
 *
 * ```
 * Each player commits a card from their hand face down.
 * When they are ready, reveal.
 * Each player puts the card they committed into their garbage.
 * ```
 *
 * **Commit** is sealed and simultaneous; **choose** is open and in turn order.
 * The verb carries the difference, so there is no "in secret" modifier.
 *
 * `test/choice-rounds.test.ts` holds the IR to account. This file is the
 * language: that the text parses to that IR, renders back to itself, runs from
 * text alone, and that a card which breaks the procedure is refused with a
 * message that says what to write instead.
 */
import { describe, expect, it } from 'vitest';
import { compileDocument, lowerDocument, parseDocument, renderDocument, wordDoc } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import { Character, Player, type ChoiceAnswer, type ChoiceRequest, type Decision, type Entity } from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { GARBAGE, HAND } from '../src/games/cards/zones.js';
import { PLAY } from '../src/engine/index.js';

const ZONES = new ZoneDictionary([HAND.id]);
const lower = (text: string) => lowerDocument(parseDocument(text, { zones: ZONES }).doc);

const FULL = `Ability Showdown
Each player commits a card from their hand face down.
When they are ready, reveal.
Each player puts the card they committed into their garbage.`;

describe('choice rounds — parsing', () => {
  it('parses the three sentences to the IR nodes', () => {
    const [ability] = lower(FULL).abilities;
    expect(ability!.steps.map((step) => step.effects[0])).toEqual([
      { kind: 'choose', round: 'choice', players: 'each', secret: true, pick: { kind: 'card', from: 'hand' } },
      { kind: 'reveal', round: 'choice' },
      { kind: 'moveChosen', round: 'choice', to: 'garbage' },
    ]);
  });

  it('parses a number choice, open or secret', () => {
    const [ability] = lower('Ability Pick\nEach player commits a number from 1 to 6 face down.\nWhen they are ready, reveal.').abilities;
    expect(ability!.steps[0]!.effects[0]).toEqual({
      kind: 'choose',
      round: 'choice',
      players: 'each',
      secret: true,
      pick: { kind: 'number', min: { kind: 'const', value: 1 }, max: { kind: 'const', value: 6 } },
    });
    const open = lower('Ability Pick\nEach player chooses a number from 1 to 6.').abilities[0]!;
    expect(open.steps[0]!.effects[0]).toMatchObject({ secret: false });
  });

  it('understands you, each opponent, and the "all players" spelling of the reveal', () => {
    const doc = lower(`Ability Mixed
Each opponent commits a card from their hand face down.
When all players are ready, reveal.
Each opponent puts the card they committed into their garbage.
You choose a card from your hand.
You put the card you chose into your garbage.`);
    const effects = doc.abilities[0]!.steps.map((step) => step.effects[0]);
    expect(effects.map((effect) => effect!.kind)).toEqual(['choose', 'reveal', 'moveChosen', 'choose', 'moveChosen']);
    expect(effects[0]).toMatchObject({ players: 'opponents' });
    expect(effects[3]).toMatchObject({ players: 'you', secret: false });
  });

  it('still reads "You win the game." and a real "when … then" trigger', () => {
    const doc = lower('Ability Win\nYou win the game.');
    expect(doc.abilities[0]!.steps[0]!.effects[0]).toEqual({ kind: 'result', players: 'you', win: true });
    const trigger = parseDocument('when this character dies then Deal 1 damage to all enemy characters.').diagnostics;
    expect(trigger.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('choice rounds — rendering', () => {
  it('renders the canonical text, and the round trip is the identity', () => {
    const ir = lower(FULL);
    const { text, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    expect(text).toContain('Each player commits a card from their hand face down.');
    expect(text).toContain('When they are ready, reveal.');
    expect(text).toContain('Each player puts the card they committed into their garbage.');
    const again = lower(text);
    expect(again.abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
    // and rendering is a fixpoint
    expect(renderDocument(again).text).toBe(text);
  });

  it('words the move by the verb that opened the round, whichever was written', () => {
    const text = renderDocument(
      lower(`Ability Mismatch
Each player commits a card from their hand face down.
When they are ready, reveal.
Each player puts the card they chose into their garbage.`),
    ).text;
    expect(text).toContain('Each player puts the card they committed into their garbage.');
  });

  it('words "you" and "each opponent" correctly', () => {
    const text = renderDocument(
      lower(`Ability Mixed
Each opponent commits a card from their hand face down.
When they are ready, reveal.
Each opponent puts the card they committed into their garbage.
You choose a card from your hand.
You put the card you chose into your garbage.`),
    ).text;
    expect(text).toContain('Each opponent commits a card from their hand face down.');
    expect(text).toContain('Each opponent puts the card they committed into their garbage.');
    expect(text).toContain('You choose a card from your hand.');
    expect(text).toContain('You put the card you chose into your garbage.');
  });
});

describe('choice rounds — diagnostics', () => {
  const errors = (text: string) =>
    compileDocument(text, { zones: ZONES }).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

  it('compiles the full round cleanly', () => {
    expect(compileDocument(FULL, { zones: ZONES }).diagnostics).toEqual([]);
  });

  it('a secret choice that is never revealed', () => {
    expect(errors('Ability A\nEach player commits a card from their hand face down.')[0]).toMatch(
      /never revealed.*When they are ready, reveal\./,
    );
  });

  it('using a choice before it is revealed points at that sentence', () => {
    const text = 'Ability A\nEach player commits a card from their hand face down.\nEach player puts the card they committed into their garbage.\nWhen they are ready, reveal.';
    const found = compileDocument(text, { zones: ZONES }).diagnostics.find((d) => d.code === 'choice-round' && /before it is revealed/.test(d.message));
    expect(found).toBeDefined();
    expect(text.slice(found!.start, found!.end)).toBe('Each player puts the card they committed into their garbage.');
  });

  it('a reveal with nothing chosen, and a reveal of an open choice', () => {
    expect(errors('Ability A\nWhen they are ready, reveal.')[0]).toMatch(/nothing has been chosen/);
    expect(errors('Ability A\nEach player chooses a card from their hand.\nWhen they are ready, reveal.')[0]).toMatch(/Use "commits … face down"/);
  });

  it('warns about a secret choice with one chooser', () => {
    const diagnostics = compileDocument(
      'Ability A\nYou commit a card from your hand face down.\nWhen they are ready, reveal.',
      { zones: ZONES },
    ).diagnostics;
    expect(diagnostics.map((d) => d.severity)).toEqual(['warning']);
  });

  it('rejects an unknown zone, a backwards range, and a bad verb with a helpful message', () => {
    expect(errors('Ability A\nEach player chooses a card from their pocket.')[0]).toMatch(/unknown zone "pocket"/);
    expect(errors('Ability A\nEach player chooses a number from 6 to 1.')[0]).toMatch(/not a range of whole numbers/);
    expect(errors('Ability A\nEach player picks a card from their hand.')[0]).toMatch(/expected "commits" \(sealed\) or "chooses" \(open\)/);
    expect(errors('Ability A\nEach cat commits a card from their hand face down.')[0]).toMatch(/"Each" is followed by "player" or "opponent"/);
  });

  it('a commitment must say "face down", and a choice must not', () => {
    expect(errors('Ability A\nEach player commits a card from their hand.')[0]).toMatch(/add "face down"/);
    expect(errors('Ability A\nEach player chooses a card from their hand face down.')[0]).toMatch(
      /"chooses" is made in the open/,
    );
  });

  it('names the old "in secret" spelling instead of reporting a stray word', () => {
    expect(errors('Ability A\nEach player chooses a card from their hand in secret.')[0]).toMatch(
      /not yet a commitment — write "commits … face down"/,
    );
  });

  it('still reads "in" for the zone, since it means the same as "from"', () => {
    expect(
      lower('Ability A\nEach player commits a card in their hand face down.\nWhen they are ready, reveal.').abilities[0]!
        .steps[0]!.effects[0],
    ).toMatchObject({ kind: 'choose', pick: { kind: 'card', from: 'hand' } });
  });
});

/* ------------------------- running from text alone ------------------------ */

class TestCard implements Entity {
  readonly type = 'card' as const;
  constructor(readonly name: string) {}
}

class Picker extends Player {
  constructor(name: string, characters: readonly Character[], private readonly pick: string) {
    super(name, characters);
  }
  async decide(): Promise<Decision[]> {
    return [];
  }
  override async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    if (request.kind === 'select') {
      return { kind: 'select', chosen: request.options.filter((option) => option.name === this.pick) };
    }
    return { kind: 'confirm', yes: true };
  }
}

describe('choice rounds — the words are in the glossary', () => {
  it('documents commit, reveal and ready, and says how commit differs from choose', () => {
    expect(wordDoc('commit')).toMatch(/sealed/);
    expect(wordDoc('commit')).toMatch(/choose a valid option and write the value face down so you cannot change it/);
    expect(wordDoc('commit')).toMatch(/loses you the game/);
    expect(wordDoc('reveal')).toMatch(/loses that player the game/);
    expect(wordDoc('choose')).toMatch(/open/);
    expect(wordDoc('reveal')).toMatch(/face up/);
    expect(wordDoc('ready')).toMatch(/committed/);
    expect(wordDoc('face')).toMatch(/face down/);
  });
});

describe('choice rounds — running from English alone', () => {
  it('plays the three sentences end to end', async () => {
    const compiled = compileDocument(FULL, { zones: ZONES });
    expect(compiled.diagnostics).toEqual([]);
    const ability = compiled.abilities[0]!;
    const engine = createEngine({ onEvent: () => {} });
    for (const zone of [HAND, GARBAGE, PLAY]) engine.zones.declare(zone);
    const seats = [
      { name: 'A', pick: 'Wisp', hand: ['Wisp', 'Bolt'] },
      { name: 'B', pick: 'Imp', hand: ['Imp'] },
    ];
    const players: Picker[] = [];
    for (const seat of seats) {
      const hero = new Character(`${seat.name} hero`, {
        gauges: [{ id: 'hp', max: 10 }],
        skills: [{ name: 'Showdown', weight: 1, abilities: [ability] }],
      });
      const player = new Picker(seat.name, [hero], seat.pick);
      engine.registerPlayer(player);
      for (const card of seat.hand) await engine.addEntity(new TestCard(card), HAND.id, { owner: player });
      players.push(player);
    }
    await engine.useAbility(players[0]!.characters[0]!, ability, { targets: [] });
    const names = (zone: string, player: Player) =>
      engine.zones.members(zone, player).filter((m) => m.type === 'card').map((m) => m.name);
    expect(names('garbage', players[0]!)).toEqual(['Wisp']);
    expect(names('hand', players[0]!)).toEqual(['Bolt']);
    expect(names('garbage', players[1]!)).toEqual(['Imp']);
  });
});
