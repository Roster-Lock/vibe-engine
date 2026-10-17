/**
 * Dice (docs/design/20-secret-choices-and-dice.md): a roll is a pipeline action
 * with a replaceable result source, its own seeded stream, an announcement, and
 * an outcome later sentences read as "the total".
 */
import { describe, expect, it } from 'vitest';
import { compileDocument, lowerDocument, parseDocument, renderDocument } from '../src/english/index.js';
import { Character, createEngine, type GameEvent } from '../src/games/turn-based/index.js';
import { type Roller } from '../src/engine/index.js';
import { bindDocument, type DocumentIR } from '../src/ir/index.js';

const hero = () =>
  new Character('Hero', { gauges: [{ id: 'hp', max: 100 }], skills: [] });

function engineWith(seed: string, extra: { roller?: Roller } = {}) {
  const events: GameEvent[] = [];
  const engine = createEngine({ seed, onEvent: (event: GameEvent) => events.push(event), ...extra });
  return { engine, events };
}

describe('the roll action', () => {
  it('is deterministic per seed and stays inside the die', async () => {
    const a = engineWith('seed-1').engine;
    const b = engineWith('seed-1').engine;
    const first = await a.roll(20, 6);
    expect(first).toEqual(await b.roll(20, 6));
    expect(first.every((die) => Number.isInteger(die) && die >= 1 && die <= 6)).toBe(true);
    expect(new Set(first).size).toBeGreaterThan(1);
  });

  it('differs between seeds', async () => {
    const x = await engineWith('seed-1').engine.roll(30, 20);
    const y = await engineWith('seed-2').engine.roll(30, 20);
    expect(x).not.toEqual(y);
  });

  it('draws from its own stream, so rolling never shifts the trigger shuffle', async () => {
    const rolled = engineWith('seed-1').engine;
    const idle = engineWith('seed-1').engine;
    await rolled.roll(50, 6);
    expect(rolled.random()).toBe(idle.random());
  });

  it('announces roll:made with the final results and the source', async () => {
    const { engine, events } = engineWith('s');
    const caster = hero();
    const results = await engine.roll(2, 6, { source: caster });
    const made = events.find((event) => event.type === 'roll:made');
    expect(made).toMatchObject({ type: 'roll:made', count: 2, sides: 6, results, source: caster });
  });

  it('takes its numbers from a replacement roller, async or not', async () => {
    const { engine } = engineWith('s', { roller: async () => [4, 2] });
    expect(await engine.roll(2, 6)).toEqual([4, 2]);
    engine.setRoller(() => [6, 6]);
    expect(await engine.roll(2, 6)).toEqual([6, 6]);
    engine.setRoller(undefined);
    expect((await engine.roll(2, 6)).length).toBe(2);
  });

  it('refuses a roller that answers outside the die', async () => {
    const { engine } = engineWith('s', { roller: () => [7] });
    await expect(engine.roll(1, 6)).rejects.toThrow(/7 is not a possible result of a d6/);
    engine.setRoller(() => [3]);
    await expect(engine.roll(2, 6)).rejects.toThrow(/returned 1 result\(s\) for 2 dice/);
  });

  it('refuses nonsense dice', async () => {
    const { engine } = engineWith('s');
    await expect(engine.roll(0, 6)).rejects.toThrow(/count/);
    await expect(engine.roll(1, 1)).rejects.toThrow(/sides/);
  });

  it('lets an adjustment add to the outcome or reroll it', async () => {
    const { engine } = engineWith('s', { roller: () => [3, 3] });
    expect(await engine.roll(2, 6, { adjust: [(rolled) => rolled.map((die) => die + 1)] })).toEqual([4, 4]);
    let calls = 0;
    engine.setRoller(() => (calls++ === 0 ? [1, 1] : [5, 6]));
    // "reroll if the total is under 5"
    const final = await engine.roll(2, 6, {
      adjust: [async (rolled, reroll) => (rolled.reduce((a, b) => a + b, 0) < 5 ? reroll() : rolled)],
    });
    expect(final).toEqual([5, 6]);
  });
});

/* ------------------------------ from English ------------------------------ */

