/**
 * Votes (docs/design/20-secret-choices-and-dice.md): a `choose` over labelled
 * options, with five ways to order it —
 *
 * - commit / reveal (everyone at once, face down),
 * - the caster goes first,
 * - the caster goes last,
 * - a randomly chosen player goes first,
 * - reverse order (the seating backwards; the caster's seat plays no part).
 *
 * This file holds the IR to account; `vote-english.test.ts` holds the wording.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEndInterrupt,
  Player,
  createEngine,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { bindDocument, type ChooseOrderIR, type DocumentIR, type EffectIR } from '../src/ir/index.js';

/** Votes for a fixed option, and records the order in which the table was asked. */
class Voter extends Player {
  constructor(
    name: string,
    characters: readonly Character[],
    private readonly vote: string,
    private readonly log: string[],
    private readonly seen: Map<string, string[]>,
  ) {
    super(name, characters);
  }
  async decide(): Promise<Decision[]> {
    return [];
  }
  override async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    this.log.push(this.name);
    if (request.kind === 'label') {
      this.seen.set(this.name, (request.prior ?? []).map((p) => `${p.player.name}:${p.option}`));
      return { kind: 'label', value: this.vote };
    }
    return { kind: 'confirm', yes: true };
  }
}

const OPTIONS = ['Attack', 'Retreat'];

function vote(order: ChooseOrderIR | undefined, secret = false): EffectIR {
  return {
    kind: 'choose',
    round: 'choice',
    players: 'each',
    secret,
    pick: { kind: 'label', options: OPTIONS },
    ...(order ? { order } : {}),
  };
}

const reveal: EffectIR = { kind: 'reveal', round: 'choice' };
const dealVotes = (option: string): EffectIR => ({
  kind: 'gauge',
  query: { kind: 'self' },
  gauge: { kind: 'life' },
  op: 'subtract',
  amount: { kind: 'votes', option },
});

function documentOf(...effects: EffectIR[]): DocumentIR {
  return {
    version: 1,
    imports: [],
    buffs: [],
    triggers: [],
    abilities: [
      {
        id: 'vote',
        name: 'Vote',
        targeting: { who: 'self', count: 1 },
        steps: effects.map((effect) => ({ effects: [effect] })),
      },
    ],
  };
}

/** Four seats, A to D in seating order; `caster` (an index) uses the ability. */
async function table(
  document: DocumentIR,
  votes: readonly string[],
  options: { caster?: number; dice?: readonly number[] } = {},
) {
  const ability = bindDocument(JSON.parse(JSON.stringify(document)) as DocumentIR, {
    resolveBuff: () => undefined,
  }).abilities[0]!;
  const log: string[] = [];
  const seen = new Map<string, string[]>();
  const events: GameEvent[] = [];
  let next = 0;
  const engine = createEngine({
    seed: 's',
    onEvent: (event: GameEvent) => events.push(event),
    roller: () => [options.dice?.[next++] ?? 1],
  });
  const players: Voter[] = [];
  const heroes: Character[] = [];
  for (const [index, name] of ['A', 'B', 'C', 'D'].entries()) {
    const hero = new Character(`${name}'s hero`, {
      gauges: [{ id: 'hp', max: 100 }],
      skills: [{ name: 'Vote', weight: 1, abilities: [ability] }],
    });
    const player = new Voter(name, [hero], votes[index]!, log, seen);
    engine.registerPlayer(player);
    players.push(player);
    heroes.push(hero);
  }
  const caster = options.caster ?? 0;
  let ended: unknown;
  try {
    await engine.useAbility(heroes[caster]!, ability, { targets: [] });
  } catch (error) {
    ended = error;
  }
  return { log, seen, events, players, heroes, hp: (i: number) => heroes[i]!.findGauge('hp')!.current, ended };
}

const ALL_ATTACK = ['Attack', 'Attack', 'Attack', 'Attack'];

describe('the order an open vote is asked in', () => {
  it('caster first goes round the table from the caster', async () => {
    expect((await table(documentOf(vote('caster-first')), ALL_ATTACK, { caster: 2 })).log).toEqual(['C', 'D', 'A', 'B']);
  });

  it('defaults to caster first', async () => {
    expect((await table(documentOf(vote(undefined)), ALL_ATTACK, { caster: 1 })).log).toEqual(['B', 'C', 'D', 'A']);
  });

  it('caster last ends with the caster', async () => {
    expect((await table(documentOf(vote('caster-last')), ALL_ATTACK, { caster: 2 })).log).toEqual(['D', 'A', 'B', 'C']);
    expect((await table(documentOf(vote('caster-last')), ALL_ATTACK, { caster: 0 })).log).toEqual(['B', 'C', 'D', 'A']);
  });

  it('reverse order is the seating backwards, wherever the caster sits', async () => {
    expect((await table(documentOf(vote('reverse')), ALL_ATTACK, { caster: 0 })).log).toEqual(['D', 'C', 'B', 'A']);
    expect((await table(documentOf(vote('reverse')), ALL_ATTACK, { caster: 2 })).log).toEqual(['D', 'C', 'B', 'A']);
  });

  it('a random start is a real die roll with a face per seat, then round the table', async () => {
    const one = await table(documentOf(vote('random')), ALL_ATTACK, { dice: [3] });
    expect(one.log).toEqual(['C', 'D', 'A', 'B']);
    const made = one.events.find((event) => event.type === 'roll:made');
    expect(made).toMatchObject({ type: 'roll:made', count: 1, sides: 4, results: [3] });
    expect((await table(documentOf(vote('random')), ALL_ATTACK, { dice: [1] })).log).toEqual(['A', 'B', 'C', 'D']);
    expect((await table(documentOf(vote('random')), ALL_ATTACK, { dice: [4] })).log).toEqual(['D', 'A', 'B', 'C']);
  });

  it('only a random start rolls', async () => {
    for (const order of ['caster-first', 'caster-last', 'reverse'] as const) {
      const out = await table(documentOf(vote(order)), ALL_ATTACK);
      expect(out.events.some((event) => event.type === 'roll:made')).toBe(false);
    }
  });

  it('shows each voter the votes already cast, and an open vote has no ready phase', async () => {
    const out = await table(documentOf(vote('caster-first')), ['Attack', 'Retreat', 'Attack', 'Retreat']);
    expect(out.seen.get('A')).toEqual([]);
    expect(out.seen.get('B')).toEqual(['A:Attack']);
    expect(out.seen.get('D')).toEqual(['A:Attack', 'B:Retreat', 'C:Attack']);
    expect(out.events.some((event) => event.type === 'choice:ready')).toBe(false);
  });
});

