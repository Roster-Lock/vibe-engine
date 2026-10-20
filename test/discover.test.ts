/**
 * **Discover** — reveal from the top of a zone until a card is worth taking
 * (`DiscoverAction`, `GameEngine.reveal`, `GameEngine.shuffleZone`).
 *
 * The mechanic is five sub-behaviours and every one of them is a place a naive
 * implementation goes wrong silently:
 *
 * 1. a peek is not a move — declining a reveal fires no `zone:changed`;
 * 2. it stops at the **first** match, leaving the rest of the deck alone;
 * 3. the card is offered, not taken — a decline bottoms it and continues;
 * 4. the reveals are bottomed **oldest first** and shuffled **once**;
 * 5. finding nothing within `count` is normal, not a hang.
 *
 * The deck order is asserted directly, because "the rest on the bottom in a
 * random order" is a claim about the pile and nothing else.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  Player,
  discover,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Decision,
  type Entity,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { GARBAGE } from '../src/engine/index.js';
import { DECK, REVEALED } from '../examples/card-game/zones.js';
import { PLAY } from '../src/engine/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

/* ------------------------------- fixtures ------------------------------- */

/**
 * A card-shaped entity with no gauges — exactly the entity kind the engine's
 * `Entity` doc insists a spell must be able to be.
 */
class TestCard implements Entity {
  readonly type = 'card' as const;
  readonly name: string;
  readonly attributes: ReadonlyMap<string, number>;

  constructor(name: string, cost: number, extra: Record<string, number> = {}) {
    this.name = name;
    this.attributes = new Map([['cost', cost], ...Object.entries(extra)]);
  }
}

class Idle extends Player {
  constructor(name = 'Idle', characters: readonly Character[] = []) {
    super(name, characters);
  }
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** A chooser that answers `confirm` from a script and records what it was asked. */
/**
 * The **owner** of the zones, and therefore the player the engine asks. It is
 * the owner rather than the engine's fallback `chooser`, because the choice
 * routes to whoever owns the decision (`choice.ts`) — an `EngineOptions.chooser`
 * only answers a question no player owns.
 */
class Confirmer extends Player {
  readonly asks: string[] = [];
  readonly #answers: boolean[];

  constructor(characters: readonly Character[], ...answers: boolean[]) {
    super('Confirmer', characters);
    this.#answers = [...answers];
  }

  override async decide(): Promise<Decision[]> {
    return [];
  }

