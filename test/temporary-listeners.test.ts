/**
 * **Temporary event listeners** — a trigger added mid-game that expires.
 *
 * The stress test is Magic's Massacre Girl: *"When she enters the
 * battlefield, each other creature gets -1/-1 until end of turn. Then
 * whenever a creature dies this turn, each other creature gets -1/-1 until
 * end of turn."* Three things at once:
 *
 * - an **enters-play** trigger — a `zone:changed` into an `IN_PLAY` zone;
 * - a listener **created while the game runs**, not declared up front;
 * - that listener **expiring** at end of turn;
 * - and a **cascade**: each death batch re-fires it, so a board of small
 *   creatures collapses in waves.
 *
 * None of it needs new engine machinery. A buff *is* "a temporary bundle of
 * abilities attached to something", so a listener-until-end-of-turn is a
 * buff carrying a trigger plus one that takes the buff off at `turn:end`.
 *
 * (The real card uses -1/-1; this uses 1 damage, because the structural
 * question is the listener's lifetime, not the stat machinery.)
 */
import { describe, expect, it } from 'vitest';
import {
  Character, GameEngine, Player, auto, buff, damage, removeBuff, skill,
  type Action, type Decision,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';

class Idle extends Player { async decide(): Promise<Decision[]> { return []; } }

/** The temporary listener: "whenever a creature dies this turn, …". */
const massacre = buff({
  name: 'Massacre',
  weight: 1,
  abilities: [
    auto({
      name: 'Massacre tick',
      event: 'character:destroyed:batch',
      targets: () => [],
      cast: (ctx): Action[] =>
        ctx.engine
          .validTargets({ who: 'any', count: 1 }, ctx.self)
          .filter((c) => c !== ctx.self)
          .map((c) => damage(c.gauge('hp'), 1, ctx.self)),
    }),
    // "until end of turn" — the buff takes itself off at turn's end.
    auto({
      name: 'Massacre expiry',
      event: 'turn:end',
      targets: () => [],
      cast: (ctx): Action[] => [removeBuff(ctx.self, 'massacre', ctx.self)],
    }),
  ],
});

/** The ETB trigger: a zone change into play, of this character. */
const etb = skill({
  name: 'Massacre Girl',
  weight: 1,
  abilities: [
    auto({
      name: 'Massacre Girl ETB',
      event: 'zone:changed',
      when: (ctx) => ctx.event.entity === ctx.self && ctx.event.to.group === 'in-play',
      targets: () => [],
      cast: async (ctx): Promise<Action[]> => {
        await ctx.engine.addBuff(ctx.self, massacre);
        return ctx.engine
          .validTargets({ who: 'any', count: 1 }, ctx.self)
          .filter((c) => c !== ctx.self)
          .map((c) => damage(c.gauge('hp'), 1, ctx.self));
      },
    }),
  ],
});

describe('Massacre Girl', () => {
  it('adds a listener on entering play, which cascades and then expires', async () => {
    const engine = createEngine({ seed: 'mg' });
    engine.zones.declare({ id: 'hand', visibility: 'owner', scope: 'per-player', group: 'hand' });
    const girl = new Character('Massacre Girl', { maxHp: 40, maxMana: 0, skills: [etb] });
    const chaff = [1, 1, 2, 10].map((hp, i) => new Character(`Chaff ${i}`, { maxHp: hp, maxMana: 0 }));
    girl.team = 'you';
    for (const c of chaff) c.team = 'them';
    const you = new Idle('You', [girl], 'you');
    engine.registerPlayers([you, new Idle('Them', chaff, 'them')]);

    // She starts in hand, then is played.
    await engine.moveTo(girl, 'hand', { owner: you });
    await engine.moveTo(girl, 'play');

    // The cascade, in waves. Chaff HP is 1, 1, 2, 10:
    //   ETB deals 1 to each      → the two 1s die together
    //   their death batch fires  → 1 to each survivor; the 2 (now 1) dies
    //   that death batch fires   → 1 more to the last one
    // So only the 10 survives, at 10 - 3 = 7.
    expect(chaff.filter((c) => engine.isInPlay(c)).map((c) => c.name)).toEqual(['Chaff 3']);
    expect(chaff[3]!.gauge('hp').current).toBe(7);

    // The listener is attached, as a buff she is wearing.
    expect(girl.statuses.map((status) => status.name)).toContain('Massacre');

    await endTurn(engine);

    // "Until end of turn": the buff took itself off, so the listener is
    // gone and a later death does nothing.
    expect(girl.statuses.map((status) => status.name)).not.toContain('Massacre');
    const before = chaff[3]!.gauge('hp').current;
    await engine.apply([damage(chaff[3]!.gauge('hp'), 1)]);
    expect(chaff[3]!.gauge('hp').current).toBe(before - 1); // no extra wave
  });

  it('does nothing until she actually enters play', async () => {
    const engine = createEngine({ seed: 'mg' });
    engine.zones.declare({ id: 'hand', visibility: 'owner', scope: 'per-player', group: 'hand' });
    const girl = new Character('Massacre Girl', { maxHp: 40, maxMana: 0, skills: [etb] });
    const chaff = new Character('Chaff', { maxHp: 1, maxMana: 0 });
    girl.team = 'you';
    chaff.team = 'them';
    const you = new Idle('You', [girl], 'you');
    engine.registerPlayers([you, new Idle('Them', [chaff], 'them')]);

    // Sitting in hand is not entering play, so the ETB does not fire.
    await engine.moveTo(girl, 'hand', { owner: you });
    expect(engine.isInPlay(chaff)).toBe(true);
    expect(girl.statuses.map((status) => status.name)).not.toContain('Massacre');
  });
});
