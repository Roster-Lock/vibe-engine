/**
 * **Choice rounds in the IR** — "each player commits a card face down; when
 * everyone is ready, reveal; each player puts the card they committed into their
 * garbage" (docs/design/20-secret-choices-and-dice.md).
 *
 * `test/sealed-round.test.ts` holds the engine round to account. This file is
 * about the IR on top of it: that the document survives JSON, that the abstract
 * zone roles resolve through the host's aliases, that only players with
 * something to choose are involved, and that a card which breaks the table
 * procedure is refused with a message saying what to write instead.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  Player,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Decision,
  type Entity,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { GameEndInterrupt } from '../src/engine/index.js';
import { bindDocument, validateRounds, type DocumentIR, type EffectIR } from '../src/ir/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { GARBAGE, HAND } from '../src/games/cards/zones.js';
import { PLAY } from '../src/engine/index.js';

class TestCard implements Entity {
  readonly type = 'card' as const;
  constructor(readonly name: string) {}
}

/** Picks a named card, or a number, after a delay so arrival order differs from seating. */
class Picker extends Player {
  readonly asked: string[] = [];
  constructor(
    name: string,
    characters: readonly Character[],
    private readonly pick: string | number,
    private readonly delay = 0,
  ) {
    super(name, characters);
  }
  async decide(): Promise<Decision[]> {
    return [];
  }
  override async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    this.asked.push(request.kind);
    await new Promise((resolve) => setTimeout(resolve, this.delay));
    if (request.kind === 'select') {
      return { kind: 'select', chosen: request.options.filter((option) => option.name === this.pick) };
    }
    if (request.kind === 'number') return { kind: 'number', value: Number(this.pick) };
    return { kind: 'confirm', yes: true };
  }
}

const ALIASES = { hand: HAND.id, garbage: GARBAGE.id };
const n = (value: number) => ({ kind: 'const' as const, value });

const chooseCard = (secret: boolean): EffectIR => ({
  kind: 'choose',
  round: 'card',
  players: 'each',
  secret,
  pick: { kind: 'card', from: 'hand' },
});
const reveal: EffectIR = { kind: 'reveal', round: 'card' };
const discard: EffectIR = { kind: 'moveChosen', round: 'card', to: 'garbage' };

function documentOf(...effects: EffectIR[]): DocumentIR {
  return {
    version: 1,
    imports: [],
    buffs: [],
    triggers: [],
    abilities: [
      {
        id: 'round',
        name: 'Round',
        targeting: { who: 'self', count: 1 },
        steps: effects.map((effect) => ({ effects: [effect] })),
      },
    ],
  };
}

function bindFromJson(document: DocumentIR) {
  const received = JSON.parse(JSON.stringify(document)) as DocumentIR;
  return bindDocument(received, { resolveBuff: () => undefined, aliases: ALIASES }).abilities[0]!;
}

interface Seat {
  readonly name: string;
  readonly pick: string | number;
  readonly hand: readonly string[];
  readonly delay?: number;
}

async function table(document: DocumentIR, seats: readonly Seat[]) {
  const ability = bindFromJson(document);
  const events: GameEvent[] = [];
  const engine = createEngine({ onEvent: (event: GameEvent) => events.push(event) });
  for (const zone of [HAND, GARBAGE, PLAY]) engine.zones.declare(zone);
  const players: Picker[] = [];
  const heroes: Character[] = [];
  for (const seat of seats) {
    const hero = new Character(`${seat.name}'s hero`, {
      gauges: [{ id: 'hp', max: 10 }],
      skills: [{ name: 'Round', weight: 1, abilities: [ability] }],
    });
    const player = new Picker(seat.name, [hero], seat.pick, seat.delay ?? 0);
    engine.registerPlayer(player);
    for (const card of seat.hand) await engine.addEntity(new TestCard(card), HAND.id, { owner: player });
    players.push(player);
    heroes.push(hero);
  }
  events.length = 0; // only what the ability itself does is of interest
  const zoneNames = (zone: string, player: Player) =>
    engine.zones.members(zone, player).filter((member) => member.type === 'card').map((member) => member.name);
  const run = () => engine.useAbility(heroes[0]!, ability, { targets: [] });
  return { engine, events, players, run, zoneNames };
}

