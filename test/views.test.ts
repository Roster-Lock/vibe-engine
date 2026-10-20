/**
 * Server views (docs/design/20-secret-choices-and-dice.md): what one player may know.
 *
 * The rule: a card you cannot see is not in your view — only that it exists, and for an
 * ordered pile where. The tests that matter most scan the JSON that would go over the
 * wire for the names of cards a recipient must not learn.
 */
import { describe, expect, it } from 'vitest';
import { compileDocument } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import {
  Character,
  Player,
  ViewProjector,
  createEngine,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Decision,
  type Entity,
  type GameEvent,
  type SlotView,
  type ViewEvent,
} from '../src/games/turn-based/index.js';
import { PLAY } from '../src/engine/index.js';
import { GARBAGE } from '../src/engine/index.js';

class Seat extends Player {
  constructor(
    name: string,
    characters: readonly Character[],
    private readonly pick?: string,
  ) {
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

class Card implements Entity {
  readonly type = 'card' as const;
  constructor(readonly name: string) {}
}

const names = (slots: readonly SlotView[]) => slots.map((slot) => (slot.hidden === true ? '·' : slot.name));

/** Three seats with a deck (hidden, ordered), a hand (owner), a public pile and a custom zone each. */
async function table(picks: Record<string, string> = {}) {
  const raw: GameEvent[] = [];
  let projector: ViewProjector | undefined;
  const heard = new Map<string, ViewEvent[]>();
  const engine = createEngine({
    seed: 's',
    onEvent: (event: GameEvent) => {
      raw.push(event);
      if (!projector) return;
      for (const player of engine.players) {
        const redacted = projector.eventFor(player, event);
        if (redacted) heard.get(player.name)!.push(redacted);
      }
    },
  });
  for (const zone of [PLAY, GARBAGE]) engine.zones.declare(zone);
  engine.zones.declare({ id: 'deck', visibility: 'hidden', scope: 'per-player', ordered: true });
  engine.zones.declare({ id: 'hand', visibility: 'owner', scope: 'per-player' });
  engine.zones.declare({ id: 'forehead', visibility: 'custom', scope: 'per-player' });
  engine.zones.declare({ id: 'table', visibility: 'public' });
  const [ann, bo, cy] = ['Ann', 'Bo', 'Cy'].map(
    (name) => new Seat(name, [new Character(`${name} hero`, { gauges: [{ id: 'hp', max: 10 }] })], picks[name]),
  ) as [Seat, Seat, Seat];
  for (const seat of [ann, bo, cy]) {
    engine.registerPlayer(seat);
    heard.set(seat.name, []);
  }
  let counter = 0;
  projector = new ViewProjector(engine, { makeRef: () => `ref-${++counter}` });
  const put = async (name: string, zone: string, owner?: Seat): Promise<Card> => {
    const card = new Card(name);
    await engine.addEntity(card, zone, owner ? { owner } : {});
    return card;
  };
  return { engine, projector, raw, heard, ann, bo, cy, put };
}

const zoneOf = (view: ReturnType<ViewProjector['viewFor']>, key: string) => view.zones.find((zone) => zone.key === key)!;

describe('a view of the game', () => {
  it('lists the players and every zone, with sizes that are never hidden', async () => {
    const { projector, ann, bo, put } = await table();
    await put('Fire', 'deck', ann);
    await put('Ice', 'deck', ann);
    const view = projector.viewFor(bo);
    expect(view.viewer).toBe(bo.id);
    expect(view.players.map((p) => p.name)).toEqual(['Ann', 'Bo', 'Cy']);
    expect(zoneOf(view, 'deck:Ann').size).toBe(2);
    expect(zoneOf(view, 'deck:Bo').size).toBe(0);
  });

  it('shows a public zone in full, with a ref for each card', async () => {
    const { projector, ann, bo, put } = await table();
    await put('Fire', 'table');
    await put('Ice', 'table');
    for (const viewer of [ann, bo]) {
      const zone = zoneOf(projector.viewFor(viewer), 'table');
      expect(names(zone.members)).toEqual(['Fire', 'Ice']);
      expect(zone.hiddenCount).toBe(0);
    }
  });

  it('shows an owner-only hand to its owner and only a count to everyone else', async () => {
    const { projector, ann, bo, put } = await table();
    await put('Fire', 'hand', ann);
    await put('Ice', 'hand', ann);
    const mine = zoneOf(projector.viewFor(ann), 'hand:Ann');
    expect(names(mine.members)).toEqual(['Fire', 'Ice']);
    const theirs = zoneOf(projector.viewFor(bo), 'hand:Ann');
    expect(theirs.members).toEqual([]);
    expect(theirs.hiddenCount).toBe(2);
    expect(theirs.size).toBe(2);
  });

  it('keeps a hidden ordered pile\'s places as anonymous placeholders, with no refs', async () => {
    const { projector, ann, put } = await table();
    await put('Fire', 'deck', ann);
    await put('Ice', 'deck', ann);
    await put('Wind', 'deck', ann);
    const zone = zoneOf(projector.viewFor(ann), 'deck:Ann'); // hidden even from its owner
    expect(zone.members).toEqual([{ hidden: true }, { hidden: true }, { hidden: true }]);
    expect(zone.hiddenCount).toBe(3);
  });

  it('follows a custom zone\'s viewer list', async () => {
    const { engine, projector, ann, bo, cy, put } = await table();
    await put('Joker', 'forehead', ann);
    engine.setViewers(engine.zones.zone('forehead', ann)!, [bo, cy]);
    expect([ann, bo, cy].map((v) => names(zoneOf(projector.viewFor(v), 'forehead:Ann').members))).toEqual([[], ['Joker'], ['Joker']]);
  });

  it('adds a single shown card to just that player\'s view, in its place, and removes it again', async () => {
    const { engine, projector, ann, bo, put } = await table();
    await put('Fire', 'deck', ann);
    const ice = await put('Ice', 'deck', ann);
    await put('Wind', 'deck', ann);
    const grant = engine.showTo(ice, [bo]);
    expect(names(zoneOf(projector.viewFor(bo), 'deck:Ann').members)).toEqual(['·', 'Ice', '·']);
    expect(names(zoneOf(projector.viewFor(ann), 'deck:Ann').members)).toEqual(['·', '·', '·']);
    grant.end();
    expect(names(zoneOf(projector.viewFor(bo), 'deck:Ann').members)).toEqual(['·', '·', '·']);
  });

  it('lists the cards you can see first in an unordered zone, then only counts the rest', async () => {
    const { engine, projector, ann, bo, put } = await table();
    await put('Fire', 'hand', ann);
    const ice = await put('Ice', 'hand', ann);
    await put('Wind', 'hand', ann);
    engine.showTo(ice, [bo]);
    const zone = zoneOf(projector.viewFor(bo), 'hand:Ann');
    expect(names(zone.members)).toEqual(['Ice']);
    expect(zone.hiddenCount).toBe(2);
  });

  it('describes a character with its gauges and controller', async () => {
    const { projector, ann, bo } = await table();
    const zone = zoneOf(projector.viewFor(bo), 'play');
    const hero = zone.members.find((slot) => slot.hidden !== true && slot.name === 'Ann hero');
    expect(hero).toMatchObject({ type: 'character', gauges: [{ id: 'hp', current: 10, max: 10 }], controller: ann.id });
  });

  it('lets a game add to what a card shows', async () => {
    const t = await table();
    const projector = new ViewProjector(t.engine, { makeRef: () => 'x', describe: (e) => ({ flavour: `about ${e.name}` }) });
    await t.put('Fire', 'table');
    const zone = zoneOf(projector.viewFor(t.bo), 'table');
    expect(zone.members[0]).toMatchObject({ name: 'Fire', flavour: 'about Fire' });
  });

  it('is plain data, and a viewer\'s JSON never contains a card they cannot see', async () => {
    const { projector, ann, bo, cy, put } = await table();
    await put('SECRET-DECK', 'deck', ann);
    await put('SECRET-HAND', 'hand', ann);
    await put('SECRET-HEAD', 'forehead', ann);
    await put('Open', 'table');
    for (const viewer of [bo, cy]) {
      const wire = JSON.stringify(projector.viewFor(viewer));
      expect(wire).not.toContain('SECRET');
      expect(wire).toContain('Open');
    }
    expect(JSON.stringify(projector.viewFor(ann))).toContain('SECRET-HAND'); // her own hand
    expect(JSON.stringify(projector.viewFor(ann))).not.toContain('SECRET-DECK'); // hidden even from her
  });
});

describe('refs', () => {
  it('are stable, shared by every viewer, and different for different cards', async () => {
    const { projector, ann, bo, put } = await table();
    await put('Fire', 'table');
    await put('Ice', 'table');
    const refs = (viewer: Player) =>
      zoneOf(projector.viewFor(viewer), 'table').members.map((slot) => (slot.hidden === true ? '' : slot.ref));
    expect(refs(ann)).toEqual(refs(bo));
    expect(refs(ann)).toEqual(refs(ann));
    expect(new Set(refs(ann)).size).toBe(2);
  });

  it('resolve to a card only while the player can see it', async () => {
    const { engine, projector, ann, bo, put } = await table();
    const fire = await put('Fire', 'hand', ann);
    const ref = projector.refOf(fire);
    expect(projector.resolveRef(ann, ref)).toBe(fire);
    expect(projector.resolveRef(bo, ref)).toBeUndefined(); // Bo cannot see it, so the ref is useless to him
    const grant = engine.showTo(fire, [bo]);
    expect(projector.resolveRef(bo, ref)).toBe(fire);
    grant.end();
    expect(projector.resolveRef(bo, ref)).toBeUndefined();
    expect(projector.resolveRef(ann, 'nonsense')).toBeUndefined();
  });

  it('are random by default', async () => {
    const t = await table();
    const projector = new ViewProjector(t.engine);
    const a = projector.refOf(await t.put('Fire', 'table'));
    const b = projector.refOf(await t.put('Ice', 'table'));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('naming a card the player cannot see', () => {
  it('by position in an ordered pile', async () => {
    const { projector, ann, bo, put } = await table();
    const fire = await put('Fire', 'deck', ann);
    const ice = await put('Ice', 'deck', ann);
    expect(projector.resolveSlot(bo, 'deck:Ann', 0)).toBe(fire);
    expect(projector.resolveSlot(bo, 'deck:Ann', 1)).toBe(ice);
    expect(projector.resolveSlot(bo, 'deck:Ann', 2)).toBeUndefined();
    expect(projector.resolveSlot(bo, 'deck:Ann', -1)).toBeUndefined();
    expect(projector.resolveSlot(bo, 'nowhere', 0)).toBeUndefined();
  });

  it('as the n-th card they cannot see, in an unordered zone', async () => {
    const { engine, projector, ann, bo, put } = await table();
    await put('Fire', 'hand', ann);
    const ice = await put('Ice', 'hand', ann);
    const wind = await put('Wind', 'hand', ann);
    engine.showTo(ice, [bo]); // Bo can see Ice, so the hidden ones are Fire and Wind
    expect(projector.resolveSlot(bo, 'hand:Ann', 1)).toBe(wind);
    expect(projector.resolveSlot(bo, 'hand:Ann', 2)).toBeUndefined();
  });
});

describe('events, redacted for each recipient', () => {
  it('shows a card moving into a hand to its owner, and to no one else', async () => {
    const { engine, heard, ann, put } = await table();
    const fire = await put('SECRET-FIRE', 'deck', ann);
    heard.get('Ann')!.length = 0;
    heard.get('Bo')!.length = 0;
    await engine.moveTo(fire, 'hand', { owner: ann });
    const owner = heard.get('Ann')!.find((e) => e.type === 'zone:changed')!;
    const other = heard.get('Bo')!.find((e) => e.type === 'zone:changed')!;
    expect(owner).toMatchObject({ entity: { name: 'SECRET-FIRE' }, from: 'deck:Ann', to: 'hand:Ann' });
    expect(other).toEqual({ type: 'zone:changed', entity: { hidden: true }, from: 'deck:Ann', to: 'hand:Ann' });
    expect(JSON.stringify(heard.get('Bo'))).not.toContain('SECRET');
  });

  it('shows a card put somewhere public to everyone', async () => {
    const { engine, heard, ann, put } = await table();
    const fire = await put('Fire', 'hand', ann);
    heard.get('Bo')!.length = 0;
    await engine.moveTo(fire, 'garbage', { owner: ann });
    expect(heard.get('Bo')!.find((e) => e.type === 'zone:changed')).toMatchObject({ entity: { name: 'Fire' } });
  });

  it('lets someone who saw a card keep track of it when it leaves for somewhere hidden', async () => {
    const { engine, projector, heard, ann, put } = await table();
    const fire = await put('Fire', 'table');
    const ref = projector.refOf(fire);
    heard.get('Bo')!.length = 0;
    await engine.moveTo(fire, 'hand', { owner: ann }); // bounced to Ann's hand
    expect(heard.get('Bo')!.find((e) => e.type === 'zone:changed')).toMatchObject({
      entity: { hidden: true, ref },
      from: 'table',
      to: 'hand:Ann',
    });
  });

  it('never gives a ref to a card that was already hidden from the recipient', async () => {
    const { engine, heard, ann, put } = await table();
    const fire = await put('Fire', 'deck', ann);
    heard.get('Bo')!.length = 0;
    await engine.moveTo(fire, 'hand', { owner: ann });
    const entity = (heard.get('Bo')!.find((e) => e.type === 'zone:changed') as unknown as { entity: Record<string, unknown> }).entity;
    expect('ref' in entity).toBe(false);
  });

  it('redacts a batch event event by event', async () => {
    const { engine, heard, ann, put } = await table();
    const fire = await put('SECRET-FIRE', 'deck', ann);
    heard.get('Bo')!.length = 0;
    await engine.moveTo(fire, 'hand', { owner: ann });
    const batch = heard.get('Bo')!.find((e) => e.type === 'zone:changed:batch')!;
    expect(JSON.stringify(batch)).not.toContain('SECRET');
    expect((batch.events as unknown[]).length).toBe(1);
  });

  it('announces a grant without the card, and a roll with its player as an id', async () => {
    const { engine, heard, ann, bo, put } = await table();
    const fire = await put('SECRET-FIRE', 'deck', ann);
    heard.get('Cy')!.length = 0;
    engine.showTo(fire, [bo]);
    await engine.roll(1, 6, { source: ann.characters[0]! });
    const granted = heard.get('Cy')!.find((e) => e.type === 'grant:added')!;
    expect(granted).toEqual({ type: 'grant:added', capability: 'see', players: [{ player: bo.id, name: 'Bo' }], count: 1 });
    expect(JSON.stringify(heard.get('Cy'))).not.toContain('SECRET');
    expect(heard.get('Cy')!.find((e) => e.type === 'roll:made')).toMatchObject({ count: 1, sides: 6 });
  });

  it('turns every event into plain data a server can send', async () => {
    const { engine, raw, projector, ann, bo, put } = await table();
    await put('Fire', 'hand', ann);
    await engine.apply([{ type: 'gauge', target: ann.characters[0]!.gauge('hp'), update: (c: number) => c - 3, intent: 'damage' } as never]);
    await engine.roll(2, 6);
    await engine.moveTo(await put('Ice', 'deck', ann), 'hand', { owner: ann });
    expect(raw.length).toBeGreaterThan(3);
    for (const event of raw) {
      for (const viewer of [ann, bo]) {
        const redacted = projector.eventFor(viewer, event);
        expect(() => JSON.stringify(redacted)).not.toThrow();
      }
    }
  });
});

describe('sending to a whole table', () => {
  it('gives each player their own copy of an event', async () => {
    const { engine, projector, ann, bo, cy, put } = await table();
    const fire = await put('SECRET-FIRE', 'deck', ann);
    const sent: [string, ViewEvent][] = [];
    await engine.moveTo(fire, 'hand', { owner: ann });
    projector.broadcast(
      { type: 'zone:changed', entity: fire, from: engine.zones.zone('deck', ann)!, to: engine.zones.zone('hand', ann)! },
      (player, event) => sent.push([player.name, event]),
    );
    expect(sent.map(([who]) => who)).toEqual(['Ann', 'Bo', 'Cy']);
    const seen = (who: string) => JSON.stringify(sent.find(([name]) => name === who)![1]);
    expect(seen('Ann')).toContain('SECRET-FIRE');
    expect(seen('Bo')).not.toContain('SECRET');
    expect(seen('Cy')).not.toContain('SECRET');
    void bo;
    void cy;
  });
});

describe('a whole round, as the opponent hears it', () => {
  const DOC = `Ability Showdown
All players commit a card from their hand face down.
When they are ready, reveal.
All players move the card they committed to their garbage.`;

  it('learns nothing about a hand until its cards are revealed', async () => {
    const t = await table({ Ann: 'ANN-PLAYED', Bo: 'BO-PLAYED' });
    for (const [owner, cards] of [
      [t.ann, ['ANN-PLAYED', 'ANN-KEPT-1', 'ANN-KEPT-2']],
      [t.bo, ['BO-PLAYED', 'BO-KEPT']],
    ] as const) {
      for (const name of cards) await t.put(name, 'hand', owner);
    }
    const compiled = compileDocument(DOC, { zones: new ZoneDictionary(['hand']) });
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = compiled.abilities[0]!;
    t.ann.characters[0]!.skills; // (the ability is called directly below)
    for (const list of t.heard.values()) list.length = 0;

    // Before anything: Bo's view of Ann's hand is a count, and nothing she holds is in his wire.
    expect(JSON.stringify(t.projector.viewFor(t.bo))).not.toContain('ANN-');
    expect(JSON.stringify(t.projector.viewFor(t.bo))).toContain('BO-KEPT'); // his own

    await ability.cast({ self: t.ann.characters[0]!, engine: t.engine }, { targets: [] });

    const boHeard = t.heard.get('Bo')!;
    const wire = JSON.stringify(boHeard);
    // What Ann kept never reaches Bo; what she played does, once it is revealed (and then discarded face up).
    expect(wire).not.toContain('ANN-KEPT');
    const revealedAt = boHeard.findIndex((e) => e.type === 'choice:revealed');
    expect(revealedAt).toBeGreaterThan(-1);
    expect(JSON.stringify(boHeard.slice(0, revealedAt))).not.toContain('ANN-PLAYED');
    expect(JSON.stringify(boHeard[revealedAt])).toContain('ANN-PLAYED');
    // Readiness is announced without content.
    for (const event of boHeard.filter((e) => e.type === 'choice:ready')) {
      expect(Object.keys(event).sort()).toEqual(['player', 'type']);
    }
    // Afterwards the played cards are in public garbage and her kept ones are still just a count.
    const after = t.projector.viewFor(t.bo);
    expect(names(zoneOf(after, 'garbage:Ann').members)).toEqual(['ANN-PLAYED']);
    expect(zoneOf(after, 'hand:Ann').hiddenCount).toBe(2);
    expect(JSON.stringify(after)).not.toContain('ANN-KEPT');
  });
});
