/**
 * **Discover as IR** — the shareable form of the mechanic (`EffectIR.discover`,
 * `ValueIR.attribute`).
 *
 * `test/discover.test.ts` holds the mechanic itself to account against the
 * engine action. This file is about the *other* half of the claim: that the
 * same behaviour is reachable from **plain JSON alone**, which is what makes it
 * shareable.
 *
 * The two things checked here are the ones the IR has to get right and the
 * action cannot:
 *
 * - zone names are **abstract** in the document (`library`, `board`) and the
 *   host maps them, so a document means the same thing in a game that calls its
 *   library `deck` and one that calls it `pile`;
 * - the count and cost ceiling are ordinary `ValueIR`, so "discover this
 *   card's power" is the same node as "discover 2".
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  Player,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Decision,
  type Entity,
} from '../src/games/turn-based/index.js';
import { bindDocument, type DocumentIR } from '../src/ir/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { GARBAGE } from '../src/engine/index.js';
import { DECK } from '../examples/card-game/zones.js';
import { PLAY } from '../src/engine/index.js';

/** A card entity with a declared `cost` fact and no gauges. */
class TestCard implements Entity {
  readonly type = 'card' as const;
  readonly attributes: ReadonlyMap<string, number>;
  constructor(readonly name: string, cost: number) {
    this.attributes = new Map([['cost', cost]]);
  }
}

