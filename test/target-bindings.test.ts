/**
 * **Named target bindings** — `Target 1 character as victim and 1
 * different character as benefactor.`
 *
 * Names rather than positions, because a body that says `the victim`
 * cannot be misread the way "the first targeted character" can — and
 * because one ability may then ask for several *different* things, which a
 * single `target …` phrase cannot. This is what retires the
 * `target-conflict` diagnostic's apology that "in this version an ability
 * picks one character".
 *
 * The engine takes one pattern per ability, so bindings are filled
 * **positionally** from its pick list and each slice is then checked
 * against its own `who`/filter.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  Player,
  skill,
  type Decision,
  type ManualAbility,
} from '../src/games/turn-based/index.js';
import { compileDocument } from '../src/english/index.js';
import { lifeDrain as handWritten } from '../src/games/turn-based/content/characters/vampire/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

class Idle extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

const DRAIN = `
  Ability Life Drain
  Target 1 enemy character as victim and 1 different character as benefactor.
  Deal 18 damage to the victim.
  Heal the benefactor for 18.
`;

/** A table where the Hero is hurt, so healing it is visible. */
function table(ability: ManualAbility) {
  const engine = createEngine({ seed: 'bindings' });
  const hero = new Character('Hero', {
    maxHp: 100,
    maxMana: 0,
    hp: 50,
    skills: [skill({ name: 'Kit', weight: 1, abilities: [ability] })],
  });
  const foe = new Character('Foe', { maxHp: 100, maxMana: 0 });
  const other = new Character('Other', { maxHp: 100, maxMana: 0, hp: 60 });
  hero.team = 'you';
  other.team = 'you';
  foe.team = 'them';
  engine.registerPlayers([
    new Idle('You', [hero, other], 'you'),
    new Idle('Them', [foe], 'them'),
  ]);
  return { engine, hero, foe, other };
}

describe('Target … as …', () => {
  it('fills each binding, and the body reads them by name', async () => {
    const result = compileDocument(DRAIN);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const t = table(ability);
    await t.engine.useAbility(t.hero, ability, { targets: [t.foe, t.hero] });
    expect(t.foe.gauge('hp').current).toBe(82);
    expect(t.hero.gauge('hp').current).toBe(68);
  });

  it('behaves like the hand-written two-target Life Drain', async () => {
    // src/examples/08-27-2026/characters/vampire/index.ts destructures
    // `targeting.targets` positionally; this names them instead. Given the
    // same picks, the outcome must agree.
    const result = compileDocument(DRAIN);
    const run = async (ability: ManualAbility): Promise<[number, number]> => {
      const t = table(ability);
      await t.engine.useAbility(t.hero, ability, { targets: [t.foe, t.hero] });
      return [t.foe.gauge('hp').current, t.hero.gauge('hp').current];
    };
    expect(await run(result.abilities[0]!)).toEqual(await run(handWritten));
  });

  it('"different" makes the picks distinct', async () => {
    const result = compileDocument(DRAIN);
    const ability = result.abilities[0]!;
    const t = table(ability);
    // The same character twice is outside the pattern, so the engine
    // refuses it — `allowDuplicates` is off because a binding asked.
    await expect(
      t.engine.useAbility(t.hero, ability, { targets: [t.foe, t.foe] }),
    ).rejects.toThrow(/outside its targeting pattern/);
  });

  it('without "different" the same pick may fill both', async () => {
    const result = compileDocument(`
      Ability Double Tap
      Target 1 enemy character as first and 1 enemy character as second.
      Deal 5 damage to the first.
      Deal 5 damage to the second.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const t = table(ability);
    await t.engine.useAbility(t.hero, ability, { targets: [t.foe, t.foe] });
    expect(t.foe.gauge('hp').current).toBe(90); // both 5s landed on it
  });

  it("checks each binding against its own filter, not just the union", async () => {
    // The union pattern lets the player pick an ally *or* an enemy, since
    // the benefactor may be either. The victim binding is enemies only, so
    // an ally handed to it is dropped rather than drained.
    const result = compileDocument(DRAIN);
    const ability = result.abilities[0]!;
    const t = table(ability);
    await t.engine.useAbility(t.hero, ability, { targets: [t.other, t.hero] });
    expect(t.other.gauge('hp').current).toBe(60); // not a legal victim, untouched
    expect(t.hero.gauge('hp').current).toBe(68); // a legal benefactor, healed
  });

  it('lowers to one binding per clause', () => {
    const result = compileDocument(DRAIN);
    expect(result.ir.abilities[0]!.targets).toEqual([
      { name: 'victim', who: 'enemy', count: 1 },
      { name: 'benefactor', who: 'any', count: 1, distinct: true },
    ]);
  });

  it('takes a count above one, and a with clause', () => {
    const result = compileDocument(`
      Ability Harvest
      Target 2 different enemy characters with hp < 30 as prey.
      Destroy the prey.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const binding = result.ir.abilities[0]!.targets![0]!;
    expect(binding.count).toBe(2);
    expect(binding.distinct).toBe(true);
    expect(binding.filter).toEqual({
      kind: 'compare',
      op: '<',
      left: { kind: 'gauge', gauge: 'hp' },
      right: { kind: 'const', value: 30 },
    });
  });

  it('reads back as English', () => {
    const result = compileDocument(DRAIN);
    expect(result.abilities[0]!.description).toBe(
      'Target 1 enemy character as victim and 1 different character as benefactor. ' +
        'Deal 18 damage to the victim. Heal the benefactor for 18.',
    );
  });

  it('still accepts the older single "target …" phrase', () => {
    const result = compileDocument('Deal 40 damage to target enemy character.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ir.abilities[0]!.targets).toBeUndefined();
    expect(result.ir.abilities[0]!.targeting).toEqual({ who: 'enemy', count: 1 });
  });
});

describe('Target …: diagnostics', () => {
  const errors = (text: string) =>
    compileDocument(text).diagnostics.filter((d) => d.severity === 'error');

  it('catches a reference to a name nothing picked', () => {
    const diags = errors(`
      Ability A
      Target 1 character as victim.
      Deal 1 damage to the benefactor.
    `);
    expect(diags[0]!.code).toBe('unknown-target-name');
    expect(diags[0]!.message).toContain('"victim"');
  });

  it('suggests naming one when there are no bindings at all', () => {
    const diags = errors('Ability A\nDeal 1 damage to the victim.');
    expect(diags[0]!.code).toBe('unknown-target-name');
    expect(diags[0]!.message).toContain('Target 1 character as victim.');
  });

  it('refuses two bindings with the same name', () => {
    const diags = errors(`
      Ability A
      Target 1 character as x and 1 character as x.
      Deal 1 damage to the x.
    `);
    expect(diags[0]!.code).toBe('target-name-dup');
  });

  it('needs an ability to belong to', () => {
    expect(errors('Target 1 character as victim.')[0]!.code).toBe('targets-outside-ability');
  });

  it('wants one sentence, joined with "and"', () => {
    const diags = errors(`
      Ability A
      Target 1 character as x.
      Target 1 character as y.
      Deal 1 damage to the x.
    `);
    expect(diags[0]!.code).toBe('targets-duplicate');
    expect(diags[0]!.message).toContain('joined with "and"');
  });

  it('expects "as <name>"', () => {
    expect(errors('Ability A\nTarget 1 character victim.')[0]!.message).toContain('expected "as <name>"');
  });
});
