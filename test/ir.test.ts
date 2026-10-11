/**
 * The IR (`src/ir/`) as the **share format**.
 *
 * `src/english/compile.ts` no longer builds engine closures directly — it
 * lowers a document to plain JSON and `src/ir/bind` binds that. These tests
 * hold that pipeline to the three claims that justify it (docs/GOAL.md):
 *
 * 1. a compiled document survives `JSON.stringify` → `JSON.parse`;
 * 2. the *deserialized* copy binds to abilities that behave identically —
 *    which is what "an ability travels to another player" means;
 * 3. a trigger written as IR by hand runs through the real trigger stack,
 *    so the trigger shapes work before the English grammar for them exists.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  Player,
  buff,
  damage,
  type Decision,
} from '../src/games/turn-based/index.js';
import {
  bindDocument,
  evaluateMathExpression,
  parseMathExpression,
  type AbilityIR,
  type DocumentIR,
  type EntityQueryIR,
  type PredicateIR,
  type TriggerIR,
  type ValueIR,
} from '../src/ir/index.js';
import { buildArena, compileDocument, runArena } from '../src/english/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

class Idle extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** Round-trips a document through JSON — the share step, literally. */
function shared(ir: DocumentIR): DocumentIR {
  return JSON.parse(JSON.stringify(ir)) as DocumentIR;
}

/* ----------------------------- the IR shape ---------------------------- */

