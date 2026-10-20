/**
 * Zones (src/engine/zone.ts, docs/design/15-zones.md).
 *
 * The engine's `play` and `garbage` are no longer two `Set<Character>`
 * fields — they are ordinary declared zones in one registry, and a game
 * declares its own alongside them. These tests cover the registry's
 * invariant (every registered entity is in exactly one zone), the
 * declaration fields, and the `zone:changed` events a move announces.
 *
 * The other 550-odd tests are the regression suite for the swap itself:
 * destroy, targeting, win/lose and the SBA loop all read zone membership
 * now, and none of their expectations changed.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  Player,
  ZoneRegistry,
  buff,
  damage,
  move,
  passiveActionModifier,
  restriction,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { isDeath, leftPlay } from '../src/games/turn-based/index.js';
import { ACTIVE, CARD_ZONES, DECK, HAND, REVEALED, STACK } from '../examples/card-game/zones.js';
import { createEngine } from '../src/games/turn-based/index.js';

class Idle extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

const char = (name: string, maxHp = 100): Character => new Character(name, { maxHp, maxMana: 10 });

/* ------------------------------ the registry --------------------------- */

describe('ZoneRegistry', () => {
  it('ships play and garbage declared', () => {
    const registry = new ZoneRegistry();
    expect(registry.zone('play')?.targetable).toBe(true);
    expect(registry.unownedZone('garbage')?.targetable).toBe(false);
    expect(registry.unownedZone('garbage')?.group).toBe('removed');
  });

  it('keeps every entity in exactly one zone', () => {
    const registry = new ZoneRegistry();
    const a = char('A');
    registry.add(a, registry.zone('play')!);
    expect(registry.zoneOf(a)?.id).toBe('play');
    expect(registry.members('play')).toEqual([a]);

    registry.move(a, registry.unownedZone('garbage')!);
    expect(registry.zoneOf(a)?.id).toBe('garbage');
    expect(registry.members('play')).toEqual([]);
    expect(registry.unownedZone('garbage')!.members).toEqual([a]);
  });

  it('preserves registration order independently of zone membership', () => {
    const registry = new ZoneRegistry();
    const [a, b, c] = [char('A'), char('B'), char('C')];
    for (const entity of [a, b, c]) registry.add(entity, registry.zone('play')!);
    registry.move(a, registry.unownedZone('garbage')!);
    registry.move(a, registry.zone('play')!);
    // A went out and came back; `entities` is still registration order,
    // which trigger ordering and target-pool order depend on.
    expect(registry.entities).toEqual([a, b, c]);
  });

  it('reports a no-op move as undefined, so events can announce only changes', () => {
    const registry = new ZoneRegistry();
    const a = char('A');
    registry.add(a, registry.zone('play')!);
    expect(registry.move(a, registry.zone('play')!)).toBeUndefined();
    expect(registry.move(char('Stranger'), registry.zone('play')!)).toBeUndefined();
  });

  it('refuses a conflicting re-declaration but allows an identical one', () => {
    const registry = new ZoneRegistry();
    registry.declare(DECK);
    expect(() => registry.declare(DECK)).not.toThrow();
    expect(() => registry.declare({ ...DECK, visibility: 'public' })).toThrow(/different shape/);
  });
});

/* ---------------------------- declared zones --------------------------- */

