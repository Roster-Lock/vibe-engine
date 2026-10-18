/**
 * `src/ir/rewrite-math.ts` — a stack of `ActionRewriteIR` entries read back
 * as one number or one piece of math, instead of N separate modifiers.
 *
 * `applyRewriteChain`/`settle` are checked against the **real engine**
 * (mirroring the `action modifiers` suite in `test/english.test.ts`) —
 * they exist specifically to match `bindModifier`'s arithmetic exactly, so
 * a shape-only test would miss the one thing that matters.
 */
import { describe, expect, it } from 'vitest';
import {
  applyOneRewrite,
  applyRewriteChain,
  bindDocument,
  constValue,
  foldRewriteChain,
  rewriteChainSteps,
  rewriteChainToLatex,
  settle,
  type ActionMatchIR,
  type ActionRewriteIR,
  type BuffIR,
  type ValueIR,
} from '../src/ir/index.js';
import { Character, Player, createEngine, type Decision } from '../src/games/turn-based/index.js';

class Idle extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

const n = (value: number): ValueIR => ({ kind: 'const', value });

/** A buff that does nothing but carry one modifier, for the engine tests. */
function modifierBuff(id: string, match: ActionMatchIR, rewrite: ActionRewriteIR): BuffIR {
  return {
    id,
    name: id,
    weight: 1,
    triggers: [],
    modifiers: [{ id: `${id}-mod`, name: id, match, rewrite }],
  };
}

async function board() {
  const engine = createEngine({ seed: 'rewrite-math' });
  const hero = new Character('Hero', { maxHp: 100, maxMana: 40 });
  const goblin = new Character('Goblin', { maxHp: 40 });
  hero.team = 'party';
  goblin.team = 'foes';
  engine.registerPlayers([new Idle('You', [hero], 'party'), new Idle('Them', [goblin], 'foes')]);
  return { engine, hero, goblin };
}

describe('applyRewriteChain / settle — checked against the real engine', () => {
  const cases: Array<{ name: string; chain: ActionRewriteIR[]; raw: number }> = [
    {
      name: 'a single reduction',
      chain: [{ kind: 'amount', op: 'subtract', by: n(50) }],
      raw: 10,
    },
    {
      name: 'a reduction that overshoots, picked up by a later increase',
      chain: [
        { kind: 'amount', op: 'subtract', by: n(10) },
        { kind: 'amount', op: 'add', by: n(5) },
      ],
      raw: 8,
    },
    {
      name: 'a reduction overshooting past what a later increase can recover',
      chain: [
        { kind: 'amount', op: 'subtract', by: n(50) },
        { kind: 'amount', op: 'add', by: n(5) },
      ],
      raw: 10,
    },
    {
      name: 'multiply then cap',
      chain: [
        { kind: 'amount', op: 'multiply', by: n(3) },
        { kind: 'cap', at: n(15) },
      ],
      raw: 10,
    },
    {
      name: 'prevent in the middle discards everything before it',
      chain: [
        { kind: 'amount', op: 'add', by: n(100) },
        { kind: 'prevent' },
        { kind: 'amount', op: 'add', by: n(5) },
      ],
      raw: 10,
    },
  ];

  for (const { name, chain, raw } of cases) {
    it(`matches the real engine: ${name}`, async () => {
      const { engine, hero, goblin } = await board();
      for (const [index, rewrite] of chain.entries()) {
        const bound = bindDocument(
          {
            version: 1,
            imports: [],
            abilities: [],
            buffs: [modifierBuff(`buff-${index}`, { direction: 'incoming', change: 'damage' }, rewrite)],
            triggers: [],
          },
          { resolveBuff: () => undefined },
        );
        await engine.addBuff(hero, bound.buffs[0]!);
      }
      await engine.damage(hero.gauge('hp'), raw, goblin);
      const expected = 100 - settle(applyRewriteChain(chain, raw, constValue));
      expect(hero.gauge('hp').current, JSON.stringify({ chain, raw })).toBe(expected);
    });
  }

  it('matches the real engine for a heal chain too', async () => {
    const { engine, hero, goblin } = await board();
    const chain: ActionRewriteIR[] = [
      { kind: 'amount', op: 'multiply', by: n(2) },
      { kind: 'amount', op: 'subtract', by: n(3) },
    ];
    hero.gauge('hp').current = 50;
    for (const [index, rewrite] of chain.entries()) {
      const bound = bindDocument(
        {
          version: 1,
          imports: [],
          abilities: [],
          buffs: [modifierBuff(`heal-buff-${index}`, { direction: 'incoming', change: 'heal' }, rewrite)],
          triggers: [],
        },
        { resolveBuff: () => undefined },
      );
      await engine.addBuff(hero, bound.buffs[0]!);
    }
    await engine.heal(hero.gauge('hp'), 10, goblin);
    const expected = 50 + settle(applyRewriteChain(chain, 10, constValue));
    expect(hero.gauge('hp').current).toBe(expected);
  });
});

