/**
 * **Toggles** — an ability with one slot that means two things
 * (docs/design/16-ability-sets.md).
 *
 * Warcraft 3's Immolation is the shape: clicking it turns an aura on,
 * clicking again turns it off. That is a fourth ability kind alongside
 * `manual` (fires once), `trigger` (listens) and `passive` (rewrites),
 * because it has **persistent state**.
 *
 * The state lives in the buff it maintains — on = attached, off = not — so
 * there is no toggle state kept anywhere else to fall out of sync, and the
 * same buff is what a UI reads to pick the lit or unlit icon.
 */
import { describe, expect, it } from 'vitest';
import { buildArena, compileDocument, runArena } from '../src/english/index.js';
import type { Arena } from '../src/english/index.js';
import type { ManualAbility } from '../src/engine/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';

/** Compiles a document and returns its first ability plus a fresh arena. */
async function stage(document: string): Promise<{ arena: Arena; ability: ManualAbility }> {
  const result = compileDocument(document);
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const ability = result.abilities[0]!;
  const arena = buildArena(ability);
  return { arena, ability };
}

const names = (arena: Arena): string[] => arena.hero.statuses.map((status) => status.name);

describe('Toggle', () => {
  const IMMOLATION = `
    Buff Immolation Aura
    when the turn starts, deal 2 damage to all enemy characters.

    Ability Immolation
    Toggle Immolation Aura.
  `;

  it('turns on, then off, then on again', async () => {
    const { arena, ability } = await stage(IMMOLATION);
    await runArena(arena, ability, { startTurn: false });
    expect(names(arena)).toContain('Immolation Aura');

    await arena.engine.useAbility(arena.hero, ability, { targets: [arena.hero] });
    expect(names(arena)).not.toContain('Immolation Aura');

    await arena.engine.useAbility(arena.hero, ability, { targets: [arena.hero] });
    expect(names(arena)).toContain('Immolation Aura');
  });

  it('the buff does its work while on, and stops when off', async () => {
    const { arena, ability } = await stage(IMMOLATION);
    await runArena(arena, ability, { startTurn: false });

    await startTurn(arena.engine);
    expect(arena.goblin.gauge('hp').current).toBe(38); // the aura ticked

    await arena.engine.useAbility(arena.hero, ability, { targets: [arena.hero] });
    await startTurn(arena.engine);
    expect(arena.goblin.gauge('hp').current).toBe(38); // switched off, no tick
  });

  /**
   * Why `toggleBuff` is its own effect rather than two guarded steps.
   *
   * Steps resolve **one at a time, with effects landing between them**, so
   * "if it has it, remove it" followed by "if it does not, add it" removes
   * and then immediately re-adds — the toggle is stuck on. This test keeps
   * that reason visible rather than leaving it in a comment.
   */
  it('two guarded steps would be stuck on — which is why this is one effect', async () => {
    const naive = await stage(`
      Buff Aura
      Ability Flip
      If this has Aura, Remove Aura from this.
      If this has not Aura, Add Aura to this.
    `);
    await runArena(naive.arena, naive.ability, { startTurn: false });
    expect(names(naive.arena)).toContain('Aura');
    // A second use should turn it off. It does not.
    await naive.arena.engine.useAbility(naive.arena.hero, naive.ability, {
      targets: [naive.arena.hero],
    });
    expect(names(naive.arena)).toContain('Aura');

    // The real toggle does turn off, from the same starting point.
    const real = await stage('Buff Aura\nAbility Flip\nToggle Aura.');
    await runArena(real.arena, real.ability, { startTurn: false });
    await real.arena.engine.useAbility(real.arena.hero, real.ability, {
      targets: [real.arena.hero],
    });
    expect(names(real.arena)).not.toContain('Aura');
  });

  it('flips a group atomically — each entity by its own state', async () => {
    const { arena, ability } = await stage(`
      Buff Mark
      Ability Sweep
      Toggle Mark on all enemy characters.
    `);
    // Mark one of the two enemies first, so the sweep must do opposite
    // things to them in the same effect.
    const marked = compileDocument('Buff Mark\nAbility Brand\nAdd Mark to target enemy character.');
    await arena.engine.addBuff(arena.goblin, marked.buffs[0]!);

    await runArena(arena, ability, { startTurn: false });
    const has = (c: typeof arena.goblin) => c.statuses.some((s) => s.name === 'Mark');
    expect(has(arena.goblin)).toBe(false); // had it, lost it
    expect(has(arena.bruiser)).toBe(true); // lacked it, gained it
  });

  it('lowers to one toggleBuff effect', () => {
    const result = compileDocument('Buff Aura\nAbility Flip\nToggle Aura.');
    expect(result.ir.abilities[0]!.steps).toEqual([
      { effects: [{ kind: 'toggleBuff', query: { kind: 'self' }, buff: 'Aura' }] },
    ]);
  });

  it('reads back as English, both spellings', () => {
    expect(compileDocument('Buff Aura\nAbility A\nToggle Aura.').abilities[0]!.description).toBe(
      'Toggle Aura.',
    );
    expect(
      compileDocument('Buff Aura\nAbility A\nToggle Aura on all enemy characters.').abilities[0]!
        .description,
    ).toBe('Toggle Aura on all enemy characters.');
  });

  it('checks the buff name like Add and Remove do', () => {
    const diags = compileDocument('Ability A\nToggle Nonexistent.').diagnostics;
    expect(diags.some((d) => d.code === 'unknown-buff')).toBe(true);
  });

  it('counts the buff as used, so it is not warned about', () => {
    const result = compileDocument('Buff Aura\nAbility A\nToggle Aura.');
    expect(result.diagnostics.filter((d) => d.code === 'unused-buff')).toEqual([]);
  });

  it('names what it expected', () => {
    const diags = compileDocument('Buff Aura\nAbility A\nToggle.').diagnostics;
    expect(diags[0]!.message).toContain('expected the buff name after "Toggle"');
  });
});