describe('declared zones', () => {
  const registry = (): ZoneRegistry => {
    const r = new ZoneRegistry();
    for (const def of CARD_ZONES) r.declare(def);
    return r;
  };

  it('gives a per-player zone one instance per player', () => {
    const r = registry();
    const you = new Idle('You', []);
    const them = new Idle('Them', []);
    const yourHand = r.zone('hand', you)!;
    const theirHand = r.zone('hand', them)!;
    expect(yourHand).not.toBe(theirHand);
    expect(yourHand.owner).toBe(you);
    expect(r.zone('hand', you)).toBe(yourHand); // stable across lookups
    // Asking for a per-player zone with no owner returns nothing rather
    // than guessing which player's.
    expect(r.zone('hand')).toBeUndefined();
  });

  it('an ordered zone addresses top and bottom', () => {
    const r = registry();
    const you = new Idle('You', []);
    const deck = r.zone('deck', you)!;
    const [a, b, c] = [char('A'), char('B'), char('C')];
    r.add(a, deck);
    r.add(b, deck, 'top');
    r.add(c, deck, 'bottom');
    expect(deck.members.map((m) => m.name)).toEqual(['B', 'A', 'C']);
    expect(deck.top?.name).toBe('B');
  });

  it("a deck is hidden even from its owner; a hand is the owner's", () => {
    const r = registry();
    expect(r.zone('deck', new Idle('You', []))!.visibility).toBe('hidden');
    expect(r.zone('hand', new Idle('You', []))!.visibility).toBe('owner');
    expect(r.zone('stack')!.visibility).toBe('public');
  });

  it('enforces a capacity — the active zone holds one resolving object', () => {
    const r = registry();
    const active = r.zone('active')!;
    r.add(char('Spell'), active);
    expect(() => r.add(char('Another'), active)).toThrow(/maximum 1/);
  });

  it('groups zones into families so generic references stay possible', () => {
    const r = registry();
    // "anything waiting to resolve, resolving, or revealed while it resolves" —
    // without a group, content would have to enumerate zone names it cannot
    // know about. `revealed` joined the family because a card held mid-reveal
    // is exactly that: in the middle of resolving, and not yet anywhere.
    expect(r.group('resolving').map((z) => z.id).sort()).toEqual(['active', 'revealed', 'stack']);
    expect(STACK.group).toBe('resolving');
    expect(ACTIVE.group).toBe('resolving');
    expect(REVEALED.group).toBe('resolving');
    expect(HAND.group).toBe('hand');
  });
});

/* ------------------------------ on the engine -------------------------- */

describe('zones on the engine', () => {
  function arena() {
    const events: GameEvent[] = [];
    const engine = createEngine({ seed: 'zones', onEvent: (event) => events.push(event) });
    const hero = char('Hero');
    const foe = char('Foe', 10);
    const bystander = char('Bystander');
    hero.team = 'party';
    foe.team = 'foes';
    bystander.team = 'foes';
    engine.registerPlayers([
      new Idle('You', [hero], 'party'),
      new Idle('Them', [foe, bystander], 'foes'),
    ]);
    return { engine, hero, foe, bystander, events };
  }

  it('registers characters into play', () => {
    const { engine, hero } = arena();
    expect(engine.zones.zoneOf(hero)?.id).toBe('play');
    expect(engine.isInPlay(hero)).toBe(true);
  });

  it('destroy is a move to the garbage, and announces both events', async () => {
    const { engine, foe, events } = arena();
    await engine.apply([damage(foe.gauge('hp'), 10)]);

    expect(engine.zones.zoneOf(foe)?.id).toBe('garbage');
    expect(engine.garbage).toEqual([foe]);
    expect(engine.isInPlay(foe)).toBe(false);

    const zoneChange = events.find(
      (e): e is Extract<GameEvent, { type: 'zone:changed' }> => e.type === 'zone:changed',
    );
    expect(zoneChange).toBeDefined();
    expect(zoneChange && 'from' in zoneChange ? zoneChange.from.id : undefined).toBe('play');
    expect(zoneChange?.to.id).toBe('garbage');
    // The mechanical transition and the death are separate announcements:
    // "left play" and "died" are different questions.
    expect(events.some((e) => e.type === 'character:destroyed')).toBe(true);
    expect(events.some((e) => e.type === 'zone:changed:batch')).toBe(true);
  });

  it('leaving play removes an entity from the target pool', async () => {
    const { engine, hero, foe } = arena();
    engine.zones.declare(HAND);
    const you = engine.players[0]!;

    expect(engine.validTargets({ who: 'any', count: 1 }, hero)).toContain(foe);
    await engine.moveTo(foe, 'hand', { owner: you });

    expect(engine.zones.zone('hand', you)!.members).toEqual([foe]);
    // Targeting reads `targetable` off the zone, so a bounced entity is out
    // of the pool without being dead...
    expect(engine.validTargets({ who: 'any', count: 1 }, hero)).not.toContain(foe);
    expect(engine.isInPlay(foe)).toBe(false);
    // ...and `include` cannot drag it back, since the zone is the gate.
    expect(engine.validTargets({ who: 'any', count: 1, include: [foe] }, hero)).not.toContain(foe);
    // Leaving play is neutral for defeat: only the garbage is death.
    expect(engine.garbage).not.toContain(foe);
  });

  it('moveTo throws for an unknown zone rather than silently doing nothing', async () => {
    const { engine, hero } = arena();
    await expect(engine.moveTo(hero, 'nowhere')).rejects.toThrow(/no zone "nowhere"/);
  });
});