describe('commit / reveal votes', () => {
  it('asks everyone, announces only readiness, then reveals together', async () => {
    const out = await table(documentOf(vote(undefined, true), reveal), ['Attack', 'Retreat', 'Attack', 'Retreat']);
    const kinds = out.events.map((event) => event.type).filter((type) => type.startsWith('choice:'));
    expect(kinds).toEqual(['choice:ready', 'choice:ready', 'choice:ready', 'choice:ready', 'choice:revealed']);
    for (const event of out.events.filter((e) => e.type === 'choice:ready')) {
      expect(Object.keys(event).sort()).toEqual(['player', 'type']);
    }
  });

  it('shows no one the earlier commitments', async () => {
    const out = await table(documentOf(vote(undefined, true), reveal), ALL_ATTACK);
    for (const prior of out.seen.values()) expect(prior).toEqual([]);
  });

  it('ignores an order, since everyone answers at once', async () => {
    const out = await table(documentOf(vote('random', true), reveal), ALL_ATTACK);
    expect(out.events.some((event) => event.type === 'roll:made')).toBe(false);
  });

  it('forfeits a commitment that is not one of the options, found at the reveal', async () => {
    const out = await table(documentOf(vote(undefined, true), reveal), ['Attack', 'Attack', 'Maybe', 'Attack']);
    // C wrote something that is not on the ballot, so C loses and the others play on.
    const forfeit = out.events.find((event) => event.type === 'choice:forfeited');
    expect(forfeit).toMatchObject({ type: 'choice:forfeited' });
    expect(out.ended).not.toBeInstanceOf(Error); // three players remain: the game does not end
  });
});

describe('counting a vote', () => {
  it('counts the votes for each option', async () => {
    const out = await table(documentOf(vote('caster-first'), dealVotes('Attack')), ['Attack', 'Retreat', 'Attack', 'Attack']);
    expect(out.hp(0)).toBe(97);
    const retreat = await table(documentOf(vote('caster-first'), dealVotes('Retreat')), ['Attack', 'Retreat', 'Attack', 'Attack']);
    expect(retreat.hp(0)).toBe(99);
  });

  it('counts a sealed vote only after the reveal', async () => {
    const out = await table(documentOf(vote(undefined, true), reveal, dealVotes('Attack')), ['Attack', 'Attack', 'Retreat', 'Attack']);
    expect(out.hp(0)).toBe(97);
  });

  it('refuses to count a sealed vote before it is revealed', async () => {
    const out = await table(documentOf(vote(undefined, true), dealVotes('Attack'), reveal), ALL_ATTACK);
    expect(out.ended).toBeInstanceOf(Error);
    expect((out.ended as Error).message).toMatch(/never revealed|before it is revealed|still sealed/);
  });

  it('reads 0 for an option nobody voted for, and when nothing has been voted on', async () => {
    expect((await table(documentOf(vote('caster-first'), dealVotes('Retreat')), ALL_ATTACK)).hp(0)).toBe(100);
    expect((await table(documentOf(dealVotes('Attack')), ALL_ATTACK)).hp(0)).toBe(100);
  });

  it('does not count a forfeited commitment', async () => {
    const out = await table(documentOf(vote(undefined, true), reveal, dealVotes('Attack')), ['Attack', 'Attack', 'Nonsense', 'Attack']);
    // C forfeits and loses; A, B and D voted, so the count is three.
    expect(out.hp(0)).toBe(97);
  });
});

describe('a vote needs something to choose between', () => {
  it('refuses fewer than two options, or the same option twice', async () => {
    const one: EffectIR = { ...(vote('caster-first') as Extract<EffectIR, { kind: 'choose' }>), pick: { kind: 'label', options: ['Only'] } };
    expect((await table(documentOf(one), ALL_ATTACK)).ended).toBeInstanceOf(Error);
    const twin: EffectIR = { ...(vote('caster-first') as Extract<EffectIR, { kind: 'choose' }>), pick: { kind: 'label', options: ['Same', 'Same'] } };
    expect(((await table(documentOf(twin), ALL_ATTACK)).ended as Error).message).toMatch(/at least two different options/);
  });
});

void GameEndInterrupt;
