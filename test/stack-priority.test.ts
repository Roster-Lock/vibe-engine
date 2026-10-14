/**
 * The stack and priority (src/games/cards/stack.ts).
 *
 * MTG-style interaction on top of the zone system: casting is a move
 * `hand → stack`, resolving is `stack → active → play|garbage`, and
 * priority is a round-robin that resolves the top object once everyone
 * passes in succession.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  Player,
  auto,
  buff,
  damage,
  passiveActionModifier,
  type Action,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { CARD_ZONES } from '../src/games/cards/zones.js';
import {
  CardStack,
  PASS,
  abilityObject,
  put,
  type AbilityStackObject,
  type PriorityOwner,
  type PriorityRequest,
  type PriorityResponse,
  type StackObject,
} from '../src/games/cards/stack.js';
import { createEngine } from '../src/games/turn-based/index.js';

/**
 * A seat at the table: a player that can hold priority. `respond` is the
 * test's hook — unset means pass, which is also what a player that does not
 * implement `PriorityOwner` does.
 */
class Seat extends Player implements PriorityOwner {
  respond?: (request: PriorityRequest) => Promise<PriorityResponse>;
  async decide(): Promise<Decision[]> {
    return [];
  }
  async takePriority(request: PriorityRequest): Promise<PriorityResponse> {
    return this.respond ? this.respond(request) : PASS;
  }
}

/** A player that cannot hold priority at all — it always passes. */
class Idle extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** A spell card: an entity with no gauges to speak of. */
const spell = (name: string): Character => new Character(name, { maxHp: 0 });
/** A creature card, which does have gauges once it is in play. */
const creature = (name: string, hp: number): Character => new Character(name, { maxHp: hp, maxMana: 0 });

function table() {
  const events: GameEvent[] = [];
  const engine = createEngine({ seed: 'stack', onEvent: (event) => events.push(event) });
  for (const def of CARD_ZONES) engine.zones.declare(def);

  const hero = creature('Hero', 100);
  const foe = creature('Foe', 20);
  hero.team = 'you';
  foe.team = 'them';
  const you = new Seat('You', [hero], 'you');
  const them = new Seat('Them', [foe], 'them');
  engine.registerPlayers([you, them]);

  const stack = new CardStack(engine);
  /** Puts a card in a hand, the way a draw would. */
  const inHand = async (card: Character, owner: Player): Promise<Character> => {
    engine.registerCharacter(card);
    await engine.moveTo(card, 'hand', { owner });
    return card;
  };

  const bolt = (target: Character, controller: Player, card: Character): StackObject => ({
    kind: 'spell',
    card,
    name: card.name,
    controller,
    targets: [target],
    targetPattern: { who: 'any', count: 1 },
    destination: 'garbage',
    resolve: ({ targets }): Action[] => targets.map((t) => damage(t.gauge('hp'), 10, card)),
  });

  return { engine, stack, hero, foe, you, them, events, inHand, bolt };
}

/* ------------------------------- resolution ---------------------------- */

describe('casting and resolving', () => {
  it('casting moves the card to the stack; resolving runs it and sends it to the garbage', async () => {
    const t = table();
    const card = await t.inHand(spell('Bolt'), t.you);
    expect(await t.stack.cast(t.bolt(t.foe, t.you, card))).toBe(true);

    expect(t.engine.zones.zoneOf(card)?.id).toBe('stack');
    expect(t.stack.size).toBe(1);
    // On the stack is not in play, so the spell cannot be targeted.
    expect(t.engine.validTargets({ who: 'any', count: 1 }, t.hero)).not.toContain(card);

    const report = await t.stack.resolveTop();
    expect(report?.outcome).toBe('resolved');
    expect(t.foe.gauge('hp').current).toBe(10);
    expect(t.engine.zones.zoneOf(card)?.id).toBe('garbage');
    expect(t.stack.size).toBe(0);
  });

  it('a resolving card passes through active, and active is empty afterwards', async () => {
    const t = table();
    const card = await t.inHand(spell('Bolt'), t.you);
    const seen: string[] = [];
    const object: StackObject = {
      ...t.bolt(t.foe, t.you, card),
      resolve: ({ engine }) => {
        // While it resolves it is in `active` — so a spell counting "the
        // spells on the stack" does not count itself.
        seen.push(engine.zones.zoneOf(card)!.id);
        seen.push(`stack:${engine.zones.zone('stack')!.size}`);
        return [];
      },
    };
    await t.stack.cast(object);
    await t.stack.resolveTop();
    expect(seen).toEqual(['active', 'stack:0']);
    expect(t.engine.zones.zone('active')!.size).toBe(0);
  });

  it('a permanent resolves into play', async () => {
    const t = table();
    const card = await t.inHand(creature('Golem', 30), t.you);
    await t.stack.cast({
      kind: 'spell',
      card,
      name: 'Golem',
      controller: t.you,
      targets: [],
      destination: 'play',
      resolve: (): Action[] => [],
    });
    await t.stack.resolveTop();
    expect(t.engine.zones.zoneOf(card)?.id).toBe('play');
    expect(t.engine.isInPlay(card)).toBe(true);
    // And now it is targetable, where it was not on the stack.
    expect(t.engine.validTargets({ who: 'any', count: 1 }, t.hero)).toContain(card);
  });

  it('resolves top-down — last cast resolves first', async () => {
    const t = table();
    const order: string[] = [];
    for (const name of ['First', 'Second']) {
      const card = await t.inHand(spell(name), t.you);
      await t.stack.cast({
        kind: 'spell',
        card,
        name,
        controller: t.you,
        targets: [],
        destination: 'garbage',
        resolve: (): Action[] => {
          order.push(name);
          return [];
        },
      });
    }
    expect(t.stack.objects.map((o) => o.name)).toEqual(['Second', 'First']);
    await t.stack.resolveTop();
    await t.stack.resolveTop();
    expect(order).toEqual(['Second', 'First']);
  });
});