/* ------------------------- dying is a zone change ---------------------- */

describe('dying is leaving play for the garbage pile', () => {
  function arena() {
    const events: GameEvent[] = [];
    const engine = createEngine({ seed: 'death', onEvent: (event) => events.push(event) });
    for (const def of CARD_ZONES) engine.zones.declare(def);
    const hero = char('Hero');
    const foe = char('Foe', 10);
    const bystander = char('Bystander');
    hero.team = 'party';
    foe.team = 'foes';
    bystander.team = 'foes';
    engine.registerPlayers([
      new Idle('You', [hero], 'party'),
      new Idle('Them', [foe, bystander], 'foes'),
    ]);
    return { engine, hero, foe, bystander, events };
  }

  it('a destroy is a death: out of play, into the garbage', async () => {
    const { engine, foe, events } = arena();
    await engine.apply([damage(foe.gauge('hp'), 10)]);
    const deaths = events.filter(isDeath);
    expect(deaths).toHaveLength(1);
    expect(deaths[0]!.entity).toBe(foe);
    // `character:destroyed` is the annotated view of the same transition —
    // it carries the reason a bare move cannot.
    const destroyed = events.find(
      (e): e is Extract<GameEvent, { type: 'character:destroyed' }> => e.type === 'character:destroyed',
    );
    expect(destroyed?.reason).toBe('hp:current-reached-minimum');
  });

  it('a bounce leaves play but is not a death', async () => {
    const { engine, bystander, events } = arena();
    await engine.moveTo(bystander, 'hand', { owner: engine.players[1] });
    expect(events.filter(leftPlay)).toHaveLength(1);
    expect(events.filter(isDeath)).toHaveLength(0);
  });

  it('an exile leaves play and is not a death, even though the zone is "removed"', async () => {
    const { engine, bystander, events } = arena();
    engine.zones.declare({ id: 'suspended', visibility: 'public', group: 'removed' });
    await engine.moveTo(bystander, 'suspended');
    expect(events.filter(leftPlay)).toHaveLength(1);
    // This is exactly why removal-by-exile dodges death triggers.
    expect(events.filter(isDeath)).toHaveLength(0);
  });

  it('a discard from hand reaches the garbage without dying', async () => {
    const { engine, bystander, events } = arena();
    await engine.moveTo(bystander, 'hand', { owner: engine.players[1] });
    events.length = 0;
    await engine.moveTo(bystander, 'garbage');
    expect(events.filter(isDeath)).toHaveLength(0);
    expect(events.filter(leftPlay)).toHaveLength(0);
  });
});

/* -------------------------- move is an Action -------------------------- */