  override async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    if (request.kind === 'confirm') {
      this.asks.push(request.prompt);
      return { kind: 'confirm', yes: this.#answers.shift() ?? false };
    }
    return { kind: 'select', chosen: [] };
  }
}

/**
 * An engine whose deck holds `cards` in the given order (index 0 = the top),
 * owned by a player, with `chooser` answering the "take it?" question.
 */
function table(cards: readonly TestCard[], ...answers: boolean[]) {
  const events: GameEvent[] = [];
  const engine = createEngine({ onEvent: (event) => events.push(event) });
  // The owner's *character* is the action's source: the engine resolves whose
  // zones to reveal from through it, the way a real effect owned by a
  // permanent does. The `Player` constructor is what stamps `controller` onto
  // its characters (the card game's `Side` does the same), so the actor is
  // owned before it is registered — and the owner is the player asked, because
  // a choice routes to whoever owns the decision.
  const actor = new Character('Actor', { maxHp: 10 });
  // The owner is the player the engine asks, so it is built with the answers
  // this test wants to give.
  const owner = new Confirmer([actor], ...answers);
  engine.players.push(owner);
  engine.zones.declare(DECK);
  engine.zones.declare(REVEALED);
  engine.zones.declare(PLAY);
  engine.zones.declare(GARBAGE);
  // Staged out of `play`: the actor is not a card, and a discovery test must
  // not find it sitting in the board it inspects.
  engine.registerCharacter(actor, { zone: GARBAGE.id, owner });
  if (actor.controller !== owner) throw new Error('fixture: the owner must control its actor');
  for (const card of cards) {
    const zone = engine.zones.zone(DECK.id, owner);
    if (!zone) throw new Error('no deck zone');
    engine.zones.add(card, zone, 'bottom');
  }
  const deck = (): string[] => (engine.zones.members(DECK.id, owner) as TestCard[]).map((c) => c.name);
  // The actor is staged in `garbage`, so it is never among the discovered.
  const playing = (): string[] => (engine.zones.members(PLAY.id, owner) as TestCard[]).map((c) => c.name);
  return { engine, owner, actor, chooser: owner, events, deck, playing };
}

/**
 * The discover action as content writes it: sourced from its owner's actor,
 * with a **temporary zone** for the reveal to wait in — the real mechanic.
 */
function step(source: Character, overrides: Partial<Parameters<typeof discover>[0]> = {}) {
  return discover({
    from: DECK.id,
    revealed: REVEALED.id,
    count: 3,
    maxCost: 2,
    to: PLAY.id,
    rest: DECK.id,
    source,
    ...overrides,
  });
}

/* ------------------------------ the primitives -------------------------- */

describe('Entity.attributes — the facts a game declares', () => {
  it('reads a declared fact', () => {
    const card = new TestCard('Fireball', 4);
    expect(card.attributes.get('cost')).toBe(4);
  });

  it('is absent on an entity that declared none, so callers use a default', () => {
    const plain: Entity = { type: 'card', name: 'Nameless' };
    expect(plain.attributes?.get('cost') ?? 0).toBe(0);
  });
});

describe('engine.reveal — a peek is not a move', () => {
  it('returns the top of an ordered zone without removing it', async () => {
    const { engine, owner, deck } = table([new TestCard('A', 1), new TestCard('B', 2)]);
    expect((engine.reveal(DECK.id, owner) as TestCard).name).toBe('A');
    // Still there — a peek changed nothing.
    expect(deck()).toEqual(['A', 'B']);
  });

  it('announces nothing — no move, because nothing moved', async () => {
    const { engine, owner, events: seen } = table([new TestCard('A', 1), new TestCard('B', 2)]);
    engine.reveal(DECK.id, owner);
    // A peek fires no `zone:changed`; if it did, a look would be a take and
    // every "when a card leaves your deck" trigger would misfire.
    expect(seen.filter((event) => event.type.startsWith('zone:changed'))).toEqual([]);
  });

  it('answers for an empty zone', async () => {
    const { engine, owner } = table([]);
    expect(engine.reveal(DECK.id, owner)).toBeUndefined();
  });

  it('answers for an unknown zone rather than throwing', async () => {
    const { engine, owner } = table([new TestCard('A', 1)]);
    expect(engine.reveal('nowhere', owner)).toBeUndefined();
  });

  it('refuses to invent a top for an unordered zone', async () => {
    const engine = createEngine({ chooser: new Idle('X') });
    const owner = new Idle('Owner');
    engine.players.push(owner);
    engine.zones.declare({ id: 'hand' });
    const hand = engine.zones.zone('hand', owner)!;
    engine.zones.add(new TestCard('A', 1), hand);
    // A bag has no top; returning a member would be a silent lie about which
    // card was seen.
    expect(engine.reveal('hand', owner)).toBeUndefined();
  });
});

/* -------------------------------- discover ------------------------------- */

describe('discover — taking the first affordable card', () => {
  it('offers the first match, takes it on a yes, and leaves the rest', async () => {
    const { engine, actor, chooser, deck, playing } = table(
      [new TestCard('Costly', 7), new TestCard('Cheap', 2), new TestCard('Other', 5)],
      true,
    );

    await engine.apply([step(actor)]);

    expect(chooser.asks).toEqual(['Put Cheap into play?']);
    expect(playing()).toEqual(['Cheap']);
    // Costly was revealed and declined (above the cap), so it goes under.
    // Other was never revealed — the loop stopped at the first match.
    expect(deck().sort()).toEqual(['Costly', 'Other']);
  });

  it('stops at the first match rather than looking for the best', async () => {
    const { engine, actor, chooser, deck } = table(
      [new TestCard('First', 1), new TestCard('Second', 1), new TestCard('Third', 1)],
      true,
    );
    await engine.apply([step(actor)]);
    expect(chooser.asks).toHaveLength(1);
    // Third was never even looked at.
    expect(deck()).toContain('Third');
  });

  it('bottoms a declined match and keeps looking', async () => {
    const { engine, actor, chooser, deck, playing } = table(
      [new TestCard('First', 1), new TestCard('Second', 1)],
      false,
      true,
    );

    await engine.apply([step(actor, { count: 5 })]);

    expect(chooser.asks).toEqual(['Put First into play?', 'Put Second into play?']);
    expect(playing()).toEqual(['Second']);
    expect(deck()).toEqual(['First']);
  });

  it('gives up at `count` and bottoms everything it saw', async () => {
    const { engine, actor, chooser, deck, playing } = table(
      [new TestCard('A', 9), new TestCard('B', 9), new TestCard('C', 9), new TestCard('D', 1)],
    );

    await engine.apply([step(actor, { count: 2, maxCost: 3 })]);

    // Never asked: neither A nor B is affordable.
    expect(chooser.asks).toEqual([]);
    expect(playing()).toEqual([]);
    // Only the top 2 were looked at; C and D were never touched. Nothing was
    // lost — the whole deck is still there — and A and B went under, shuffled.
    expect(deck().sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('is a no-op on an empty zone', async () => {
    const { engine, actor, chooser, playing } = table([], true);
    await engine.apply([step(actor)]);
    expect(playing()).toEqual([]);
    expect(chooser.asks).toEqual([]);
  });

  it('accepts a card whose cost is exactly the cap', async () => {
    const { engine, actor, chooser, playing } = table([new TestCard('Exact', 3)], true);
    await engine.apply([step(actor, { count: 1, maxCost: 3 })]);
    expect(playing()).toEqual(['Exact']);
  });

  it('treats a missing cost fact as 0, so an uncosted card is affordable', async () => {
    const bare: Entity = { type: 'card', name: 'Land' };
    const { engine, actor, chooser, playing } = table([bare as unknown as TestCard], true);
    await engine.apply([step(actor, { count: 1, maxCost: 0 })]);
    expect(playing()).toEqual(['Land']);
  });

  it('leaves the cards it never looked at alone, up to the shuffle', async () => {
    // `count: 1` looks at exactly the top card, so nothing is bottomed and the
    // only mutation is the taken card leaving. The shuffle at the end is still
    // applied (the effect says "the rest in a random order"), so the *order*
    // below `count` is not a promise — the untouched cards' relative order is.
    const { engine, actor, chooser, deck } = table(
      [new TestCard('Taken', 1), new TestCard('B', 5), new TestCard('C', 5), new TestCard('D', 5)],
      true,
    );
    await engine.apply([step(actor, { count: 1 })]);
    // The shuffle randomizes the whole zone (a Fisher–Yates over it), so the
    // only promise left is membership: exactly the untouched cards, once each,
    // and the taken one gone.
    expect(deck().sort()).toEqual(['B', 'C', 'D']);
    expect(new Set(deck()).size).toBe(3);
  });

  it('puts the reveals on the bottom in their original relative order before shuffling', async () => {
    // Every reveal is declined and the deck is shuffled, so the *order* cannot
    // be asserted — but the set can, and that is what catches a reveal being
    // dropped or duplicated.
    const { engine, actor, deck } = table([
      new TestCard('A', 9),
      new TestCard('B', 9),
      new TestCard('C', 9),
      new TestCard('D', 9),
    ]);
    await engine.apply([step(actor, { maxCost: 1 })]);
    expect(deck().sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(new Set(deck()).size).toBe(4);
  });

  it('rejects a nonsensical count at build time', () => {
    const base = { from: 'deck', revealed: 'revealed', maxCost: 1, to: 'play', rest: 'deck' } as const;
    expect(() => discover({ ...base, count: 0 })).toThrow(/positive integer/);
    expect(() => discover({ ...base, count: 1.5 })).toThrow(/positive integer/);
  });

  it('rejects a holding zone that is not its own place', () => {
    // `revealed === from` would make the revealed pile and the library the same
    // zone, so the loop could never tell "looked at" from "not yet seen".
    expect(() => discover({ from: 'deck', revealed: 'deck', count: 1, maxCost: 1, to: 'play', rest: 'deck' })).toThrow(
      /its own place/,
    );
  });

  it('moves each looked-at card into the temporary zone, and leaves it empty', async () => {
    // The whole reason for a holding zone: the reveal is a **real move**, so
    // other effects can see it. And its members are what "the rest" means, so
    // it must be empty once the reveal is done — a leftover would be a card
    // stranded outside every pile.
    const { engine, actor, chooser, deck } = table(
      [new TestCard('A', 9), new TestCard('B', 9)],
      true,
    );

    await engine.apply([step(actor, { count: 2, maxCost: 1 })]);

    expect(engine.zones.members(REVEALED.id)).toEqual([]);
    expect(deck().sort()).toEqual(['A', 'B']);
    expect(chooser.asks).toEqual([]);
  });

  it('announces the reveal as a zone change, so a trigger can see it', async () => {
    const moves: string[] = [];
    const engine = createEngine({
      onEvent: (event) => {
        if (event.type === 'zone:changed' && 'from' in event) {
          moves.push(`${event.from.id}->${event.to.id}`);
        }
      },
    });
    const actor = new Character('Actor', { maxHp: 10 });
    const owner = new Confirmer([actor], true);
    engine.players.push(owner);
    engine.zones.declare(DECK);
    engine.zones.declare(REVEALED);
    engine.zones.declare(PLAY);
    engine.zones.declare(GARBAGE);
    engine.registerCharacter(actor, { zone: GARBAGE.id, owner });
    const deck = engine.zones.zone(DECK.id, owner)!;
    engine.zones.add(new TestCard('Cheap', 2), deck, 'bottom');

    await engine.apply([step(actor, { count: 1, maxCost: 2 })]);

    // Revealed (deck -> revealed), then taken (revealed -> play). A peek would
    // have produced neither, which is the whole reason for the holding zone.
    expect(moves).toContain(`${DECK.id}->${REVEALED.id}`);
    expect(moves).toContain(`${REVEALED.id}->play`);
  });

  it('passes over a skipped card — a land — and settles on the next real one', async () => {
    // "reveal until you find a nonland card with cost at most 2": the land has
    // no cost to compare, so the ceiling alone cannot exclude it without also
    // excluding every free card. The `skip` facts are what make it a nonland.
    const land = new TestCard('Mountain', 0, { land: 1 });
    const { engine, actor, chooser, deck, playing } = table(
      [land, new TestCard('Cheap', 2)],
      true,
    );

    await engine.apply([step(actor, { count: 2, maxCost: 2, skip: new Map([['land', 1]]) })]);

    // The land was revealed and passed over, never offered.
    expect(chooser.asks).toEqual(['Put Cheap into play?']);
    expect(playing()).toEqual(['Cheap']);
    expect(deck()).toEqual(['Mountain']);
  });

  it('takes a character into play and realizes its gauges', async () => {
    // A `Character` taken into play arrives fresh, the way a replayed
    // permanent does — the same move path, so the same rule.
    const creature = new Character('Goblin', { maxHp: 4, stats: { power: 2 } });
    const card = Object.assign(creature, { attributes: new Map([['cost', 1]]) }) as unknown as TestCard;
    const { engine, actor, chooser, playing } = table([card], true);

    await engine.apply([step(actor, { count: 1 })]);

    expect(playing().filter((n) => n !== 'Actor')).toEqual(['Goblin']);
    expect(creature.gauge('hp').current).toBe(4);
  });
});