/* ------------------------- countering and fizzling --------------------- */

describe('leaving the stack without resolving', () => {
  it('a countered spell goes to the garbage and never runs', async () => {
    const t = table();
    const card = await t.inHand(spell('Bolt'), t.you);
    const object = t.bolt(t.foe, t.you, card);
    await t.stack.cast(object);

    expect(await t.stack.counter(object)).toBe(true);
    expect(t.stack.size).toBe(0);
    expect(t.engine.zones.zoneOf(card)?.id).toBe('garbage');
    expect(t.foe.gauge('hp').current).toBe(20); // never dealt

    expect(await t.stack.resolveTop()).toBeUndefined();
  });

  it('fizzles when every target became illegal', async () => {
    const t = table();
    const card = await t.inHand(spell('Bolt'), t.you);
    await t.stack.cast(t.bolt(t.foe, t.you, card));

    // The target leaves play while the spell waits — Magic's "countered on
    // resolution". The card never becomes active.
    await t.engine.moveTo(t.foe, 'hand', { owner: t.them });

    const report = await t.stack.resolveTop();
    expect(report?.outcome).toBe('fizzled');
    expect(report?.targets).toEqual([]);
    expect(t.foe.gauge('hp').current).toBe(20);
    expect(t.engine.zones.zoneOf(card)?.id).toBe('garbage');
  });

  it('a spell with surviving targets resolves against only those', async () => {
    const t = table();
    const other = creature('Other', 20);
    other.team = 'them';
    t.engine.registerCharacter(other);
    const card = await t.inHand(spell('Forked Bolt'), t.you);
    await t.stack.cast({
      ...t.bolt(t.foe, t.you, card),
      targets: [t.foe, other],
    });
    await t.engine.moveTo(t.foe, 'hand', { owner: t.them });

    const report = await t.stack.resolveTop();
    expect(report?.outcome).toBe('resolved');
    expect(report?.targets).toEqual([other]);
    expect(other.gauge('hp').current).toBe(10);
    expect(t.foe.gauge('hp').current).toBe(20);
  });

  it('a restriction that blocks the cast move keeps the object off the stack', async () => {
    const t = table();
    const card = await t.inHand(spell('Bolt'), t.you);
    await t.engine.addBuff(
      card,
      buff({
        name: 'Stuck in Hand',
        weight: 1,
        abilities: [
          passiveActionModifier({
            name: 'Stuck in Hand',
            // A replacement effect that refuses the destination: the card
            // stays where it is, so the cast does not take.
            transform: (action) =>
              action.type === 'move' && action.to.id === 'stack'
                ? { ...action, to: t.engine.zones.zone('hand', t.you)! }
                : action,
          }),
        ],
      }),
    );
    expect(await t.stack.cast(t.bolt(t.foe, t.you, card))).toBe(false);
    expect(t.stack.size).toBe(0);
    expect(t.engine.zones.zoneOf(card)?.id).toBe('hand');
  });
});

/* -------------------------------- priority ----------------------------- */

