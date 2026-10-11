/**
 * The language: what parses, what compiles, and what the creator is told
 * when it does not.
 *
 * Diagnostics are asserted by **code and span**, not by message text, so
 * wording can be improved without breaking the suite — but a diagnostic
 * that starts pointing at the wrong word still fails, which is the part
 * that matters for an editor.
 */
import { describe, expect, it } from 'vitest';
import { compileDocument } from '../src/english/compile.js';
import type { EffectNode, UnitQuery } from '../src/ir.js';
import { lex } from '../src/english/lexer.js';
import { parseDocument } from '../src/english/parser.js';

/** The unit query of a damage effect — narrowed so tests can reach into it. */
function damageUnits(effect: EffectNode | undefined): UnitQuery {
  expect(effect?.kind).toBe('damage');
  return (effect as Extract<EffectNode, { kind: 'damage' }>).units;
}

/** Compiles and returns only the error codes, in order. */
function errors(source: string, units: string[] = []): string[] {
  return compileDocument(source, { units })
    .diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.code);
}

function compileOne(source: string, units: string[] = []) {
  const result = compileDocument(source, { units });
  const fatal = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(fatal.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)).toEqual([]);
  return result;
}

describe('lexer', () => {
  it('splits the possessive off its noun', () => {
    expect(lex("this unit's hp").map((token) => token.kind)).toEqual(['word', 'word', 'possessive', 'word', 'eof']);
  });

  it('lexes two-character comparisons as one token', () => {
    expect(lex('hp <= 10').map((token) => token.text)).toEqual(['hp', '<=', '10', '']);
  });

  it('keeps a sentence terminator out of a number', () => {
    expect(lex('20.').map((token) => token.text)).toEqual(['20', '.', '']);
    expect(lex('2.5').map((token) => token.text)).toEqual(['2.5', '']);
  });

  it('drops comment lines entirely', () => {
    expect(lex('# a comment\nDeal').map((token) => token.text)).toEqual(['Deal', '']);
  });
});

describe('abilities', () => {
  it('reads the header lines', () => {
    const { program } = compileOne(`
      Ability Storm Bolt
      Targeting: target enemy unit
      Cooldown 7 seconds
      Cost 75 mana
      Range 600
      Deal 180 damage to the target.
    `);
    expect(program.abilities[0]).toMatchObject({
      id: 'storm-bolt',
      name: 'Storm Bolt',
      targeting: 'enemyUnit',
      cooldown: 7,
      manaCost: 75,
      castRange: 600,
    });
  });

  it('splits an "and" chain into separate steps rather than delaying one', () => {
    const { program } = compileOne(`
      Ability Storm Bolt
      Targeting: target enemy unit
      Range 600
      Deal 180 damage to the target and add Stunned to the target.

      Buff Stunned
      Duration 3 seconds
    `);
    // Two top-level effects, not one wrapped in a delay.
    expect(program.abilities[0]!.effects.map((effect) => effect.kind)).toEqual(['damage', 'addBuff']);
  });

  it('compiles an area phrase with an anchor and a radius', () => {
    const { program } = compileOne(`
      Ability Thunder Clap
      Deal 100 damage to all enemy units within 300 range of this unit.
    `);
    expect(program.abilities[0]!.effects[0]).toEqual({
      kind: 'damage',
      amount: { kind: 'const', value: 100 },
      units: { kind: 'area', who: 'enemy', radius: 300, anchor: { kind: 'self' }, other: false },
    });
  });

  it('compiles a possessive percentage into a stat read', () => {
    const { program } = compileOne(`
      Ability Cleave
      Whenever this unit attacks, deal damage equal to 30% of this unit's attack damage to the victim.
    `);
    expect(program.abilities[0]!.triggers[0]!.effects[0]).toMatchObject({
      kind: 'damage',
      amount: { kind: 'stat', of: { kind: 'self' }, stat: 'attackDamage', percent: 30 },
    });
  });

  it('keeps a filter on a single-unit noun', () => {
    const { program } = compileOne(`
      Ability Execute
      Targeting: target enemy unit
      Range 500
      Kill the target with hp below 15%.
    `);
    expect(program.abilities[0]!.effects[0]).toEqual({
      kind: 'kill',
      units: {
        kind: 'filtered',
        units: { kind: 'target' },
        filter: { kind: 'statShare', stat: 'hp', op: '<', percent: 15, of: 'maxHp' },
      },
    });
  });

  it('warns, but still compiles, when a buff is declared with no body', () => {
    // A bare `Buff Poisoned` is a marker: no duration, no modifiers.
    const { program } = compileOne('Ability Sting\nAdd Poisoned to this unit.\n\nBuff Poisoned');
    expect(program.buffs[0]).toMatchObject({ id: 'poisoned', duration: 0, modifiers: [], periodic: [] });
  });

  it('gives "and" tighter binding than "or" inside a filter', () => {
    const { program } = compileOne(`
      Ability Purge
      Deal 10 damage to all enemy units within 300 range of this unit with poisoned or slowed and hp < 100.

      Buff Poisoned
      Buff Slowed
    `);
    // poisoned OR (slowed AND hp < 100)
    expect(damageUnits(program.abilities[0]!.effects[0])).toMatchObject({
      kind: 'filtered',
      filter: { kind: 'or', left: { kind: 'buff', buff: 'poisoned' }, right: { kind: 'and' } },
    });
  });

  it('lets parentheses override that binding', () => {
    const { program } = compileOne(`
      Ability Purge
      Deal 10 damage to all enemy units within 300 range of this unit with (poisoned or slowed) and hp < 100.

      Buff Poisoned
      Buff Slowed
    `);
    expect(damageUnits(program.abilities[0]!.effects[0])).toMatchObject({
      kind: 'filtered',
      filter: { kind: 'and', left: { kind: 'or' }, right: { kind: 'stat' } },
    });
  });

  it('does not let a filter swallow the "and" of an effect chain', () => {
    const { program } = compileOne(`
      Ability Rot
      Deal 10 damage to all enemy units within 300 range of this unit with poisoned and add Slowed to this unit.

      Buff Poisoned
      Buff Slowed
    `);
    expect(program.abilities[0]!.effects.map((effect) => effect.kind)).toEqual(['damage', 'addBuff']);
  });

  it('treats a buff name that starts with a stat word as a buff', () => {
    const { program } = compileOne(`
      Ability Dispel
      Remove Mana Shield from all enemy units within 300 range of this unit with mana shield.

      Buff Mana Shield
    `);
    expect(program.abilities[0]!.effects[0]).toMatchObject({ kind: 'removeBuff', buff: 'mana-shield' });
  });
});

