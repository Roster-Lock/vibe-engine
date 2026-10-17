/**
 * Sealed rounds — "everyone chooses in secret, then reveal"
 * (docs/design/20-secret-choices-and-dice.md).
 */
import { describe, expect, it } from 'vitest';
import {
  GameEngine,
  Player,
  markersFor,
  pickById,
  resolveLabel,
  resolveWritten,
  validateAnswer,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Decision,
  type GameEvent,
} from '../src/engine/index.js';

/** Answers a number after `delay` ms, so arrival order differs from list order. */
class SlowPlayer extends Player {
  constructor(name: string, private readonly value: number, private readonly delay: number) {
    super(name, []);
  }

  async decide(): Promise<Decision[]> {
    return [];
  }

  override async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    await new Promise((resolve) => setTimeout(resolve, this.delay));
    return request.kind === 'number' ? { kind: 'number', value: this.value } : { kind: 'confirm', yes: true };
  }
}

const ask = (player: Player): ChoiceRequest => ({
  kind: 'number',
  prompt: 'Pick 1-6',
  chooser: player,
  min: 1,
  max: 6,
});

function setup() {
  const a = new SlowPlayer('A', 3, 20);
  const b = new SlowPlayer('B', 5, 1);
  const c = new SlowPlayer('C', 2, 1);
  const events: GameEvent[] = [];
  const engine = new GameEngine({ onEvent: (event: GameEvent) => events.push(event) });
  return { a, b, c, engine, events };
}

describe('sealed round', () => {
  it('holds every answer until the reveal', async () => {
    const { a, b, engine } = setup();
    const round = await engine.askAll([ask(a), ask(b)], { sealed: true });
    expect(round.ready).toBe(true);
    expect(round.revealed).toBe(false);
    expect(() => round.answerOf(a)).toThrow(/sealed/);
    expect(() => round.answers).toThrow(/sealed/);
    await engine.revealRound(round);
    expect(round.answerOf(a)).toEqual({ kind: 'number', value: 3 });
    expect(round.answerOf(b)).toEqual({ kind: 'number', value: 5 });
  });

  it('announces readiness without content, then every answer at once', async () => {
    const { a, b, engine, events } = setup();
    const round = await engine.askAll([ask(a), ask(b)], { sealed: true });
    const ready = events.filter((event) => event.type === 'choice:ready');
    // B answers first, but nothing about the value is in the event.
    expect(ready.map((event) => (event as { player: Player }).player)).toEqual([b, a]);
    expect(JSON.stringify(ready.map((event) => Object.keys(event)))).not.toMatch(/answer|value/);
    expect(events.some((event) => event.type === 'choice:revealed')).toBe(false);

    await engine.revealRound(round);
    const revealed = events.find((event) => event.type === 'choice:revealed');
    expect(revealed?.type === 'choice:revealed' ? revealed.answers : []).toHaveLength(2);
  });

  it('lists answers in chooser order, whatever order they arrived in', async () => {
    const { a, b, engine } = setup();
    const round = await engine.askAll([ask(a), ask(b)], { sealed: true });
    await engine.revealRound(round);
    expect(round.answers.map((entry) => entry.player)).toEqual([a, b]);
  });

  it('waits only for the players it asked', async () => {
    const { a, b, c, engine } = setup();
    const round = await engine.askAll([ask(b), ask(c)], { sealed: true });
    await engine.revealRound(round);
    expect(() => round.answerOf(a)).toThrow(/not part of this round/);
  });

  it('judges a commitment at the reveal, not when it arrives', async () => {
    const { b, engine, events } = setup();
    const bad = new SlowPlayer('Bad', 9, 1);
    // Placing it face down does not throw: nobody can tell yet.
    const round = await engine.askAll([ask(bad), ask(b)], { sealed: true });
    expect(round.ready).toBe(true);
    expect(() => round.forfeited).toThrow(/sealed/);

    const forfeited = await engine.revealRound(round);
    expect(forfeited.map((entry) => entry.player)).toEqual([bad]);
    expect(forfeited[0]!.reason).toMatch(/invalid commitment.*from 1 to 6/);
    // The valid answers are revealed; the forfeit is announced separately.
    expect(round.answers.map((entry) => entry.player)).toEqual([b]);
    expect(() => round.answerOf(bad)).toThrow(/no valid answer/);
    expect(events.some((event) => event.type === 'choice:forfeited')).toBe(true);
  });

  it('treats a vague commitment — an answer that names nothing — as invalid', async () => {
    const { a, engine } = setup();
    const vague = new (class extends SlowPlayer {
      override async choose(): Promise<ChoiceAnswer> {
        return { kind: 'select', chosen: [] };
      }
    })('Vague', 1, 0);
    const pick: ChoiceRequest = {
      kind: 'select',
      prompt: 'Pick a card',
      chooser: vague,
      options: [{ type: 'card', name: 'X' }],
      count: 1,
    };
    const round = await engine.askAll([pick, ask(a)], { sealed: true });
    const forfeited = await engine.revealRound(round);
    expect(forfeited.map((entry) => entry.player)).toEqual([vague]);
    expect(forfeited[0]!.reason).toMatch(/at least 1/);
  });

  it('treats an answer of the wrong kind as invalid', async () => {
    const { engine } = setup();
    const wrong = new (class extends SlowPlayer {
      override async choose(): Promise<ChoiceAnswer> {
        return { kind: 'confirm', yes: true };
      }
    })('Wrong', 1, 0);
    const round = await engine.askAll([ask(wrong)], { sealed: true });
    expect((await engine.revealRound(round))[0]!.reason).toMatch(/expected a "number" answer/);
  });

  it('forfeits a player who tries to change a commitment', async () => {
    const { a, b, engine } = setup();
    const round = await engine.askAll([ask(a), ask(b)], { sealed: true });
    round._commit(a, { kind: 'number', value: 1 }); // a second, different answer
    const forfeited = await engine.revealRound(round);
    expect(forfeited).toHaveLength(1);
    expect(forfeited[0]!.player).toBe(a);
    expect(forfeited[0]!.reason).toMatch(/change a commitment/);
  });

  it('still validates an open round as the answers are made', async () => {
    const { engine } = setup();
    const bad = new SlowPlayer('Bad', 9, 1);
    await expect(engine.askAll([ask(bad)], { sealed: false })).rejects.toThrow(/from 1 to 6/);
  });

  it('refuses a missing chooser and a repeated player in a sealed round', async () => {
    const { a, engine } = setup();
    await expect(
      engine.askAll([{ kind: 'number', prompt: 'p', chooser: undefined, min: 1, max: 6 }], { sealed: true }),
    ).rejects.toThrow(/needs a chooser/);
    await expect(engine.askAll([ask(a), ask(a)], { sealed: true })).rejects.toThrow(/only once/);
  });

  it('cannot be revealed twice', async () => {
    const { a, engine } = setup();
    const round = await engine.askAll([ask(a)], { sealed: true });
    await engine.revealRound(round);
    await expect(engine.revealRound(round)).rejects.toThrow(/already revealed/);
  });

  it('an open round asks in order and comes back revealed', async () => {
    const { a, b, engine, events } = setup();
    const order: string[] = [];
    const watch = (player: Player) => {
      const original = player.choose.bind(player);
      player.choose = async (request) => {
        order.push(player.name);
        return original(request);
      };
    };
    watch(a);
    watch(b);
    const round = await engine.askAll([ask(a), ask(b)], { sealed: false });
    expect(order).toEqual(['A', 'B']);
    expect(round.revealed).toBe(true);
    expect(round.answerOf(b)).toEqual({ kind: 'number', value: 5 });
    expect(events.some((event) => event.type === 'choice:ready')).toBe(false);
  });
});

