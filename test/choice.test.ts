/**
 * The choice protocol (src/engine/choice.ts).
 *
 * The engine asks a **player** to decide things mid-resolution, and the
 * request names the chooser. These tests cover the routing (chooser, or the
 * host when nothing owns the decision), the validation every path is held
 * to, and the two kinds that ship: `select` and `confirm`.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  Player,
  AutoChooser,
  ScriptedChooser,
  autoChoose,
  buff,
  countRange,
  heal,
  prompt,
  validateAnswer,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Decision,
  type SelectRequest,
} from '../src/games/turn-based/index.js';
import { chosenCharacters } from '../src/engine/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';

const char = (name: string, hp = 100, current?: number): Character =>
  new Character(name, { maxHp: hp, maxMana: 10, ...(current !== undefined ? { hp: current } : {}) });

class Idle extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** A player that records what it was asked and answers from a script. */
class Recorder extends Player {
  readonly asked: ChoiceRequest[] = [];
  #answers: ChoiceAnswer[];
  constructor(name: string, characters: Character[], team: string, ...answers: ChoiceAnswer[]) {
    super(name, characters, team);
    this.#answers = answers;
  }
  async decide(): Promise<Decision[]> {
    return [];
  }
  override async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    this.asked.push(request);
    return this.#answers.shift() ?? autoChoose(request);
  }
}

/* ------------------------------- the pieces ---------------------------- */

describe('autoChoose', () => {
  it('takes the fewest a select allows', () => {
    const [a, b, c] = [char('A'), char('B'), char('C')];
    const request = (count: number | [number, number]): SelectRequest => ({
      kind: 'select',
      prompt: 'pick',
      chooser: undefined,
      options: [a, b, c],
      count,
    });
    expect(autoChoose(request(2))).toEqual({ kind: 'select', chosen: [a, b] });
    expect(autoChoose(request([0, 3]))).toEqual({ kind: 'select', chosen: [] });
    expect(autoChoose(request([1, 3]))).toEqual({ kind: 'select', chosen: [a] });
  });

  it('says yes to a confirm — a default that hides content is worse', () => {
    expect(autoChoose({ kind: 'confirm', prompt: 'may', chooser: undefined })).toEqual({
      kind: 'confirm',
      yes: true,
    });
  });
});

describe('countRange', () => {
  it('normalizes an exact count and a range', () => {
    expect(countRange(2)).toEqual([2, 2]);
    expect(countRange([0, 3])).toEqual([0, 3]);
  });
});

describe('validateAnswer', () => {
  const [a, b, c] = [char('A'), char('B'), char('C')];
  const stranger = char('Stranger');
  const request: SelectRequest = {
    kind: 'select',
    prompt: 'pick',
    chooser: undefined,
    options: [a, b, c],
    count: [1, 2],
  };

  it('accepts a legal answer', () => {
    expect(validateAnswer(request, { kind: 'select', chosen: [a, b] })).toBeUndefined();
  });

  it('rejects a pick outside the offered options', () => {
    expect(validateAnswer(request, { kind: 'select', chosen: [stranger] })).toMatch(
      /outside its targeting pattern: "Stranger"/,
    );
  });

  it('rejects too many, and duplicates', () => {
    expect(validateAnswer(request, { kind: 'select', chosen: [a, b, c] })).toMatch(/at most 2/);
    expect(validateAnswer(request, { kind: 'select', chosen: [a, a] })).toMatch(/more than once/);
  });

  it('allows fewer than the minimum only when there were not enough options', () => {
    expect(validateAnswer(request, { kind: 'select', chosen: [] })).toMatch(/at least 1/);
    const thin: SelectRequest = { ...request, options: [], count: 2 };
    // "Choose 2" with nothing legal to choose picks nothing, legally.
    expect(validateAnswer(thin, { kind: 'select', chosen: [] })).toBeUndefined();
  });

  it('rejects an answer of the wrong kind', () => {
    expect(validateAnswer(request, { kind: 'confirm', yes: true })).toMatch(/expected a "select"/);
  });
});

/* -------------------------------- routing ------------------------------ */

describe('the engine asks the chooser', () => {
  /** A prompt-triggered ability: asks which ally to heal at turn start. */
  const inspire = buff({
    name: 'War Cry',
    weight: 1,
    abilities: [
      prompt({
        name: 'Inspire',
        event: 'turn:start',
        prompt: () => ({ who: 'ally', count: 1, match: (ctx, c) => c !== ctx.self }),
        cast: (ctx, targeting) => (targeting.targets[0] ? [heal(targeting.targets[0].gauge('hp'), 20, ctx.self)] : []),
      }),
    ],
  });

  it("routes to the owner's controller, naming it as the chooser", async () => {
    const hero = char('Hero');
    const paladin = char('Paladin', 100, 40);
    const you = new Recorder('You', [hero, paladin], 'party', { kind: 'select', chosen: [paladin] });
    const engine = createEngine({ seed: 'choice' });
    engine.registerPlayers([you, new Idle('Them', [char('Foe')], 'foes')]);

    await engine.addBuff(hero, inspire);
    await startTurn(engine);

    expect(you.asked).toHaveLength(1);
    const request = you.asked[0]!;
    expect(request.kind).toBe('select');
    expect(request.prompt).toBe('Inspire');
    expect(request.chooser).toBe(you); // the chooser is named, never implied
    expect(request.kind === 'select' ? request.options : []).toEqual([paladin]);
    expect(paladin.gauge('hp').current).toBe(60);
  });

  it('rejects a chooser that answers outside its options', async () => {
    const hero = char('Hero');
    const paladin = char('Paladin', 100, 40);
    const foe = char('Foe');
    const you = new Recorder('You', [hero, paladin], 'party', { kind: 'select', chosen: [foe] });
    const engine = createEngine({ seed: 'choice' });
    engine.registerPlayers([you, new Idle('Them', [foe], 'foes')]);

    await engine.addBuff(hero, inspire);
    // The same guard a remote client would hit — validation is the engine's,
    // not the chooser's.
    await expect(startTurn(engine)).rejects.toThrow(/outside its targeting pattern/);
  });

  it('falls back to the host when nothing owns the decision', async () => {
    // No players registered, so the characters have no controller and
    // there is nobody to ask — the engine's own `chooser` answers.
    const hero = char('Hero');
    const paladin = char('Paladin', 100, 40);
    hero.team = 'party';
    paladin.team = 'party';
    const engine = createEngine({ seed: 'choice', chooser: ScriptedChooser.selects([paladin]) });
    engine.registerCharacter(hero);
    engine.registerCharacter(paladin);

    await engine.addBuff(hero, inspire);
    await startTurn(engine);
    expect(paladin.gauge('hp').current).toBe(60);
  });

  it('a player with no override answers automatically', async () => {
    const hero = char('Hero');
    const paladin = char('Paladin', 100, 40);
    const you = new Idle('You', [hero, paladin], 'party');
    const engine = createEngine({ seed: 'choice' });
    engine.registerPlayers([you, new Idle('Them', [char('Foe')], 'foes')]);

    await engine.addBuff(hero, inspire);
    await startTurn(engine);
    // The base `choose` took the only legal option — no host involved.
    expect(paladin.gauge('hp').current).toBe(60);
  });
});

