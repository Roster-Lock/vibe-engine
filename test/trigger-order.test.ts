/**
 * Ordering simultaneous triggers (Magic rule 603.3b).
 *
 * When several abilities trigger at once, each player chooses the order
 * **their own** go on the stack — the active player first, then each other
 * player in turn order. The order is stack order, so the last one put on
 * resolves first, which is why a player's choice is observable.
 */
import { describe, expect, it } from 'vitest';
import {
  CardStack,
  abilityObject,
  isTriggerOrderer,
  type AbilityStackObject,
  type TriggerOrderRequest,
} from '../src/games/cards/stack.js';
import { CARD_ZONES } from '../src/games/cards/zones.js';
import { Character, Player, createEngine, type Decision } from '../src/games/turn-based/index.js';

class Seat extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** A seat that orders its triggers with a scripted policy. */
class OrderingSeat extends Seat {
  calls = 0;
  policy: (triggers: readonly AbilityStackObject[]) => readonly AbilityStackObject[] = (t) => t;

  async orderTriggers(request: TriggerOrderRequest): Promise<readonly AbilityStackObject[]> {
    this.calls += 1;
    return this.policy(request.triggers);
  }
}

function table() {
  const engine = createEngine({ seed: 'order' });
  for (const def of CARD_ZONES) engine.zones.declare(def);

  const heroA = new Character('Hero A', { maxHp: 20, maxMana: 0 });
  const heroB = new Character('Hero B', { maxHp: 20, maxMana: 0 });
  heroA.team = 'a';
  heroB.team = 'b';
  const alice = new OrderingSeat('Alice', [heroA], 'a');
  const bob = new Seat('Bob', [heroB], 'b');
  engine.registerPlayers([alice, bob]);

  const stack = new CardStack(engine);
  /** A trigger that records when it resolves. */
  const trigger = (name: string, controller: Player, source: Character, log: string[]): AbilityStackObject => ({
    kind: 'ability',
    ability: abilityObject(name, source),
    name,
    controller,
    targets: [],
    resolve: async () => {
      log.push(name);
      return [];
    },
  });

  /** Queues, flushes, and resolves everything — returns the resolution order. */
  const run = async (objects: AbilityStackObject[], active: Player): Promise<string[]> => {
    for (const object of objects) stack.queueTriggered(object);
    await stack.flushTriggered([alice, bob], active);
    while (stack.size > 0) await stack.resolveTop();
    return [];
  };

  return { engine, stack, alice, bob, heroA, heroB, trigger, run };
}

describe('ordering simultaneous triggers', () => {
  it('lets a player order their own triggers, and resolves the last one first', async () => {
    const t = table();
    const log: string[] = [];
    const first = t.trigger('First', t.alice, t.heroA, log);
    const second = t.trigger('Second', t.alice, t.heroA, log);

    // Default: table order on the stack, so `Second` is on top.
    await t.run([first, second], t.alice);
    expect(log).toEqual(['Second', 'First']);
    expect(t.alice.calls).toBe(1);
  });

  it('honours the order the player chose', async () => {
    const t = table();
    const log: string[] = [];
    const first = t.trigger('First', t.alice, t.heroA, log);
    const second = t.trigger('Second', t.alice, t.heroA, log);
    // "Put First on top": returned last, so it resolves first.
    t.alice.policy = (triggers) => [...triggers].reverse();

    await t.run([first, second], t.alice);
    expect(log).toEqual(['First', 'Second']);
  });

  it('does not ask about a single trigger', async () => {
    const t = table();
    const log: string[] = [];
    await t.run([t.trigger('Only', t.alice, t.heroA, log)], t.alice);
    expect(t.alice.calls).toBe(0);
  });

  it('is APNAP across players: the last player to stack resolves first', async () => {
    const t = table();
    const log: string[] = [];
    const mine = t.trigger('Alice:1', t.alice, t.heroA, log);
    const theirs = t.trigger('Bob:1', t.bob, t.heroB, log);

    // Alice is the active player, so hers go on first and Bob's resolve first.
    await t.run([theirs, mine], t.alice);
    expect(log).toEqual(['Bob:1', 'Alice:1']);

    // Turn order is the only thing that changed.
    log.length = 0;
    const mine2 = t.trigger('Alice:2', t.alice, t.heroA, log);
    const theirs2 = t.trigger('Bob:2', t.bob, t.heroB, log);
    await t.run([mine2, theirs2], t.bob);
    expect(log).toEqual(['Alice:2', 'Bob:2']);
  });

  it('only asks the player whose triggers they are', async () => {
    const t = table();
    const log: string[] = [];
    t.alice.policy = (triggers) => [...triggers].reverse();
    await t.run(
      [
        t.trigger('A1', t.alice, t.heroA, log),
        t.trigger('A2', t.alice, t.heroA, log),
        t.trigger('B1', t.bob, t.heroB, log),
      ],
      t.alice,
    );
    // Alice was asked once (she has two); Bob was never asked (he has one).
    expect(t.alice.calls).toBe(1);
    expect(isTriggerOrderer(t.bob)).toBe(false);
  });

  it('rejects an answer that is not the same triggers', async () => {
    const t = table();
    const log: string[] = [];
    const first = t.trigger('First', t.alice, t.heroA, log);
    const second = t.trigger('Second', t.alice, t.heroA, log);
    t.alice.policy = () => [first];

    for (const object of [first, second]) t.stack.queueTriggered(object);
    await expect(t.stack.flushTriggered([t.alice, t.bob], t.alice)).rejects.toThrow(
      /ordered triggers into 1 object\(s\) that are not the 2/,
    );
  });

  it('rejects an answer that duplicates one', async () => {
    const t = table();
    const log: string[] = [];
    const first = t.trigger('First', t.alice, t.heroA, log);
    const second = t.trigger('Second', t.alice, t.heroA, log);
    t.alice.policy = () => [first, first];

    for (const object of [first, second]) t.stack.queueTriggered(object);
    await expect(t.stack.flushTriggered([t.alice, t.bob], t.alice)).rejects.toThrow(/not the 2/);
  });
});
