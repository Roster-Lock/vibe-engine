/**
 * Custom visibility (docs/design/20-secret-choices-and-dice.md): who may see a
 * card. A zone has a standing rule — `public`, `owner`, `hidden`, or `custom`
 * with a viewer list of real players — and a single card can be shown to some
 * players on top of that with a sight grant.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  Player,
  createEngine,
  type Decision,
  type Entity,
  type GameEvent,
  type ZoneDef,
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

const ZONES: Record<string, ZoneDef> = {
  open: { id: 'open', visibility: 'public', scope: 'per-player' },
  mine: { id: 'mine', visibility: 'owner', scope: 'per-player' },
  secret: { id: 'secret', visibility: 'hidden', scope: 'per-player' },
  forehead: { id: 'forehead', visibility: 'custom', scope: 'per-player' },
  other: { id: 'other', visibility: 'hidden', scope: 'per-player' },
};

/** Three seats; each holds one card in every zone. */
async function table() {
  const events: GameEvent[] = [];
  const engine = createEngine({ seed: 's', onEvent: (event: GameEvent) => events.push(event) });
  engine.zones.declare(PLAY);
  for (const zone of Object.values(ZONES)) engine.zones.declare(zone);
  const players = ['Ann', 'Bo', 'Cy'].map((name) => new Seat(name, [new Character(`${name} hero`, { gauges: [{ id: 'hp', max: 10 }] })]));
  for (const player of players) engine.registerPlayer(player);
  const cards = new Map<string, Card>();
  for (const player of players) {
    for (const zone of Object.keys(ZONES)) {
      const card = new Card(`${player.name}-${zone}`);
      cards.set(card.name, card);
      await engine.addEntity(card, zone, { owner: player });
    }
  }
  events.length = 0;
  const [ann, bo, cy] = players as [Seat, Seat, Seat];
  const card = (owner: Seat, zone: string): Card => cards.get(`${owner.name}-${zone}`)!;
  const sees = (viewer: Player, owner: Seat, zone: string): boolean => engine.canSee(viewer, card(owner, zone));
  return { engine, events, ann, bo, cy, card, sees };
}

describe('a zone\'s standing visibility', () => {
  it('public is seen by everyone, owner by its owner alone, hidden by no one', async () => {
    const { ann, bo, cy, sees } = await table();
    for (const viewer of [ann, bo, cy]) expect(sees(viewer, ann, 'open')).toBe(true);
    expect([ann, bo, cy].map((viewer) => sees(viewer, ann, 'mine'))).toEqual([true, false, false]);
    for (const viewer of [ann, bo, cy]) expect(sees(viewer, ann, 'secret')).toBe(false);
  });

  it('custom is seen by exactly the viewer list, and nobody until it is set', async () => {
    const { engine, ann, bo, cy, card, sees } = await table();
    expect([ann, bo, cy].map((viewer) => sees(viewer, ann, 'forehead'))).toEqual([false, false, false]);
    const zone = engine.zones.zone('forehead', ann)!;
    expect(zone.viewers).toEqual([]);
    // "Everyone but the owner can see it": the keyword builds this list from the game.
    engine.setViewers(zone, [bo, cy]);
    expect([ann, bo, cy].map((viewer) => sees(viewer, ann, 'forehead'))).toEqual([false, true, true]);
    expect(zone.viewers).toEqual([bo, cy]);
    expect(engine.canSee(bo, card(ann, 'forehead'))).toBe(true);
  });

  it('replaces the list rather than adding to it, and ignores a repeated player', async () => {
    const { engine, ann, bo, cy, sees } = await table();
    const zone = engine.zones.zone('forehead', ann)!;
    engine.setViewers(zone, [bo, bo, cy]);
    expect(zone.viewers).toEqual([bo, cy]);
    engine.setViewers(zone, [ann]);
    expect([ann, bo, cy].map((viewer) => sees(viewer, ann, 'forehead'))).toEqual([true, false, false]);
    engine.setViewers(zone, []);
    expect(sees(ann, ann, 'forehead')).toBe(false);
  });

  it('keeps one list per player\'s zone', async () => {
    const { engine, ann, bo, cy, sees } = await table();
    engine.setViewers(engine.zones.zone('forehead', ann)!, [bo]);
    expect(sees(bo, ann, 'forehead')).toBe(true);
    expect(sees(bo, cy, 'forehead')).toBe(false);
  });

  it('only a custom zone has a list to set', async () => {
    const { engine, ann, bo } = await table();
    expect(() => engine.setViewers(engine.zones.zone('secret', ann)!, [bo])).toThrow(/not "custom"/);
    expect(() => engine.setViewers(engine.zones.zone('open', ann)!, [bo])).toThrow(/only a custom zone/);
  });

  it('lists the cards a player may see, in the zone\'s order, and a card in no zone is unseen', async () => {
    const { engine, ann, bo, card } = await table();
    const zone = engine.zones.zone('forehead', ann)!;
    const extra = new Card('Ann-forehead-2');
    await engine.addEntity(extra, 'forehead', { owner: ann });
    engine.setViewers(zone, [bo]);
    expect(engine.visibleMembers(zone, bo).map((member) => member.name)).toEqual(['Ann-forehead', 'Ann-forehead-2']);
    expect(engine.visibleMembers(zone, ann)).toEqual([]);
    expect(zone.size).toBe(2); // how many is never hidden
    expect(engine.canSee(bo, new Card('stranger'))).toBe(false);
    void card;
  });
});