describe('priority', () => {
  it('all passing on an empty stack ends the window', async () => {
    const t = table();
    expect(await t.stack.runPriority([t.you, t.them])).toEqual([]);
  });

  it('resolves the top object once every player has passed in succession', async () => {
    const t = table();
    const card = await t.inHand(spell('Bolt'), t.you);
    await t.stack.cast(t.bolt(t.foe, t.you, card));

    const reports = await t.stack.runPriority([t.you, t.them]);
    expect(reports.map((r) => r.outcome)).toEqual(['resolved']);
    expect(t.foe.gauge('hp').current).toBe(10);
  });

  it('a response goes on top and resolves first — the counterspell case', async () => {
    const t = table();
    const bolt = await t.inHand(spell('Bolt'), t.you);
    const counter = await t.inHand(spell('Counterspell'), t.them);
    await t.stack.cast(t.bolt(t.foe, t.you, bolt));

    const resolved: string[] = [];
    /** Them responds once, with a counter aimed at whatever is beneath it. */
    t.them.respond = async ({ stack }) => {
        if (t.engine.zones.zoneOf(counter)?.id !== 'hand') return PASS;
        const victim = stack[0]!; // the top of the stack is the Bolt
        return put({
          kind: 'spell',
          card: counter,
          name: 'Counterspell',
          speed: 'instant', // a sorcery could never be a response

          controller: t.them,
          targets: [],
          destination: 'garbage',
          resolve: async (): Promise<Action[]> => {
            resolved.push('Counterspell');
            await t.stack.counter(victim);
            return [];
          },
        });
    };

    const reports = await t.stack.runPriority([t.you, t.them]);
    expect(resolved).toEqual(['Counterspell']);
    // The counter resolved first and took the Bolt with it: the Bolt never
    // resolved, and never dealt its damage.
    expect(reports.map((r) => r.object.name)).toEqual(['Counterspell']);
    expect(t.foe.gauge('hp').current).toBe(20);
    expect(t.engine.zones.zoneOf(bolt)?.id).toBe('garbage');
    expect(t.stack.size).toBe(0);
  });

  it('gives up rather than looping when a player never passes', async () => {
    const t = table();
    t.you.respond = async ({ player }) => {
        const card = spell('Endless');
        t.engine.registerCharacter(card);
        await t.engine.moveTo(card, 'hand', { owner: player });
        return put({
          kind: 'spell',
          card,
          name: 'Endless',
          speed: 'instant',
          controller: player,
          targets: [],
          destination: 'garbage',
          resolve: (): Action[] => [],
        });
    };
    await expect(t.stack.runPriority([t.you, t.them], { maxSteps: 20 })).rejects.toThrow(
      /never passes/,
    );
  });
});

/* ------------------------------- timing -------------------------------- */

describe('instant and sorcery speed', () => {
  const sorcery = (card: Character, controller: Player): StackObject => ({
    kind: 'spell',
    card,
    name: card.name,
    controller,
    targets: [],
    speed: 'sorcery',
    destination: 'garbage',
    resolve: (): Action[] => [],
  });
  const instant = (card: Character, controller: Player): StackObject => ({
    ...sorcery(card, controller),
    speed: 'instant',
  });

  it('a sorcery is legal only in its own main phase with an empty stack', async () => {
    const t = table();
    const card = await t.inHand(spell('Wrath'), t.you);
    const object = sorcery(card, t.you);
    const main = { activePlayer: t.you, mainPhase: true };

    expect(t.stack.canPut(object, t.you, main)).toBe(true);
    // Not your turn.
    expect(t.stack.canPut(object, t.them, main)).toBe(false);
    // Not a main phase.
    expect(t.stack.canPut(object, t.you, { activePlayer: t.you, mainPhase: false })).toBe(false);

    // Stack not empty — which is what stops a sorcery being a response.
    const other = await t.inHand(spell('Other'), t.you);
    await t.stack.cast(instant(other, t.you));
    expect(t.stack.canPut(object, t.you, main)).toBe(false);
  });

  it('an instant is legal in all of those', async () => {
    const t = table();
    const card = await t.inHand(spell('Bolt'), t.you);
    const object = instant(card, t.you);
    const other = await t.inHand(spell('Other'), t.you);
    await t.stack.cast(instant(other, t.you));

    expect(t.stack.canPut(object, t.them, { activePlayer: t.you, mainPhase: false })).toBe(true);
  });

  it('omitting a speed means sorcery — the restrictive default', async () => {
    const t = table();
    const card = await t.inHand(spell('Unmarked'), t.you);
    const object: StackObject = {
      kind: 'spell',
      card,
      name: 'Unmarked',
      controller: t.you,
      targets: [],
      destination: 'garbage',
      resolve: (): Action[] => [],
    };
    expect(t.stack.canPut(object, t.them, { activePlayer: t.you, mainPhase: true })).toBe(false);
  });

  it('a player that cannot hold priority simply passes', async () => {
    const t = table();
    const card = await t.inHand(spell('Bolt'), t.you);
    await t.stack.cast(t.bolt(t.foe, t.you, card));
    // `Idle` does not implement PriorityOwner — no implementation needed
    // for an opponent that never responds.
    const bystander = new Idle('Bystander', [], 'you');
    const reports = await t.stack.runPriority([t.you, bystander]);
    expect(reports.map((r) => r.outcome)).toEqual(['resolved']);
  });

  it('a player that offers an illegal play fails loudly', async () => {
    const t = table();
    const card = await t.inHand(spell('Wrath'), t.you);
    // Them tries a sorcery on You's turn.
    t.them.respond = async () => put(sorcery(card, t.them));
    await expect(
      t.stack.runPriority([t.you, t.them], { activePlayer: 0, maxSteps: 20 }),
    ).rejects.toThrow(/cannot put "Wrath" on the stack now/);
  });
});