describe('move as an action', () => {
  function arena() {
    const events: GameEvent[] = [];
    const engine = createEngine({ seed: 'move', onEvent: (event) => events.push(event) });
    for (const def of CARD_ZONES) engine.zones.declare(def);
    engine.zones.declare({ id: 'suspended', visibility: 'public', group: 'removed' });
    const hero = char('Hero');
    const token = char('Token');
    hero.team = 'party';
    token.team = 'party';
    engine.registerPlayers([new Idle('You', [hero, token], 'party'), new Idle('Them', [char('Foe')], 'foes')]);
    return { engine, hero, token, events };
  }

  it('batches several moves into one zone:changed:batch', async () => {
    const { engine, hero, token, events } = arena();
    const garbage = engine.zones.zone('garbage', hero.controller!)!;
    await engine.apply([move(hero, garbage), move(token, garbage)]);
    expect(events.filter((e) => e.type === 'zone:changed')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'zone:changed:batch')).toHaveLength(1);
  });

  it('a replacement effect can redirect where a move lands', async () => {
    const { engine, token } = arena();
    const suspended = engine.zones.zone('suspended')!;
    // "If it would go to your garbage, suspend it instead" — an ordinary
    // ActionTransformer rewriting the move's destination. This is the whole
    // reason movement is an action.
    await engine.addBuff(
      token,
      buff({
        name: 'Suspend Instead',
        weight: 1,
        abilities: [
          passiveActionModifier({
            name: 'Suspend Instead',
            transform: (action) =>
              action.type === 'move' && action.to.id === 'garbage' ? { ...action, to: suspended } : action,
          }),
        ],
      }),
    );
    await engine.moveTo(token, 'garbage');
    expect(engine.zones.zoneOf(token)?.id).toBe('suspended');
    expect(engine.garbage).not.toContain(token);
  });

  it('an on-move restriction blocks it outright, rather than redirecting', async () => {
    const { engine, token } = arena();
    await engine.addBuff(
      token,
      buff({
        name: 'Rooted',
        weight: 1,
        abilities: [restriction({ name: 'Rooted', on: 'move' })],
      }),
    );
    await engine.moveTo(token, 'garbage');
    expect(engine.zones.zoneOf(token)?.id).toBe('play');
  });
});

/* --------------------- gauges are live only in play -------------------- */

describe('gauge values are realized on entering play', () => {
  function arena() {
    const engine = createEngine({ seed: 'realize' });
    for (const def of CARD_ZONES) engine.zones.declare(def);
    const hero = char('Hero');
    const minion = char('Minion', 30);
    hero.team = 'you';
    minion.team = 'you';
    const you = new Idle('You', [hero, minion], 'you');
    const them = new Idle('Them', [char('Foe')], 'them');
    engine.registerPlayers([you, them]);
    return { engine, hero, minion, you, them };
  }

  it('a card bounced to hand and replayed comes back fresh', async () => {
    const { engine, minion, you } = arena();
    await engine.apply([damage(minion.gauge('hp'), 12)]);
    expect(minion.gauge('hp').current).toBe(18);

    await engine.moveTo(minion, 'hand', { owner: you });
    await engine.moveTo(minion, 'play');

    // The damage it took last time does not come back with it: a gauge's
    // value is only meaningful while its owner is in play, so it is
    // re-established on the way in.
    expect(minion.gauge('hp').current).toBe(30);
  });

  it('is silent — arriving in play is setup, not healing, so nothing triggers', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ seed: 'realize', onEvent: (event) => events.push(event) });
    for (const def of CARD_ZONES) engine.zones.declare(def);
    const minion = char('Minion', 30);
    minion.team = 'you';
    const you = new Idle('You', [minion], 'you');
    engine.registerPlayers([you, new Idle('Them', [char('Foe')], 'them')]);

    await engine.apply([damage(minion.gauge('hp'), 12)]);
    await engine.moveTo(minion, 'hand', { owner: you });
    events.length = 0;

    await engine.moveTo(minion, 'play');
    // The reset emits no gauge:changed — only the zone move is announced.
    expect(events.filter((e) => e.type === 'gauge:changed')).toEqual([]);
    expect(minion.gauge('hp').current).toBe(30);
  });

  it('registering directly into play keeps the state it was built with', () => {
    const engine = createEngine({ seed: 'realize' });
    // A half-spent mana pool stays half-spent: registration is placement,
    // not a move, so it does not realize.
    const veteran = new Character('Veteran', { maxHp: 50, maxMana: 20, mana: 5 });
    engine.registerCharacter(veteran);
    expect(veteran.gauge('mana').current).toBe(5);
    expect(engine.zones.zoneOf(veteran)?.id).toBe('play');
  });

  it('a revive from the garbage arrives at full', async () => {
    const { engine, minion } = arena();
    await engine.apply([damage(minion.gauge('hp'), 30)]);
    expect(engine.isInPlay(minion)).toBe(false);
    expect(minion.gauge('hp').current).toBe(0); // inspectable after death

    minion.destroyed = false;
    await engine.moveTo(minion, 'play');
    expect(minion.gauge('hp').current).toBe(30);
    expect(engine.isInPlay(minion)).toBe(true);
  });
});
