/**
 * Roll tables — a result per line, in the Deck of Many Things shape
 * (docs/design/20-secret-choices-and-dice.md):
 *
 * ```
 * Roll a d20.
 *   1: Destroy this character.
 *   2 to 5: Deal 5 damage to this character.
 *   20: Draw(you, 2).
 * ```
 *
 * The roll is read **once**, the first line it falls in runs, and a result no
 * line covers does nothing.
 */
import { describe, expect, it } from 'vitest';
import { compileDocument, lowerDocument, parseDocument, renderDocument } from '../src/english/index.js';
import { Character, createEngine, type GameEvent } from '../src/games/turn-based/index.js';
import type { Roller } from '../src/engine/index.js';
import { bindDocument, type DocumentIR } from '../src/ir/index.js';

const compile = (text: string) => compileDocument(text);
const errors = (text: string) =>
  compile(text).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

/** Runs the ability for a hero with 100 hp, each roll taking the next set of dice. */
async function run(text: string, rolls: readonly (readonly number[])[]) {
  const compiled = compile(text);
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const ability = compiled.abilities[0]!;
  const subject = new Character('Hero', {
    gauges: [{ id: 'hp', max: 100 }],
    skills: [{ name: ability.name, weight: 1, abilities: [ability] }],
  });
  let next = 0;
  const roller: Roller = () => rolls[next++]!;
  const events: GameEvent[] = [];
  const engine = createEngine({ seed: 's', roller, onEvent: (event: GameEvent) => events.push(event) });
  engine.registerCharacter(subject);
  await engine.useAbility(subject, ability, { targets: [] });
  return { hp: subject.findGauge('hp')!.current, rolled: next, events };
}

const DECK = `Ability Deck of Many Things
Roll a d20.
  1: Deal 50 damage to this.
  2 to 5: Deal 5 damage to this.
  6 or more: Deal 1 damage to this.
`;

describe('a roll table — running', () => {
  it('runs the line the roll falls in', async () => {
    expect((await run(DECK, [[1]])).hp).toBe(50);
    expect((await run(DECK, [[2]])).hp).toBe(95);
    expect((await run(DECK, [[5]])).hp).toBe(95);
    expect((await run(DECK, [[6]])).hp).toBe(99);
    expect((await run(DECK, [[20]])).hp).toBe(99);
  });

  it('does nothing for a result no line covers', async () => {
    const sparse = 'Ability Sparse\nRoll a d20.\n  1: Deal 50 damage to this.\n  20: Deal 10 damage to this.';
    const out = await run(sparse, [[10]]);
    expect(out.hp).toBe(100);
    expect(out.rolled).toBe(1);
  });

  it('falls back to Otherwise for everything left', async () => {
    const text = 'Ability Fallback\nRoll a d20.\n  1: Deal 50 damage to this.\n  Otherwise: Deal 2 damage to this.';
    expect((await run(text, [[1]])).hp).toBe(50);
    expect((await run(text, [[13]])).hp).toBe(98);
  });

  it('reads "or less" as everything up to it', async () => {
    const text = 'Ability Low\nRoll a d20.\n  5 or less: Deal 7 damage to this.';
    expect((await run(text, [[1]])).hp).toBe(93);
    expect((await run(text, [[5]])).hp).toBe(93);
    expect((await run(text, [[6]])).hp).toBe(100);
  });

  it('keys a table on the total of several dice', async () => {
    const text = 'Ability Pair\nRoll 2d6.\n  2: Deal 40 damage to this.\n  3 to 11: Deal 3 damage to this.\n  12: Deal 20 damage to this.';
    expect((await run(text, [[1, 1]])).hp).toBe(60);
    expect((await run(text, [[3, 4]])).hp).toBe(97);
    expect((await run(text, [[6, 6]])).hp).toBe(80);
  });

  it('runs every sentence on the line', async () => {
    const text = 'Ability Two\nRoll a d6.\n  4: Deal 3 damage to this. Deal 4 damage to this.';
    expect((await run(text, [[4]])).hp).toBe(93);
  });

  it('reads the roll once: a roll inside a line cannot send it to another line', async () => {
    // Result 1 rolls again and gets 20. The 20 line must not then run.
    const text = `Ability Chain
Roll a d20.
  1: Roll a d20. Deal that value damage to this.
  20: Deal 1000 damage to this.`;
    const out = await run(text, [[1], [20]]);
    expect(out.hp).toBe(80);
    expect(out.rolled).toBe(2);
  });

  it('belongs to the roll directly above it, and lets a line read the roll that chose it', async () => {
    const text = `Ability Echo
Roll a d20.
Store that value as Original.
  1 to 10: Deal that value damage to this.`;
    // A sentence between the roll and its lines means the lines belong to nothing: error.
    expect(errors(text).length).toBeGreaterThan(0);
    const ok = `Ability Echo
Roll a d20.
  1 to 10: Deal that value damage to this.
  11 to 20: Deal that value damage to this.`;
    expect((await run(ok, [[7]])).hp).toBe(93);
    expect((await run(ok, [[15]])).hp).toBe(85);
  });

  it('announces the roll like any other', async () => {
    const { events } = await run(DECK, [[3]]);
    expect(events.filter((event) => event.type === 'roll:made')).toHaveLength(1);
  });
});

