/**
 * `draw(player, count)` — move `count` cards from the top of a player's library
 * to that player's hand — as a function, as the language's `Draw(you, 2).`, and
 * as a game's own override with its edge rules.
 */
import { describe, expect, it } from 'vitest';
import { compileDocument, lowerDocument, parseDocument, renderDocument } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import { Character, Player, createEngine, type Decision, type Entity, type GameEvent } from '../src/games/turn-based/index.js';
import { PLAY } from '../src/engine/index.js';
import { createDraw, setEngineDraw } from '../src/games/cards/draw.js';
import { DECK, GARBAGE, HAND } from '../src/games/cards/zones.js';

class Card implements Entity {
  readonly type = 'card' as const;
  constructor(readonly name: string) {}
}

class Seat extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

async function table(deckSize: number, seats = 2, ability?: ReturnType<typeof compileDocument>['abilities'][number]) {
  const events: GameEvent[] = [];
  const engine = createEngine({ seed: 's', onEvent: (event: GameEvent) => events.push(event), roller: () => [3] });
  for (const zone of [DECK, HAND, GARBAGE, PLAY]) engine.zones.declare(zone);
  const players: Player[] = [];
  for (let i = 0; i < seats; i += 1) {
    const hero = new Character(`Hero ${i}`, {
      gauges: [{ id: 'hp', max: 30 }],
      skills: ability ? [{ name: ability.name, weight: 1, abilities: [ability] }] : [],
    });
    const player = new Seat(`P${i}`, [hero]);
    engine.registerPlayer(player);
    for (let n = 1; n <= deckSize; n += 1) await engine.addEntity(new Card(`c${n}`), DECK.id, { owner: player });
    players.push(player);
  }
  events.length = 0;
  const names = (zone: string, player: Player) =>
    engine.zones.members(zone, player).filter((m) => m.type === 'card').map((m) => m.name);
  return { engine, events, players, names };
}

describe('draw(player, count)', () => {
  it('moves the top cards, top first, into the hand', async () => {
    const { engine, players, names } = await table(5);
    const draw = createDraw(engine, { library: DECK.id, hand: HAND.id });
    await draw(players[0]!, 2);
    expect(names('hand', players[0]!)).toEqual(['c1', 'c2']);
    expect(names('deck', players[0]!)).toEqual(['c3', 'c4', 'c5']);
  });

  it('is a real move per card, so "when you draw" is answerable', async () => {
    const { engine, events, players } = await table(3);
    await createDraw(engine, { library: DECK.id, hand: HAND.id })(players[0]!, 2);
    const moves = events.filter((event) => event.type === 'zone:changed');
    expect(moves).toHaveLength(2);
  });

  it('draws for the player it is given and no one else', async () => {
    const { engine, players, names } = await table(3);
    await createDraw(engine, { library: DECK.id, hand: HAND.id })(players[1]!, 1);
    expect(names('hand', players[1]!)).toEqual(['c1']);
    expect(names('hand', players[0]!)).toEqual([]);
  });

  it('stops short on an empty library and tells the game once per missing card', async () => {
    const { engine, players, names } = await table(1);
    const empties: string[] = [];
    await createDraw(engine, { library: DECK.id, hand: HAND.id, onEmpty: (p) => void empties.push(p.name) })(players[0]!, 3);
    expect(names('hand', players[0]!)).toEqual(['c1']);
    expect(empties).toEqual(['P0', 'P0']);
  });

  it('sends a card that does not fit in a full hand to the overflow', async () => {
    const { engine, players, names } = await table(4);
    await createDraw(engine, { library: DECK.id, hand: HAND.id, maxHand: 2, overflow: GARBAGE.id })(players[0]!, 4);
    expect(names('hand', players[0]!)).toEqual(['c1', 'c2']);
    expect(names('garbage', players[0]!)).toEqual(['c3', 'c4']);
  });

  it('refuses a hand limit with nowhere for the extra card to go', async () => {
    const { engine } = await table(1);
    expect(() => createDraw(engine, { library: DECK.id, hand: HAND.id, maxHand: 2 })).toThrow(/overflow/);
  });
});

/* ------------------------------ the language ------------------------------ */

const ZONES = new ZoneDictionary([DECK.id, HAND.id]);
const BIND = { aliases: { library: DECK.id } };

function abilityOf(text: string, options: { draw?: Parameters<typeof setEngineDraw>[1] } = {}) {
  const compiled = compileDocument(text, { zones: ZONES, bind: { ...BIND, ...(options.draw ? { draw: options.draw } : {}) } });
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return compiled.abilities[0]!;
}