describe('foldRewriteChain', () => {
  it('merges a run of add/subtract into one net add', () => {
    const folded = foldRewriteChain([
      { kind: 'amount', op: 'subtract', by: n(10) },
      { kind: 'amount', op: 'add', by: n(5) },
    ]);
    expect(folded).toEqual([{ kind: 'amount', op: 'add', by: n(-5) }]);
  });

  it('merges a run of multiplies into one', () => {
    const folded = foldRewriteChain([
      { kind: 'amount', op: 'multiply', by: n(3) },
      { kind: 'amount', op: 'multiply', by: n(0.5) },
    ]);
    expect(folded).toEqual([{ kind: 'amount', op: 'multiply', by: n(1.5) }]);
  });

  it('does not merge across multiply, cap, prevent, or redirect', () => {
    const chain: ActionRewriteIR[] = [
      { kind: 'amount', op: 'add', by: n(5) },
      { kind: 'amount', op: 'multiply', by: n(2) },
      { kind: 'amount', op: 'add', by: n(3) },
      { kind: 'cap', at: n(50) },
      { kind: 'amount', op: 'add', by: n(1) },
      { kind: 'prevent' },
      { kind: 'amount', op: 'add', by: n(1) },
      { kind: 'redirect', gauge: 'mana' },
      { kind: 'amount', op: 'add', by: n(1) },
    ];
    expect(foldRewriteChain(chain)).toEqual(chain);
  });
});

describe('redirect', () => {
  it('leaves the magnitude untouched — only where it lands changes', () => {
    expect(applyOneRewrite(7, { kind: 'redirect', gauge: 'mana' }, constValue)).toBe(7);
    expect(applyRewriteChain([{ kind: 'amount', op: 'add', by: n(3) }, { kind: 'redirect', gauge: 'mana' }], 7, constValue)).toBe(10);
  });

  it('is invisible in the merged equation', () => {
    expect(rewriteChainToLatex([{ kind: 'amount', op: 'subtract', by: n(10) }, { kind: 'redirect', gauge: 'mana' }])).toBe(
      '\\max\\left(0, x - 10\\right)',
    );
  });

  it('shows up in the step list', () => {
    expect(rewriteChainSteps([{ kind: 'redirect', gauge: 'mana' }])).toEqual(['redirected to mana']);
  });
});

describe('rewriteChainToLatex', () => {
  it('renders a simple reduction, floored once at the end', () => {
    expect(rewriteChainToLatex([{ kind: 'amount', op: 'subtract', by: n(10) }])).toBe(
      '\\max\\left(0, x - 10\\right)',
    );
  });

  it('nests a mixed add/subtract/multiply chain left to right', () => {
    const chain: ActionRewriteIR[] = [
      { kind: 'amount', op: 'subtract', by: n(10) },
      { kind: 'amount', op: 'multiply', by: n(2) },
    ];
    expect(rewriteChainToLatex(chain)).toBe('\\max\\left(0, \\left(x - 10\\right) \\cdot 2\\right)');
  });

  it('renders a merged multiply run as a fraction, not a decimal', () => {
    const chain: ActionRewriteIR[] = [
      { kind: 'amount', op: 'multiply', by: n(3) },
      { kind: 'amount', op: 'multiply', by: n(0.5) },
    ];
    expect(rewriteChainToLatex(chain)).toContain('\\frac{3}{2}');
  });

  it('renders cap as \\min and prevent as a flat 0', () => {
    expect(rewriteChainToLatex([{ kind: 'cap', at: n(50) }])).toBe(
      '\\max\\left(0, \\min\\left(x, 50\\right)\\right)',
    );
    expect(rewriteChainToLatex([{ kind: 'amount', op: 'add', by: n(5) }, { kind: 'prevent' }])).toBe('0');
  });

  it('can render the unsettled, pure-arithmetic form on request', () => {
    expect(
      rewriteChainToLatex([{ kind: 'amount', op: 'subtract', by: n(10) }], { settled: false }),
    ).toBe('x - 10');
  });
});

describe('rewriteChainSteps', () => {
  it('lists the original, unfolded entries', () => {
    expect(
      rewriteChainSteps([
        { kind: 'amount', op: 'subtract', by: n(10) },
        { kind: 'amount', op: 'add', by: n(5) },
        { kind: 'amount', op: 'multiply', by: n(2) },
        { kind: 'cap', at: n(50) },
        { kind: 'prevent' },
      ]),
    ).toEqual(['−10', '+5', 'doubled', 'capped at 50', 'prevented']);
  });
});