describe('a roll table — in the text', () => {
  it('lowers to a roll and a table in one step', () => {
    const ir = lowerDocument(parseDocument(DECK).doc);
    const step = ir.abilities[0]!.steps;
    expect(step).toHaveLength(1);
    expect(step[0]!.effects.map((effect) => effect.kind)).toEqual(['roll', 'table']);
    const table = step[0]!.effects[1]!;
    if (table.kind !== 'table') throw new Error('expected a table');
    expect(table.on).toEqual({ kind: 'rolled', stat: 'total' });
    expect(table.rows.map((row) => [row.min, row.max])).toEqual([
      [1, 1],
      [2, 5],
      [6, null],
    ]);
  });

  it('renders one line per result and round-trips exactly', () => {
    const source = `Ability Deck
Roll a d20.
  1: Deal 50 damage to this.
  2 to 5: Deal 5 damage to this. Heal this for 1.
  6 to 19: Heal this for 3.
  Otherwise: Deal 2 damage to this.`;
    const ir = lowerDocument(parseDocument(source).doc);
    const { text, gaps } = renderDocument(ir);
    expect(gaps).toEqual([]);
    expect(text).toContain('Roll a d20.\n  1: Deal 50 damage to this.\n  2 to 5: Deal 5 damage to this. Heal this for 1.');
    expect(text).toContain('  Otherwise: Deal 2 damage to this.');
    const again = lowerDocument(parseDocument(text).doc);
    expect(again.abilities[0]!.steps).toEqual(ir.abilities[0]!.steps);
    expect(renderDocument(again).text).toBe(text);
  });

  it('renders "or more" and "or less" back as written', () => {
    const text = renderDocument(
      lowerDocument(parseDocument('Ability A\nRoll a d20.\n  3 or less: Heal this for 1.\n  15 or more: Heal this for 2.').doc),
    ).text;
    expect(text).toContain('  3 or less: Heal');
    expect(text).toContain('  15 or more: Heal');
  });

  it('describes the roll with its lines in the ability summary', () => {
    const description = lowerDocument(parseDocument(DECK).doc).abilities[0]!.description ?? '';
    expect(description).toContain('Roll a d20.');
    expect(description).toContain('2 to 5: Deal 5 damage');
  });

  it('marks, rather than drops, a table that reads something else (from JSON)', () => {
    const document: DocumentIR = {
      version: 1,
      imports: [],
      buffs: [],
      triggers: [],
      abilities: [
        {
          id: 'odd',
          name: 'Odd',
          targeting: { who: 'self', count: 1 },
          steps: [
            {
              effects: [
                { kind: 'roll', count: { kind: 'const', value: 1 }, sides: { kind: 'const', value: 6 } },
                { kind: 'table', on: { kind: 'const', value: 3 }, rows: [{ min: 3, max: 3, steps: [] }] },
              ],
            },
          ],
        },
      ],
    };
    expect(renderDocument(document).gaps.map((gap) => gap.reason)).toEqual([
      'a table that reads something other than the roll just made',
    ]);
  });
});