describe('a secret choice round in the IR', () => {
  it('moves each player\'s own pick into their own garbage', async () => {
    const t = await table(documentOf(chooseCard(true), reveal, discard), [
      { name: 'A', pick: 'Wisp', hand: ['Wisp', 'Bolt'], delay: 10 },
      { name: 'B', pick: 'Imp', hand: ['Imp', 'Orc'] },
    ]);
    await t.run();
    const [a, b] = t.players as [Picker, Picker];
    expect(t.zoneNames('garbage', a)).toEqual(['Wisp']);
    expect(t.zoneNames('hand', a)).toEqual(['Bolt']);
    expect(t.zoneNames('garbage', b)).toEqual(['Imp']);
    expect(t.zoneNames('hand', b)).toEqual(['Orc']);
  });

  it('announces readiness before the reveal, with no content', async () => {
    const t = await table(documentOf(chooseCard(true), reveal, discard), [
      { name: 'A', pick: 'Wisp', hand: ['Wisp'], delay: 10 },
      { name: 'B', pick: 'Imp', hand: ['Imp'] },
    ]);
    await t.run();
    const order = t.events
      .filter((event) => event.type === 'choice:ready' || event.type === 'choice:revealed' || event.type === 'zone:changed')
      .map((event) => event.type);
    // Both ready, then the reveal, and only then do any cards move.
    expect(order.slice(0, 3)).toEqual(['choice:ready', 'choice:ready', 'choice:revealed']);
    expect(order.lastIndexOf('choice:revealed')).toBeLessThan(order.lastIndexOf('zone:changed'));
    for (const event of t.events.filter((e) => e.type === 'choice:ready')) {
      expect(Object.keys(event).sort()).toEqual(['player', 'type']);
    }
  });

  it('leaves a player with an empty hand out of the round', async () => {
    const t = await table(documentOf(chooseCard(true), reveal, discard), [
      { name: 'A', pick: 'Wisp', hand: ['Wisp'] },
      { name: 'B', pick: 'Imp', hand: [] },
    ]);
    await t.run();
    const [a, b] = t.players as [Picker, Picker];
    expect(b.asked).toEqual([]);
    expect(t.zoneNames('garbage', a)).toEqual(['Wisp']);
    expect(t.zoneNames('garbage', b)).toEqual([]);
  });

  it('asks an open round in turn order, with nothing to reveal', async () => {
    const t = await table(documentOf(chooseCard(false), discard), [
      { name: 'A', pick: 'Wisp', hand: ['Wisp'] },
      { name: 'B', pick: 'Imp', hand: ['Imp'] },
    ]);
    await t.run();
    expect(t.events.some((event) => event.type === 'choice:ready')).toBe(false);
    const [a, b] = t.players as [Picker, Picker];
    expect(t.zoneNames('garbage', a)).toEqual(['Wisp']);
    expect(t.zoneNames('garbage', b)).toEqual(['Imp']);
  });

  it('collects secret numbers and reveals them together', async () => {
    const roll: EffectIR = {
      kind: 'choose',
      round: 'card',
      players: 'each',
      secret: true,
      pick: { kind: 'number', min: n(1), max: n(6) },
    };
    const t = await table(documentOf(roll, reveal), [
      { name: 'A', pick: 4, hand: [], delay: 5 },
      { name: 'B', pick: 2, hand: [] },
    ]);
    await t.run();
    const revealed = t.events.find((event) => event.type === 'choice:revealed');
    const values =
      revealed?.type === 'choice:revealed'
        ? revealed.answers.map((entry) => (entry.answer.kind === 'number' ? entry.answer.value : -1))
        : [];
    expect(values).toEqual([4, 2]);
  });

  it('an out-of-range number forfeits the game for that player, at the reveal', async () => {
    const roll: EffectIR = {
      kind: 'choose',
      round: 'card',
      players: 'each',
      secret: true,
      pick: { kind: 'number', min: n(1), max: n(6) },
    };
    const t = await table(documentOf(roll, reveal), [
      { name: 'A', pick: 3, hand: [] },
      { name: 'B', pick: 9, hand: [] },
    ]);
    // B's commitment is invalid, so B loses and A, the only one standing, wins.
    const ended = await t.run().catch((error: unknown) => error);
    expect(ended).toBeInstanceOf(GameEndInterrupt);
    expect((ended as GameEndInterrupt).winners).toEqual([t.players[0]]);
    expect(t.events.some((event) => event.type === 'choice:forfeited')).toBe(true);
  });

  it('a vague commitment — naming no card — also loses, and its card is not moved', async () => {
    const t = await table(documentOf(chooseCard(true), reveal, discard), [
      { name: 'A', pick: 'Wisp', hand: ['Wisp'] },
      { name: 'B', pick: 'No such card', hand: ['Imp'] },
    ]);
    const ended = await t.run().catch((error: unknown) => error);
    expect(ended).toBeInstanceOf(GameEndInterrupt);
    expect((ended as GameEndInterrupt).winners).toEqual([t.players[0]]);
    expect(t.zoneNames('hand', t.players[1]!)).toEqual(['Imp']);
  });

  it('an open choice is still validated as it is made, and throws', async () => {
    const roll: EffectIR = {
      kind: 'choose',
      round: 'card',
      players: 'each',
      secret: false,
      pick: { kind: 'number', min: n(1), max: n(6) },
    };
    const t = await table(documentOf(roll), [{ name: 'A', pick: 9, hand: [] }]);
    await expect(t.run()).rejects.toThrow(/from 1 to 6/);
  });
});

