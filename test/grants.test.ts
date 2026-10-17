/**
 * Grants (docs/design/20-secret-choices-and-dice.md, "Who may act on a card"):
 * permission on one card for some players, with a lifetime and a source.
 *
 * Permission to act is NOT permission to see — a capability implies nothing
 * unless the game declares it does.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  Player,
  createEngine,
  type Decision,
  type Entity,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { PLAY } from '../src/engine/index.js';

class Seat extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

class Card implements Entity {
  readonly type = 'card' as const;
  constructor(readonly name: string) {}
}

async function table() {
  const events: GameEvent[] = [];
  const engine = createEngine({ seed: 's', onEvent: (event: GameEvent) => events.push(event) });
  engine.zones.declare(PLAY);
  engine.zones.declare({ id: 'exile', visibility: 'hidden', scope: 'per-player' });
  engine.zones.declare({ id: 'pile', visibility: 'hidden', scope: 'per-player' });
  const [ann, bo, cy] = ['Ann', 'Bo', 'Cy'].map(
    (name) => new Seat(name, [new Character(`${name} hero`, { gauges: [{ id: 'hp', max: 10 }] })]),
  ) as [Seat, Seat, Seat];
  for (const seat of [ann, bo, cy]) engine.registerPlayer(seat);
  const present = new Card('Present');
  await engine.addEntity(present, 'exile', { owner: ann });
  events.length = 0;
  return { engine, events, ann, bo, cy, present };
}

describe('declared capabilities', () => {
  it('refuses to grant a capability nobody declared', async () => {
    const { engine, bo, present } = await table();
    expect(() => engine.grant(present, [bo], 'cast')).toThrow(/not a declared capability/);
  });

  it('knows "see" without being told', async () => {
    const { engine, bo, present } = await table();
    engine.grant(present, [bo], 'see');
    expect(engine.canSee(bo, present)).toBe(true);
  });

  it('re-declaring the same shape is fine, a different one is not', async () => {
    const { engine } = await table();
    engine.declareCapability('cast');
    engine.declareCapability('cast');
    expect(() => engine.declareCapability('cast', { implies: ['see'] })).toThrow(/different shape/);
  });

  it('an implied capability must be declared first', async () => {
    const { engine } = await table();
    expect(() => engine.declareCapability('peek', { implies: ['nonsense'] })).toThrow(/not declared yet/);
  });
});

describe('permission to act does not imply sight', () => {
  it('a cast grant lets the player cast a card they cannot see', async () => {
    const { engine, bo, present } = await table();
    engine.declareCapability('cast');
    engine.grant(present, [bo], 'cast');
    expect(engine.mayAct(bo, present, 'cast')).toBe(true);
    expect(engine.canSee(bo, present)).toBe(false); // casting is what reveals it
  });

  it('only the named players hold it', async () => {
    const { engine, ann, bo, cy, present } = await table();
    engine.declareCapability('cast');
    engine.grant(present, [bo], 'cast');
    expect([ann, bo, cy].map((p) => engine.mayAct(p, present, 'cast'))).toEqual([false, true, false]);
  });

  it('a capability grants only itself: seeing is not acting either', async () => {
    const { engine, bo, present } = await table();
    engine.declareCapability('cast');
    engine.showTo(present, [bo]);
    expect(engine.canSee(bo, present)).toBe(true);
    expect(engine.mayAct(bo, present, 'cast')).toBe(false);
  });

  it('a game may still declare a link, and then both are granted and end together', async () => {
    const { engine, bo, present } = await table();
    engine.declareCapability('inspect', { implies: ['see'] });
    const grant = engine.grant(present, [bo], 'inspect');
    expect(engine.mayAct(bo, present, 'inspect')).toBe(true);
    expect(engine.canSee(bo, present)).toBe(true);
    grant.end();
    expect(engine.mayAct(bo, present, 'inspect')).toBe(false);
    expect(engine.canSee(bo, present)).toBe(false);
  });
});

describe('sources', () => {
  it('ending one source leaves another effect\'s permission on the same card', async () => {
    const { engine, ann, bo, present } = await table();
    engine.declareCapability('cast');
    const a = ann.characters[0]!;
    const b = bo.characters[0]!;
    engine.grant(present, [bo], 'cast', { source: a, until: 'manual' });
    engine.grant(present, [bo], 'cast', { source: b, until: 'manual' });
    engine.revokeGrants(a);
    expect(engine.mayAct(bo, present, 'cast')).toBe(true); // b's grant still holds
    engine.revokeGrants(b);
    expect(engine.mayAct(bo, present, 'cast')).toBe(false);
  });

  it('revoking a source with no grants does nothing', async () => {
    const { engine, ann } = await table();
    expect(() => engine.revokeGrants(ann.characters[0]!)).not.toThrow();
  });
});

describe('lifetimes', () => {
  it('ends with the zone change by default', async () => {
    const { engine, bo, present } = await table();
    engine.declareCapability('cast');
    engine.grant(present, [bo], 'cast');
    await engine.moveTo(present, 'pile', { owner: bo });
    expect(engine.mayAct(bo, present, 'cast')).toBe(false);
  });

  it('ends at the end of the turn', async () => {
    const { engine, bo, present } = await table();
    engine.declareCapability('cast');
    const grant = engine.grant(present, [bo], 'cast', { until: 'turn-end' });
    await engine.moveTo(present, 'pile', { owner: bo }); // a turn-end grant outlives a move
    expect(grant.active).toBe(true);
    await engine.emit({ type: 'turn:end' });
    expect(grant.active).toBe(false);
    expect(engine.mayAct(bo, present, 'cast')).toBe(false);
  });

  it('ends with the resolution that made it', async () => {
    const { engine, bo, present } = await table();
    engine.declareCapability('cast');
    await engine.resolution(() => {
      engine.grant(present, [bo], 'cast', { until: 'resolution' });
      expect(engine.mayAct(bo, present, 'cast')).toBe(true);
    });
    expect(engine.mayAct(bo, present, 'cast')).toBe(false);
  });
});

describe('announcements', () => {
  it('announce the capability and who, never the card', async () => {
    const { engine, events, bo, present } = await table();
    engine.declareCapability('cast');
    const grant = engine.grant(present, [bo], 'cast');
    grant.end();
    expect(events.find((e) => e.type === 'grant:added')).toEqual({ type: 'grant:added', capability: 'cast', players: [bo], count: 1 });
    expect(events.find((e) => e.type === 'grant:removed')).toEqual({ type: 'grant:removed', capability: 'cast', players: [bo], count: 1 });
  });

  it('announce an implied grant too, once each', async () => {
    const { engine, events, bo, present } = await table();
    engine.declareCapability('inspect', { implies: ['see'] });
    engine.grant(present, [bo], 'inspect').end();
    await Promise.resolve();
    expect(events.filter((e) => e.type === 'grant:removed').map((e) => (e as { capability: string }).capability).sort()).toEqual(['inspect', 'see']);
  });
});
