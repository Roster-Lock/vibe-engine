/**
 * **Ability availability** — whether an activated ability can be used
 * right now (`GameEngine.canUse`).
 *
 * Motivated by input constraints rather than rules: an RTS binds abilities
 * to hotkeys, and a gamepad has very few. An ability that is *granted* by
 * a trigger would appear and disappear, shuffling every slot around it —
 * so instead the ability stays in its owner's kit permanently and becomes
 * **available** when a condition holds. One button, one slot, lit or grey.
 *
 * That it is a *condition* and not a flag is the point: nothing has to be
 * kept in sync, no enabling event can be missed, and the answer is the
 * same after a reload or inside a replay.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  Player,
  buff,
  restriction,
  skill,
  type Decision,
} from '../src/games/turn-based/index.js';
import { compileDocument } from '../src/english/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';

class Idle extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** A unit whose Counterstrike is live only while it is Charged. */
const DOCUMENT = `
  Buff Charged
  Fading 0.

  Ability Counterstrike
  Available while this has Charged.
  Deal 100 damage to target enemy character.

  Ability Strike
  Deal 10 damage to target enemy character.
`;

function arena() {
  const result = compileDocument(DOCUMENT);
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const engine = createEngine({ seed: 'available' });
  const hero = new Character('Hero', {
    maxHp: 100,
    maxMana: 0,
    skills: [skill({ name: 'Kit', weight: 1, abilities: result.abilities })],
  });
  const foe = new Character('Foe', { maxHp: 200, maxMana: 0 });
  hero.team = 'you';
  foe.team = 'them';
  engine.registerPlayers([new Idle('You', [hero], 'you'), new Idle('Them', [foe], 'them')]);
  const ability = (name: string) => result.abilities.find((a) => a.name === name)!;
  return { engine, hero, foe, result, ability };
}

describe('canUse', () => {
  it('reports an unavailable ability as unusable, with a reason', () => {
    const { engine, hero, ability } = arena();
    expect(engine.canUse(hero, ability('Counterstrike'))).toEqual({
      usable: false,
      reason: 'unavailable',
    });
    // Its sibling, with no condition, is usable the whole time.
    expect(engine.canUse(hero, ability('Strike')).usable).toBe(true);
  });

  it('becomes usable when the condition holds — and the slot never moved', async () => {
    const { engine, hero, result, ability } = arena();
    const charged = result.buffs.find((b) => b.name === 'Charged')!;

    // The ability is in the kit before and after, in the same position:
    // a hotkey bound to it stays bound.
    const slots = () => hero.manualAbilities.map((a) => a.name);
    const before = slots();

    await engine.addBuff(hero, charged);
    expect(engine.canUse(hero, ability('Counterstrike')).usable).toBe(true);
    expect(slots()).toEqual(before);
  });

  it('goes back to unusable when the buff expires', async () => {
    const { engine, hero, result, ability } = arena();
    await engine.addBuff(hero, result.buffs.find((b) => b.name === 'Charged')!);
    expect(engine.canUse(hero, ability('Counterstrike')).usable).toBe(true);
    await endTurn(engine); // the duration takes it off
    expect(engine.canUse(hero, ability('Counterstrike')).usable).toBe(false);
  });

  it('refuses the use, not just the query', async () => {
    const { engine, hero, foe, ability } = arena();
    await expect(
      engine.useAbility(hero, ability('Counterstrike'), { targets: [foe] }),
    ).rejects.toThrow(/cannot use "Counterstrike" right now \(unavailable\)/);
    expect(foe.gauge('hp').current).toBe(200);
  });

  it('allows it once charged', async () => {
    const { engine, hero, foe, result, ability } = arena();
    await engine.addBuff(hero, result.buffs.find((b) => b.name === 'Charged')!);
    await engine.useAbility(hero, ability('Counterstrike'), { targets: [foe] });
    expect(foe.gauge('hp').current).toBe(100);
  });

  it('an "activate" restriction silences every ability, and says which one blocked it', async () => {
    const { engine, hero, ability } = arena();
    await engine.addBuff(
      hero,
      buff({ name: 'Silenced', weight: 1, abilities: [restriction({ name: 'Silenced', on: 'activate' })] }),
    );
    const answer = engine.canUse(hero, ability('Strike'));
    expect(answer.usable).toBe(false);
    expect(answer.reason).toBe('restricted');
    expect(answer.blockedBy?.id).toContain('silenced');
  });

  it('reports "no-targets" as a hint, without refusing', () => {
    const { engine, hero, foe, ability } = arena();
    // Nothing legal to hit once the only enemy is gone from the pool.
    foe.team = 'you';
    const answer = engine.canUse(hero, ability('Strike'));
    expect(answer).toEqual({ usable: true, reason: 'no-targets' });
  });

  it('lowers to a predicate on the ability, not a flag', () => {
    const { result } = arena();
    const ir = result.ir.abilities.find((a) => a.name === 'Counterstrike')!;
    expect(ir.available).toEqual({
      kind: 'any',
      query: { kind: 'self' },
      test: { kind: 'hasBuff', buff: 'Charged' },
    });
    expect(result.ir.abilities.find((a) => a.name === 'Strike')!.available).toBeUndefined();
  });

  it('reads back as English', () => {
    const { result } = arena();
    expect(result.abilities.find((a) => a.name === 'Counterstrike')!.description).toBe(
      'Available while this has Charged. Deal 100 damage to target enemy character.',
    );
  });
});

describe('Available while: diagnostics', () => {
  const errors = (text: string) =>
    compileDocument(text).diagnostics.filter((d) => d.severity === 'error');

  it('needs an ability to belong to', () => {
    expect(errors('Available while this has Charged.')[0]!.code).toBe('available-outside-ability');
  });

  it('refuses two clauses on one ability', () => {
    const diags = errors(`
      Buff Charged
      Buff Ready
      Ability A
      Available while this has Charged.
      Available while this has Ready.
      Deal 1 damage to this.
    `);
    expect(diags[0]!.code).toBe('available-duplicate');
    expect(diags[0]!.message).toContain('combine the conditions with "and"');
  });

  it('expects "while"', () => {
    expect(errors('Ability A\nAvailable this has Charged.\nDeal 1 damage to this.')[0]!.message).toContain(
      'expected "while"',
    );
  });
});