describe('a choice round that a table could not play is refused', () => {
  it('a secret choice that is never revealed', () => {
    expect(validateRounds(documentOf(chooseCard(true)).abilities[0]!.steps)[0]).toMatchObject({
      severity: 'error',
      message: expect.stringMatching(/never revealed.*Add "When they are ready, reveal\."/),
    });
  });

  it('using a choice before it is revealed', () => {
    const issues = validateRounds(documentOf(chooseCard(true), discard, reveal).abilities[0]!.steps);
    expect(issues.map((issue) => issue.message).join(' ')).toMatch(/used before it is revealed/);
  });

  it('a reveal with nothing chosen, and a reveal of an open round', () => {
    expect(validateRounds(documentOf(reveal).abilities[0]!.steps)[0]!.message).toMatch(/nothing has been chosen/);
    expect(validateRounds(documentOf(chooseCard(false), reveal).abilities[0]!.steps)[0]!.message).toMatch(
      /Use "commits … face down"/,
    );
  });

  it('a double reveal', () => {
    const issues = validateRounds(documentOf(chooseCard(true), reveal, reveal).abilities[0]!.steps);
    expect(issues[0]!.message).toMatch(/revealed twice/);
  });

  it('warns, without failing, about a secret choice with one chooser', () => {
    const solo: EffectIR = { ...(chooseCard(true) as Extract<EffectIR, { kind: 'choose' }>), players: 'you' };
    const issues = validateRounds(documentOf(solo, reveal).abilities[0]!.steps);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning' });
    expect(() => bindFromJson(documentOf(solo, reveal))).not.toThrow();
  });

  it('binding throws on an error but not on a sound card', () => {
    expect(() => bindFromJson(documentOf(chooseCard(true)))).toThrow(/never revealed/);
    expect(() => bindFromJson(documentOf(chooseCard(true), reveal, discard))).not.toThrow();
  });

  it('the same checks cover a trigger', () => {
    const doc = documentOf(chooseCard(true), reveal, discard);
    const triggerDoc: DocumentIR = {
      ...doc,
      abilities: [],
      triggers: [
        {
          id: 't',
          name: 'T',
          event: { kind: 'turnStart' },
          steps: [{ effects: [chooseCard(true)] }],
        } as unknown as DocumentIR['triggers'][number],
      ],
    };
    expect(() => bindDocument(triggerDoc, { resolveBuff: () => undefined, aliases: ALIASES })).toThrow(
      /never revealed/,
    );
  });
});