describe('showing one card to some players', () => {
  it('lets them see it on top of the zone rule, and nobody else', async () => {
    const { engine, ann, bo, cy, card, sees } = await table();
    engine.showTo(card(ann, 'secret'), [bo]);
    expect([ann, bo, cy].map((viewer) => sees(viewer, ann, 'secret'))).toEqual([false, true, false]);
    // …but only that card.
    expect(sees(bo, cy, 'secret')).toBe(false);
  });

  it('lasts, by default, while the card stays where it is, and ends when it moves', async () => {
    const { engine, ann, bo, card, sees } = await table();
    const grant = engine.showTo(card(ann, 'secret'), [bo]);
    expect(grant.active).toBe(true);
    const moved = card(ann, 'secret');
    await engine.moveTo(moved, 'open', { owner: ann });
    expect(grant.active).toBe(false);
    // 'open' is public, so move to a hidden zone to test the grant itself.
    await engine.moveTo(moved, 'other', { owner: ann });
    expect(engine.canSee(bo, moved)).toBe(false);
    // A move back does not bring it back: it is a new object each time.
    await engine.moveTo(moved, 'secret', { owner: ann });
    expect(engine.canSee(bo, moved)).toBe(false);
    void sees;
  });

  it('does not end for a move within the same zone', async () => {
    const { engine, ann, bo, card } = await table();
    const extra = new Card('second');
    await engine.addEntity(extra, 'secret', { owner: ann });
    const grant = engine.showTo(card(ann, 'secret'), [bo]);
    engine.reposition(card(ann, 'secret'), 'bottom');
    expect(grant.active).toBe(true);
  });

  it('a one-time look ends with its resolution: they learned it but cannot look again', async () => {
    const { engine, ann, bo, card, sees } = await table();
    let during = false;
    await engine.resolution(() => {
      engine.showTo(card(ann, 'secret'), [bo], { until: 'resolution' });
      during = sees(bo, ann, 'secret');
    });
    expect(during).toBe(true);
    expect(sees(bo, ann, 'secret')).toBe(false);
  });

  it('refuses a one-time look outside a resolution', async () => {
    const { engine, ann, bo, card } = await table();
    expect(() => engine.showTo(card(ann, 'secret'), [bo], { until: 'resolution' })).toThrow(/inside engine\.resolution/);
  });

  it('ends a resolution look even if the effect throws', async () => {
    const { engine, ann, bo, card, sees } = await table();
    await expect(
      engine.resolution(() => {
        engine.showTo(card(ann, 'secret'), [bo], { until: 'resolution' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(sees(bo, ann, 'secret')).toBe(false);
  });

  it('a manual grant lasts until it is ended, and ending twice is harmless', async () => {
    const { engine, ann, bo, card, sees } = await table();
    const moved = card(ann, 'secret');
    const grant = engine.showTo(moved, [bo], { until: 'manual' });
    await engine.moveTo(moved, 'other', { owner: ann });
    expect(engine.canSee(bo, moved)).toBe(true); // a manual grant survives the move
    grant.end();
    grant.end();
    expect(engine.canSee(bo, moved)).toBe(false);
    void sees;
  });

  it('two grants stack as a union, and ending one leaves the other', async () => {
    const { engine, ann, bo, cy, card, sees } = await table();
    const first = engine.showTo(card(ann, 'secret'), [bo], { until: 'manual' });
    engine.showTo(card(ann, 'secret'), [bo, cy], { until: 'manual' });
    first.end();
    expect(sees(bo, ann, 'secret')).toBe(true);
    expect(sees(cy, ann, 'secret')).toBe(true);
  });

  it('adds to a custom zone\'s list rather than replacing it', async () => {
    const { engine, ann, bo, cy, card, sees } = await table();
    engine.setViewers(engine.zones.zone('forehead', ann)!, [bo]);
    engine.showTo(card(ann, 'forehead'), [cy]);
    expect([bo, cy].map((viewer) => sees(viewer, ann, 'forehead'))).toEqual([true, true]);
  });

  it('is announced without the card', async () => {
    const { engine, events, ann, bo, card } = await table();
    const grant = engine.showTo(card(ann, 'secret'), [bo]);
    grant.end();
    await Promise.resolve();
    const granted = events.find((event) => event.type === 'grant:added');
    const revoked = events.find((event) => event.type === 'grant:removed');
    expect(granted).toEqual({ type: 'grant:added', capability: 'see', players: [bo], count: 1 });
    expect(revoked).toEqual({ type: 'grant:removed', capability: 'see', players: [bo], count: 1 });
  });

  it('ends every grant when the card leaves the game', async () => {
    const { engine, ann, bo, card } = await table();
    const grant = engine.showTo(card(ann, 'secret'), [bo], { until: 'manual' });
    engine.removeEntity(card(ann, 'secret'));
    expect(grant.active).toBe(false);
  });

  it('refuses a card that is not in the game', async () => {
    const { engine, bo } = await table();
    expect(() => engine.showTo(new Card('ghost'), [bo])).toThrow(/not in the game/);
  });
});
