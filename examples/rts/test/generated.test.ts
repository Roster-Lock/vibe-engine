/**
 * The claim this example exists to make: the English document becomes
 * executable code, and that code is the same program.
 *
 * Three checks, in increasing strength:
 *
 * 1. the shipped `abilities.rts` compiles clean;
 * 2. the committed generated module is exactly what the compiler emits for
 *    it today (so it cannot silently rot);
 * 3. a full battle produces an **identical log** whether the abilities are
 *    interpreted from the IR or run as the generated TypeScript closures.
 *
 * (3) is the real one. The two paths share only `CastApi` and the sim; the
 * traversal, the control flow, even the order the effects are written in
 * are separately produced. A divergence in either the interpreter or the
 * emitter shows up as a diff in the log.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBattle, deployArmies, runBattle } from '../src/battle.js';
import { loadContent } from '../src/content/index.js';
import { generateModule } from '../src/english/codegen.js';
import { COMPILED_ABILITIES, COMPILED_BUFFS } from '../src/generated/abilities.gen.js';
import { resetUnitIds } from '../src/sim/unit.js';

const GENERATED = fileURLToPath(new URL('../src/generated/abilities.gen.ts', import.meta.url));

describe('the shipped content', () => {
  it('compiles with no errors', () => {
    const { diagnostics } = loadContent();
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });

  it('produces every ability the units ask for', () => {
    const { program } = loadContent();
    const ids = new Set(program.abilities.map((ability) => ability.id));
    expect(ids).toContain('storm-bolt');
    expect(ids).toContain('thunder-clap');
    expect(ids).toContain('carrion-swarm');
  });
});

describe('the generated module', () => {
  it('is up to date with abilities.rts', () => {
    const { program } = loadContent();
    // Fails when the .rts file or the emitter changed without a
    // `npm run rts:codegen`. The message says exactly that.
    expect(generateModule(program, 'src/content/abilities.rts')).toBe(readFileSync(GENERATED, 'utf8'));
  });

  it('exports one closure per compiled ability, and the buffs as data', () => {
    const { program } = loadContent();
    expect(COMPILED_ABILITIES.map((ability) => ability.id)).toEqual(program.abilities.map((ability) => ability.id));
    expect(COMPILED_BUFFS).toEqual(program.buffs);
  });
});

describe('interpreted and generated agree', () => {
  /** Fights the demo skirmish one way or the other and returns its log. */
  function fight(compiled: boolean): { log: string[]; winner: number | undefined; elapsed: number } {
    resetUnitIds();
    const { program } = loadContent();
    const battle = createBattle(program, { seed: 4242, compiled: compiled ? COMPILED_ABILITIES : undefined });
    deployArmies(battle);
    const result = runBattle(battle);
    return { log: battle.world.formatLog(), winner: result.winner, elapsed: result.elapsed };
  }

  it('produces the same battle, line for line', () => {
    const interpreted = fight(false);
    const generated = fight(true);

    expect(generated.log).toEqual(interpreted.log);
    expect(generated.winner).toBe(interpreted.winner);
    expect(generated.elapsed).toBe(interpreted.elapsed);
  });

  it('actually fought a battle worth comparing', () => {
    const { log } = fight(false);
    // Guards against the above passing because nothing happened.
    expect(log.length).toBeGreaterThan(200);
    expect(log.some((line) => line.includes('casts Thunder Clap'))).toBe(true);
    expect(log.some((line) => line.includes('casts Carrion Swarm'))).toBe(true);
    expect(log.some((line) => line.includes('dies'))).toBe(true);
  });
});

describe('determinism', () => {
  it('replays identically from the same seed', () => {
    const run = (): string[] => {
      resetUnitIds();
      const { program } = loadContent();
      const battle = createBattle(program, { seed: 99 });
      deployArmies(battle);
      runBattle(battle);
      return battle.world.formatLog();
    };
    expect(run()).toEqual(run());
  });
});
