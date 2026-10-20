/**
 * Abilities a card is given (docs/design/20-secret-choices-and-dice.md, §6).
 *
 * A card has the abilities it was printed with plus whatever its current zone or
 * an effect gives it. The case that shaped it is the Boxed Present: a zone of
 * wrapped cards, each of which has *Open Present* — reveal this card; cast it if
 * it can be, otherwise move it to its owner's garbage. Casting starts with a
 * reveal, because the stack is public.
 */
import { describe, expect, it } from 'vitest';
import { compileDocument, lowerDocument, parseDocument, renderDocument } from '../src/english/index.js';
import {
  Character,
  Player,
  createEngine,
  type Decision,
  type Entity,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import { PLAY } from '../src/engine/index.js';
import { GARBAGE } from '../src/engine/index.js';
import { setEngineCast } from '../src/games/cards/cast.js';

class Seat extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

class Card implements Entity {
  readonly type = 'card' as const;
  constructor(readonly name: string) {}
}

const OPEN_PRESENT = `Ability Open Present
Reveal this.
Cast this if you can, otherwise move it to its owner's garbage.`;

/** Three seats; Ann owns two wrapped presents in her `boxed` zone. */
async function table(options: { castable?: boolean } = {}) {
  const events: GameEvent[] = [];
  const engine = createEngine({ seed: 's', onEvent: (event: GameEvent) => events.push(event) });
  for (const zone of [PLAY, GARBAGE]) engine.zones.declare(zone);
  engine.zones.declare({ id: 'boxed', visibility: 'hidden', scope: 'per-player' });
  engine.zones.declare({ id: 'stack', visibility: 'public' });
  engine.zones.declare({ id: 'pile', visibility: 'hidden', scope: 'per-player' });
  const [ann, bo, cy] = ['Ann', 'Bo', 'Cy'].map(
    (name) => new Seat(name, [new Character(`${name} hero`, { gauges: [{ id: 'hp', max: 10 }] })]),
  ) as [Seat, Seat, Seat];
  for (const seat of [ann, bo, cy]) engine.registerPlayer(seat);
  const gift = new Card('Gift');
  const other = new Card('Other');
  await engine.addEntity(gift, 'boxed', { owner: ann });
  await engine.addEntity(other, 'boxed', { owner: ann });

  // The game's cast: it reports whether it could, and what the table could see when it tried.
  const attempts: { by: string; card: string; seenByEveryone: boolean }[] = [];
  setEngineCast(engine, async (player, card) => {
    attempts.push({
      by: player.name,
      card: card.name,
      seenByEveryone: [ann, bo, cy].every((p) => engine.canSee(p, card)),
    });
    if (options.castable === false) return false;
    await engine.moveTo(card, 'stack', { reason: 'cast' });
    return true;
  });

  const compiled = compileDocument(OPEN_PRESENT);
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const openPresent = compiled.abilities[0]!;
  events.length = 0;
  return { engine, events, ann, bo, cy, gift, other, openPresent, attempts };
}

describe('abilities a zone gives its cards', () => {
  it('every card in the zone has them, for the players it names', async () => {
    const { engine, ann, bo, cy, gift, other, openPresent } = await table();
    engine.setZoneAbilities(engine.zones.zone('boxed', ann)!, [openPresent], [bo, cy]);
    expect(engine.abilitiesFor(bo, gift)).toEqual([openPresent]);
    expect(engine.abilitiesFor(cy, other)).toEqual([openPresent]);
    // The owner was not named, so the owner may not open her own present.
    expect(engine.abilitiesFor(ann, gift)).toEqual([]);
  });

  it('a card that enters has them and one that leaves does not', async () => {
    const { engine, ann, bo, gift, openPresent } = await table();
    engine.setZoneAbilities(engine.zones.zone('boxed', ann)!, [openPresent], [bo]);
    const late = new Card('Late');
    await engine.addEntity(late, 'boxed', { owner: ann });
    expect(engine.abilitiesFor(bo, late)).toEqual([openPresent]);
    await engine.moveTo(gift, 'pile', { owner: ann });
    expect(engine.abilitiesFor(bo, gift)).toEqual([]);
  });

  it('is standing state set while the game runs: replaced, and changeable', async () => {
    const { engine, ann, bo, cy, gift, openPresent } = await table();
    const zone = engine.zones.zone('boxed', ann)!;
    engine.setZoneAbilities(zone, [openPresent], [bo]);
    engine.setZoneAbilities(zone, [openPresent], [cy]);
    expect(engine.abilitiesFor(bo, gift)).toEqual([]);
    expect(engine.abilitiesFor(cy, gift)).toEqual([openPresent]);
    engine.setZoneAbilities(zone, [], []);
    expect(engine.abilitiesFor(cy, gift)).toEqual([]);
  });

  it('is per zone instance: another player\'s boxed zone is untouched', async () => {
    const { engine, ann, bo, cy, openPresent } = await table();
    const theirs = new Card('Theirs');
    await engine.addEntity(theirs, 'boxed', { owner: cy });
    engine.setZoneAbilities(engine.zones.zone('boxed', ann)!, [openPresent], [bo]);
    expect(engine.abilitiesFor(bo, theirs)).toEqual([]);
  });

  it('refuses an ability that is not one a player uses', async () => {
    const { engine, ann, bo } = await table();
    const passive = { kind: 'passive', id: 'p', name: 'Passive' } as never;
    expect(() => engine.setZoneAbilities(engine.zones.zone('boxed', ann)!, [passive], [bo])).toThrow(/not a manual ability/);
  });
});

describe('abilities an effect gives one card', () => {
  it('lasts as long as its grant, and not past the turn if it says so', async () => {
    const { engine, bo, gift, openPresent } = await table();
    const grant = engine.grantAbility(gift, openPresent, [bo], { until: 'turn-end' });
    expect(engine.abilitiesFor(bo, gift)).toEqual([openPresent]);
    await engine.emit({ type: 'turn:end' });
    expect(grant.active).toBe(false);
    expect(engine.abilitiesFor(bo, gift)).toEqual([]);
  });

  it('is revoked with its source and no other, and a zone\'s ability is a union with it', async () => {
    const { engine, ann, bo, gift, openPresent } = await table();
    const mine = ann.characters[0]!;
    engine.grantAbility(gift, openPresent, [bo], { source: mine, until: 'manual' });
    engine.revokeGrants(mine);
    expect(engine.abilitiesFor(bo, gift)).toEqual([]);
    // Given by both the zone and an effect, it is still one ability.
    engine.setZoneAbilities(engine.zones.zone('boxed', ann)!, [openPresent], [bo]);
    engine.grantAbility(gift, openPresent, [bo], { until: 'manual' });
    expect(engine.abilitiesFor(bo, gift)).toEqual([openPresent]);
  });

  it('ends when the card moves, by default', async () => {
    const { engine, ann, bo, gift, openPresent } = await table();
    engine.grantAbility(gift, openPresent, [bo]);
    await engine.moveTo(gift, 'pile', { owner: ann });
    expect(engine.abilitiesFor(bo, gift)).toEqual([]);
  });
});

describe('opening the Boxed Present', () => {
  async function opened(options: { castable?: boolean } = {}) {
    const t = await table(options);
    t.engine.setZoneAbilities(t.engine.zones.zone('boxed', t.ann)!, [t.openPresent], [t.bo]);
    await t.engine.useCardAbility(t.bo, t.gift, t.openPresent);
    return t;
  }

  it('reveals the card first, then casts it: the card is on the stack, which everyone sees', async () => {
    const { engine, attempts, ann, bo, cy, gift } = await opened();
    expect(attempts).toEqual([{ by: 'Bo', card: 'Gift', seenByEveryone: true }]);
    expect(engine.zones.zoneOf(gift)?.id).toBe('stack');
    expect([ann, bo, cy].every((p) => engine.canSee(p, gift))).toBe(true);
  });

  it('a card that cannot be cast goes to its OWNER\'s garbage, not the opener\'s', async () => {
    const { engine, ann, bo, gift } = await opened({ castable: false });
    const zone = engine.zones.zoneOf(gift)!;
    expect(zone.id).toBe('garbage');
    expect(zone.owner).toBe(ann);
    expect(zone.owner).not.toBe(bo);
  });

  it('leaves the other wrapped cards alone', async () => {
    const { engine, other } = await opened();
    expect(engine.zones.zoneOf(other)?.id).toBe('boxed');
  });

  it('is announced as a look by everyone, without naming the card', async () => {
    const { events } = await opened();
    const looks = events.filter((event) => event.type === 'grant:added');
    expect(looks).toHaveLength(1);
    expect(Object.keys(looks[0]!).sort()).toEqual(['capability', 'count', 'players', 'type']);
  });

  it('only a player who may open it can', async () => {
    const t = await table();
    t.engine.setZoneAbilities(t.engine.zones.zone('boxed', t.ann)!, [t.openPresent], [t.bo]);
    await expect(t.engine.useCardAbility(t.cy, t.gift, t.openPresent)).rejects.toThrow(/may not use "Open Present"/);
    await expect(t.engine.useCardAbility(t.ann, t.gift, t.openPresent)).rejects.toThrow(/may not use/);
  });

  it('cannot be opened once the card has left the box', async () => {
    const t = await table();
    t.engine.setZoneAbilities(t.engine.zones.zone('boxed', t.ann)!, [t.openPresent], [t.bo]);
    await t.engine.moveTo(t.gift, 'pile', { owner: t.ann });
    await expect(t.engine.useCardAbility(t.bo, t.gift, t.openPresent)).rejects.toThrow(/may not use/);
  });

  it('fails clearly when the game has no way to cast', async () => {
    const t = await table();
    const engine = createEngine({ seed: 's' });
    engine.zones.declare(PLAY);
    engine.zones.declare(GARBAGE);
    engine.zones.declare({ id: 'boxed', visibility: 'hidden', scope: 'per-player' });
    const player = new Seat('P', [new Character('P hero', { gauges: [{ id: 'hp', max: 5 }] })]);
    const rival = new Seat('Q', [new Character('Q hero', { gauges: [{ id: 'hp', max: 5 }] })]);
    engine.registerPlayer(player);
    engine.registerPlayer(rival);
    const card = new Card('Lonely');
    await engine.addEntity(card, 'boxed', { owner: player });
    engine.setZoneAbilities(engine.zones.zone('boxed', player)!, [t.openPresent], [player]);
    await expect(engine.useCardAbility(player, card, t.openPresent)).rejects.toThrow(/no way to cast a card/);
  });
});

describe('"this card" in the language', () => {
  const lower = (text: string) => lowerDocument(parseDocument(text).doc);
  const errors = (text: string) =>
    compileDocument(text).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

  it('lowers to three effects on the host', () => {
    expect(lower(OPEN_PRESENT).abilities[0]!.steps.map((step) => step.effects[0])).toEqual([
      { kind: 'revealCard' },
      { kind: 'castCard', otherwise: 'garbage' },
    ]);
    expect(lower('Ability A\nCast this if you can.\nMove this to its owner\'s garbage.').abilities[0]!.steps.map((s) => s.effects[0])).toEqual([
      { kind: 'castCard' },
      { kind: 'moveCard', to: 'garbage' },
    ]);
  });

  it('renders each back as written and round-trips', () => {
    const source = `Ability Wrapped
Reveal this.
Cast this if you can.
Cast this if you can, otherwise move it to its owner's garbage.
Move this to its owner's garbage.`;
    const ir = lower(source);
    const { text, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    for (const line of source.split('\n').slice(1)) expect(text).toContain(line);
    expect(lower(text).abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
  });

  it('explains what each sentence expects', () => {
    expect(errors('Ability A\nReveal that card.')[0]).toMatch(/acts on the card an ability belongs to — write "this"/);
    expect(errors('Ability A\nCast this.')[0]).toMatch(/write "if you can"/);
    expect(errors('Ability A\nCast this if you can, otherwise discard it.')[0]).toMatch(/otherwise move it to its owner's <zone>/);
    expect(errors('Ability A\nMove this to its garbage.')[0]).toMatch(/expected "its owner's <zone>"/);
    expect(errors("Ability A\nMove this to its owner's pocket.")[0]).toMatch(/unknown zone "pocket"/);
  });

  it('is an error at run time in an ability a character carries, with a message that says why', async () => {
    const compiled = compileDocument('Ability Peek\nReveal this.');
    const ability = compiled.abilities[0]!;
    const hero = new Character('Hero', {
      gauges: [{ id: 'hp', max: 5 }],
      skills: [{ name: 'Peek', weight: 1, abilities: [ability] }],
    });
    const engine = createEngine({ seed: 's' });
    engine.registerCharacter(hero);
    await expect(engine.useAbility(hero, ability, { targets: [] })).rejects.toThrow(/"this" needs an ability a zone or an effect gave a card/);
  });
});

describe('"Cards in … have …" — a zone gives its cards an ability, in the language', () => {
  const ZONES = new ZoneDictionary(['boxed']);
  const lower = (text: string) => lowerDocument(parseDocument(text, { zones: ZONES }).doc);
  const errors = (text: string) =>
    compileDocument(text, { zones: ZONES }).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

  const effectOf = (line: string) => lower(`Ability Open Present\nReveal this.\n\nAbility Wrap\n${line}`).abilities[1]!.steps[0]!.effects[0];

  it('says whose zone, which ability, and who may use it', () => {
    expect(effectOf('Cards in your boxed zone have Open Present for all opponents.')).toEqual({
      kind: 'zoneAbility',
      zone: 'boxed',
      owners: 'you',
      ability: 'open-present',
      users: 'opponents',
    });
    expect(effectOf("Cards in all players' boxed zone have Open Present for you.")).toMatchObject({ owners: 'each', users: 'you' });
    expect(effectOf("Cards in all opponents' boxed zone have Open Present for all players.")).toMatchObject({ owners: 'opponents', users: 'each' });
    expect(effectOf('Cards in the boxed zone have Open Present for you.')).toMatchObject({ owners: 'shared' });
  });

  it('lets anyone use it when no one is named, and reads the word "zone" as optional', () => {
    expect(effectOf('Cards in your boxed have Open Present.')).toMatchObject({ users: 'each' });
    expect(effectOf('Cards in your garbage have Open Present for you.')).toMatchObject({ zone: 'garbage' });
  });

  it('round-trips, always writing the word "zone"', () => {
    const source = `Ability Open Present
Reveal this.

Ability Wrap
Cards in your boxed zone have Open Present for all opponents.
Cards in all players' boxed zone have Open Present for you.
Cards in the boxed zone have Open Present for all players.`;
    const ir = lower(source);
    const { text, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    for (const line of source.split('\n').slice(4)) expect(text).toContain(line);
    expect(lower(text).abilities[1]!.steps).toEqual(ir.abilities[1]!.steps);
  });

  it('finds an ability defined later in the document, and a name with several words', () => {
    expect(
      errors(`Ability Wrap\nCards in your boxed zone have Open Present.\n\nAbility Open Present\nReveal this.`),
    ).toEqual([]);
  });

  /** Runs `Wrap` for Ann, who casts it, and returns the engine to look at. */
  async function wrapped(line: string) {
    const compiled = compileDocument(`${OPEN_PRESENT}\n\nAbility Wrap\n${line}`, { zones: ZONES });
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const [openPresent, wrap] = compiled.abilities as [typeof compiled.abilities[number], typeof compiled.abilities[number]];
    const t = await table();
    await wrap.cast({ self: t.ann.characters[0]!, engine: t.engine }, { targets: [] });
    return { ...t, openPresent };
  }

  it('gives the cards of the caster\'s own zone the ability, for the players named', async () => {
    const { engine, ann, bo, cy, gift, openPresent } = await wrapped('Cards in your boxed zone have Open Present for all opponents.');
    // "Each opponent" of Ann is Bo and Cy; Ann herself may not.
    expect([ann, bo, cy].map((p) => engine.abilitiesFor(p, gift))).toEqual([[], [openPresent], [openPresent]]);
  });

  it('for you: only the caster', async () => {
    const { engine, ann, bo, gift, openPresent } = await wrapped('Cards in your boxed zone have Open Present for you.');
    expect(engine.abilitiesFor(ann, gift)).toEqual([openPresent]);
    expect(engine.abilitiesFor(bo, gift)).toEqual([]);
  });

  it("all players' zone covers every player's, and your zone only the caster's", async () => {
    const t = await wrapped("Cards in all players' boxed zone have Open Present for all players.");
    const theirs = new Card('Theirs');
    await t.engine.addEntity(theirs, 'boxed', { owner: t.cy });
    // Cards that arrive later are covered too.
    expect(t.engine.abilitiesFor(t.bo, theirs)).toEqual([t.openPresent]);
    const own = await wrapped('Cards in your boxed zone have Open Present for all players.');
    const others = new Card('Others');
    await own.engine.addEntity(others, 'boxed', { owner: own.cy });
    expect(own.engine.abilitiesFor(own.bo, others)).toEqual([]);
  });

  it('adds to what the zone gives, and giving it again changes who may use it', async () => {
    const compiled = compileDocument(
      `${OPEN_PRESENT}\n\nAbility Peek\nReveal this.\n\nAbility Wrap\nCards in your boxed zone have Open Present for you.\nCards in your boxed zone have Peek for you.\nCards in your boxed zone have Open Present for all opponents.`,
      { zones: ZONES },
    );
    const [openPresent, peek, wrap] = compiled.abilities as [typeof compiled.abilities[number], typeof compiled.abilities[number], typeof compiled.abilities[number]];
    const t = await table();
    await wrap.cast({ self: t.ann.characters[0]!, engine: t.engine }, { targets: [] });
    expect(t.engine.abilitiesFor(t.ann, t.gift)).toEqual([peek]); // Open Present now belongs to the opponents
    expect(t.engine.abilitiesFor(t.bo, t.gift)).toEqual([openPresent]);
  });

  it('a shared zone has one list for everyone', async () => {
    const compiled = compileDocument(`${OPEN_PRESENT}\n\nAbility Wrap\nCards in the stack zone have Open Present for you.`, {
      zones: new ZoneDictionary(['stack']),
    });
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const [openPresent, wrap] = compiled.abilities as [typeof compiled.abilities[number], typeof compiled.abilities[number]];
    const t = await table();
    const onStack = new Card('OnStack');
    await t.engine.addEntity(onStack, 'stack');
    await wrap.cast({ self: t.ann.characters[0]!, engine: t.engine }, { targets: [] });
    expect(t.engine.abilitiesFor(t.ann, onStack)).toEqual([openPresent]);
  });

  it('names the abilities that exist when it is given one that does not', () => {
    expect(errors(`${OPEN_PRESENT}\n\nAbility Wrap\nCards in your boxed zone have Open Presnt for you.`)[0]).toMatch(
      /no ability called "Open Presnt" in this document — it has "Open Present", "Wrap"/,
    );
    expect(errors(`${OPEN_PRESENT}\n\nAbility Wrap\nCards in your boxed zone have Open for you.`)[0]).toMatch(/did you mean "Open Present"/);
    // A bare sentence belongs to an implicit "Untitled" ability, which is all the document has.
    expect(errors('Cards in your boxed zone have Anything.')[0]).toMatch(/no ability called "Anything" in this document — it has "Untitled"/);
  });

  it('explains what each part expects', () => {
    const wrap = (line: string) => errors(`${OPEN_PRESENT}\n\nAbility Wrap\n${line}`)[0];
    expect(wrap('Cards have Open Present.')).toMatch(/write "Cards in <whose> <zone> have <ability>"/);
    expect(wrap('Cards in boxed have Open Present.')).toMatch(/whose zone\? — "your", "all players'", "all opponents'" or "the"/);
    expect(wrap('Cards in your pocket have Open Present.')).toMatch(/unknown zone "pocket"/);
    expect(wrap('Cards in your boxed zone Open Present.')).toMatch(/expected "have <ability>"/);
    expect(wrap('Cards in your boxed zone have.')).toMatch(/expected the name of an ability/);
    expect(wrap('Cards in your boxed zone have Open Present for them.')).toMatch(/who may use it\? — "for you", "for all players" or "for all opponents"/);
    expect(wrap('Cards in your boxed zone have Open Present for each cat.')).toMatch(/who may use it\? — "for you", "for all players" or "for all opponents"/);
  });

  it('fails clearly at run time when the zone does not exist in the game', async () => {
    const compiled = compileDocument(`${OPEN_PRESENT}\n\nAbility Wrap\nCards in your boxed zone have Open Present for you.`, { zones: ZONES });
    const wrap = compiled.abilities[1]!;
    const engine = createEngine({ seed: 's' });
    const player = new Seat('P', [new Character('P hero', { gauges: [{ id: 'hp', max: 5 }] })]);
    const rival = new Seat('Q', [new Character('Q hero', { gauges: [{ id: 'hp', max: 5 }] })]);
    engine.registerPlayer(player);
    engine.registerPlayer(rival);
    await expect(wrap.cast({ self: player.characters[0]!, engine }, { targets: [] })).rejects.toThrow(/there is no zone "boxed"/);
  });
});

describe('a Zone section — "Cards in this zone have …"', () => {
  const ZONES = new ZoneDictionary(['boxed']);
  const DOC = `Ability Open Present
Reveal this.
Cast this if you can, otherwise move it to its owner's garbage.

Zone boxed
Cards in this zone have Open Present for all opponents.`;
  const errors = (text: string) =>
    compileDocument(text, { zones: ZONES }).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

  it('parses to a section about one zone, and lowers each statement with that zone filled in', () => {
    const ir = lowerDocument(parseDocument(DOC, { zones: ZONES }).doc);
    expect(ir.zones).toEqual([
      {
        zone: 'boxed',
        steps: [
          { effects: [{ kind: 'zoneAbility', zone: 'boxed', owners: 'this', ability: 'open-present', users: 'opponents' }] },
        ],
      },
    ]);
  });

  it('renders back with the heading and "this zone", and round-trips', () => {
    const ir = lowerDocument(parseDocument(DOC, { zones: ZONES }).doc);
    const { text, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    expect(text).toContain('Zone boxed\nCards in this zone have Open Present for all opponents.');
    expect(lowerDocument(parseDocument(text, { zones: ZONES }).doc).zones).toEqual(ir.zones);
  });

  it('applies to every player\'s instance, with that instance\'s owner as "you"', async () => {
    const compiled = compileDocument(DOC, { zones: ZONES });
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const { engine, ann, bo, cy, gift } = await table();
    const theirs = new Card('Theirs');
    await engine.addEntity(theirs, 'boxed', { owner: bo });
    await compiled.zones[0]!.apply(engine);
    const [open] = compiled.abilities;
    // Ann's boxed cards can be opened by her opponents, and Bo's by his.
    expect([ann, bo, cy].map((p) => engine.abilitiesFor(p, gift))).toEqual([[], [open], [open]]);
    expect([ann, bo, cy].map((p) => engine.abilitiesFor(p, theirs))).toEqual([[open], [], [open]]);
  });

  it('is applied by the host, so it can be applied again and changes nothing', async () => {
    const compiled = compileDocument(DOC, { zones: ZONES });
    const { engine, bo, gift } = await table();
    await compiled.zones[0]!.apply(engine);
    await compiled.zones[0]!.apply(engine);
    expect(engine.abilitiesFor(bo, gift)).toHaveLength(1);
  });

  it('works with the Open Present flow end to end', async () => {
    const compiled = compileDocument(DOC, { zones: ZONES });
    const { engine, bo, gift } = await table();
    await compiled.zones[0]!.apply(engine);
    await engine.useCardAbility(bo, gift, compiled.abilities[0]!);
    expect(engine.zones.zoneOf(gift)?.id).toBe('stack');
  });

  it('uses the owner of a shared zone only for "each player"', async () => {
    const shared = new ZoneDictionary(['commons']);
    const ok = compileDocument(`${OPEN_PRESENT}\n\nZone commons\nCards in this zone have Open Present for all players.`, { zones: shared });
    expect(ok.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const t = await table();
    t.engine.zones.declare({ id: 'commons', visibility: 'public' });
    const card = new Card('Shared');
    await t.engine.addEntity(card, 'commons');
    await ok.zones[0]!.apply(t.engine);
    expect(t.engine.abilitiesFor(t.cy, card)).toEqual([ok.abilities[0]]);

    const bad = compileDocument(`${OPEN_PRESENT}\n\nZone commons\nCards in this zone have Open Present for you.`, { zones: shared });
    await expect(bad.zones[0]!.apply(t.engine)).rejects.toThrow(/shared, so it has no owner — say "for all players"/);
  });

  it('fails clearly if the game has no such zone', async () => {
    const compiled = compileDocument(DOC, { zones: ZONES });
    const engine = createEngine({ seed: 's' });
    engine.registerPlayer(new Seat('P', [new Character('P hero', { gauges: [{ id: 'hp', max: 5 }] })]));
    await expect(compiled.zones[0]!.apply(engine)).rejects.toThrow(/the game has no zone "boxed"/);
  });

  it('maps the zone through the host\'s aliases like any other', async () => {
    const compiled = compileDocument(DOC, { zones: ZONES, bind: { aliases: { boxed: 'pile' } } });
    const { engine, ann, bo, cy, gift } = await table();
    const wrapped = new Card('Wrapped');
    await engine.addEntity(wrapped, 'pile', { owner: ann });
    await compiled.zones[0]!.apply(engine);
    expect(engine.abilitiesFor(bo, wrapped)).toEqual([compiled.abilities[0]]);
    expect(engine.abilitiesFor(cy, gift)).toEqual([]); // the unaliased 'boxed' zone is untouched
  });

  it('names an ability that is not there, like the other form does', () => {
    expect(errors(`${OPEN_PRESENT}\n\nZone boxed\nCards in this zone have Open Presnt for you.`)[0]).toMatch(
      /no ability called "Open Presnt" in this document — it has "Open Present"/,
    );
  });

  it('holds only statements about its own zone', () => {
    expect(errors(`${OPEN_PRESENT}\n\nZone boxed\nReveal this.`)[0]).toMatch(/a Zone section is about its own zone/);
    expect(errors(`${OPEN_PRESENT}\n\nZone boxed\nCards in your boxed zone have Open Present for you.`)[0]).toMatch(
      /a Zone section is about its own zone — write "Cards in this zone have/,
    );
  });

  it('needs a Zone section for "this zone"', () => {
    expect(errors(`${OPEN_PRESENT}\n\nAbility Wrap\nCards in this zone have Open Present for you.`)[0]).toMatch(
      /"this zone" needs a zone to be about — put the sentence under a "Zone <name>" heading/,
    );
  });

  it('knows its zones', () => {
    expect(errors(`${OPEN_PRESENT}\n\nZone pocket\nCards in this zone have Open Present for you.`)[0]).toMatch(/unknown zone "pocket"/);
    expect(errors('Zone\nCards in this zone have X.')[0]).toMatch(/expected a zone name after "Zone"/);
  });

  it('still reads the explicit form inside an ability', () => {
    const doc = `${OPEN_PRESENT}\n\nAbility Wrap\nCards in your boxed zone have Open Present for you.`;
    expect(errors(doc)).toEqual([]);
  });
});

describe('taking an ability away from a zone', () => {
  const ZONES = new ZoneDictionary(['boxed']);
  const errors = (text: string) =>
    compileDocument(text, { zones: ZONES }).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

  it('the engine removes what was given, for everyone, and says whether it had it', async () => {
    const { engine, ann, bo, cy, gift, openPresent } = await table();
    const zone = engine.zones.zone('boxed', ann)!;
    engine.addZoneAbility(zone, openPresent, [bo, cy]);
    expect(engine.removeZoneAbility(zone, openPresent)).toBe(true);
    expect([bo, cy].map((p) => engine.abilitiesFor(p, gift))).toEqual([[], []]);
    expect(engine.removeZoneAbility(zone, openPresent)).toBe(false);
  });

  it('keeps the zone\'s other abilities', async () => {
    const compiled = compileDocument(`${OPEN_PRESENT}\n\nAbility Peek\nReveal this.`);
    const [open, peek] = compiled.abilities as [typeof compiled.abilities[number], typeof compiled.abilities[number]];
    const { engine, ann, bo, gift } = await table();
    const zone = engine.zones.zone('boxed', ann)!;
    engine.addZoneAbility(zone, open, [bo]);
    engine.addZoneAbility(zone, peek, [bo]);
    engine.removeZoneAbility(zone, open);
    expect(engine.abilitiesFor(bo, gift)).toEqual([peek]);
  });

  it('does not touch an ability an effect granted a card', async () => {
    const { engine, ann, bo, gift, openPresent } = await table();
    const zone = engine.zones.zone('boxed', ann)!;
    engine.addZoneAbility(zone, openPresent, [bo]);
    engine.grantAbility(gift, openPresent, [bo], { until: 'manual' });
    engine.removeZoneAbility(zone, openPresent);
    expect(engine.abilitiesFor(bo, gift)).toEqual([openPresent]); // the grant still holds
  });

  it('is a sentence, in both forms, and round-trips', () => {
    const source = `Ability Open Present
Reveal this.

Ability Unwrap
Cards in your boxed zone no longer have Open Present.
Cards in all opponents' boxed zone no longer have Open Present.

Zone boxed
Cards in this zone no longer have Open Present.`;
    const ir = lowerDocument(parseDocument(source, { zones: ZONES }).doc);
    expect(ir.abilities[1]!.steps[0]!.effects[0]).toEqual({
      kind: 'zoneAbility',
      zone: 'boxed',
      owners: 'you',
      ability: 'open-present',
      users: 'each',
      remove: true,
    });
    const { text, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    expect(text).toContain('Cards in your boxed zone no longer have Open Present.');
    expect(text).toContain("Cards in all opponents' boxed zone no longer have Open Present.");
    expect(text).toContain('Zone boxed\nCards in this zone no longer have Open Present.');
    const again = lowerDocument(parseDocument(text, { zones: ZONES }).doc);
    expect(again.abilities[1]!.steps).toEqual(ir.abilities[1]!.steps);
    expect(again.zones).toEqual(ir.zones);
  });

  it('run as an ability: gives, then takes away', async () => {
    const compiled = compileDocument(
      `${OPEN_PRESENT}\n\nAbility Wrap\nCards in your boxed zone have Open Present for all opponents.\n\nAbility Unwrap\nCards in your boxed zone no longer have Open Present.`,
      { zones: ZONES },
    );
    const [open, wrap, unwrap] = compiled.abilities as [typeof compiled.abilities[number], typeof compiled.abilities[number], typeof compiled.abilities[number]];
    const { engine, ann, bo, gift } = await table();
    const self = ann.characters[0]!;
    await wrap.cast({ self, engine }, { targets: [] });
    expect(engine.abilitiesFor(bo, gift)).toEqual([open]);
    await unwrap.cast({ self, engine }, { targets: [] });
    expect(engine.abilitiesFor(bo, gift)).toEqual([]);
  });

  it('applies a Zone section that takes it away', async () => {
    const compiled = compileDocument(
      `${OPEN_PRESENT}\n\nZone boxed\nCards in this zone no longer have Open Present.`,
      { zones: ZONES },
    );
    const { engine, ann, bo, gift, openPresent } = await table();
    engine.addZoneAbility(engine.zones.zone('boxed', ann)!, openPresent, [bo]);
    await compiled.zones[0]!.apply(engine);
    expect(engine.abilitiesFor(bo, gift)).toEqual([]);
  });

  it('takes no "for": it removes the ability for everyone', () => {
    expect(errors(`${OPEN_PRESENT}\n\nZone boxed\nCards in this zone no longer have Open Present for you.`)[0]).toMatch(
      /"no longer have" takes the ability away from everyone it was given to — drop the "for …"/,
    );
  });

  it('checks the ability name like the giving form', () => {
    expect(errors(`${OPEN_PRESENT}\n\nZone boxed\nCards in this zone no longer have Open Presnt.`)[0]).toMatch(
      /no ability called "Open Presnt"/,
    );
  });
});