/* -------------------------- abilities on the stack --------------------- */

describe('abilities on the stack', () => {
  const pinger = (source: Character, controller: Player, target: Character): AbilityStackObject => ({
    kind: 'ability',
    ability: abilityObject('Ping', source),
    name: 'Ping',
    controller,
    targets: [target],
    targetPattern: { who: 'any', count: 1 },
    speed: 'instant',
    resolve: ({ targets }): Action[] => targets.map((entity) => damage(entity.gauge('hp'), 5, source)),
  });

  it('an ability is placed on the stack, resolves, and ceases to exist', async () => {
    const t = table();
    const object = pinger(t.hero, t.you, t.foe);
    expect(await t.stack.stackObject(object)).toBe(true);

    // It occupies the stack as an entity, without being a card.
    expect(t.engine.zones.zone('stack')!.members).toContain(object.ability);
    expect(t.engine.zones.zone('stack')!.of('character')).toEqual([]);

    const report = await t.stack.resolveTop();
    expect(report?.outcome).toBe('resolved');
    expect(t.foe.gauge('hp').current).toBe(15);
    // Gone from the game, not sent to a zone — an ability has no destination.
    expect(t.engine.zones.zoneOf(object.ability)).toBeUndefined();
    expect(t.engine.garbage).toEqual([]);
  });

  it("the ability's source stays in play, and its damage is attributed to it", async () => {
    const t = table();
    const seen: string[] = [];
    const engineEvents = t.events;
    await t.stack.stackObject(pinger(t.hero, t.you, t.foe));
    await t.stack.resolveTop();
    for (const event of engineEvents) {
      if (event.type === 'gauge:changed' && 'source' in event && event.source.type === 'character') {
        seen.push(event.source.name);
      }
    }
    expect(seen).toContain('Hero');
    expect(t.engine.isInPlay(t.hero)).toBe(true);
  });

  it('an ability resolves even after its source has been destroyed', async () => {
    const t = table();
    await t.stack.stackObject(pinger(t.hero, t.you, t.foe));
    // The source dies while its ability waits — the whole reason the
    // ability is a separate object on the stack.
    await t.engine.moveTo(t.hero, 'garbage', { reason: 'destroyed' });
    expect(t.engine.isInPlay(t.hero)).toBe(false);

    const report = await t.stack.resolveTop();
    expect(report?.outcome).toBe('resolved');
    expect(t.foe.gauge('hp').current).toBe(15);
  });

  it('a countered ability also just ceases to exist', async () => {
    const t = table();
    const object = pinger(t.hero, t.you, t.foe);
    await t.stack.stackObject(object);
    expect(await t.stack.counter(object)).toBe(true);
    expect(t.engine.zones.zoneOf(object.ability)).toBeUndefined();
    expect(t.foe.gauge('hp').current).toBe(20);
  });

  it('a queued trigger goes on the stack before anyone gets priority, ignoring timing', async () => {
    const t = table();
    // Not a main phase, not this player's turn — a triggered ability obeys
    // neither (rule 603.3).
    t.stack.queueTriggered(pinger(t.foe, t.them, t.hero));
    expect(t.stack.pendingTriggered).toHaveLength(1);

    const reports = await t.stack.runPriority([t.you, t.them], {
      activePlayer: 0,
      mainPhase: false,
    });
    expect(reports.map((r) => r.object.name)).toEqual(['Ping']);
    expect(t.hero.gauge('hp').current).toBe(95);
    expect(t.stack.pendingTriggered).toHaveLength(0);
  });

  it('queued triggers stack in APNAP order — the active player first', async () => {
    const t = table();
    t.stack.queueTriggered({ ...pinger(t.foe, t.them, t.hero), name: 'Theirs' });
    t.stack.queueTriggered({ ...pinger(t.hero, t.you, t.foe), name: 'Yours' });

    await t.stack.flushTriggered([t.you, t.them], t.you);
    // Yours was stacked first, so Theirs is on top and resolves first.
    expect(t.stack.objects.map((o) => o.name)).toEqual(['Theirs', 'Yours']);
  });
});