/* --------------------- look-alikes: markers and vague answers -------------------- */

const goblinA = { type: 'card', name: 'Goblin' };
const goblinB = { type: 'card', name: 'Goblin' };
const imp = { type: 'card', name: 'Imp' };

/** A player who writes down a fixed value. */
class Writer extends SlowPlayer {
  constructor(name: string, private readonly text: string) {
    super(name, 0, 0);
  }
  override async choose(): Promise<ChoiceAnswer> {
    return { kind: 'written', text: this.text };
  }
}

describe('markers tell look-alikes apart', () => {
  it('keeps a unique name and lettered markers for duplicates, in option order', () => {
    const markers = markersFor([goblinA, imp, goblinB]);
    expect(markers.get(imp)).toBe('Imp');
    expect(markers.get(goblinA)).toBe('Goblin (A)');
    expect(markers.get(goblinB)).toBe('Goblin (B)');
  });

  it('prefers an explicit marker when it is unique', () => {
    const one = { type: 'card', name: 'Goblin', marker: '1' };
    const two = { type: 'card', name: 'Goblin', marker: '2' };
    const markers = markersFor([one, two]);
    expect([markers.get(one), markers.get(two)]).toEqual(['1', '2']);
  });

  it('still letters two options that share the same marker', () => {
    const x = { type: 'card', name: 'Goblin', marker: '7' };
    const y = { type: 'card', name: 'Orc', marker: '7' };
    expect([...markersFor([x, y]).values()]).toEqual(['7 (A)', '7 (B)']);
  });
});

