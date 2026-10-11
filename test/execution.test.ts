/**
 * The IR's expression layer (src/ir/): DeclaredFn as a data-only
 * expression tree split by category (variable/boolean/math/iteration/action),
 * and BatchEvent/Trigger compiling into ordinary TriggeredAbility instances
 * that run through the real trigger stack (docs/free-write/triggered.md).
 */
import { describe, expect, it } from 'vitest';
import { Character, GameEngine, Player, Skill, buff, damage, skill, type Decision } from '../src/games/turn-based/index.js';
import {
  compileBatchEvent,
  compileTrigger,
  evaluateDeclaredFn,
  mathNodeToLatex,
  type DeclaredFn,
  type DeclaredFnContext,
} from '../src/ir/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

function char(name: string, maxHp: number): Character {
  return new Character(name, { maxHp, maxMana: maxHp });
}

/** A throwaway status to satisfy `DeclaredFnContext.status` in standalone evaluator tests. */
function testContext(self: Character): DeclaredFnContext {
  return { self, engine: createEngine(), status: new Skill(skill({ name: 'Test', weight: 1 })) };
}

/* ------------------------- evaluateDeclaredFn ------------------------- */

describe('evaluateDeclaredFn', () => {
  const ctx = testContext(char('Self', 10));

  it('evaluates a math node (arithmetic) and renders it as LaTeX', () => {
    const fn: DeclaredFn<null, number> = {
      kind: 'math',
      expression: {
        kind: 'binary',
        op: '+',
        left: { kind: 'number', value: 2 },
        right: { kind: 'binary', op: '*', left: { kind: 'number', value: 3 }, right: { kind: 'number', value: 4 } },
      },
    };
    expect(evaluateDeclaredFn(fn, null, ctx)).toBe(14);
    expect(mathNodeToLatex(fn)).toBe('2 + 3 \\cdot 4');
  });

  it('a math node resolves paths against input/self/vars', () => {
    ctx.status.vars.stacks = 3;
    const fn: DeclaredFn<{ power: number }, number> = {
      kind: 'math',
      expression: { kind: 'path', parts: ['input', 'power'] },
    };
    expect(evaluateDeclaredFn(fn, { power: 7 }, ctx)).toBe(7);
    const stacks: DeclaredFn<null, number> = { kind: 'math', expression: { kind: 'path', parts: ['vars', 'stacks'] } };
    expect(evaluateDeclaredFn(stacks, null, ctx)).toBe(3);
  });

  it('get reads a nested property off input/self/vars', () => {
    ctx.status.vars.nested = { power: 9 };
    const fromInput: DeclaredFn<{ power: number }, number> = { kind: 'get', root: 'input', path: ['power'] };
    expect(evaluateDeclaredFn(fromInput, { power: 5 }, ctx)).toBe(5);
    const fromSelf: DeclaredFn<null, string> = { kind: 'get', root: 'self', path: ['name'] };
    expect(evaluateDeclaredFn(fromSelf, null, ctx)).toBe('Self');
    const fromVars: DeclaredFn<null, number> = { kind: 'get', root: 'vars', path: ['nested', 'power'] };
    expect(evaluateDeclaredFn(fromVars, null, ctx)).toBe(9);
  });

  it('set writes a nested property into vars and produces no Action', () => {
    const setFn: DeclaredFn<null, readonly unknown[]> = {
      kind: 'set',
      path: ['ticker'],
      value: { kind: 'math', expression: { kind: 'number', value: 1 } },
    };
    expect(evaluateDeclaredFn(setFn, null, ctx)).toEqual([]);
    expect(ctx.status.vars.ticker).toBe(1);
  });

  it('evaluates comparisons and boolean combinators (the "2 to 4" count-phrase shape)', () => {
    const length: DeclaredFn<readonly unknown[], number> = { kind: 'get', root: 'input', path: ['length'] };
    const two: DeclaredFn<unknown, number> = { kind: 'math', expression: { kind: 'number', value: 2 } };
    const four: DeclaredFn<unknown, number> = { kind: 'math', expression: { kind: 'number', value: 4 } };
    const twoToFour: DeclaredFn<readonly unknown[], boolean> = {
      kind: 'and',
      clauses: [
        { kind: 'compare', op: '>=', left: length, right: two },
        { kind: 'compare', op: '<=', left: length, right: four },
      ],
    };
    expect(evaluateDeclaredFn(twoToFour, [1], ctx)).toBe(false); // below range
    expect(evaluateDeclaredFn(twoToFour, [1, 2, 3], ctx)).toBe(true); // in range
    expect(evaluateDeclaredFn(twoToFour, [1, 2, 3, 4, 5], ctx)).toBe(false); // above range
    const notTwoToFour: DeclaredFn<readonly unknown[], boolean> = { kind: 'not', expression: twoToFour };
    expect(evaluateDeclaredFn(notTwoToFour, [1], ctx)).toBe(true);
  });

  it('some/every check a predicate across an array', () => {
    const powerOver7: DeclaredFn<unknown, boolean> = {
      kind: 'compare',
      op: '>',
      left: { kind: 'get', root: 'input', path: ['power'] },
      right: { kind: 'math', expression: { kind: 'number', value: 7 } },
    };
    const some: DeclaredFn<readonly { power: number }[], boolean> = { kind: 'some', array: { kind: 'get', root: 'input', path: [] }, test: powerOver7 };
    const every: DeclaredFn<readonly { power: number }[], boolean> = { kind: 'every', array: { kind: 'get', root: 'input', path: [] }, test: powerOver7 };
    const roster = [{ power: 3 }, { power: 9 }];
    expect(evaluateDeclaredFn(some, roster, ctx)).toBe(true);
    expect(evaluateDeclaredFn(every, roster, ctx)).toBe(false);
  });

  it('forEach + a gauge action node flattens one Action per element', () => {
    const a = char('A', 20);
    const b = char('B', 20);
    const healEach: DeclaredFn<readonly Character[], readonly unknown[]> = {
      kind: 'forEach',
      array: { kind: 'get', root: 'input', path: [] },
      body: { kind: 'gauge', op: 'add', target: { kind: 'get', root: 'input', path: [] }, amount: { kind: 'math', expression: { kind: 'number', value: 5 } } },
    };
    const actions = evaluateDeclaredFn(healEach, [a, b], ctx);
    expect(actions).toEqual([
      { type: 'gauge', target: a.gauge('hp'), update: expect.any(Function), intent: 'heal', source: ctx.self },
      { type: 'gauge', target: b.gauge('hp'), update: expect.any(Function), intent: 'heal', source: ctx.self },
    ]);
  });
});

