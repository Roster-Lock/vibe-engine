/**
 * Cast speed — the instant marker (`src/games/cards/speed.ts`).
 *
 * One symbol marks a card *or* an activated ability as usable at instant
 * speed; the stack reads it in `speedOf`, so the same marker decides timing
 * wherever the object ends up.
 */
import { describe, expect, it } from 'vitest';
import { CARD_ZONES } from '../examples/card-game/zones.js';
import {
  CardStack,
  PASS,
  abilityObject,
  speedOf,
  type PriorityOwner,
  type PriorityRequest,
  type PriorityResponse,
  type StackObject,
} from '../src/games/cards/stack.js';
import {
  INSTANT,
  castSpeedOf,
  instant,
  isInstant,
} from '../src/games/cards/speed.js';
import {
  Character,
  Player,
  cast,
  createEngine,
  damage,
  type Decision,
} from '../src/games/turn-based/index.js';

class Seat extends Player implements PriorityOwner {
  async decide(): Promise<Decision[]> {
    return [];
  }
  async takePriority(_request: PriorityRequest): Promise<PriorityResponse> {
    return PASS;
  }
}

const card = (name: string, hp = 0): Character => new Character(name, { maxHp: hp, maxMana: 0 });

function table() {
  const engine = createEngine({ seed: 'speed' });
  for (const def of CARD_ZONES) engine.zones.declare(def);
  const you = new Seat('You', [card('Hero', 20)], 'you');
  const them = new Seat('Them', [card('Foe', 20)], 'them');
  engine.registerPlayers([you, them]);
  const stack = new CardStack(engine);
  return { engine, stack, you, them };
}

/** A spell stack object wrapping `entity`. */
function bolt(entity: Character, controller: Player): StackObject {
  return {
    kind: 'spell',
    card: entity,
    name: entity.name,
    controller,
    targets: [],
    destination: 'garbage',
    resolve: (): never[] => [],
  };
}

describe('the instant symbol', () => {
  it('marks an object without adding data to it', () => {
    const plain = { name: 'Bolt', cost: 1 };
    const marked = instant({ name: 'Bolt', cost: 1 });

    expect(isInstant(plain)).toBe(false);
    expect(isInstant(marked)).toBe(true);
    expect(marked[INSTANT]).toBe(true);
    // Identity, not data: a marked object serializes exactly like a plain one.
    expect(JSON.stringify(marked)).toBe(JSON.stringify(plain));
    expect(Object.keys(marked)).toEqual(['name', 'cost']);
  });

  it('marks a real engine ability — an activated ability can be instant too', () => {
    const ping = cast({
      name: 'Ping',
      targeting: { who: 'enemy', count: 1 },
      cast: (ctx, targeting) => (targeting.targets[0] ? [damage(targeting.targets[0].gauge('hp'), 1, ctx.self)] : []),
    });
    expect(isInstant(ping)).toBe(false);
    expect(castSpeedOf(ping)).toBe('sorcery');
    // `instant` marks the object itself (a mark, not a copy).
    expect(isInstant(instant(ping))).toBe(true);
    expect(castSpeedOf(ping)).toBe('instant');
  });
});

describe('the stack reads the marker', () => {
  it('a marked card makes its spell instant', () => {
    const { you } = table();
    expect(speedOf(bolt(card('Bolt'), you))).toBe('sorcery');
    expect(speedOf(bolt(instant(card('Bolt')), you))).toBe('instant');
  });

  it('a marked ability object is instant', () => {
    const { you } = table();
    const source = card('Mage', 20);
    const plain: StackObject = {
      kind: 'ability',
      ability: abilityObject('Ping', source),
      name: 'Ping',
      controller: you,
      targets: [],
      resolve: (): never[] => [],
    };
    const marked: StackObject = { ...plain, ability: instant(abilityObject('Ping', source)) };
    expect(speedOf(plain)).toBe('sorcery');
    expect(speedOf(marked)).toBe('instant');
  });

  it('an explicit speed still wins, for a host-built stack object', () => {
    const { you } = table();
    expect(speedOf({ ...bolt(instant(card('Bolt')), you), speed: 'sorcery' })).toBe('sorcery');
  });

  it('gates timing: an instant needs only priority, a sorcery needs the main phase', async () => {
    const { engine, stack, you, them } = table();
    const hand = instant(card('Bolt'));
    engine.registerCharacter(hand);
    await engine.moveTo(hand, 'hand', { owner: them });
    const instantSpell = bolt(hand, them);
    const sorcerySpell = { ...bolt(card('Slow'), them) };

    // Someone else's turn, not a main phase: an instant is still legal.
    const window = { activePlayer: you, mainPhase: false };
    expect(stack.canPut(instantSpell, them, window)).toBe(true);
    expect(stack.canPut(sorcerySpell, them, window)).toBe(false);

    // With an object already on the stack, even their own main phase is too
    // late for a sorcery (rule 307.1) — that is what makes responding work.
    expect(await stack.stackObject(instantSpell, { window: { activePlayer: you, mainPhase: true } })).toBe(true);
    expect(stack.size).toBe(1);
    expect(stack.canPut(sorcerySpell, them, { activePlayer: them, mainPhase: true })).toBe(false);
  });
});