/* ------------------------ triggers on the stack ------------------------ */

describe('triggers are respondable to', () => {
  /** A table whose engine hands its triggers to the stack. */
  function wired() {
    const events: GameEvent[] = [];
    let stack: CardStack;
    const engine = createEngine({
      seed: 'defer',
      onEvent: (event) => events.push(event),
      // The stack needs the engine and the engine needs the stack, so the
      // scheduler is resolved on first use.
      scheduler: {
        enqueue: (ready, event) => stack.scheduler().enqueue(ready, event),
        get pending() {
          return stack.scheduler().pending;
        },
        drain: (maxRuns) => stack.scheduler().drain(maxRuns),
      },
    });
    stack = new CardStack(engine);
    for (const def of CARD_ZONES) engine.zones.declare(def);

    const hero = creature('Hero', 100);
    const foe = creature('Foe', 100);
    hero.team = 'you';
    foe.team = 'them';
    const you = new Seat('You', [hero], 'you');
    const them = new Seat('Them', [foe], 'them');
    engine.registerPlayers([you, them]);
    return { engine, stack, hero, foe, you, them, events };
  }

  /** "Whenever this character is damaged, deal 3 back." */
  const thorns = (owner: Character) =>
    buff({
      name: 'Thorns',
      weight: 1,
      abilities: [
        auto({
          name: 'Thorns',
          event: 'character:survived',
          when: (ctx) => ctx.event.character === owner,
          targets: () => [],
          cast: (ctx): Action[] => {
            const attacker = ctx.event.changes
              .map((change) => ('source' in change ? change.source : undefined))
              .find((source) => source?.type === 'character') as Character | undefined;
            return attacker ? [damage(attacker.gauge('hp'), 3, owner)] : [];
          },
        }),
      ],
    });

  it('a trigger waits on the stack instead of resolving immediately', async () => {
    const t = wired();
    await t.engine.addBuff(t.foe, thorns(t.foe));
    await t.engine.apply([damage(t.foe.gauge('hp'), 10, t.hero)]);

    // The damage landed, but Thorns has not fired — it is queued, waiting
    // for a priority window. Previously it would already have resolved.
    expect(t.foe.gauge('hp').current).toBe(90);
    expect(t.hero.gauge('hp').current).toBe(100);
    expect(t.stack.pendingTriggered.map((o) => o.name)).toEqual(['Thorns']);

    const reports = await t.stack.runPriority([t.you, t.them]);
    expect(reports.map((r) => r.object.name)).toEqual(['Thorns']);
    expect(t.hero.gauge('hp').current).toBe(97);
  });

  it('a player can counter a trigger before it resolves', async () => {
    const t = wired();
    await t.engine.addBuff(t.foe, thorns(t.foe));
    const counter = creature('Stifle', 0);
    t.engine.registerCharacter(counter);
    await t.engine.moveTo(counter, 'hand', { owner: t.you });

    await t.engine.apply([damage(t.foe.gauge('hp'), 10, t.hero)]);

    let used = false;
    t.you.respond = async ({ player, stack }) => {
        if (used || player !== t.you || stack.length === 0) return PASS;
        used = true;
        const victim = stack[0]!;
        return put({
          kind: 'spell',
          card: counter,
          name: 'Stifle',
          controller: t.you,
          targets: [],
          speed: 'instant',
          destination: 'garbage',
          resolve: async (): Promise<Action[]> => {
            await t.stack.counter(victim);
            return [];
          },
        });
    };

    const reports = await t.stack.runPriority([t.you, t.them]);
    expect(reports.map((r) => r.object.name)).toEqual(['Stifle']);
    // Thorns was countered on the stack and never dealt its 3.
    expect(t.hero.gauge('hp').current).toBe(100);
  });

  it('a trigger with no controller runs inline, as it always did', async () => {
    const t = wired();
    const loner = creature('Loner', 50); // registered, but no player owns it
    t.engine.registerCharacter(loner);
    await t.engine.addBuff(loner, thorns(loner));
    await t.engine.apply([damage(loner.gauge('hp'), 10, t.hero)]);

    // Declined by the sink, so the engine ran it the moment it fired.
    expect(t.stack.pendingTriggered).toHaveLength(0);
    expect(t.hero.gauge('hp').current).toBe(97);
  });
});