/* ---------------------------- scripted chooser ------------------------- */

describe('ScriptedChooser', () => {
  it('answers in order and complains when it runs dry', async () => {
    const [a, b] = [char('A'), char('B')];
    const chooser = ScriptedChooser.selects([a], [b]);
    const request: SelectRequest = {
      kind: 'select',
      prompt: 'pick',
      chooser: undefined,
      options: [a, b],
      count: 1,
    };
    expect(await chooser.choose(request)).toEqual({ kind: 'select', chosen: [a] });
    expect(await chooser.choose(request)).toEqual({ kind: 'select', chosen: [b] });
    await expect(chooser.choose(request)).rejects.toThrow(/no more scripted answers/);
  });
});

/* --------------------------- the default chooser ----------------------- */

describe('AutoChooser', () => {
  it('is the engine default, and takes the first valid targets', async () => {
    const engine = createEngine();
    const [a, b, c] = [char('A', 10), char('B', 10), char('C', 10)];
    for (const entity of [a, b, c]) engine.registerCharacter(entity);
    const answer = await new AutoChooser().choose({
      kind: 'select',
      prompt: 'choose',
      chooser: undefined,
      options: engine.validTargets({ who: 'enemy' }, a),
      count: 2,
    });
    expect(answer.kind === 'select' ? answer.chosen.map((t) => t.name) : []).toEqual(['B', 'C']);
  });
});

describe('select over entities that are not characters', () => {
  const card = (name: string) => ({ type: 'card', name });
  const [x, y, z] = [card('X'), card('Y'), card('Z')];
  const request: SelectRequest = {
    kind: 'select',
    prompt: 'Choose a card',
    chooser: undefined,
    options: [x, y, z],
    count: 1,
  };

  it('accepts a hand card as an option and rejects one that was not offered', () => {
    expect(validateAnswer(request, { kind: 'select', chosen: [y] })).toBeUndefined();
    expect(validateAnswer(request, { kind: 'select', chosen: [card('W')] })).toMatch(/outside/);
  });

  it('auto-chooses the fewest from the options', () => {
    expect(autoChoose(request)).toEqual({ kind: 'select', chosen: [x] });
  });

  it('chosenCharacters keeps characters and drops everything else', () => {
    const hero = new Character('Hero', { maxHp: 10 });
    expect(chosenCharacters({ kind: 'select', chosen: [x, hero] })).toEqual([hero]);
    expect(chosenCharacters({ kind: 'confirm', yes: true })).toEqual([]);
  });
});

describe('number requests', () => {
  const request: ChoiceRequest = { kind: 'number', prompt: 'Pick', chooser: undefined, min: 1, max: 6 };

  it('accepts every integer in range, inclusive', () => {
    for (const value of [1, 3, 6]) {
      expect(validateAnswer(request, { kind: 'number', value })).toBeUndefined();
    }
  });

  it('rejects out of range and non-integers', () => {
    expect(validateAnswer(request, { kind: 'number', value: 0 })).toMatch(/from 1 to 6/);
    expect(validateAnswer(request, { kind: 'number', value: 7 })).toMatch(/from 1 to 6/);
    expect(validateAnswer(request, { kind: 'number', value: 2.5 })).toMatch(/whole number/);
    expect(validateAnswer(request, { kind: 'number', value: Number.NaN })).toMatch(/whole number/);
  });

  it('rejects an answer of the wrong kind', () => {
    expect(validateAnswer(request, { kind: 'confirm', yes: true })).toMatch(/expected a "number"/);
    expect(validateAnswer({ kind: 'confirm', prompt: 'p', chooser: undefined }, { kind: 'number', value: 1 })).toMatch(
      /expected a "confirm"/,
    );
  });

  it('auto-chooses the lowest legal number', () => {
    expect(autoChoose(request)).toEqual({ kind: 'number', value: 1 });
  });

  it('is routed through the engine and validated there', async () => {
    const engine = new GameEngine({ chooser: ScriptedChooser.numbers(4, 9) });
    expect(await engine.ask(request)).toEqual({ kind: 'number', value: 4 });
    await expect(engine.ask(request)).rejects.toThrow(/from 1 to 6/);
  });
});