describe('buffs', () => {
  it('compiles modifiers, restrictions and a cadence', () => {
    const { program } = compileOne(`
      Ability Chill
      Add Frostbite to this unit.

      Buff Frostbite
      Duration 6 seconds
      Reduce movement speed by 50%.
      Increase armor by 2.
      Cannot cast.
      Every 1 second, deal 5 damage to this unit.
    `);
    expect(program.buffs[0]).toMatchObject({
      id: 'frostbite',
      duration: 6,
      stacks: false,
      modifiers: [
        { stat: 'moveSpeed', mode: 'percent', amount: -50 },
        { stat: 'armor', mode: 'flat', amount: 2 },
      ],
      restrictions: ['cast'],
      periodic: [{ interval: 1 }],
    });
  });

  it('records the stacks option', () => {
    const { program } = compileOne(`
      Ability Sting
      Add Poisoned to this unit.
      Buff Poisoned (stacks)
      Duration 8 seconds
      Every 1 second, deal 4 damage to this unit.
    `);
    expect(program.buffs[0]!.stacks).toBe(true);
  });
});

describe('diagnostics', () => {
  it('points at the exact unknown buff', () => {
    const source = 'Ability Hex\nAdd Frailty to this unit.';
    const [diagnostic] = compileDocument(source).diagnostics;
    expect(diagnostic).toMatchObject({ code: 'unknown-buff', severity: 'error' });
    expect(source.slice(diagnostic!.start, diagnostic!.end)).toBe('Frailty');
  });

  it('rejects "the target" on an ability with no targeting', () => {
    expect(errors('Ability Zap\nDeal 10 damage to the target.')).toEqual(['no-target']);
  });

  it('rejects "the target" as a unit on a point-targeted ability', () => {
    expect(
      errors('Ability Rain\nTargeting: target point\nRange 500\nDeal 10 damage to the target.'),
    ).toEqual(['point-not-unit']);
  });

  it('rejects an event noun outside a trigger', () => {
    expect(errors('Ability Zap\nDeal 10 damage to the attacker.')).toEqual(['role-outside-trigger']);
  });

  it('rejects an event noun the event does not bind', () => {
    expect(errors('Ability Zap\nWhenever this unit casts an ability, deal 10 damage to the attacker.')).toEqual([
      'role-not-bound',
    ]);
  });

  it('rejects a cast target inside a buff', () => {
    expect(
      errors('Ability Hex\nAdd Curse to this unit.\n\nBuff Curse\nWhenever this unit dies, deal 10 damage to the target.'),
    ).toEqual(['target-in-buff']);
  });

  it('requires an end for an ability cadence and forbids one on a buff', () => {
    expect(errors('Ability Drip\nEvery 1 second, deal 5 damage to this unit.')).toEqual(['every-needs-duration']);
    expect(
      errors('Ability Rot\nAdd Decay to this unit.\n\nBuff Decay\nDuration 5 seconds\nEvery 1 second for 3 seconds, deal 5 damage to this unit.'),
    ).toEqual(['every-for-on-buff']);
  });

  it('rejects a summon of an unknown unit', () => {
    expect(errors('Ability Raise Dead\nSummon 2 Wyvern near this unit.', ['skeleton-warrior'])).toEqual([
      'unknown-unit',
    ]);
  });

  it('warns about a buff nothing applies', () => {
    const { diagnostics } = compileDocument('Ability Nothing\nDeal 1 damage to this unit.\n\nBuff Unused');
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['unused-buff']);
  });

  it('reports several bad sentences instead of stopping at the first', () => {
    const codes = errors(`
      Ability Broken
      Deal 10 damage to the moon.
      Frobnicate all enemy units within 300 range of this unit.
      Deal 20 damage to all enemy units within 300 range of this unit.
    `);
    expect(codes).toEqual(['unknown-noun', 'unknown-verb']);
  });

  it('keeps the good sentences from a document that has errors', () => {
    const { program } = compileDocument(`
      Ability Half Broken
      Frobnicate everything.
      Deal 20 damage to all enemy units within 300 range of this unit.
    `);
    expect(program.abilities[0]!.effects).toHaveLength(1);
  });

  it('parses a heading with no name without crashing', () => {
    const { diagnostics } = parseDocument('Ability\nDeal 1 damage to this unit.');
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('missing-name');
  });
});
