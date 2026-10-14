/**
 * Zone-movement triggers (`when <subject> enters <zone> [from <zone>] then …`).
 *
 * The point of these tests is that zone movement is **game-agnostic
 * content**: the phrase names a zone and an optional other end, lowers to
 * the engine's `zone:changed` event, and a game gets the trigger for free
 * as long as it moves its entities through declared zones. Nothing here
 * mentions cards.
 */
import { describe, expect, it } from 'vitest';
import { completeAt, compileDocument, emptyDictionary } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import { ACTIVE, CARD_ZONES, STACK } from '../src/games/cards/zones.js';
import {
  Character,
  Player,
  createEngine,
  move,
  skill,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';

class Idle extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** The zones the game declares — engine zones are always known as well. */
const ZONES = new ZoneDictionary(['hand', 'deck', STACK.id, ACTIVE.id]);

/** A character whose WATCHED trigger is the document's game-scoped trigger. */
function unit(name: string, source: string, maxHp = 20): Character {
  const compiled = compileDocument(source, { zones: ZONES });
  return new Character(name, {
    maxHp,
    maxMana: 0,
    skills: [skill({ name: 'Watched', weight: 1, abilities: [...compiled.triggers] })],
  });
}

/** An engine with a `mover` (party) and a `foe` (foes), all zones declared. */
function arena() {
  const events: GameEvent[] = [];
  const engine = createEngine({ seed: 'zone-triggers', onEvent: (event) => events.push(event) });
  for (const def of CARD_ZONES) engine.zones.declare(def);
  const mover = new Character('Mover', { maxHp: 20, maxMana: 0 });
  const foe = new Character('Foe', { maxHp: 20, maxMana: 0 });
  mover.team = 'party';
  foe.team = 'foes';
  engine.registerPlayers([new Idle('You', [mover], 'party'), new Idle('Them', [foe], 'foes')]);
  return { engine, mover, foe, events };
}

/** Registers a unit on the mover's side and returns it. */
function ally(engine: ReturnType<typeof arena>['engine'], mover: Character, character: Character): Character {
  character.team = 'party';
  character.controller = mover.controller;
  engine.registerCharacter(character);
  return character;
}

const WATCH = 'Ability Watched\n';
const dealFive = 'then deal 5 damage to all enemy characters.';

/* ------------------------------ the phrase ----------------------------- */

describe('zone triggers — the phrase compiles', () => {
  it('lowers "enters a garbage from play" to a zone:changed trigger', () => {
    const result = compileDocument(`Ability T\nWhen this enters a garbage from play ${dealFive}`);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir.triggers[0]!.event).toBe('zone:changed');
    expect(result.ir.triggers[0]!.zone).toEqual({ verb: 'enters', id: 'garbage', opposite: 'play' });
  });

  it('leaves the other end open when it is not written', () => {
    const result = compileDocument(`Ability T\nWhen a character enters play ${dealFive}`);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir.triggers[0]!.zone).toEqual({ verb: 'enters', id: 'play' });
  });

  it('reads "leaves play to garbage" backwards — the named zone is the origin', () => {
    const result = compileDocument(`Ability T\nWhen this leaves play to garbage ${dealFive}`);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir.triggers[0]!.zone).toEqual({ verb: 'leaves', id: 'play', opposite: 'garbage' });
  });

  it('accepts the plural verb forms for a batch', () => {
    const result = compileDocument(`Ability T\nWhen 2 or more characters enter play ${dealFive}`);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir.triggers[0]!.event).toBe('zone:changed:batch');
    expect(result.ir.triggers[0]!.mode).toBe('batch');
    expect(result.ir.triggers[0]!.zone?.verb).toBe('enters');
  });

  it('names a zone the host declares', () => {
    const zones = new ZoneDictionary([ACTIVE.id, STACK.id, 'hand', 'deck']);
    const result = compileDocument(`Ability T\nWhen this enters play from active ${dealFive}`, { zones });
    expect(result.diagnostics).toEqual([]);
    expect(result.ir.triggers[0]!.zone).toEqual({ verb: 'enters', id: 'play', opposite: 'active' });
  });

  it('reports an unknown zone with the zones it does know', () => {
    const zones = new ZoneDictionary([ACTIVE.id, STACK.id]);
    const result = compileDocument(`Ability T\nWhen this enters nowhere from play ${dealFive}`, { zones });
    const diagnostic = result.diagnostics.find((d) => d.code === 'unknown-zone');
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.message).toContain('"active"');
    expect(diagnostic!.message).toContain('"play"');
  });

  it('corrects the preposition rather than reporting a stray word', () => {
    const result = compileDocument(`Ability T\nWhen this enters play to hand ${dealFive}`);
    const diagnostic = result.diagnostics.find((d) => d.code === 'zone-preposition');
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.message).toContain('"from <zone>"');
  });

  it('lists the zone verbs in the "not an event verb" message', () => {
    const result = compileDocument(`Ability T\nWhen this teleports ${dealFive}`);
    const diagnostic = result.diagnostics.find((d) => d.code === 'unknown-event');
    expect(diagnostic!.message).toContain('enters <zone>');
    expect(diagnostic!.message).toContain('leaves <zone>');
  });
});

/* ------------------------------ completion ----------------------------- */