describe('a roll table — diagnostics', () => {
  it('rejects a result the dice cannot make', () => {
    expect(errors('Ability A\nRoll a d20.\n  25: Heal this for 1.')[0]).toMatch(/a d20 never rolls 25 — it rolls 1 to 20/);
    expect(errors('Ability A\nRoll 2d6.\n  1: Heal this for 1.')[0]).toMatch(/2d6 never rolls 1 — it rolls 2 to 12/);
    expect(errors('Ability A\nRoll a d6.\n  7 or more: Heal this for 1.')[0]).toMatch(/never rolls 7/);
  });

  it('rejects two lines that cover the same result, and says which', () => {
    expect(errors('Ability A\nRoll a d20.\n  1 to 10: Heal this for 1.\n  10 to 20: Heal this for 2.')[0]).toMatch(
      /"10 to 20" and "1 to 10" both cover 10 — give each result one line/,
    );
    expect(errors('Ability A\nRoll a d20.\n  15 or more: Heal this for 1.\n  20: Heal this for 2.')[0]).toMatch(/both cover 20/);
  });

  it('puts Otherwise last and only once', () => {
    expect(errors('Ability A\nRoll a d6.\n  Otherwise: Heal this for 1.\n  1: Heal this for 2.')[0]).toMatch(
      /comes after "Otherwise:"/,
    );
    expect(errors('Ability A\nRoll a d6.\n  Otherwise: Heal this for 1.\n  Otherwise: Heal this for 2.').join(' ')).toMatch(
      /already an "Otherwise:" line/,
    );
  });

  it('does not let a line pick a target', () => {
    expect(errors('Ability A\nRoll a d6.\n  1: Deal 5 damage to target enemy character.')[0]).toMatch(
      /a result line cannot pick a target.*Target 1 character as Victim/,
    );
  });

  it('checks names used inside a line', () => {
    expect(errors('Ability A\nRoll a d6.\n  1: Deal Missing damage to this.')[0]).toMatch(/"Missing" has not been stored/);
    expect(errors('Ability A\nRoll a d6.\n  1: Add Nonexistent to this.')[0]).toMatch(/Nonexistent/);
  });

  it('explains a malformed line', () => {
    expect(errors('Ability A\nRoll a d6.\n  1:')[0]).toMatch(/needs something to happen/);
    expect(errors('Ability A\nRoll a d6.\n  3 to: Heal this for 1.')[0]).toMatch(/expected a number after "3 to"/);
    expect(errors('Ability A\nRoll a d6.\n  5 to 2: Heal this for 1.')[0]).toMatch(/counts down/);
    expect(errors('Ability A\nRoll a d6.\n  3 or fewer: Heal this for 1.')[0]).toMatch(/expected "more" or "less"/);
  });

  it('leaves a result line with no roll above it as an ordinary mistake', () => {
    expect(errors('Ability A\nHeal this for 1.\n  1: Heal this for 2.').length).toBeGreaterThan(0);
  });
});

describe('a roll table — from JSON', () => {
  it('runs the first matching row, then Otherwise', async () => {
    const document: DocumentIR = {
      version: 1,
      imports: [],
      buffs: [],
      triggers: [],
      abilities: [
        {
          id: 'deck',
          name: 'Deck',
          targeting: { who: 'self', count: 1 },
          steps: [
            {
              effects: [
                { kind: 'roll', count: { kind: 'const', value: 1 }, sides: { kind: 'const', value: 20 } },
                {
                  kind: 'table',
                  on: { kind: 'rolled', stat: 'total' },
                  rows: [
                    { min: 1, max: 5, steps: [{ effects: [dealSelf(10)] }] },
                    { min: 0, max: null, otherwise: true, steps: [{ effects: [dealSelf(1)] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const ability = bindDocument(JSON.parse(JSON.stringify(document)) as DocumentIR, { resolveBuff: () => undefined })
      .abilities[0]!;
    for (const [roll, expected] of [[3, 90], [17, 99]] as const) {
      const subject = new Character('Hero', {
        gauges: [{ id: 'hp', max: 100 }],
        skills: [{ name: 'Deck', weight: 1, abilities: [ability] }],
      });
      const engine = createEngine({ seed: 's', roller: () => [roll] });
      engine.registerCharacter(subject);
      await engine.useAbility(subject, ability, { targets: [] });
      expect(subject.findGauge('hp')!.current).toBe(expected);
    }
  });
});

function dealSelf(amount: number) {
  return {
    kind: 'gauge' as const,
    query: { kind: 'self' as const },
    gauge: { kind: 'life' as const },
    op: 'subtract' as const,
    amount: { kind: 'const' as const, value: amount },
  };
}