/* ---------------------------- compileTrigger ---------------------------- */

describe('compileTrigger', () => {
  it('"whenever a character survives damage, heal it for 1" fires once per instance', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const engine = createEngine();
    engine.registerPlayers([new TestPlayer('Hero', [hero], 'party'), new TestPlayer('Goblins', [goblin], 'monsters')]);

    const patchUp = compileTrigger<{ character: Character }>({
      name: 'Patch Up',
      event: 'character:survived',
      triggerFilter: { kind: 'bool', value: true },
      actions: [{ kind: 'gauge', op: 'add', target: { kind: 'get', root: 'input', path: ['character'] }, amount: { kind: 'math', expression: { kind: 'number', value: 1 } } }],
    });
    await engine.addBuff(goblin, buff({ name: 'Regen Ward', weight: 1, abilities: [patchUp] }));

    await engine.damage(goblin.gauge('hp'), 30, hero);

    expect(goblin.gauge('hp').current).toBe(71); // 100 - 30 + 1
  });
});

/* -------------------------- compileBatchEvent -------------------------- */

describe('compileBatchEvent', () => {
  function healSurvivorsBatch() {
    return compileBatchEvent<{ character: Character }>({
      name: 'Field Medic',
      event: 'character:survived:batch',
      triggerFilter: { kind: 'bool', value: true },
      willTrigger: {
        kind: 'compare',
        op: '>=',
        left: { kind: 'get', root: 'input', path: ['length'] },
        right: { kind: 'math', expression: { kind: 'number', value: 2 } },
      },
      actions: [
        {
          kind: 'forEach',
          array: { kind: 'get', root: 'input', path: [] },
          body: {
            kind: 'gauge',
            op: 'add',
            target: { kind: 'get', root: 'input', path: ['character'] },
            amount: { kind: 'math', expression: { kind: 'number', value: 5 } },
          },
        },
      ],
    });
  }

  it('fires and heals every survivor when 2 or more survive together', async () => {
    const hero = char('Hero', 100);
    const a = char('A', 100);
    const b = char('B', 100);
    const engine = createEngine();
    engine.registerPlayers([new TestPlayer('Hero', [hero], 'party'), new TestPlayer('Monsters', [a, b], 'monsters')]);
    await engine.addBuff(hero, buff({ name: 'Field Medic', weight: 1, abilities: [healSurvivorsBatch()] }));

    await engine.apply([damage(a.gauge('hp'), 10, hero), damage(b.gauge('hp'), 20, hero)]);

    expect(a.gauge('hp').current).toBe(95); // 100 - 10 + 5
    expect(b.gauge('hp').current).toBe(85); // 100 - 20 + 5
  });

  it("doesn't fire (willTrigger fails) when only 1 survives in the batch", async () => {
    const hero = char('Hero', 100);
    const a = char('A', 100);
    const engine = createEngine();
    engine.registerPlayers([new TestPlayer('Hero', [hero], 'party'), new TestPlayer('Monsters', [a], 'monsters')]);
    await engine.addBuff(hero, buff({ name: 'Field Medic', weight: 1, abilities: [healSurvivorsBatch()] }));

    await engine.damage(a.gauge('hp'), 10, hero);

    expect(a.gauge('hp').current).toBe(90); // no heal — the batch only held one survivor
  });
});