describe('zone triggers — completion', () => {
  const at = (text: string): string[] =>
    completeAt(text, text.length, emptyDictionary(), ZONES).map((s) => s.label);

  it('offers the zone verbs once the subject is written', () => {
    const labels = at('Ability T\nWhen this ');
    expect(labels).toContain('enters');
    expect(labels).toContain('leaves');
    expect(labels).toContain('dies');
  });

  it('offers zone names after the zone verb', () => {
    const labels = at('Ability T\nWhen this enters ');
    expect(labels).toContain('play');
    expect(labels).toContain('garbage');
    expect(labels).toContain('active');
  });

  it('offers the right preposition for the verb', () => {
    expect(at('Ability T\nWhen this enters play ')).toContain('from');
    expect(at('Ability T\nWhen this enters play ')).not.toContain('to');
    expect(at('Ability T\nWhen this leaves play ')).toContain('to');
    expect(at('Ability T\nWhen this leaves play ')).not.toContain('from');
  });

  it('offers zone names after the preposition, then "then"', () => {
    expect(at('Ability T\nWhen this enters play from ')).toContain('active');
    expect(at('Ability T\nWhen this enters play from active ')).toContain('then');
  });

  it('offers the effect sentence after "then"', () => {
    expect(at('Ability T\nWhen this enters play from active then ')).toContain('Deal');
  });
});

/* -------------------------------- firing ------------------------------- */

describe('zone triggers — firing', () => {
  it('fires on entering the garbage from play', async () => {
    const { engine, mover, foe } = arena();
    const watched = ally(engine, mover, unit('Watched', `${WATCH}When this enters a garbage from play ${dealFive}`));

    await engine.moveTo(watched, 'garbage');
    expect(foe.gauge('hp').current).toBe(15);
  });

  it('does not fire when the origin is wrong', async () => {
    const { engine, mover, foe } = arena();
    ally(engine, mover, unit('Watched', `${WATCH}When this enters a garbage from hand ${dealFive}`));

    await engine.moveTo(mover, 'garbage');
    expect(foe.gauge('hp').current).toBe(20);
  });

  it('fires when a character enters play, whichever zone it came from', async () => {
    const { engine, mover, foe } = arena();
    const scout = unit('Scout', `${WATCH}When this enters play ${dealFive}`, 10);
    scout.team = 'party';
    scout.controller = mover.controller;
    // Staged out of play, then moved in — a real transition with a `from`.
    engine.registerCharacter(scout, { zone: 'active' });
    expect(engine.isInPlay(scout)).toBe(false);

    await engine.moveTo(scout, 'play');
    expect(engine.isInPlay(scout)).toBe(true);
    expect(foe.gauge('hp').current).toBe(15);
  });

  it('distinguishes entering from active and from the stack', async () => {
    const { engine, mover, foe } = arena();
    const fromActive = `${WATCH}When this enters play from active ${dealFive}`;
    const fromStack = `${WATCH}When this enters play from stack ${dealFive}`;
    const stage = (name: string, source: string, from: string): Character => {
      const character = unit(name, source, 10);
      character.team = 'party';
      character.controller = mover.controller;
      engine.registerCharacter(character, { zone: from });
      return character;
    };

    // The honest path: staged in `active`, moved into play.
    const honest = stage('Honest', fromActive, 'active');
    await engine.moveTo(honest, 'play');
    expect(foe.gauge('hp').current).toBe(15);

    // Cheated out of the stack: the "from active" effect must not fire.
    const cheater = stage('Cheater', fromActive, 'stack');
    await engine.moveTo(cheater, 'play');
    expect(foe.gauge('hp').current).toBe(15);

    // ...and the "from stack" guard is exactly what catches that path.
    const gatekeeper = stage('Gatekeeper', fromStack, 'stack');
    await engine.moveTo(gatekeeper, 'play');
    expect(foe.gauge('hp').current).toBe(10);
  });

  it('fires on leaving play, whatever the destination', async () => {
    const { engine, mover, foe } = arena();
    const watched = ally(engine, mover, unit('Watched', `${WATCH}When this leaves play then deal 4 damage to all enemy characters.`));

    await engine.moveTo(watched, 'garbage');
    expect(foe.gauge('hp').current).toBe(16);
  });

  it('counts a batch of arrivals', async () => {
    const { engine, mover, foe } = arena();
    ally(engine, mover, unit('Watcher', `${WATCH}When 2 or more characters enter play then deal 7 damage to all enemy characters.`, 10));
    const a = ally(engine, mover, unit('A', `${WATCH}Ability Noop\nHeal this for 1.`, 5));
    const b = ally(engine, mover, unit('B', `${WATCH}Ability Noop\nHeal this for 1.`, 5));

    const play = engine.zones.zone('play')!;
    const garbage = engine.zones.zone('garbage', mover.controller!)!;
    await engine.apply([move(a, garbage), move(b, garbage)]);

    // One arrival in a settle: not two, so the gate holds.
    await engine.moveTo(a, 'play');
    expect(foe.gauge('hp').current).toBe(20);

    // Two arrivals in one settle: the batch event fires and the count passes.
    await engine.apply([move(a, garbage), move(b, play)]);
    await engine.apply([move(a, play)]);
    expect(foe.gauge('hp').current).toBe(20);
    await engine.apply([move(a, garbage), move(b, garbage)]);
    await engine.apply([move(a, play), move(b, play)]);
    expect(foe.gauge('hp').current).toBe(13);
  });

  it('does not fire for a plain first placement — placement is setup, not a move', async () => {
    const { engine, mover, foe } = arena();
    const placed = unit('Placed', `${WATCH}When this enters play ${dealFive}`, 10);
    placed.team = 'party';
    placed.controller = mover.controller;
    engine.registerCharacter(placed); // straight into play: no `from`, no event
    expect(foe.gauge('hp').current).toBe(20);
  });
});