async function play(text: string, seats = 2) {
  const ability = abilityOf(text);
  const t = await table(5, seats, ability);
  await t.engine.useAbility(t.players[0]!.characters[0]!, ability, { targets: [] });
  return t;
}

describe('Draw(player, count) in English', () => {
  it('draws for you', async () => {
    const { players, names } = await play('Ability Study\nDraw(you, 2).');
    expect(names('hand', players[0]!)).toEqual(['c1', 'c2']);
    expect(names('hand', players[1]!)).toEqual([]);
  });

  it('draws for all players, and for all opponents', async () => {
    const all = await play('Ability Study\nDraw(all players, 1).');
    expect(all.names('hand', all.players[0]!)).toEqual(['c1']);
    expect(all.names('hand', all.players[1]!)).toEqual(['c1']);
    const others = await play('Ability Study\nDraw(all opponents, 2).');
    expect(others.names('hand', others.players[0]!)).toEqual([]);
    expect(others.names('hand', others.players[1]!)).toEqual(['c1', 'c2']);
  });

  it('takes any amount: a roll, or a stored value', async () => {
    const rolled = await play('Ability Study\nRoll a d6.\nDraw(you, that value).');
    expect(rolled.names('hand', rolled.players[0]!)).toEqual(['c1', 'c2', 'c3']); // the roller answers 3
    const stored = await play('Ability Study\nRoll a d6.\nStore that value as Pages.\nDraw(all opponents, Pages).');
    expect(stored.names('hand', stored.players[1]!)).toEqual(['c1', 'c2', 'c3']);
  });

  it('uses the draw a game registered for its engine, so its edge rules apply', async () => {
    const ability = abilityOf('Ability Study\nDraw(you, 2).');
    const t = await table(5, 2, ability);
    const calls: [number, string][] = [];
    setEngineDraw(t.engine, async (player, count) => void calls.push([count, player.name]));
    await t.engine.useAbility(t.players[0]!.characters[0]!, ability, { targets: [] });
    expect(calls).toEqual([[2, 'P0']]);
    expect(t.names('hand', t.players[0]!)).toEqual([]); // the override ran instead of the plain draw
  });

  it('prefers the host\'s draw over the engine\'s', async () => {
    const calls: string[] = [];
    const ability = abilityOf('Ability Study\nDraw(you, 1).', { draw: async (player) => void calls.push(`host ${player.name}`) });
    const t = await table(5, 2, ability);
    setEngineDraw(t.engine, async () => void calls.push('engine'));
    await t.engine.useAbility(t.players[0]!.characters[0]!, ability, { targets: [] });
    expect(calls).toEqual(['host P0']);
  });

  it('explains what it expects when it is written wrong', () => {
    const message = (text: string) => compileDocument(text, { zones: ZONES }).diagnostics[0]?.message ?? '';
    expect(message('Ability A\nDraw.')).toMatch(/takes a player and a number.*Draw\(you, 2\)/);
    expect(message('Ability A\nDraw(you).')).toMatch(/needs a number after the player/);
    expect(message('Ability A\nDraw(everyone, 2).')).toMatch(/"you", "all players" or "all opponents"/);
    expect(message('Ability A\nDraw(each cat, 2).')).toMatch(/"all" is followed by|the player is "you"/);
    expect(message('Ability A\nDraw(you, 2.')).toMatch(/expected "\)"/);
    expect(message('Ability A\nDraw(you, Nothing).')).toMatch(/"Nothing" has not been stored/);
    // The old order is named, not reported as a stray word.
    expect(message('Ability A\nDraw(2, you).')).toMatch(/the player comes first/);
    expect(message('Ability A\nDraw(that value, you).')).toMatch(/the player comes first/);
  });

  it('round-trips through the IR and renders as the function call', () => {
    const source = 'Ability Study\nDraw(you, 2).\nDraw(all players, 1).\nDraw(all opponents, 3).';
    const ir = lowerDocument(parseDocument(source, { zones: ZONES }).doc);
    expect(ir.abilities[0]!.steps.map((step) => step.effects[0])).toEqual([
      { kind: 'draw', count: { kind: 'const', value: 2 }, players: 'you' },
      { kind: 'draw', count: { kind: 'const', value: 1 }, players: 'each' },
      { kind: 'draw', count: { kind: 'const', value: 3 }, players: 'opponents' },
    ]);
    const { text, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    expect(text).toContain('Draw(you, 2).');
    expect(text).toContain('Draw(all players, 1).');
    expect(text).toContain('Draw(all opponents, 3).');
    expect(lowerDocument(parseDocument(text, { zones: ZONES }).doc).abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
  });
});