describe('lowering to IR', () => {
  it('lowers an ability into steps, with its targeting pattern hoisted', () => {
    const result = compileDocument(`
      Ability Fireball
      Deal 40 damage to target enemy character.
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir.abilities).toHaveLength(1);
    const ability = result.ir.abilities[0]!;
    expect(ability.id).toBe('fireball');
    expect(ability.targeting).toEqual({ who: 'enemy', count: 1 });
    expect(ability.steps).toEqual([
      {
        effects: [
          {
            kind: 'gauge',
            query: { kind: 'picked' },
            // Bare `Deal … damage` targets the life gauge, not a literal 'hp'.
            gauge: { kind: 'life' },
            op: 'subtract',
            amount: { kind: 'const', value: 40 },
          },
        ],
      },
    ]);
  });

  it('lowers an ownership clause to a relation filter, not a comparison', () => {
    const result = compileDocument('Destroy all characters owned by the opponent.');
    const effect = result.ir.abilities[0]!.steps[0]!.effects[0]!;
    expect(effect).toEqual({
      kind: 'destroy',
      query: { kind: 'all', who: 'any', other: false, filter: { kind: 'relation', to: 'opponent' } },
    });
  });

  it('keeps a grouped filter as a tree so the grouping survives the round trip', () => {
    const result = compileDocument(`
      Buff Poison
      Buff Thorns
      Ability Reap
      Add Poison to this character.
      Add Thorns to this character.
      Destroy all enemy characters with (Poison or Thorns) and hp <= 40.
    `);
    const destroy = result.ir.abilities[0]!.steps[2]!.effects[0]!;
    const query = destroy.kind === 'destroy' ? destroy.query : undefined;
    expect(query?.kind === 'all' ? query.filter : undefined).toEqual({
      kind: 'and',
      clauses: [
        { kind: 'or', clauses: [{ kind: 'hasBuff', buff: 'Poison' }, { kind: 'hasBuff', buff: 'Thorns' }] },
        {
          kind: 'compare',
          op: '<=',
          left: { kind: 'gauge', gauge: 'hp' },
          right: { kind: 'const', value: 40 },
        },
      ],
    });
  });

  it('a multi-sentence ability lowers to one step per sentence', () => {
    const result = compileDocument(`
      Buff Poison
      Ability Plague
      Add Poison to all enemy characters.
      Destroy all enemy characters with Poison.
    `);
    expect(result.ir.abilities[0]!.steps).toHaveLength(2);
  });

  it('a buff lowers its sentences to triggers grouped by event', () => {
    const result = compileDocument(`
      Buff Regeneration
      When the turn starts, heal this character for 5.
      When the turn ends, heal this character for 2.

      Ability Bless
      Add Regeneration to target ally character.
    `);
    const buffIr = result.ir.buffs[0]!;
    expect(buffIr.triggers.map((t) => [t.event, t.mode, t.scope])).toEqual([
      ['turn:start', 'single', 'self'],
      ['turn:end', 'single', 'self'],
    ]);
  });
});

/* --------------------------- the share format -------------------------- */

describe('IR as the share format', () => {
  const source = `
    Buff Frailty (stacks)

    Ability Soul Rot
    Deal 12 damage to target enemy character.
    Add Frailty to target enemy character.
  `;

  it('round-trips through JSON unchanged', () => {
    const { ir } = compileDocument(source);
    expect(shared(ir)).toEqual(ir);
  });

  it('carries no closures — every leaf is JSON-representable', () => {
    const { ir } = compileDocument(source);
    const walk = (value: unknown, path: string): void => {
      if (value === null) return;
      expect(typeof value, `at ${path}`).not.toBe('function');
      if (typeof value === 'object') {
        // A plain object or array — never a class instance.
        expect([Object.prototype, Array.prototype], `at ${path}`).toContain(Object.getPrototypeOf(value));
        for (const [key, child] of Object.entries(value as object)) walk(child, `${path}.${key}`);
      }
    };
    walk(ir, 'ir');
  });

  it('the deserialized copy binds to an ability that behaves identically', async () => {
    const compiled = compileDocument(source);
    expect(compiled.diagnostics).toEqual([]);

    // The "other player" end: nothing but the JSON and the buff resolver.
    const received = shared(compiled.ir);
    const rebound = bindDocument(received, {
      resolveBuff: (name) => received.buffs.find((b) => b.name === name) && { name, weight: 1, stacks: true },
    });

    const run = async (ability: Parameters<typeof buildArena>[0]) => {
      const arena = buildArena(ability);
      await runArena(arena, ability);
      return { hp: arena.goblin.gauge('hp').current, statuses: arena.goblin.statuses.map((s) => s.name) };
    };

    expect(await run(rebound.abilities[0]!)).toEqual(await run(compiled.abilities[0]!));
    expect((await run(rebound.abilities[0]!)).hp).toBe(28); // 40 - 12
    expect((await run(rebound.abilities[0]!)).statuses).toContain('Frailty');
  });
});

/* ----------------------- triggers, straight from IR -------------------- */

/** The triggering set: the entities that survived a trigger's filter. */
const triggering: EntityQueryIR = { kind: 'event', role: 'subject' };
const triggerCount: ValueIR = { kind: 'count', query: triggering };
const n = (value: number): ValueIR => ({ kind: 'const', value });

/** What a `<n> to <m>` count phrase lowers to — a predicate, not a range. */
const countBetween = (min: number, max: number): PredicateIR => ({
  kind: 'and',
  clauses: [
    { kind: 'compare', op: '>=', left: triggerCount, right: n(min) },
    { kind: 'compare', op: '<=', left: triggerCount, right: n(max) },
  ],
});

describe('bindTrigger', () => {
  const marked = { name: 'Marked', weight: 1 };

  /**
   * "when 2 to 5 characters an opponent controls survive, mark each of
   * them" — the batch-event sentence shape, written as IR:
   *
   *   when   → `count(triggering) >= 2 and <= 5`   the "2 to 5"
   *   filter → `relation: 'enemy'`                 the "an opponent controls"
   *   event  → `character:survived:batch` + `mode: 'batch'`
   *   steps  → the "then …"
   */
  const mark: TriggerIR = {
    id: 'mark-the-survivors',
    name: 'Mark the Survivors',
    scope: 'self',
    event: 'character:survived:batch',
    mode: 'batch',
    when: countBetween(2, 5),
    filter: { kind: 'relation', to: 'enemy' },
    steps: [{ effects: [{ kind: 'addBuff', query: triggering, buff: 'Marked' }] }],
  };

  async function arena(trigger: TriggerIR, enemyHp = 100) {
    const engine = createEngine({ seed: 'ir-trigger' });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 10 });
    const friend = new Character('Friend', { maxHp: 100, maxMana: 10 });
    const a = new Character('Foe A', { maxHp: enemyHp, maxMana: 10 });
    const b = new Character('Foe B', { maxHp: enemyHp, maxMana: 10 });
    // A bystander nobody touches: keeps the enemy team standing when A and B
    // die, so the engine does not end the game mid-assertion.
    const bystander = new Character('Foe C', { maxHp: 100, maxMana: 10 });
    hero.team = 'party';
    friend.team = 'party';
    a.team = 'foes';
    b.team = 'foes';
    bystander.team = 'foes';
    engine.registerPlayers([
      new Idle('You', [hero, friend], 'party'),
      new Idle('Them', [a, b, bystander], 'foes'),
    ]);
    const bound = bindDocument(
      { version: 1, imports: [], abilities: [], buffs: [], triggers: [trigger] },
      { resolveBuff: (name) => (name === 'Marked' ? marked : undefined) },
    );
    await engine.addBuff(hero, buff({ name: trigger.name, weight: 1, abilities: [bound.triggers[0]!] }));
    return { engine, hero, a, b, friend };
  }

  const names = (c: Character): string[] => c.statuses.map((status) => status.name);

  it('fires when the gate holds for the filtered set', async () => {
    const { engine, a, b } = await arena(mark);
    await engine.apply([damage(a.gauge('hp'), 10), damage(b.gauge('hp'), 10)]);
    expect(names(a)).toContain('Marked');
    expect(names(b)).toContain('Marked');
  });

  it('stays quiet below the count floor', async () => {
    const { engine, a } = await arena(mark);
    await engine.apply([damage(a.gauge('hp'), 10)]);
    expect(names(a)).not.toContain('Marked');
  });

  it('counts only the entities the filter kept', async () => {
    const { engine, a, friend } = await arena(mark);
    // One enemy and one ally are hit in the same batch. The filter keeps
    // enemies, so the counted set is 1 — below the floor, even though the
    // batch itself held two survivors.
    await engine.apply([damage(a.gauge('hp'), 10), damage(friend.gauge('hp'), 10)]);
    expect(names(a)).not.toContain('Marked');
    expect(names(friend)).not.toContain('Marked');
  });

  it('an omitted gate means "at least one"', async () => {
    const anyNumber: TriggerIR = { ...mark, when: undefined };
    const { engine, a } = await arena(anyNumber);
    await engine.apply([damage(a.gauge('hp'), 10)]);
    expect(names(a)).toContain('Marked');
  });

  /* ------- gates a {min,max} range could not have expressed ------- */

  it('gates on an even count — a parity, not a remainder', async () => {
    // `%` is reserved for percent, so parity is its own predicate rather
    // than `count % 2 = 0` in a formula.
    const evenOnly: TriggerIR = {
      ...mark,
      when: { kind: 'parity', value: triggerCount, parity: 'even' },
    };
    const two = await arena(evenOnly);
    await two.engine.apply([damage(two.a.gauge('hp'), 10), damage(two.b.gauge('hp'), 10)]);
    expect(names(two.a)).toContain('Marked'); // 2 is even

    const one = await arena(evenOnly);
    await one.engine.apply([damage(one.a.gauge('hp'), 10)]);
    expect(names(one.a)).not.toContain('Marked'); // 1 is not
  });

  it('gates on a count AND a property of one of the triggers', async () => {
    // "when 2 or more enemies survive and one of them is below 50 HP".
    const woundedOne: TriggerIR = {
      ...mark,
      when: {
        kind: 'and',
        clauses: [
          { kind: 'compare', op: '>=', left: triggerCount, right: n(2) },
          {
            kind: 'any',
            query: triggering,
            test: { kind: 'compare', op: '<', left: { kind: 'gauge', gauge: 'hp' }, right: n(50) },
          },
        ],
      },
    };
    const healthy = await arena(woundedOne);
    await healthy.engine.apply([damage(healthy.a.gauge('hp'), 10), damage(healthy.b.gauge('hp'), 10)]);
    expect(names(healthy.a)).not.toContain('Marked'); // both still at 90

    const hurt = await arena(woundedOne);
    await hurt.engine.apply([damage(hurt.a.gauge('hp'), 60), damage(hurt.b.gauge('hp'), 10)]);
    expect(names(hurt.a)).toContain('Marked'); // A is at 40
  });

  it('uses the count as an amount — "damage equal to how many survived"', async () => {
    const backlash: TriggerIR = {
      ...mark,
      id: 'backlash',
      name: 'Backlash',
      when: undefined,
      steps: [
        {
          effects: [
            { kind: 'gauge', query: { kind: 'self' }, gauge: 'hp', op: 'subtract', amount: triggerCount },
          ],
        },
      ],
    };
    const { engine, hero, a, b } = await arena(backlash);
    await engine.apply([damage(a.gauge('hp'), 10), damage(b.gauge('hp'), 10)]);
    expect(hero.gauge('hp').current).toBe(98); // two enemies survived → 2 damage
  });

  it('a single-mode trigger fires once per matching event', async () => {
    const perDeath: TriggerIR = {
      id: 'recoil',
      name: 'Recoil',
      scope: 'self',
      event: 'character:destroyed',
      mode: 'single',
      filter: { kind: 'relation', to: 'enemy' },
      steps: [
        {
          effects: [
            { kind: 'gauge', query: { kind: 'self' }, gauge: 'hp', op: 'subtract', amount: n(5) },
          ],
        },
      ],
    };
    const { engine, hero, a, b } = await arena(perDeath, 10);
    await engine.apply([damage(a.gauge('hp'), 10), damage(b.gauge('hp'), 10)]);
    expect(engine.isInPlay(a)).toBe(false);
    expect(hero.gauge('hp').current).toBe(90); // 5 per death, two deaths
  });
});

/* --------------------------- conditional steps ------------------------- */

describe('StepIR.when', () => {
  const strikeIf = (threshold: number): AbilityIR => ({
    id: 'overkill',
    name: 'Overkill',
    targeting: { who: 'enemy', count: 1 },
    steps: [
      {
        effects: [
          { kind: 'gauge', query: { kind: 'picked' }, gauge: 'hp', op: 'subtract', amount: n(10) },
        ],
      },
      {
        // "…then, if you face <threshold> or more enemies, hit again."
        when: {
          kind: 'compare',
          op: '>=',
          left: { kind: 'count', query: { kind: 'all', who: 'enemy', other: false } },
          right: n(threshold),
        },
        effects: [
          { kind: 'gauge', query: { kind: 'picked' }, gauge: 'hp', op: 'subtract', amount: n(10) },
        ],
      },
    ],
  });

  const run = async (ir: AbilityIR) => {
    const bound = bindDocument(
      { version: 1, imports: [], abilities: [ir], buffs: [], triggers: [] },
      { resolveBuff: () => undefined },
    );
    const ability = bound.abilities[0]!;
    const arena = buildArena(ability);
    await runArena(arena, ability);
    return arena.goblin.gauge('hp').current;
  };

  it('runs the step when its predicate holds', async () => {
    expect(await run(strikeIf(2))).toBe(20); // 40 - 10 - 10, two enemies present
  });

  it('skips the step when it does not', async () => {
    expect(await run(strikeIf(3))).toBe(30); // 40 - 10, the gate fails
  });
});

/* ------------------------- the formula language ------------------------ */

describe('math: no remainder operator', () => {
  it('rejects %, which is reserved for percent', () => {
    // A `%` meaning remainder would be misread as a percentage every time;
    // parity has its own predicate instead.
    expect(() => parseMathExpression('count % 2')).toThrow(/unexpected character "%"/);
  });

  it('still parses the arithmetic it does have', () => {
    expect(evaluateMathExpression(parseMathExpression('(1 + 7) / 2'), {})).toBe(4);
  });
});

/* ----------------- what one boolean vocabulary made possible ----------- */

describe('unified predicates', () => {
  /**
   * The old split had an entity filter whose only numeric node was
   * "this gauge <op> a number". With one vocabulary a filter is an ordinary
   * `compare`, so both sides can be values — including two gauges of the
   * same candidate ("every character whose mana exceeds its HP"), or a
   * board count.
   */
  async function board() {
    const engine = createEngine({ seed: 'ir-predicate' });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 10 });
    const squishy = new Character('Squishy', { maxHp: 60, maxMana: 60 });
    const tank = new Character('Tank', { maxHp: 60, maxMana: 1 });
    hero.team = 'party';
    squishy.team = 'foes';
    tank.team = 'foes';
    engine.registerPlayers([new Idle('You', [hero], 'party'), new Idle('Them', [squishy, tank], 'foes')]);
    return { engine, hero, squishy, tank };
  }

  const strikeWhere = (filter: PredicateIR): AbilityIR => ({
    id: 'cull',
    name: 'Cull',
    targeting: { who: 'self', count: 1 },
    steps: [
      {
        effects: [
          {
            kind: 'gauge',
            query: { kind: 'all', who: 'enemy', other: false, filter },
            gauge: 'hp',
            op: 'subtract',
            amount: n(10),
          },
        ],
      },
    ],
  });

  async function cast(filter: PredicateIR) {
    const { engine, hero, squishy, tank } = await board();
    const bound = bindDocument(
      { version: 1, imports: [], abilities: [strikeWhere(filter)], buffs: [], triggers: [] },
      { resolveBuff: () => undefined },
    );
    const ability = bound.abilities[0]!;
    await engine.addBuff(hero, buff({ name: 'Cull', weight: 1, abilities: [ability] }));
    await engine.useAbility(hero, ability, { targets: [hero] });
    return { squishy: squishy.gauge('hp').current, tank: tank.gauge('hp').current };
  }

  it('compares two gauges of the same candidate', async () => {
    // "all enemy characters whose mana is at least their HP" — Squishy is
    // 60 mana / 60 HP; Tank is 1 mana / 60 HP.
    const result = await cast({
      kind: 'compare',
      op: '>=',
      left: { kind: 'gauge', gauge: 'mana' },
      right: { kind: 'gauge', gauge: 'hp' },
    });
    expect(result).toEqual({ squishy: 50, tank: 60 });
  });

  it('compares a candidate gauge against a board count', async () => {
    // "all enemy characters with mana above the number of enemies" — 2
    // enemies, so Squishy (60 mana) qualifies and Tank (1) does not.
    const result = await cast({
      kind: 'compare',
      op: '>',
      left: { kind: 'gauge', gauge: 'mana' },
      right: { kind: 'count', query: { kind: 'all', who: 'enemy', other: false } },
    });
    expect(result).toEqual({ squishy: 50, tank: 60 });
  });

  it('an entity question with no entity in scope is false, not an error', async () => {
    // `hasBuff` at the top of a step gate has no candidate to ask about.
    const bound = bindDocument(
      {
        version: 1,
        imports: [],
        abilities: [
          {
            id: 'scopeless',
            name: 'Scopeless',
            targeting: { who: 'self', count: 1 },
            steps: [
              {
                when: { kind: 'hasBuff', buff: 'Anything' },
                effects: [
                  { kind: 'gauge', query: { kind: 'self' }, gauge: 'hp', op: 'subtract', amount: n(10) },
                ],
              },
            ],
          },
        ],
        buffs: [],
        triggers: [],
      },
      { resolveBuff: () => ({ name: 'Anything', weight: 1 }) },
    );
    const ability = bound.abilities[0]!;
    const arena = buildArena(ability);
    await runArena(arena, ability);
    expect(arena.hero.gauge('hp').current).toBe(100); // the gate was false; nothing ran
  });
});