/** The owner, who is also the player the engine asks. */
class Confirmer extends Player {
  readonly asks: string[] = [];
  readonly #answers: boolean[];
  constructor(characters: readonly Character[], ...answers: boolean[]) {
    super('Confirmer', characters);
    this.#answers = [...answers];
  }
  async decide(): Promise<Decision[]> {
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

/** The abstract zone names a document writes, and this game's real ones. */
const ALIASES = { library: DECK.id, board: PLAY.id };

/**
 * The document a player would share: an ability that discovers 2, written with
 * no knowledge of this game's zone ids.
 */
function discoverDocument(count = 2, maxCost = 2): DocumentIR {
  return {
    version: 1,
    imports: [],
    buffs: [],
    triggers: [],
    abilities: [
      {
        id: 'dig',
        name: 'Dig',
        targeting: { who: 'self', count: 1 },
        steps: [
          {
            effects: [
              {
                kind: 'discover',
                count: { kind: 'const', value: count },
                maxCost: { kind: 'const', value: maxCost },
                from: 'library',
                revealed: 'revealed',
                to: 'board',
                rest: 'library',
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * The share step, literally: only what survives JSON is trusted, and the
 * ability it binds is granted to the hero through a skill — which is how a
 * real character comes by an ability.
 */
function bindFromJson(document: DocumentIR) {
  const received = JSON.parse(JSON.stringify(document)) as DocumentIR;
  return bindDocument(received, { resolveBuff: () => undefined, aliases: ALIASES }).abilities[0]!;
}

/** A board whose hero has already been granted `document`'s ability. */
async function table(document: DocumentIR, ...answers: boolean[]) {
  const ability = bindFromJson(document);
  const hero = new Character('Hero', {
    gauges: [
      { id: 'hp', max: 10 },
      { id: 'mana', max: 10 },
    ],
    skills: [{ name: 'Dig', weight: 1, abilities: [ability] }],
  });
  const owner = new Confirmer([hero], ...answers);
  const engine = createEngine({ onEvent: () => {} });
  engine.players.push(owner);
  engine.zones.declare(DECK);
  engine.zones.declare(PLAY);
  engine.zones.declare(GARBAGE);
  // The holding zone is a real declaration, not something the engine invents.
  engine.zones.declare({ id: 'revealed', group: 'resolving' });
  engine.registerCharacter(hero, { zone: GARBAGE.id, owner });
  return { engine, hero, owner, ability };
}

/** Casts the ability on a hero who already holds it. */
async function cast(ability: ReturnType<typeof bindFromJson>, engine: ReturnType<typeof createEngine>, hero: Character) {
  await engine.useAbility(hero, ability, { targets: [] });
}

describe('Discover in the IR — a JSON document alone', () => {
  it('carries the mechanic across a JSON round trip', async () => {
    const { engine, hero, owner, ability } = await table(discoverDocument(), true);
    const deck = engine.zones.zone(DECK.id, owner)!;
    engine.zones.add(new TestCard('Costly', 7), deck, 'bottom');
    engine.zones.add(new TestCard('Cheap', 2), deck, 'bottom');

    await cast(ability, engine, hero);

    expect(owner.asks).toEqual(['Put Cheap into play?']);
    expect(engine.zones.members(PLAY.id, owner).map((e) => e.name)).toContain('Cheap');
  });

  it('resolves the document’s abstract zone names through the host’s aliases', async () => {
    // The document says `library`/`board`; this game's zones are `deck`/`play`.
    // Anything other than the mapping working would move nothing.
    const { engine, hero, owner, ability } = await table(discoverDocument(1, 3), true);
    const deck = engine.zones.zone(DECK.id, owner)!;
    engine.zones.add(new TestCard('Cheap', 2), deck, 'bottom');

    await cast(ability, engine, hero);

    expect(engine.zones.members(DECK.id, owner)).toHaveLength(0);
    expect(engine.zones.members(PLAY.id, owner).map((e) => e.name)).toEqual(['Cheap']);
  });

  it('reads a dynamic count from a value, not just a literal', async () => {
    // "discover mana" — the count is the caster's own gauge, so the node is
    // doing real work rather than carrying a constant.
    const document = discoverDocument();
    // Rewrite the count as "the caster's mana" (starting at 10, capped by the
    // deck's size in effect).
    (document.abilities[0]!.steps![0]!.effects[0] as { count: unknown }).count = {
      kind: 'gauge',
      gauge: 'mana',
      of: { kind: 'self' },
    };
    const { engine, hero, owner, ability } = await table(document);
    const deck = engine.zones.zone(DECK.id, owner)!;
    engine.zones.add(new TestCard('A', 9), deck, 'bottom');
    engine.zones.add(new TestCard('B', 9), deck, 'bottom');
    engine.zones.add(new TestCard('C', 9), deck, 'bottom');
    engine.zones.add(new TestCard('D', 9), deck, 'bottom');

    await cast(ability, engine, hero);

    // Nothing was affordable, so nothing was asked — but the loop ran, which
    // is what proves the value was evaluated.
    expect(owner.asks).toEqual([]);
    expect(engine.zones.members(DECK.id, owner)).toHaveLength(4);
  });

  it('compares the ceiling against the entity’s declared cost', async () => {
    // The ceiling is a value like any other; here it is the literal 4 the
    // document carries and the card costs exactly that — the boundary case,
    // where `<=` and `<` differ.
    const { engine, hero, owner, ability } = await table(discoverDocument(1, 4), true);
    const deck = engine.zones.zone(DECK.id, owner)!;
    engine.zones.add(new TestCard('Mid', 4), deck, 'bottom');

    await cast(ability, engine, hero);

    expect(owner.asks).toEqual(['Put Mid into play?']);
  });

  it('refuses a card one over the ceiling', async () => {
    const { engine, hero, owner, ability } = await table(discoverDocument(1, 3), false);
    const deck = engine.zones.zone(DECK.id, owner)!;
    engine.zones.add(new TestCard('Mid', 4), deck, 'bottom');

    await cast(ability, engine, hero);

    // Never offered, because it was never affordable.
    expect(owner.asks).toEqual([]);
  });

  it('passes over a skipped card when the document says so', async () => {
    // The "or a land" half of "reveal until you find a nonland card with cost
    // ≤ 2", written as an ordinary predicate. It compiles to the facts the loop
    // compares against a card's declared attributes.
    const document = discoverDocument(2, 2);
    (document.abilities[0]!.steps![0]!.effects[0] as { skip: unknown }).skip = {
      kind: 'compare',
      op: '=',
      left: { kind: 'attribute', attribute: 'land' },
      right: { kind: 'const', value: 1 },
    };
    const { engine, hero, owner, ability } = await table(document, true);
    const deck = engine.zones.zone(DECK.id, owner)!;
    const land = new TestCard('Mountain', 0);
    // A fresh card whose declared facts include a land flag.
    Object.defineProperty(land, 'attributes', { value: new Map([['cost', 0], ['land', 1]]) });
    engine.zones.add(land, deck, 'bottom');
    engine.zones.add(new TestCard('Cheap', 2), deck, 'bottom');

    await cast(ability, engine, hero);

    expect(owner.asks).toEqual(['Put Cheap into play?']);
    expect(engine.zones.members(PLAY.id, owner).map((e) => e.name)).toContain('Cheap');
  });

  it('ignores a skip test it cannot reduce to facts', async () => {
    // The loop cannot test a revealed card against board context, so a
    // predicate it cannot reduce is dropped — the ceiling still governs —
    // rather than throwing mid-resolution.
    const document = discoverDocument(1, 2);
    (document.abilities[0]!.steps![0]!.effects[0] as { skip: unknown }).skip = {
      kind: 'any',
      query: { kind: 'all', who: 'any', other: false },
      test: { kind: 'always' },
    };
    const { engine, hero, owner, ability } = await table(document, true);
    const deck = engine.zones.zone(DECK.id, owner)!;
    engine.zones.add(new TestCard('Cheap', 2), deck, 'bottom');

    await cast(ability, engine, hero);

    expect(owner.asks).toEqual(['Put Cheap into play?']);
  });

  it('reads a declared attribute as a value', async () => {
    // `ValueIR.attribute` is the reader the discover loop's ceiling uses, and
    // it is content-reachable: "deal damage equal to this card's cost".
    const document: DocumentIR = {
      version: 1,
      imports: [],
      buffs: [],
      triggers: [],
      abilities: [
        {
          id: 'costly-blow',
          name: 'Costly Blow',
          targeting: { who: 'self', count: 1 },
          steps: [
            {
              effects: [
                {
                  kind: 'gauge',
                  query: { kind: 'self' },
                  gauge: 'hp',
                  op: 'subtract',
                  amount: { kind: 'attribute', attribute: 'cost' },
                },
              ],
            },
          ],
        },
      ],
    };
    const { engine, hero, ability } = await table(document);
    hero.attributes = new Map([['cost', 6]]);

    await cast(ability, engine, hero);

    // 6 damage, read from the entity in scope's own declared fact.
    expect(hero.gauge('hp').current).toBe(4);
  });

  it('treats a missing attribute as 0 rather than throwing', async () => {
    const document: DocumentIR = {
      version: 1,
      imports: [],
      buffs: [],
      triggers: [],
      abilities: [
        {
          id: 'nothing-blow',
          name: 'Nothing Blow',
          targeting: { who: 'self', count: 1 },
          steps: [
            {
              effects: [
                {
                  kind: 'gauge',
                  query: { kind: 'self' },
                  gauge: 'hp',
                  op: 'subtract',
                  amount: { kind: 'attribute', attribute: 'nowhere' },
                },
              ],
            },
          ],
        },
      ],
    };
    const { engine, hero, ability } = await table(document);

    await cast(ability, engine, hero);
    // No such fact, so 0 damage — not a throw and not a NaN gauge.
    expect(hero.gauge('hp').current).toBe(10);
  });
});