describe('a written value must name exactly one option', () => {
  const options = [goblinA, imp, goblinB];

  it('resolves a full marker or a unique name exactly, ignoring only surrounding space', () => {
    expect(resolveWritten(options, 'Goblin (B)')).toEqual({ chosen: [goblinB] });
    expect(resolveWritten(options, '  Imp ')).toEqual({ chosen: [imp] });
  });

  it('matches case exactly: options are picked from a list, not typed', () => {
    expect(resolveWritten(options, 'imp')).toEqual({ problem: expect.stringMatching(/not one of the options/) });
    expect(resolveWritten(options, 'goblin (b)')).toEqual({ problem: expect.stringMatching(/not one of the options/) });
    expect(resolveLabel(['Attack', 'Retreat'], 'attack')).toEqual({ problem: expect.stringMatching(/not one of "Attack", "Retreat"/) });
    expect(resolveLabel(['Attack', 'Retreat'], ' Attack ')).toEqual({ value: 'Attack' });
  });

  it('calls a shared bare name vague and lists the ways to write it', () => {
    const result = resolveWritten(options, 'Goblin');
    expect('problem' in result && result.problem).toMatch(/could be 2 different options.*Goblin \(A\).*Goblin \(B\).*vague/);
  });

  it('calls an unknown name and an empty slip invalid', () => {
    expect(resolveWritten(options, 'Dragon')).toEqual({ problem: expect.stringMatching(/not one of the options/) });
    expect(resolveWritten(options, '   ')).toEqual({ problem: 'wrote nothing' });
  });

  it('validates as a pick of the option it names would', () => {
    const request: ChoiceRequest = { kind: 'select', prompt: 'p', chooser: undefined, options, count: 1 };
    expect(validateAnswer(request, { kind: 'written', text: 'Goblin (A)' })).toBeUndefined();
    expect(validateAnswer(request, { kind: 'written', text: 'Goblin' })).toMatch(/vague/);
  });

  it('forfeits a vague commitment at the reveal, and accepts a marked one', async () => {
    const { engine } = setup();
    const vague = new Writer('Vague', 'Goblin');
    const marked = new Writer('Marked', 'Goblin (B)');
    const pick = (chooser: Player): ChoiceRequest => ({
      kind: 'select',
      prompt: 'Pick a card',
      chooser,
      options: [goblinA, imp, goblinB],
      count: 1,
      markers: markersFor([goblinA, imp, goblinB]),
    });
    const round = await engine.askAll([pick(vague), pick(marked)], { sealed: true });
    const forfeited = await engine.revealRound(round);
    expect(forfeited.map((entry) => entry.player)).toEqual([vague]);
    expect(forfeited[0]!.reason).toMatch(/vague/);
    // The marked one resolved to the second goblin, as an ordinary pick.
    expect(round.answerOf(marked)).toEqual({ kind: 'select', chosen: [goblinB] });
  });

  it('resolves a written value in an open choice on the spot', async () => {
    const { engine } = setup();
    const writer = new Writer('Open', 'Imp');
    const answer = await engine.ask({ kind: 'select', prompt: 'p', chooser: writer, options: [goblinA, imp], count: 1 });
    expect(answer).toEqual({ kind: 'select', chosen: [imp] });
  });
});

describe('a card is chosen by its id', () => {
  const g1 = { type: 'card', name: 'Goblin', id: 'c-17' };
  const g2 = { type: 'card', name: 'Goblin', id: 'c-42' };
  const options = [g1, imp, g2];

  it('an id names exactly one option, even among look-alikes', () => {
    expect(resolveWritten(options, 'c-42')).toEqual({ chosen: [g2] });
    expect(resolveWritten(options, pickById('c-17').text)).toEqual({ chosen: [g1] });
  });

  it('uses the id as the marker that tells look-alikes apart', () => {
    const markers = markersFor(options);
    expect(markers.get(g1)).toBe('Goblin (c-17)');
    expect(markers.get(g2)).toBe('Goblin (c-42)');
    expect(markers.get(imp)).toBe('Imp');
  });

  it('a committed id is never vague, and an unknown id is invalid', async () => {
    const { engine } = setup();
    const pick = (chooser: Player): ChoiceRequest => ({ kind: 'select', prompt: 'p', chooser, options, count: 1 });
    const good = new (class extends SlowPlayer {
      override async choose(): Promise<ChoiceAnswer> {
        return pickById('c-42');
      }
    })('Good', 1, 0);
    const bad = new (class extends SlowPlayer {
      override async choose(): Promise<ChoiceAnswer> {
        return pickById('c-999');
      }
    })('Bad', 1, 0);
    const round = await engine.askAll([pick(good), pick(bad)], { sealed: true });
    const forfeited = await engine.revealRound(round);
    expect(forfeited.map((entry) => entry.player)).toEqual([bad]);
    expect(round.answerOf(good)).toEqual({ kind: 'select', chosen: [g2] });
  });

  it('refuses a request whose options share an id', async () => {
    const { a, engine } = setup();
    const twin = { type: 'card', name: 'Goblin', id: 'c-17' };
    await expect(
      engine.askAll([{ kind: 'select', prompt: 'Pick', chooser: a, options: [g1, twin], count: 1 }], { sealed: true }),
    ).rejects.toThrow(/more than one option with the id "c-17"/);
  });
});