const compile = (text: string) => compileDocument(text);

async function run(text: string, dice: readonly number[]) {
  const compiled = compile(text);
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const ability = compiled.abilities[0]!;
  const subject = new Character('Hero', {
    gauges: [{ id: 'hp', max: 100 }],
    skills: [{ name: ability.name, weight: 1, abilities: [ability] }],
  });
  const { engine } = engineWith('s', { roller: () => dice });
  engine.registerCharacter(subject);
  await engine.useAbility(subject, ability, { targets: [] });
  return subject.findGauge('hp')!.current;
}

describe('dice in English', () => {
  it('rolls 2d6 and deals that total', async () => {
    expect(await run('Ability Gamble\nRoll 2d6.\nDeal that total damage to this character.', [3, 4])).toBe(93);
  });

  it('reads the highest and the lowest die', async () => {
    expect(await run('Ability Gamble\nRoll 3d6.\nDeal that highest die damage to this character.', [2, 6, 3])).toBe(94);
    expect(await run('Ability Gamble\nRoll 3d6.\nDeal that lowest die damage to this character.', [2, 6, 3])).toBe(98);
  });

  it('accepts total, value and result as the same thing', async () => {
    for (const word of ['total', 'value', 'result']) {
      expect(await run(`Ability Gamble\nRoll a d20.\nDeal that ${word} damage to this character.`, [15])).toBe(85);
    }
  });

  it('uses the outcome in a formula', async () => {
    expect(await run('Ability Gamble\nRoll a d6.\nDeal (roll.total * 2) damage to this character.', [4])).toBe(92);
  });

  it('reads 0 before anything has been rolled, instead of failing', async () => {
    expect(await run('Ability Gamble\nDeal that total damage to this character.', [5])).toBe(100);
  });

  it('keeps a roll for the whole ability, so two sentences use the same dice', async () => {
    expect(
      await run('Ability Gamble\nRoll 2d6.\nDeal that total damage to this character.\nDeal that total damage to this character.', [3, 4]),
    ).toBe(86);
  });

  it('has no "the total": it says what to write instead', () => {
    const messages = compile('Ability A\nRoll a d6.\nDeal the total damage to this character.').diagnostics.map((d) => d.message);
    expect(messages[0]).toMatch(/write "that total" — "that" is always the most recent roll.*Store that value as AttackerRoll/);
  });

  it('rejects dice that are not dice', () => {
    const messages = (text: string) => compile(text).diagnostics.map((d) => d.message);
    expect(messages('Ability A\nRoll 0d6.')[0]).toMatch(/not a number of dice/);
    expect(messages('Ability A\nRoll a d1.')[0]).toMatch(/at least 2 sides/);
    expect(messages('Ability A\nRoll 2 d6.')[0]).toMatch(/with no spaces/);
    expect(messages('Ability A\nRoll.')[0]).toMatch(/Roll a d20/);
  });

  it('round-trips through the IR and renders its own words back', () => {
    const text = 'Ability Gamble\nRoll 2d6.\nDeal that total damage to this character.\nRoll a d20.\nDeal that lowest die damage to this character.';
    const ir = lowerDocument(parseDocument(text).doc);
    expect(ir.abilities[0]!.steps[0]!.effects[0]).toEqual({
      kind: 'roll',
      count: { kind: 'const', value: 2 },
      sides: { kind: 'const', value: 6 },
    });
    expect(ir.abilities[0]!.steps[1]!.effects[0]).toMatchObject({ amount: { kind: 'rolled', stat: 'total' } });
    const { text: rendered, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    expect(rendered).toContain('Roll 2d6.');
    expect(rendered).toContain('Deal that total damage to this character.');
    expect(rendered).toContain('Roll a d20.');
    expect(rendered).toContain('Deal that lowest die damage to this character.');
    const again = lowerDocument(parseDocument(rendered).doc);
    expect(again.abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
    expect(renderDocument(again).text).toBe(rendered);
  });
});

/** Like `run`, but each roll gets the next set of dice. */
async function runRolls(text: string, rolls: readonly (readonly number[])[]) {
  const compiled = compile(text);
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const ability = compiled.abilities[0]!;
  const subject = new Character('Hero', {
    gauges: [{ id: 'hp', max: 100 }],
    skills: [{ name: ability.name, weight: 1, abilities: [ability] }],
  });
  let next = 0;
  const { engine } = engineWith('s', { roller: () => rolls[next++]! });
  engine.registerCharacter(subject);
  await engine.useAbility(subject, ability, { targets: [] });
  return subject.findGauge('hp')!.current;
}

describe('several rolls: "that" is the latest, and a stored value keeps an earlier one', () => {
  const text = (...lines: string[]) => `Ability Gamble\n${lines.join('\n')}`;

  it('"that" always means the most recent roll', async () => {
    const hp = await runRolls(
      text('Roll a d6.', 'Roll a d20.', 'Deal that value damage to this character.'),
      [[4], [15]],
    );
    expect(hp).toBe(100 - 15);
  });

  it('stores a roll under a name that survives the next roll', async () => {
    const hp = await runRolls(
      text(
        'Roll a d20.',
        'Store that value as AttackerRoll.',
        'Roll a d20.',
        'Store that value as DefenderRoll.',
        'Deal AttackerRoll damage to this character.',
        'Deal DefenderRoll damage to this character.',
      ),
      [[17], [5]],
    );
    expect(hp).toBe(100 - 17 - 5);
  });

  it('uses a stored name inside a formula, and stores a formula', async () => {
    const hp = await runRolls(
      text('Roll a d6.', 'Store (that total * 2) as Doubled.', 'Roll a d6.', 'Deal (Doubled + that total) damage to this character.'),
      [[3], [4]],
    );
    expect(hp).toBe(100 - (6 + 4));
  });

  it('stores the value as it was, even after later dice', async () => {
    const hp = await runRolls(
      text('Roll 2d6.', 'Store that highest die as Best.', 'Roll 2d6.', 'Deal Best damage to this character.', 'Deal that total damage to this character.'),
      [[1, 6], [2, 2]],
    );
    expect(hp).toBe(100 - 6 - 4);
  });

  it('reports a name that was never stored, used twice, or reserved', () => {
    const errors = (...lines: string[]) =>
      compile(text(...lines)).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
    expect(errors('Deal Missing damage to this character.')[0]).toMatch(/"Missing" has not been stored.*Store that value as Missing/);
    expect(errors('Roll a d6.', 'Store that value as X.', 'Store that value as X.')[0]).toMatch(/already stored/);
    expect(errors('Roll a d6.', 'Store that value as count.')[0]).toMatch(/word the language already uses/);
    expect(errors('Roll a d6.', 'Store that value as total.')[0]).toMatch(/word the language already uses/);
    expect(errors('Deal (Later * 2) damage to this character.', 'Roll a d6.', 'Store that value as Later.')[0]).toMatch(/"Later" has not been stored/);
  });

  it('round-trips the store sentence and a stored name, as the bare name', () => {
    const source = text('Roll a d6.', 'Store that value as AttackerRoll.', 'Deal AttackerRoll damage to this character.');
    const ir = lowerDocument(parseDocument(source).doc);
    expect(ir.abilities[0]!.steps[1]!.effects[0]).toEqual({
      kind: 'store',
      name: 'AttackerRoll',
      value: { kind: 'rolled', stat: 'total' },
    });
    expect(ir.abilities[0]!.steps[2]!.effects[0]).toMatchObject({ amount: { kind: 'variable', name: 'AttackerRoll' } });
    const rendered = renderDocument(ir).text;
    expect(rendered).toContain('Store that total as AttackerRoll.');
    expect(rendered).toContain('Deal AttackerRoll damage to this character.');
    expect(lowerDocument(parseDocument(rendered).doc).abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
  });
});

describe('dice in a JSON document', () => {
  it('carries a roll and a rolled value across a round trip', async () => {
    const document: DocumentIR = {
      version: 1,
      imports: [],
      buffs: [],
      triggers: [],
      abilities: [
        {
          id: 'gamble',
          name: 'Gamble',
          targeting: { who: 'self', count: 1 },
          steps: [
            { effects: [{ kind: 'roll', count: { kind: 'const', value: 2 }, sides: { kind: 'const', value: 6 } }] },
            {
              effects: [
                {
                  kind: 'gauge',
                  query: { kind: 'self' },
                  gauge: { kind: 'life' },
                  op: 'subtract',
                  amount: { kind: 'rolled', stat: 'total' },
                },
              ],
            },
          ],
        },
      ],
    };
    const ability = bindDocument(JSON.parse(JSON.stringify(document)) as DocumentIR, {
      resolveBuff: () => undefined,
    }).abilities[0]!;
    const subject = new Character('Hero', {
      gauges: [{ id: 'hp', max: 100 }],
      skills: [{ name: 'Gamble', weight: 1, abilities: [ability] }],
    });
    const { engine, events } = engineWith('s', { roller: () => [5, 6] });
    engine.registerCharacter(subject);
    await engine.useAbility(subject, ability, { targets: [] });
    expect(subject.findGauge('hp')!.current).toBe(89);
    expect(events.some((event) => event.type === 'roll:made')).toBe(true);
  });
});

/* ------------------------- one-off conditions on a value ------------------------- */

describe('If <value> is <test>', () => {
  const text = (...lines: string[]) => `Ability Gamble\n${lines.join('\n')}`;
  const hpAfter = (roll: number, ...lines: string[]) => runRolls(text('Roll a d20.', ...lines), [[roll]]);

  it('"N or more" runs only when the roll is at least that', async () => {
    const line = 'If that total is 15 or more, Deal 50 damage to this character.';
    expect(await hpAfter(15, line)).toBe(50);
    expect(await hpAfter(20, line)).toBe(50);
    expect(await hpAfter(14, line)).toBe(100);
  });

  it('"N or less", "N to M" and a bare "N"', async () => {
    expect(await hpAfter(3, 'If that total is 3 or less, Deal 7 damage to this character.')).toBe(93);
    expect(await hpAfter(4, 'If that total is 3 or less, Deal 7 damage to this character.')).toBe(100);
    expect(await hpAfter(5, 'If that total is 5 to 8, Deal 7 damage to this character.')).toBe(93);
    expect(await hpAfter(8, 'If that total is 5 to 8, Deal 7 damage to this character.')).toBe(93);
    expect(await hpAfter(9, 'If that total is 5 to 8, Deal 7 damage to this character.')).toBe(100);
    expect(await hpAfter(13, 'If that total is 13, Deal 7 damage to this character.')).toBe(93);
    expect(await hpAfter(12, 'If that total is 13, Deal 7 damage to this character.')).toBe(100);
  });

  it('compares two values: higher than, lower than, the same as', async () => {
    const duel = (attacker: number, defender: number) =>
      runRolls(
        text(
          'Roll a d20.',
          'Store that value as AttackerRoll.',
          'Roll a d20.',
          'Store that value as DefenderRoll.',
          'If AttackerRoll is higher than DefenderRoll, Deal 10 damage to this character.',
          'If AttackerRoll is lower than DefenderRoll, Deal 20 damage to this character.',
          'If AttackerRoll is the same as DefenderRoll, Deal 1 damage to this character.',
        ),
        [[attacker], [defender]],
      );
    expect(await duel(15, 4)).toBe(90);
    expect(await duel(4, 15)).toBe(80);
    expect(await duel(9, 9)).toBe(99);
  });

  it('tests a formula, and compares against a formula', async () => {
    expect(await hpAfter(8, 'If (that total * 2) is 16 or more, Deal 5 damage to this character.')).toBe(95);
    expect(await hpAfter(7, 'If (that total * 2) is 16 or more, Deal 5 damage to this character.')).toBe(100);
    expect(await hpAfter(8, 'If that total is higher than (4 + 3), Deal 5 damage to this character.')).toBe(95);
  });

  it('works with You may, and as the condition of a Repeat', async () => {
    // Roll until the die is above 3: 2, 2, then a 6 stops it.
    const hp = await runRolls(
      text('Roll a d6.', 'Repeat up to 10 times while that total is 3 or less: Roll a d6.', 'Deal that total damage to this character.'),
      [[2], [2], [6]],
    );
    expect(hp).toBe(94);
  });

  it('works inside a table line', async () => {
    const lines = ['Roll a d20.', '  1 to 10: If that total is 5 or more, Deal 9 damage to this character.', '  11 or more: Deal 1 damage to this character.'];
    expect(await runRolls(text(...lines), [[7]])).toBe(91);
    expect(await runRolls(text(...lines), [[3]])).toBe(100);
    expect(await runRolls(text(...lines), [[15]])).toBe(99);
  });

  it('keeps "If the board is full" on the old message that lists the other shapes', () => {
    const message = compile(text('If the board is full, Deal 1 damage to this character.')).diagnostics[0]?.message ?? '';
    expect(message).toMatch(/"there are …".*"every …".*that total is 10 or more/);
  });

  it('explains a test it cannot read', () => {
    const message = (line: string) => compile(text('Roll a d6.', line)).diagnostics[0]?.message ?? '';
    expect(message('If that total is big, Deal 1 damage to this character.')).toMatch(/expected a number or a comparison after "is"/);
    expect(message('If that total is 9 to 3, Deal 1 damage to this character.')).toMatch(/counts down/);
    expect(message('If that total is 3 or fewer, Deal 1 damage to this character.')).toMatch(/expected "more" or "less"/);
    expect(message('If that total is higher than, Deal 1 damage to this character.')).toMatch(/expected a number/);
  });

  it('checks a stored name used in a condition', () => {
    const errors = compile(text('If Missing is 3 or more, Deal 1 damage to this character.')).diagnostics.map((d) => d.message);
    expect(errors[0]).toMatch(/"Missing" has not been stored/);
    expect(
      compile(text('Roll a d6.', 'Store that value as X.', 'If Y is higher than X, Deal 1 damage to this character.')).diagnostics[0]?.message,
    ).toMatch(/"Y" has not been stored/);
  });

  it('round-trips every form through the IR', () => {
    const source = text(
      'Roll a d20.',
      'Store that value as A.',
      'If that total is 15 or more, Deal 1 damage to this character.',
      'If that total is 3 or less, Deal 1 damage to this character.',
      'If that total is 5 to 8, Deal 1 damage to this character.',
      'If that total is 13, Deal 1 damage to this character.',
      'If A is higher than that total, Deal 1 damage to this character.',
      'If A is lower than 7, Deal 1 damage to this character.',
      'If A is the same as that total, Deal 1 damage to this character.',
      'If (that total * 2) is 16 or more, Deal 1 damage to this character.',
    );
    const ir = lowerDocument(parseDocument(source).doc);
    const { text: rendered, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    // The renderer's own style: the effect after a guard is lowercased, a stored
    // value reads "that total", and a formula is written with its path.
    for (const line of [
      'If that total is 15 or more, deal 1 damage to this character.',
      'If that total is 3 or less, deal 1 damage to this character.',
      'If that total is 5 to 8, deal 1 damage to this character.',
      'If that total is 13, deal 1 damage to this character.',
      'If A is higher than that total, deal 1 damage to this character.',
      'If A is lower than 7, deal 1 damage to this character.',
      'If A is the same as that total, deal 1 damage to this character.',
      'If (roll.total * 2) is 16 or more, deal 1 damage to this character.',
    ]) {
      expect(rendered).toContain(line);
    }
    const again = lowerDocument(parseDocument(rendered).doc);
    expect(again.abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
    expect(renderDocument(again).text).toBe(rendered);
  });

  it('lowers to plain comparisons, so JSON documents use the same predicate', () => {
    const ir = lowerDocument(parseDocument(text('Roll a d20.', 'If that total is 5 to 8, Deal 1 damage to this character.')).doc);
    expect(ir.abilities[0]!.steps[1]!.when).toEqual({
      kind: 'and',
      clauses: [
        { kind: 'compare', op: '>=', left: { kind: 'rolled', stat: 'total' }, right: { kind: 'const', value: 5 } },
        { kind: 'compare', op: '<=', left: { kind: 'rolled', stat: 'total' }, right: { kind: 'const', value: 8 } },
      ],
    });
  });
});
