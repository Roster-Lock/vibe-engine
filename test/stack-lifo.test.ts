/**
 * The stack is **LIFO, always**.
 *
 * Not "usually", and not "in the common case": the last object put on is the
 * first to resolve, in every path — a response before the spell it answered,
 * a trigger before the spell that raised it, the last player to stack before
 * the others. These tests exist because that is an invariant a refactor can
 * quietly break (swap `pop` for `shift`, "fix" `objects` to stop reversing)
 * and every other test would keep passing while the game got the wrong
 * answer.
 */
import { describe, expect, it } from 'vitest';
import {
  CardStack,
  PASS,
  abilityObject,
  put,
  type PriorityOwner,
  type PriorityRequest,
  type PriorityResponse,
  type StackObject,
} from '../src/games/cards/stack.js';
import { CARD_ZONES } from '../examples/card-game/zones.js';
import { Character, Player, createEngine, type Decision } from '../src/games/turn-based/index.js';

class Seat extends Player implements PriorityOwner {
  async decide(): Promise<Decision[]> {
    return [];
  }
  async takePriority(_request: PriorityRequest): Promise<PriorityResponse> {
    return PASS;
  }
}

function table() {
  const engine = createEngine({ seed: 'lifo' });
  for (const def of CARD_ZONES) engine.zones.declare(def);
  const heroA = new Character('Hero A', { maxHp: 20, maxMana: 0 });
  const heroB = new Character('Hero B', { maxHp: 20, maxMana: 0 });
  heroA.team = 'a';
  heroB.team = 'b';
  const you = new Seat('You', [heroA], 'a');
  const them = new Seat('Them', [heroB], 'b');
  engine.registerPlayers([you, them]);
  const stack = new CardStack(engine);

  /** A spell whose resolution is recorded. */
  const spell = (name: string, log: string[]): StackObject => {
    const card = new Character(name, { maxHp: 0 });
    engine.registerCharacter(card);
    return {
      kind: 'spell',
      card,
      name,
      controller: you,
      targets: [],
      destination: 'garbage',
      resolve: async () => {
        log.push(name);
        return [];
      },
    };
  };

  /** An ability whose resolution is recorded. */
  const ability = (name: string, log: string[]): StackObject => ({
    kind: 'ability',
    ability: abilityObject(name, heroA),
    name,
    controller: you,
    targets: [],
    resolve: async () => {
      log.push(name);
      return [];
    },
  });

  return { engine, stack, you, them, spell, ability };
}

/** Puts objects on the stack in the order given, ignoring legality windows. */
async function stackThem(stack: CardStack, objects: readonly StackObject[]): Promise<void> {
  for (const object of objects) await stack.stackObject(object);
}

describe('the stack is LIFO', () => {
  it('exposes the stack top-first, and `top` is the last one put on', async () => {
    const t = table();
    const log: string[] = [];
    const first = t.spell('First', log);
    const second = t.spell('Second', log);
    await stackThem(t.stack, [first, second]);

    // Top first — the resolution order, not the order they were cast.
    expect(t.stack.objects.map((o) => o.name)).toEqual(['Second', 'First']);
    expect(t.stack.top?.name).toBe('Second');
    // ...and it is a copy: a caller cannot walk or mutate the real stack.
    expect(t.stack.objects).not.toBe(t.stack.objects);
  });

  it('resolves last-in-first-out', async () => {
    const t = table();
    const log: string[] = [];
    await stackThem(t.stack, [t.spell('First', log), t.spell('Second', log)]);

    while (t.stack.size > 0) await t.stack.resolveTop();
    expect(log).toEqual(['Second', 'First']);
  });

  it('resolves a trigger put on top of a spell before the spell', async () => {
    const t = table();
    const log: string[] = [];
    const bolt = t.spell('Bolt', log);
    await stackThem(t.stack, [bolt]);

    // A trigger goes on top of what raised it, so it resolves first.
    await t.stack.stackObject(t.ability('Trigger', log));
    expect(t.stack.objects.map((o) => o.name)).toEqual(['Trigger', 'Bolt']);

    while (t.stack.size > 0) await t.stack.resolveTop();
    expect(log).toEqual(['Trigger', 'Bolt']);
  });

  it('keeps the priority round-robin LIFO too', async () => {
    const t = table();
    const log: string[] = [];
    const first = t.spell('First', log);
    await stackThem(t.stack, [first]);

    // The other player answers through a priority window, at instant speed
    // (a sorcery could not: the stack is not empty).
    let taken = false;
    t.them.takePriority = async (): Promise<PriorityResponse> => {
      if (taken) return PASS;
      taken = true;
      return put({ ...t.spell('Answer', log), speed: 'instant' });
    };

    await t.stack.runPriority([t.you, t.them], { activePlayer: 0 });
    // The answer was on top, so it resolved before the spell it answered.
    expect(log).toEqual(['Answer', 'First']);
  });

  it('counters from the middle without disturbing the rest', async () => {
    const t = table();
    const log: string[] = [];
    const bottom = t.spell('Bottom', log);
    const middle = t.spell('Middle', log);
    const top = t.spell('Top', log);
    await stackThem(t.stack, [bottom, middle, top]);
    expect(t.stack.objects.map((o) => o.name)).toEqual(['Top', 'Middle', 'Bottom']);

    await t.stack.counter(middle);
    expect(t.stack.objects.map((o) => o.name)).toEqual(['Top', 'Bottom']);

    while (t.stack.size > 0) await t.stack.resolveTop();
    expect(log).toEqual(['Top', 'Bottom']); // Middle never resolved
  });
});
