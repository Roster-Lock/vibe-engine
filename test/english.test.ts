/**
 * Tests for the Ability Language (src/english): grammar, diagnostics,
 * compilation into engine abilities, running those abilities in a headless
 * arena, and position-aware completion. Mirrors the style of the engine
 * suite — each `it` is one behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  BuffDictionary,
  DefinitionIndex,
  indexDocuments,
  buffReferenceInfo,
  buildArena,
  charsToString,
  completeAt,
  compileDocument,
  describeBuffReference,
  effectSummary,
  evaluateMathExpression,
  mathToLatex,
  parseMathExpression,
  runArena,
  wordDoc,
} from '../src/english/index.js';
import { poison } from '../src/games/turn-based/content/buffs/poison/index.js';
import { thorns } from '../src/games/turn-based/content/buffs/thorns/index.js';
import { rage as handWrittenRage } from '../src/games/turn-based/content/buffs/rage/index.js';
import { thorns as handWrittenThorns } from '../src/games/turn-based/content/buffs/thorns/index.js';
import {
  Character,
  GameEngine,
  Player,
  autoChoose,
  buff,
  passiveActionModifier,
  redirectGauge,
  skill,
  type BuffDef,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';

const rage = buff({ name: 'Rage', weight: 1 });
const dict = new BuffDictionary([
  { name: 'Poison', def: poison },
  { name: 'Thorns', def: thorns },
  { name: 'Rage', def: rage },
]);

/** Shorthand: the diagnostics of a document, by code. */
function errors(text: string) {
  return compileDocument(text, { dictionary: dict }).diagnostics;
}

function compile(text: string) {
  return compileDocument(text, { dictionary: dict });
}

describe('grammar: sections and sentences', () => {
  it('parses an ability heading with a multi-word name', () => {
    const result = compileDocument('Ability Void Bolt\nDestroy target enemy character.');
    expect(result.doc.abilities).toHaveLength(1);
    expect(result.doc.abilities[0]!.name).toBe('Void Bolt');
    expect(result.abilities).toHaveLength(1);
    expect(result.abilities[0]!.name).toBe('Void Bolt');
    expect(result.diagnostics).toEqual([]);
  });

  it('turns each effect sentence into an engine action description', () => {
    const result = compileDocument(`
      Ability Cry
      Deal 20 damage to all enemy characters.
      Heal all other ally characters for 25.
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.abilities[0]!.description).toBe(
      'Deal 20 damage to all enemy characters. Heal all other ally characters for 25.',
    );
  });
  it('accepts every effect shape from the language docs', () => {
    const result = compile(`
      Ability Kitchen Sink
      Deal 3 damage to this character.
      Heal this character for 5.
      Heal 6 to target ally character.
      Destroy all characters owned by you.
      Remove Thorns from all ally characters.
      You lose the game.
      All players win the game.
    `);
    expect(result.diagnostics).toEqual([]);
    const [ability] = result.abilities;
    expect(ability).toBeDefined();
    expect(ability!.targeting.who).toBe('ally'); // the one target sentence
  });

  it('lets sentences before any heading form an implicit ability', () => {
    const result = compileDocument('You lose the game.');
    expect(result.diagnostics).toEqual([]);
    expect(result.doc.abilities).toHaveLength(1);
    expect(result.doc.abilities[0]!.name).toBe('Untitled');
  });

  it('parses buff declarations with options', () => {
    const result = compileDocument(`
      Ability Soul Rot
      Buff Frailty (stacks)
      Buff Heavy Curse (weight 3)
      Add Frailty to target enemy character.
      Remove Heavy Curse from this character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.buffs).toHaveLength(2);
    const frailty = result.buffs.find((b) => b.name === 'Frailty')!;
    expect(frailty.stacks).toBe(true);
    expect(frailty.weight).toBe(1);
    const curse = result.buffs.find((b) => b.name === 'Heavy Curse')!;
    expect(curse.weight).toBe(3);
    expect(curse.stacks).toBeUndefined();
  });

  it('skips comment and blank lines', () => {
    const result = compileDocument('# A comment\n\nAbility Clean\n# another\nDestroy this character.\n');
    expect(result.diagnostics).toEqual([]);
    expect(result.doc.abilities).toHaveLength(1);
  });

  it('renders phrases back the way the player wrote them', () => {
    const result = compileDocument(`
      Ability Shapes
      Destroy this character.
      Destroy target enemy character.
      Destroy all characters owned by you.
      Destroy all other ally characters.
      Heal all characters owned by the opponent for 3.
    `);
    expect(result.diagnostics).toEqual([]);
    const summaries = result.doc.abilities[0]!.sentences.map(effectSummary);
    expect(summaries).toEqual([
      'Destroy this character.',
      'Destroy target enemy character.',
      'Destroy all characters owned by you.',
      'Destroy all other ally characters.',
      'Heal all characters owned by the opponent for 3.',
    ]);
  });
});

describe('cross-file definition index', () => {
  it('indexes all files before individual references are resolved', () => {
    const { index, parsed } = indexDocuments([
      { filePath: 'ability.buff', text: 'Ability Bite\nAdd Poison to this character.' },
      { filePath: 'poison.buff', text: 'Buff Poison (stacks)' },
    ]);

    expect(parsed).toHaveLength(2);
    expect(index.resolve('buff', 'Poison')).toEqual({ name: 'Poison', weight: 1, stacks: true });
  });

  it('merges equivalent definitions and retains every source location', () => {
    const index = new DefinitionIndex();
    const first = { name: 'Poison', weight: 1, stacks: true } as const;
    index.add('buff', 'Poison', first, { filePath: 'poison.buff', line: 1 });
    index.add('buff', 'poison', { name: 'Poison', weight: 1, stacks: true }, { filePath: 'venom.buff', line: 4 });

    expect(index.candidates('buff', 'POISON')).toHaveLength(1);
    expect(index.candidates('buff', 'poison')?.[0]?.locations).toEqual([
      { filePath: 'poison.buff', line: 1 },
      { filePath: 'venom.buff', line: 4 },
    ]);
    expect(index.resolve('buff', 'poison')).toEqual(first);
  });

  it('keeps conflicting definitions ambiguous instead of choosing one', () => {
    const index = new DefinitionIndex();
    index.add('buff', 'Poison', { name: 'Poison', weight: 1 }, { filePath: 'a.buff', line: 1 });
    index.add('buff', 'Poison', { name: 'Poison', weight: 2 }, { filePath: 'b.buff', line: 1 });

    expect(index.candidates('buff', 'Poison')).toHaveLength(2);
    expect(index.resolve('buff', 'Poison')).toBeUndefined();
  });

  it('records a referenced but unresolved title as an empty entry', () => {
    const index = new DefinitionIndex();
    index.ensure('buff', 'Poison');

    expect(index.candidates('buff', 'Poison')).toEqual([]);
    expect(index.resolve('buff', 'Poison')).toBeUndefined();
  });
});

describe('grammar: errors with spans', () => {
  it('requires a period to end a sentence', () => {
    const diags = errors('Ability A\nDeal 5 damage to this character');
    expect(diags.some((d) => d.code === 'syntax' && d.message.includes('expected "."'))).toBe(true);
  });

  it('reports an unknown verb at a sentence start', () => {
    const diags = errors('Ability A\nFrobnicate this character.');
    expect(diags.some((d) => d.code === 'syntax' && d.message.includes('Frobnicate'))).toBe(true);
  });

  it('names the next milestone instead of guessing on future words', () => {
    // An unsupported event verb names the ones that are supported, rather
    // than calling the whole sentence a future feature — the subject and
    // the trigger shape are understood.
    const diags = errors('Ability A\nwhen this character attacks then deal 5 damage to all enemy characters.');
    expect(diags.some((d) => d.code === 'unknown-event' && d.message.includes('"die"'))).toBe(true);
    const buffDiags = errors('Ability A\nDestroy this buff.');
    expect(buffDiags.some((d) => d.code === 'future-feature' && d.message.includes('buff-owned'))).toBe(true);
  });

  it('complains when a sentence has no ability or buff to belong to', () => {
    const diags = errors('Ability A\nDestroy this character.\nimport Poison from "./Poison.buff"\nDestroy this character.');
    expect(diags.some((d) => d.code === 'no-ability')).toBe(true);
  });

  it('catches an unknown buff and hints at the declaration', () => {
    const diags = errors('Ability A\nAdd Poisoned to this character.\n\nBuff Poison (stacks)');
    const unknown = diags.find((d) => d.code === 'unknown-buff')!;
    expect(unknown).toBeDefined();
    expect(unknown.message).toContain('Buff Poisoned');
    expect(unknown.message).toContain('Poison');
  });

  it('rejects a second, different target-picking sentence', () => {
    const diags = errors(
      'Ability A\nDestroy target enemy character.\nHeal target ally character for 5.',
    );
    expect(diags.some((d) => d.code === 'target-conflict')).toBe(true);
  });

  it('allows the same target-picking sentence to repeat', () => {
    const diags = errors(
      'Ability A\nDestroy target enemy character.\nDeal 5 damage to target enemy character.',
    );
    expect(diags.filter((d) => d.code === 'target-conflict')).toEqual([]);
  });

  it('flags a buff declaration that shadows a built-in', () => {
    const diags = errors('Ability A\nBuff Poison (stacks)\nAdd Poison to this character.');
    expect(diags.some((d) => d.code === 'buff-dup-builtin')).toBe(true);
  });

  it('warns about a declared buff nothing references', () => {
    const diags = errors('Ability A\nBuff Frailty (stacks)\nDestroy this character.');
    expect(diags.some((d) => d.code === 'unused-buff' && d.severity === 'warning')).toBe(true);
    // ...and stays quiet when the buff is actually used.
    const used = errors('Ability A\nBuff Frailty (stacks)\nAdd Frailty to this character.');
    expect(used.some((d) => d.code === 'unused-buff')).toBe(false);
  });

  it('suggests fixups for character phrases', () => {
    const diags = errors('Ability A\nAll characters owned by you lose 5.');
    expect(diags.some((d) => d.code === 'syntax' && d.message.includes('"All players'))).toBe(true);
  });

  it('checks the buff-option parentheses', () => {
    const diags = errors('Ability A\nBuff Frailty (stacks\nAdd Frailty to this character.');
    expect(diags.some((d) => d.code === 'syntax' && d.message.includes('")"'))).toBe(true);
  });
});

describe('triggers: when … then …', () => {
  /** The compiled trigger of a one-trigger document. */
  const trigger = (text: string) => {
    const result = compileDocument(text);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    return result.ir.triggers[0]!;
  };

  it.each([
    ['1 or more', 'character:destroyed:batch', undefined],
    ['3 or more', 'character:destroyed:batch', { min: 3, max: null }],
    ['2 to 5', 'character:destroyed:batch', { min: 2, max: 5 }],
    ['7 or less', 'character:destroyed:batch', { min: 1, max: 7 }],
  ])('compiles the count phrase "%s"', (phrase, event, range) => {
    const ir = trigger(`when ${phrase} characters die then heal this character for 5.`);
    expect(ir.event).toBe(event);
    expect(ir.mode).toBe('batch');
    if (!range) {
      // "one or more" is the default — the binder already refuses an empty
      // filtered set, so no predicate is needed.
      expect(ir.when).toBeUndefined();
      return;
    }
    const size = { kind: 'count', query: { kind: 'event', role: 'subject' } };
    const clauses = [
      ...(range.min > 1 ? [{ kind: 'compare', op: '>=', left: size, right: { kind: 'const', value: range.min } }] : []),
      ...(range.max !== null ? [{ kind: 'compare', op: '<=', left: size, right: { kind: 'const', value: range.max } }] : []),
    ];
    expect(ir.when).toEqual(clauses.length === 1 ? clauses[0] : { kind: 'and', clauses });
  });

  it.each([
    ['an even number of', 'even'],
    ['an odd number of', 'odd'],
  ])('compiles the parity count "%s"', (phrase, parity) => {
    const ir = trigger(`when ${phrase} characters die then heal this for 5.`);
    expect(ir.event).toBe('character:destroyed:batch');
    expect(ir.when).toEqual({
      kind: 'parity',
      value: { kind: 'count', query: { kind: 'event', role: 'subject' } },
      parity,
    });
  });

  it('a singular subject is the per-event trigger, with no count', () => {
    const ir = trigger('when a character dies then heal this character for 5.');
    expect(ir.event).toBe('character:destroyed');
    expect(ir.mode).toBe('single');
    expect(ir.when).toBeUndefined();
  });

  it('a bare plural means "1 or more"', () => {
    const ir = trigger('when characters survive then heal this character for 5.');
    expect(ir.event).toBe('character:survived:batch');
    expect(ir.mode).toBe('batch');
    expect(ir.when).toBeUndefined();
  });

  it("the subject's adjective filters the triggering characters", () => {
    const ir = trigger('when 2 or more enemy characters die then heal this character for 5.');
    expect(ir.filter).toEqual({ kind: 'relation', to: 'enemy' });
  });

  it('the subject takes ownership and "with" clauses, like any noun phrase', () => {
    const ir = trigger(
      'when 2 or more characters owned by the opponent with hp < 10 die then heal this character for 5.',
    );
    expect(ir.filter).toEqual({
      kind: 'and',
      clauses: [
        { kind: 'relation', to: 'opponent' },
        {
          kind: 'compare',
          op: '<',
          left: { kind: 'gauge', gauge: 'hp' },
          right: { kind: 'const', value: 10 },
        },
      ],
    });
  });

  it('reads back as English, for the name and the preview', () => {
    const ir = trigger('when 2 to 5 enemy characters die then deal 5 damage to all enemy characters.');
    expect(ir.name).toBe(
      'When 2 to 5 enemy characters die, deal 5 damage to all enemy characters.',
    );
  });

  it('a trigger inside a Buff is granted by the buff', () => {
    const result = compileDocument(`
      Buff Vengeance
      when 2 or more enemy characters die then deal 5 damage to all enemy characters.

      Ability Curse
      Add Vengeance to target ally character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ir.triggers).toEqual([]); // not document-level
    expect(result.ir.buffs[0]!.triggers).toHaveLength(1);
    expect(result.ir.buffs[0]!.triggers[0]!.scope).toBe('self');
    expect(result.buffs[0]!.abilities).toHaveLength(1);
  });

  it('a trigger outside any Buff is handed to the host to place', () => {
    const result = compileDocument('when a character dies then heal this character for 5.');
    expect(result.ir.triggers).toHaveLength(1);
    expect(result.ir.triggers[0]!.scope).toBe('game');
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0]!.kind).toBe('trigger');
  });

  it('still accepts the turn prefix inside a Buff', () => {
    const result = compileDocument(`
      Buff Regeneration
      When the turn starts, heal this character for 5.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ir.buffs[0]!.triggers.map((t) => t.event)).toEqual(['turn:start']);
  });
});

describe('bare `this`', () => {
  it('names the ability\'s owner with no noun', () => {
    const result = compileDocument('Destroy this.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const effect = result.ir.abilities[0]!.steps[0]!.effects[0]!;
    expect(effect).toEqual({ kind: 'destroy', query: { kind: 'self' } });
  });

  it('is the same phrase as "this character"', () => {
    const bare = compileDocument('Destroy this.');
    const spelled = compileDocument('Destroy this character.');
    expect(bare.ir.abilities[0]!.steps).toEqual(spelled.ir.abilities[0]!.steps);
  });

  it('reads back as written', () => {
    const bare = compileDocument('Heal this for 5.');
    const spelled = compileDocument('Heal this character for 5.');
    expect(bare.abilities[0]!.description).toBe('Heal this for 5.');
    expect(spelled.abilities[0]!.description).toBe('Heal this character for 5.');
  });

  it('works as a trigger subject', () => {
    const result = compileDocument('when this dies then deal 5 damage to all enemy characters.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ir = result.ir.triggers[0]!;
    expect(ir.mode).toBe('single');
    expect(ir.filter).toEqual({ kind: 'relation', to: 'self' });
    expect(ir.name).toBe('When this dies, deal 5 damage to all enemy characters.');
  });

  it('still requires a noun on a group — "all" does not say all what', () => {
    const result = compileDocument('Destroy all.');
    expect(result.diagnostics[0]!.message).toContain('expected "character" or "characters"');
  });
});

describe('triggers: diagnostics', () => {
  it('points at the digit when a count is spelled out', () => {
    const diags = errors('when one or more characters die then heal this for 5.');
    expect(diags[0]!.code).toBe('count-word');
    expect(diags[0]!.message).toContain('"1" instead of "one"');
  });

  it('names the event verbs it knows', () => {
    const diags = errors('when 2 or more characters explode then heal this character for 5.');
    expect(diags[0]!.code).toBe('unknown-event');
    expect(diags[0]!.message).toContain('"die"');
    expect(diags[0]!.message).toContain('"survive"');
  });

  it('requires "then" before the effect', () => {
    const diags = errors('when 2 or more characters die heal this character for 5.');
    expect(diags[0]!.message).toContain('expected "then"');
  });

  it('rejects a backwards count range', () => {
    const diags = errors('when 5 to 2 characters die then heal this character for 5.');
    expect(diags[0]!.code).toBe('count-range');
    expect(diags[0]!.message).toContain('the larger number goes last');
  });

  it('explains a bare number that is not a count phrase', () => {
    const diags = errors('when 3 characters die then heal this character for 5.');
    expect(diags[0]!.message).toContain('"or more"');
  });
});

describe('compile + run in the arena', () => {
  it('destroy target enemy character', async () => {
    const doc = 'Ability Void Bolt\nDestroy target enemy character.';
    const result = compileDocument(doc);
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    const run = await runArena(arena, result.abilities[0]!);
    expect(run.picked).toBe(arena.goblin);
    expect(arena.goblin.destroyed).toBe(true);
    expect(arena.hero.destroyed).toBe(false);
    expect(arena.events.some((e) => e.type === 'character:destroyed')).toBe(true);
  });

  it('deal damage to all enemy characters', async () => {
    const result = compileDocument('Ability Battle Cry\nDeal 20 damage to all enemy characters.');
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await runArena(arena, result.abilities[0]!);
    expect(arena.goblin.gauge('hp').current).toBe(20);
    expect(arena.bruiser.gauge('hp').current).toBe(35);
    expect(arena.hero.gauge('hp').current).toBe(100);
  });

  it('sacrifice: destroy this character and heal the others', async () => {
    const result = compileDocument(
      'Ability Sacrifice\nDestroy this character.\nHeal all other ally characters for 25.',
    );
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await runArena(arena, result.abilities[0]!);
    expect(arena.hero.destroyed).toBe(true);
    // Paladin was already full; the heal was a no-op, not an error.
    expect(arena.ally.gauge('hp').current).toBe(90);
  });

  it('you lose the game — the foes win', async () => {
    const result = compileDocument('Ability Concede\nYou lose the game.');
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    const run = await runArena(arena, result.abilities[0]!);
    expect(run.winners).toEqual([arena.foes]);
  });

  it('all players lose the game — a draw', async () => {
    const result = compileDocument('Ability Annihilation\nAll players lose the game.');
    const arena = buildArena(result.abilities[0]!);
    const run = await runArena(arena, result.abilities[0]!);
    expect(run.winners).toEqual([]);
  });

  it('adds a built-in buff and its turn-trigger fires', async () => {
    const result = compile('Ability Venom Strike\nAdd Poison to target enemy character.');
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await runArena(arena, result.abilities[0]!);
    expect(arena.goblin.hasStatus('poison')).toBe(true);
    // The arena plays one turn:start, so the poison tick landed.
    expect(arena.goblin.gauge('hp').current).toBe(35);
    expect(arena.events.some((e) => e.type === 'gauge:changed')).toBe(true);
  });

  it('removes a buff by its id', async () => {
    const add = compile('Ability Strike\nAdd Poison to target enemy character.');
    const arena = buildArena(add.abilities[0]!);
    await runArena(arena, add.abilities[0]!);
    expect(arena.goblin.hasStatus('poison')).toBe(true);

    const remove = compile('Ability Cleanse\nRemove Poison from all enemy characters.');
    expect(remove.diagnostics).toEqual([]);
    const removeArena = buildArena(remove.abilities[0]!);
    // Seed the poison directly (the arena is fresh for the second ability).
    await removeArena.engine.addBuff(removeArena.goblin, poison, removeArena.hero);
    await runArena(removeArena, remove.abilities[0]!);
    expect(removeArena.goblin.hasStatus('poison')).toBe(false);
  });

  it('adds a buff declared in the document itself', async () => {
    const result = compileDocument(
      'Ability Soul Rot\nAdd Frailty to target enemy character.\n\nBuff Frailty (stacks)',
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.buffs[0]!.name).toBe('Frailty');
    const arena = buildArena(result.abilities[0]!);
    await runArena(arena, result.abilities[0]!);
    expect(arena.goblin.findBuff('frailty')).toBeDefined();
  });

  it('the implicit-ability form runs too', async () => {
    const result = compileDocument('All players lose the game.');
    expect(result.doc.abilities[0]!.name).toBe('Untitled');
    const arena = buildArena(result.abilities[0]!);
    const run = await runArena(arena, result.abilities[0]!);
    expect(run.winners).toEqual([]);
  });

  it('reports events through the arena observer', async () => {
    const result = compileDocument('Ability Cry\nDeal 5 damage to all enemy characters.');
    const arena = buildArena(result.abilities[0]!);
    await runArena(arena, result.abilities[0]!);
    const types = arena.events.map((e: GameEvent) => e.type);
    expect(types).toContain('ability:used');
    expect(types).toContain('gauge:changed');
  });
});

describe('completion', () => {
  const doc = 'Ability Cry\nDeal 20 damage to all enemy characters.\n';

  it('offers section starters and verbs on a fresh line', () => {
    const items = completeAt('', 0);
    const labels = items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Ability', 'Buff', 'Deal', 'Destroy', 'Add', 'Remove', 'You', 'All']));
  });

  it('filters by the word being typed', () => {
    const at = completeAt('Destr', 5);
    expect(at.map((i) => i.label)).toEqual(expect.arrayContaining(['Destroy']));
  });

  it('offers the target words after "deal … to"', () => {
    const text = doc + 'Heal all ally characters for 5.\nDeal 3 damage to ';
    const labels = completeAt(text, text.length).map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['target', 'this', 'all']));
  });

  it('offers adjectives and nouns inside an "all" phrase', () => {
    const text = 'Destroy all ';
    const labels = completeAt(text, text.length).map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['enemy', 'ally', 'other', 'characters']));
    // Typing the adjective narrows the list.
    const narrowed = completeAt('Destroy all en', 14).map((i) => i.label);
    expect(narrowed).toContain('enemy');
    expect(narrowed).not.toContain('ally');
  });

  it('offers ownership after a completed group', () => {
    const text = 'Destroy all characters ';
    const labels = completeAt(text, text.length).map((i) => i.label);
    expect(labels).toContain('owned');
    const byLabels = completeAt('Destroy all characters owned ', 31).map((i) => i.label);
    expect(byLabels).toContain('by');
    const ownerLabels = completeAt('Destroy all characters owned by ', 33).map((i) => i.label);
    expect(ownerLabels).toEqual(expect.arrayContaining(['you', 'the']));
  });

  it('offers buff names after "Add"/"Remove", and the separator mid-name', () => {
    const add = completeAt('Add ', 4, dict).map((i) => i.label);
    expect(add).toEqual(expect.arrayContaining(['Poison', 'Rage', 'Thorns']));
    const poisoned = completeAt('Add Po', 6, dict).map((i) => i.label);
    expect(poisoned).toEqual(['Poison']);
    const midName = completeAt('Add Poison ', 11, dict).map((i) => i.label);
    expect(midName).toContain('to');
    const remove = completeAt('Remove Thorns ', 14, dict).map((i) => i.label);
    expect(remove).toContain('from');
  });

  it('walks the subject-first result sentences', () => {
    expect(completeAt('You ', 4).map((i) => i.label)).toEqual(
      expect.arrayContaining(['win', 'lose']),
    );
    expect(completeAt('All ', 4).map((i) => i.label)).toContain('players');
    const verbs = completeAt('All players ', 12).map((i) => i.label);
    expect(verbs).toEqual(expect.arrayContaining(['wins', 'loses']));
  });

  it('offers nothing inside a free-form ability name', () => {
    expect(completeAt('Ability Fi', 10)).toEqual([]);
  });

  it('offers buff options inside the declaration parens', () => {
    expect(completeAt('Buff X (s', 9).map((i) => i.label)).toEqual(['stacks']);
  });

  it('knows where one sentence ends and the next begins', () => {
    const text = doc;
    const labels = completeAt(text, text.length).map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Heal', 'Destroy']));
  });
});

describe('charsToString', () => {
  it('renders every phrase shape', () => {
    const phrase = (over: Partial<Parameters<typeof charsToString>[0]>): Parameters<typeof charsToString>[0] => ({
      kind: 'chars',
      span: { start: 0, end: 0 },
      quantifier: 'this',
      other: false,
      who: undefined,
      owner: undefined,
      withClause: undefined,
      ...over,
    });
    expect(charsToString(phrase({ quantifier: 'this' }))).toBe('this character');
    expect(charsToString(phrase({ quantifier: 'target', who: 'enemy' }))).toBe('target enemy character');
    expect(charsToString(phrase({ quantifier: 'all', owner: 'you' }))).toBe('all characters owned by you');
    expect(charsToString(phrase({ quantifier: 'all', other: true, who: 'ally' }))).toBe('all other ally characters');
  });
});

describe('custom dictionaries', () => {
  it('resolves names from an injected dictionary', () => {
    const venom = { name: 'Venom', weight: 2 };
    const dict = new BuffDictionary([{ name: 'Venom', def: venom }]);
    const result = compileDocument('Ability Bite\nAdd Venom to target enemy character.', {
      dictionary: dict,
    });
    expect(result.diagnostics).toEqual([]);
    // The injected dictionary replaces the built-ins.
    const unknown = compileDocument('Ability Bite\nAdd Poison to target enemy character.', {
      dictionary: dict,
    }).diagnostics;
    expect(unknown.some((d) => d.code === 'unknown-buff')).toBe(true);
  });
});

describe('imports and parenthesized conditions', () => {
  it('resolves a buff imported through the compiler boundary', () => {
    const result = compileDocument(
      'import Venom from "./Venom.buff"\nAbility Bite\nAdd Venom to target enemy character.',
      { resolveImport: (path, name) => path === './Venom.buff' && name === 'Venom' ? { name: 'Venom', weight: 2 } : undefined },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.abilities[0]!.description).toContain('Add Venom');
  });

  it('reports imports that the host cannot resolve', () => {
    const result = compileDocument('import Missing from "./Missing.buff"\nAbility Bite\nAdd Missing to this character.');
    expect(result.diagnostics.some((d) => d.code === 'unknown-import')).toBe(true);
  });

  it('evaluates parenthesized boolean groups', async () => {
    const result = compile('Ability Hex\nDestroy all enemy characters with (poison or thorns) and hp <= 40.');
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.goblin, poison, arena.hero);
    await runArena(arena, result.abilities[0]!);
    expect(arena.goblin.destroyed).toBe(true);
    expect(charsToString(result.doc.abilities[0]!.sentences[0]!.kind === 'destroy' ? result.doc.abilities[0]!.sentences[0]!.chars : (() => { throw new Error('unreachable'); })())).toContain('(Poison or Thorns)');
  });
});

describe('math expressions', () => {
  it('supports object properties, array indices, arithmetic, SUM, and LaTeX', () => {
    const expression = parseMathExpression('Σ(i = 0 to events.length - 1, events[i].damage) + heroes[1].power * 2');
    expect(evaluateMathExpression(expression, {
      events: [{ damage: 2 }, { damage: 3 }, { damage: 5 }],
      heroes: [{ power: 1 }, { power: 4 }],
    })).toBe(18);
    expect(mathToLatex(expression)).toContain('\\sum_{i=0}^{events.length - 1}');
    expect(mathToLatex(parseMathExpression('a / (b + 1)'))).toContain('\\frac');
  });
});

describe('the "with" clause', () => {
  it('parses the example sentence and renders it back', () => {
    const result = compileDocument('Ability Mercy\nHeal all other ally characters with hp < 10 for 25.');
    expect(result.diagnostics).toEqual([]);
    const sentence = result.doc.abilities[0]!.sentences[0]!;
    expect(sentence.kind).toBe('heal');
    if (sentence.kind !== 'heal') throw new Error('unreachable');
    const clause = sentence.chars.withClause!;
    expect(clause.kind).toBe('with');
    expect(clause.conditions).toHaveLength(1);
    const condition = clause.conditions[0]!;
    expect(condition.kind).toBe('gauge');
    if (condition.kind !== 'gauge') throw new Error('unreachable');
    expect(condition.gauge).toBe('hp');
    expect(condition.op).toBe('<');
    expect(condition.value).toEqual({ kind: 'number', value: 10 });
    expect(charsToString(sentence.chars)).toBe('all other ally characters with hp < 10');
    expect(effectSummary(sentence)).toBe('Heal all other ally characters with hp < 10 for 25.');
  });

  it('accepts every comparison operator', () => {
    const result = compileDocument(`
      Ability Ops
      Destroy all enemy characters with hp <= 10.
      Destroy all enemy characters with hp > 10.
      Destroy all enemy characters with hp >= 10.
      Destroy all enemy characters with hp = 10.
    `);
    expect(result.diagnostics).toEqual([]);
    const ops = result.doc.abilities[0]!.sentences.map((s) => {
      if (s.kind === 'destroy') {
        const c = s.chars.withClause!.conditions[0]!;
        if (c.kind === 'gauge') return c.op;
      }
      return undefined;
    });
    expect(ops).toEqual(['<=', '>', '>=', '=']);
  });

  it('allows "with" before or after "owned by"', () => {
    const a = compileDocument('Ability A\nDestroy all characters owned by you with hp < 5.');
    const b = compileDocument('Ability B\nDestroy all characters with hp < 5 owned by you.');
    expect(a.diagnostics).toEqual([]);
    expect(b.diagnostics).toEqual([]);
    expect(a.doc.abilities[0]!.sentences[0]!.kind).toBe('destroy');
  });

  it('heals only the low-HP allies', async () => {
    const result = compileDocument('Ability Mercy\nHeal all other ally characters with hp < 10 for 25.');
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.damage(arena.ally.gauge('hp'), 85, arena.goblin); // Paladin 90 -> 5
    await runArena(arena, result.abilities[0]!);
    expect(arena.ally.gauge('hp').current).toBe(30);
    expect(arena.hero.gauge('hp').current).toBe(100); // untouched
  });

  it('destroys only the matching enemies', async () => {
    const result = compileDocument('Ability Execute\nDestroy all enemy characters with hp < 20.');
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.damage(arena.goblin.gauge('hp'), 30, arena.hero); // 40 -> 10
    await arena.engine.damage(arena.bruiser.gauge('hp'), 30, arena.hero); // 55 -> 25
    await runArena(arena, result.abilities[0]!);
    expect(arena.goblin.destroyed).toBe(true);
    expect(arena.bruiser.destroyed).toBe(false);
  });

  it('filters target-picking by the clause', async () => {
    const result = compileDocument('Ability Finish\nDestroy target enemy character with hp < 20.');
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.damage(arena.goblin.gauge('hp'), 30, arena.hero); // only the goblin qualifies
    const run = await runArena(arena, result.abilities[0]!);
    expect(run.picked).toBe(arena.goblin);
    expect(arena.goblin.destroyed).toBe(true);
    expect(arena.bruiser.destroyed).toBe(false);
  });

  it('filters by buff presence and combines conditions with "and"', async () => {
    const result = compile('Ability Purge\nDestroy all enemy characters with hp <= 40 and poison.');
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.goblin, poison, arena.hero);
    // Both enemies qualify by HP, but only the goblin has Poison.
    await arena.engine.damage(arena.bruiser.gauge('hp'), 20, arena.hero); // 55 -> 35
    await runArena(arena, result.abilities[0]!);
    expect(arena.goblin.destroyed).toBe(true);
    expect(arena.bruiser.destroyed).toBe(false);
  });

  it('counts a declared buff referenced only by a filter as used', () => {
    const result = compileDocument('Ability Pestilence\nDestroy all enemy characters with Bleed.\n\nBuff Bleed (stacks)');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.diagnostics.some((d) => d.code === 'unused-buff')).toBe(false);
  });

  it('reports unknown buffs and impossible filters', () => {
    const unknown = errors('Ability A\nDestroy all enemy characters with Wobble.');
    expect(unknown.some((d) => d.code === 'unknown-buff')).toBe(true);
    const selfFilter = errors('Ability A\nDestroy this character with hp < 10.');
    expect(selfFilter.some((d) => d.code === 'syntax' && d.message.includes('one character'))).toBe(true);
    const missingOp = errors('Ability A\nDestroy all enemy characters with hp 10.');
    expect(missingOp.some((d) => d.code === 'syntax' && d.message.includes('comparison'))).toBe(true);
    const missingValue = errors('Ability A\nDestroy all enemy characters with hp <.');
    expect(missingValue.some((d) => d.code === 'syntax' && d.message.includes('number'))).toBe(true);
  });

  it('completes the clause word by word', () => {
    const atEnd = (text: string): string[] => completeAt(text, text.length, dict).map((i) => i.label);
    expect(atEnd('Destroy all enemy characters ')).toEqual(expect.arrayContaining(['with', 'owned']));
    expect(atEnd('Destroy all enemy characters with ')).toEqual(expect.arrayContaining(['hp', 'mana', 'Poison']));
    expect(atEnd('Destroy all enemy characters with hp ')).toEqual(expect.arrayContaining(['<', '<=', '>', '>=', '=']));
    expect(atEnd('Destroy all enemy characters with hp < ')).toEqual([]); // a number: nothing to offer
    expect(atEnd('Destroy all enemy characters with poison ')).toEqual(expect.arrayContaining(['and', 'owned']));
    expect(atEnd('Destroy all enemy characters with poison and ')).toEqual(expect.arrayContaining(['hp', 'mana', 'Poison']));
  });
});

describe('three or more "with" conditions', () => {
  it('parses and renders 3+ mixed conditions', () => {
    const result = compile(
      'Ability Purge\nDestroy all enemy characters with hp <= 40 and mana > 5 and poison and thorns.',
    );
    expect(result.diagnostics).toEqual([]);
    const sentence = result.doc.abilities[0]!.sentences[0]!;
    if (sentence.kind !== 'destroy') throw new Error('unreachable');
    const conditions = sentence.chars.withClause!.conditions;
    expect(conditions).toHaveLength(4);
    const shapes = conditions.map((c) =>
      c.kind === 'gauge'
        ? `g:${c.gauge}${c.op}${c.value.kind === 'number' ? c.value.value : '?'}`
        : `b:${c.buffName.toLowerCase()}`,
    );
    expect(shapes).toEqual(['g:hp<=40', 'g:mana>5', 'b:poison', 'b:thorns']);
    // References render with the built-ins' display spelling.
    expect(charsToString(sentence.chars)).toBe(
      'all enemy characters with hp <= 40 and mana > 5 and Poison and Thorns',
    );
  });

  it('accepts comma separators between conditions', () => {
    const result = compile(
      'Ability Mixed\nDestroy all enemy characters with poison, thorns, and hp <= 40.',
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.doc.abilities[0]!.sentences[0]!.kind).toBe('destroy');
  });

  it('resolves every buff condition against the dictionary', () => {
    const rage = buff({ name: 'Rage', weight: 1 });
    const rageDict = new BuffDictionary([
      { name: 'Poison', def: poison },
      { name: 'Thorns', def: thorns },
      { name: 'Rage', def: rage },
    ]);
    const result = compileDocument(
      'Ability Triple\nDestroy all enemy characters with poison and thorns and rage.',
      { dictionary: rageDict },
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // An unknown name anywhere in the chain is still an error.
    const bad = compileDocument('Ability Triple\nDestroy all enemy characters with poison and wobble and rage.', { dictionary: rageDict });
    expect(bad.diagnostics.filter((d) => d.code === 'unknown-buff')).toHaveLength(1);
  });

  it('runs a sentence gated on three conditions at once', async () => {
    const result = compile(
      'Ability Snipe\nDestroy all enemy characters with hp <= 40 and mana >= 0 and poison.',
    );
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.goblin, poison, arena.hero); // goblin: 40 HP, poisoned
    await arena.engine.damage(arena.bruiser.gauge('hp'), 20, arena.hero); // bruiser: 35 HP, no poison
    await runArena(arena, result.abilities[0]!);
    expect(arena.goblin.destroyed).toBe(true);
    expect(arena.bruiser.destroyed).toBe(false);
  });

  it('runs a sentence gated on three gauge conditions (two hp bounds + mana)', async () => {
    const result = compile(
      'Ability Cleric\nHeal all ally characters with hp < 30 and hp > 5 and mana < 5 for 25.',
    );
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    // Paladin at 10 HP qualifies (10 < 30, > 5, mana 0 < 5).
    await arena.engine.damage(arena.ally.gauge('hp'), 80, arena.goblin); // 90 -> 10
    // Hero is full HP — excluded by hp < 30.
    await runArena(arena, result.abilities[0]!);
    expect(arena.ally.gauge('hp').current).toBe(35);
    expect(arena.hero.gauge('hp').current).toBe(100);
  });

  it('keeps completing after two conditions (the 3rd and later ones)', () => {
    const atEnd = (text: string): string[] => completeAt(text, text.length, dict).map((i) => i.label);
    const third = atEnd('Destroy all enemy characters with hp < 40 and mana > 5 and ');
    expect(third).toEqual(expect.arrayContaining(['hp', 'mana', 'Poison', 'Thorns']));
    const fourth = atEnd('Destroy all enemy characters with poison and thorns and ');
    expect(fourth).toEqual(expect.arrayContaining(['hp', 'mana', 'Poison']));
    const done = atEnd('Destroy all enemy characters with hp < 40 and mana > 5 and poison ');
    expect(done).toEqual(expect.arrayContaining(['and', 'owned']));
  });
});

describe('"or" in "with" clauses', () => {
  it('records the joiners between conditions', () => {
    const result = compile(
      'Ability Mix\nDestroy all enemy characters with poison or thorns and hp <= 40.',
    );
    expect(result.diagnostics).toEqual([]);
    const sentence = result.doc.abilities[0]!.sentences[0]!;
    if (sentence.kind !== 'destroy') throw new Error('unreachable');
    const clause = sentence.chars.withClause!;
    expect(
      clause.conditions.map((c) =>
        c.kind === 'buff' ? c.buffName : `${c.gauge}${c.op}${c.value.kind === 'number' ? c.value.value : '?'}`,
      ),
    ).toEqual(['Poison', 'Thorns', 'hp<=40']);
    expect([...clause.joiners]).toEqual(['or', 'and']);
    expect(charsToString(sentence.chars)).toBe('all enemy characters with Poison or Thorns and hp <= 40');
  });

  it('treats commas as "and", even before an "or"', () => {
    const result = compile(
      'Ability Mixed\nDestroy all enemy characters with poison, thorns, or hp <= 40.',
    );
    expect(result.diagnostics).toEqual([]);
    const clause = result.doc.abilities[0]!.sentences[0]!;
    if (clause.kind !== 'destroy') throw new Error('unreachable');
    expect([...clause.chars.withClause!.joiners]).toEqual(['and', 'or']);
  });

  it('a lone "or" branch matches on its own (buff side)', async () => {
    const result = compile(
      'Ability Hex\nDestroy all enemy characters with poison or thorns and hp <= 40.',
    );
    const arena = buildArena(result.abilities[0]!);
    // Bruiser: poisoned, but at full 55 HP — only the poison branch applies.
    await arena.engine.addBuff(arena.bruiser, poison, arena.hero);
    await runArena(arena, result.abilities[0]!);
    expect(arena.bruiser.destroyed).toBe(true);
    expect(arena.goblin.destroyed).toBe(false);
  });

  it('"and" binds tighter than "or"', async () => {
    const result = compile(
      'Ability Tester\nDestroy all enemy characters with poison or thorns and hp <= 40.',
    );
    const arena = buildArena(result.abilities[0]!);
    // Bruiser: only Thorns at full 55 HP — (thorns AND hp <= 40) is false
    // and there is no poison, so it survives. A naive left fold
    // ((poison OR thorns) AND hp <= 40) would have destroyed it.
    await arena.engine.addBuff(arena.bruiser, thorns, arena.hero);
    await runArena(arena, result.abilities[0]!);
    expect(arena.bruiser.destroyed).toBe(false);
  });

  it('a gauge "or" branch matches on its own', async () => {
    const result = compile(
      'Ability Finisher\nDestroy all enemy characters with poison or hp < 20.',
    );
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.damage(arena.goblin.gauge('hp'), 25, arena.hero); // 40 -> 15, no poison
    await runArena(arena, result.abilities[0]!);
    expect(arena.goblin.destroyed).toBe(true);
    expect(arena.bruiser.destroyed).toBe(false);
  });

  it('reports unknown buffs on either side of an "or"', () => {
    const bad = errors('Ability A\nDestroy all enemy characters with poison or wobble.');
    expect(bad.filter((d) => d.code === 'unknown-buff')).toHaveLength(1);
  });

  it('keeps completing after "or"', () => {
    const atEnd = (text: string): string[] => completeAt(text, text.length, dict).map((i) => i.label);
    const afterFirst = atEnd('Destroy all enemy characters with poison ');
    expect(afterFirst).toEqual(expect.arrayContaining(['and', 'or']));
    const afterOr = atEnd('Destroy all enemy characters with poison or ');
    expect(afterOr).toEqual(expect.arrayContaining(['hp', 'mana', 'Poison', 'Thorns']));
    const afterSecond = atEnd('Destroy all enemy characters with poison or hp < 20 ');
    expect(afterSecond).toEqual(expect.arrayContaining(['and', 'or', 'owned']));
  });
});

describe('buff names: display spelling and inspection', () => {
  it('supports multi-word buff names end to end', async () => {
    // Adding a multi-word declared buff.
    const add = compileDocument(
      'Ability Tentacle Sweep\nAdd toxic tentacles to target enemy character.\n\nBuff Toxic Tentacles (stacks)',
    );
    expect(add.diagnostics).toEqual([]);
    expect(add.abilities[0]!.description).toBe('Add Toxic Tentacles to target enemy character.');
    const arena = buildArena(add.abilities[0]!);
    await runArena(arena, add.abilities[0]!);
    expect(arena.goblin.hasStatus('toxic-tentacles')).toBe(true);

    // Filtering on the same multi-word buff (seeded before the cast —
    // filters see the state at cast time, before the cast's own effects).
    const wipe = compileDocument(
      'Ability Sweep\nDestroy all enemy characters with toxic tentacles.\n\nBuff Toxic Tentacles (stacks)',
    );
    expect(wipe.diagnostics).toEqual([]);
    const wipeArena = buildArena(wipe.abilities[0]!);
    await wipeArena.engine.addBuff(wipeArena.goblin, wipe.buffs[0]!, wipeArena.hero);
    await runArena(wipeArena, wipe.abilities[0]!);
    expect(wipeArena.goblin.destroyed).toBe(true);
    expect(wipeArena.bruiser.destroyed).toBe(false);
  });

  it('offers document-declared buffs in completion, multi-word included', () => {
    const atEnd = (text: string): string[] => completeAt(text, text.length, dict).map((i) => i.label);
    const doc = 'Ability X\nAdd ';
    const labels = atEnd(doc);
    expect(labels).toContain('Poison'); // built-ins offered
    // Typing mid-name matches from any word boundary.
    const text = 'Ability X\nAdd Toxic tentacl\n\nBuff Toxic Tentacles (stacks)';
    const partial = completeAt(text, text.indexOf('tentacl') + 'tentacl'.length, dict).map((i) => i.label);
    expect(partial).toContain('Toxic Tentacles');
  });

  it('finds the buff under the cursor on references and declarations', () => {
    const text = [
      'Ability A',
      'Add toxic tentacles to target enemy character.',
      'Remove poison from this character.',
      '',
      'Buff Toxic Tentacles (stacks)',
    ].join('\n');
    const decl = buffReferenceInfo(text, text.indexOf('Toxic Tentacles'), { dictionary: dict });
    expect(decl).toMatchObject({ name: 'Toxic Tentacles', declared: true });
    const ref = buffReferenceInfo(text, text.indexOf('tentacles') + 2, { dictionary: dict });
    expect(ref).toMatchObject({ name: 'Toxic Tentacles', declared: true });
    const builtin = buffReferenceInfo(text, text.indexOf('poison'), { dictionary: dict });
    expect(builtin).toMatchObject({ name: 'Poison', declared: false });
    expect(builtin!.def).toBeDefined();
    // A non-buff word is not a buff reference.
    expect(buffReferenceInfo(text, text.indexOf('character'), { dictionary: dict })).toBeUndefined();
  });

  it('describes declared and built-in buffs', () => {
    const text = 'Ability A\nAdd Toxic Tentacles to this character.\n\nBuff Toxic Tentacles (stacks)';
    const declared = buffReferenceInfo(text, text.indexOf('Toxic Tentacles', 10), { dictionary: dict })!;
    const declaredText = describeBuffReference(declared);
    expect(declaredText).toContain('Toxic Tentacles');
    expect(declaredText).toContain('declared in this document');
    expect(declaredText).toContain('stackable');

    const builtin = buffReferenceInfo('Ability A\nAdd Poison to this character.', 'Ability A\nAdd '.length, { dictionary: dict })!;
    const builtinText = describeBuffReference(builtin);
    expect(builtinText).toContain('Poison');
    expect(builtinText).toContain('built-in');
    expect(builtinText).toContain('turn:start'); // Poison's tick trigger
    expect(builtinText).toContain('stackable');
  });
});

describe('multi-step abilities (sentences see earlier sentences)', () => {
  it('the Add-then-Destroy combo wipes the board', async () => {
    const result = compileDocument(
      'Ability Plague\nAdd Poison to all enemy characters.\nDestroy all enemy characters with poison.\n\nBuff Poison (stacks)',
    );
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    const run = await runArena(arena, result.abilities[0]!);
    // Step 1 poisons both enemies; step 2's filter sees the poison.
    expect(arena.goblin.destroyed).toBe(true);
    expect(arena.bruiser.destroyed).toBe(true);
    expect(run.winners).toEqual([arena.you]);
  });

  it('a later sentence can filter on an earlier sentence\'s damage', async () => {
    const result = compileDocument(
      'Ability Execute\nDeal 30 damage to all enemy characters.\nDestroy all enemy characters with hp < 20.',
    );
    const arena = buildArena(result.abilities[0]!);
    await runArena(arena, result.abilities[0]!);
    // Step 1: goblin 40 -> 10, bruiser 55 -> 25. Step 2 destroys only the
    // one below 20.
    expect(arena.goblin.destroyed).toBe(true);
    expect(arena.bruiser.destroyed).toBe(false);
    expect(arena.bruiser.gauge('hp').current).toBe(25);
  });

  it('single-sentence abilities keep firing as one apply', async () => {
    // The Venom sample is a single sentence — poison lands, then the turn
    // tick fires as before (no per-step split for one sentence).
    const result = compileDocument('Ability Venom Strike\nAdd Poison to target enemy character.\nBuff Poison (stacks)');
    const arena = buildArena(result.abilities[0]!);
    await runArena(arena, result.abilities[0]!);
    expect(arena.goblin.hasStatus('poison')).toBe(true);
  });
});

describe('buff event listeners and triggers in DSL', () => {
  it('parses and compiles event sentences on declared buffs into auto abilities', async () => {
    const docText = [
      'Ability Venom Strike',
      'Add Poison to target enemy character.',
      '',
      'Buff Poison (stacks)',
      'When the turn starts, deal 10 damage to this character.',
    ].join('\n');

    const result = compileDocument(docText);
    expect(result.diagnostics).toEqual([]);
    expect(result.buffs).toHaveLength(1);
    const poisonDef = result.buffs[0]!;
    expect(poisonDef.name).toBe('Poison');
    expect(poisonDef.abilities).toHaveLength(1);

    const arena = buildArena(result.abilities[0]!);
    // runArena casts Venom Strike (applying Poison) then plays turn:start (firing the 10 damage tick)
    await runArena(arena, result.abilities[0]!);
    expect(arena.goblin.hasStatus('poison')).toBe(true);
    expect(arena.goblin.gauge('hp').current).toBe(30);

    // Subsequent turn:start fires the tick again
    await startTurn(arena.engine);
    expect(arena.goblin.gauge('hp').current).toBe(20);
  });

  it('supports "when the turn ends," prefix event trigger', async () => {
    const docText = [
      'Ability Burn',
      'Add Flame to target enemy character.',
      '',
      'Buff Flame (stacks)',
      'When the turn ends, deal 15 damage to this character.',
    ].join('\n');

    const result = compileDocument(docText);
    expect(result.diagnostics).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await runArena(arena, result.abilities[0]!);
    expect(arena.goblin.hasStatus('flame')).toBe(true);
    // turn:end fires after runArena's turn:start, triggered by endTurn(engine)
    await endTurn(arena.engine);
    // 40 - 15 = 25 after one turn:end tick
    expect(arena.goblin.gauge('hp').current).toBe(25);
  });
});

describe('triggers: running in the arena', () => {
  it('a buff-granted trigger fires through the real engine', async () => {
    // Vengeance watches the board; Curse puts it on the Hero. When two or
    // more enemies die in one batch, every enemy takes 5.
    const result = compileDocument(`
      Buff Vengeance
      when 2 or more enemy characters die then deal 5 damage to all enemy characters.

      Ability Wrath
      Deal 40 damage to all enemy characters.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const wrath = result.abilities.find((a) => a.name === 'Wrath')!;
    const arena = buildArena(wrath);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await runArena(arena, wrath);

    // Goblin (40hp) and Bruiser (55hp) both took 40 in one batch; only the
    // Goblin died, so one death is below the floor of 2 and Vengeance
    // stayed quiet.
    expect(arena.engine.isInPlay(arena.goblin)).toBe(false);
    expect(arena.bruiser.gauge('hp').current).toBe(15);
  });

  it('fires when the count is met', async () => {
    // Survival, not death: killing *every* enemy would end the game, and
    // the engine deliberately does not run death triggers at game end
    // (win/lose-first). Marking is also gauge-free, so the trigger cannot
    // re-trigger off its own effect.
    const result = compileDocument(`
      Buff Mark
      Buff Vengeance
      when 2 or more enemy characters survive then Add Mark to all enemy characters.

      Ability Sting
      Deal 10 damage to all enemy characters.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const sting = result.abilities.find((a) => a.name === 'Sting')!;
    const vengeance = result.buffs.find((b) => b.name === 'Vengeance')!;
    const arena = buildArena(sting);
    await arena.engine.addBuff(arena.hero, vengeance);
    await runArena(arena, sting);

    expect(arena.goblin.gauge('hp').current).toBe(30);
    expect(arena.bruiser.gauge('hp').current).toBe(45);
    expect(arena.goblin.statuses.map((status) => status.name)).toContain('Mark');
    expect(arena.bruiser.statuses.map((status) => status.name)).toContain('Mark');
  });

  it('stays quiet when the filtered count is short', async () => {
    const result = compileDocument(`
      Buff Mark
      Buff Vengeance
      when 3 or more enemy characters survive then Add Mark to all enemy characters.

      Ability Sting
      Deal 10 damage to all enemy characters.
    `);
    const sting = result.abilities.find((a) => a.name === 'Sting')!;
    const arena = buildArena(sting);
    await arena.engine.addBuff(arena.hero, result.buffs.find((b) => b.name === 'Vengeance')!);
    await runArena(arena, sting);
    // Two survivors, a floor of three.
    expect(arena.goblin.statuses.map((status) => status.name)).not.toContain('Mark');
  });

  it('a document-level trigger runs once the host places it', async () => {
    const result = compileDocument(`
      when a character dies then deal 3 damage to all ally characters.

      Ability Wrath
      Deal 40 damage to all enemy characters.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const wrath = result.abilities.find((a) => a.name === 'Wrath')!;
    // The arena is the host: it carries the document's triggers on the
    // Hero's skill.
    const arena = buildArena(wrath, 'english-arena', result.triggers);
    await runArena(arena, wrath);

    // Only the Goblin (40hp) died, so the game continued and one
    // per-character death trigger ran: 3 to every ally.
    expect(arena.engine.isInPlay(arena.goblin)).toBe(false);
    expect(arena.hero.gauge('hp').current).toBe(97);
    expect(arena.ally.gauge('hp').current).toBe(87);
  });
});

describe('if: conditional effects', () => {
  const steps = (text: string) => {
    const result = compileDocument(text);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    return result.ir.abilities[0]!.steps;
  };

  it('"there are <count>" compares how many exist', () => {
    const [step] = steps('If there are 2 or more enemy characters, deal 5 damage to this.');
    expect(step!.when).toEqual({
      kind: 'compare',
      op: '>=',
      left: { kind: 'count', query: { kind: 'all', who: 'enemy', other: false } },
      right: { kind: 'const', value: 2 },
    });
  });

  it('"any … has" is one of them, "every … has" is all of them', () => {
    const anyStep = steps('Buff Poison\nAbility A\nAdd Poison to this.\nIf any enemy character has Poison, deal 5 damage to this.')[1];
    const everyStep = steps('Buff Poison\nAbility A\nAdd Poison to this.\nIf every enemy character has Poison, deal 5 damage to this.')[1];
    expect(anyStep!.when).toEqual({
      kind: 'any',
      query: { kind: 'all', who: 'enemy', other: false },
      test: { kind: 'hasBuff', buff: 'Poison' },
    });
    expect(everyStep!.when).toEqual({ ...(anyStep!.when as object), kind: 'every' });
  });

  it('"this has" is the condition on the ability\'s owner', () => {
    const [step] = steps('If this has hp < 10, heal this for 20.');
    expect(step!.when).toEqual({
      kind: 'any',
      query: { kind: 'self' },
      test: { kind: 'compare', op: '<', left: { kind: 'gauge', gauge: 'hp' }, right: { kind: 'const', value: 10 } },
    });
  });

  it('a condition may combine with and/or, written out', () => {
    const [step] = steps('If this has hp < 10 and mana > 5, heal this for 20.');
    expect(step!.when).toEqual({
      kind: 'any',
      query: { kind: 'self' },
      test: {
        kind: 'and',
        clauses: [
          { kind: 'compare', op: '<', left: { kind: 'gauge', gauge: 'hp' }, right: { kind: 'const', value: 10 } },
          { kind: 'compare', op: '>', left: { kind: 'gauge', gauge: 'mana' }, right: { kind: 'const', value: 5 } },
        ],
      },
    });
  });

  it('reads back as English', () => {
    const result = compileDocument('If there are 2 or more enemy characters, deal 5 damage to this.');
    expect(result.abilities[0]!.description).toBe(
      'If there are 2 or more enemy characters, deal 5 damage to this.',
    );
    const every = compileDocument('Buff Poison\nAbility A\nAdd Poison to this.\nIf every enemy character has Poison, deal 5 damage to this.');
    expect(every.abilities[0]!.description).toContain('If every enemy character has Poison,');
  });

  it('gates the step at run time, seeing the earlier steps', async () => {
    // Two enemies in the arena, so the first guard holds and the second
    // does not — and the run proves the gate is checked, not just stored.
    const result = compileDocument(`
      Ability Judgement
      If there are 2 or more enemy characters, deal 5 damage to all enemy characters.
      If there are 5 or more enemy characters, deal 50 damage to all enemy characters.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const arena = buildArena(ability);
    await runArena(arena, ability);
    expect(arena.goblin.gauge('hp').current).toBe(35);
    expect(arena.bruiser.gauge('hp').current).toBe(50);
  });

  it('works inside a trigger\'s effect', () => {
    const result = compileDocument(
      'when a character dies then if this has hp < 150, heal this for 5.',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ir.triggers[0]!.steps[0]!.when).toBeDefined();
  });
});

describe('if: diagnostics', () => {
  it('requires the comma between condition and effect', () => {
    const diags = errors('If this has hp < 10 heal this for 20.');
    expect(diags[0]!.message).toContain('expected ","');
  });

  it('names the shapes it accepts', () => {
    const diags = errors('If the board is full, heal this for 20.');
    expect(diags[0]!.message).toContain('"there are …"');
    expect(diags[0]!.message).toContain('"every …"');
  });

  it('requires "has" after any/every', () => {
    const diags = errors('If any enemy character hp < 10, heal this for 20.');
    expect(diags[0]!.message).toContain('expected "has"');
  });
});

describe('you may: optional effects', () => {
  /** A player that answers every confirm with the same answer. */
  class Decider extends Player {
    constructor(name: string, characters: Character[], team: string, readonly yes: boolean) {
      super(name, characters, team);
    }
    async decide(): Promise<Decision[]> {
      return [];
    }
    override async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
      if (request.kind === 'confirm') return { kind: 'confirm', yes: this.yes };
      return autoChoose(request);
    }
  }

  const document = `
    Ability Gamble
    Deal 10 damage to all enemy characters.
    You may deal 10 damage to this.
  `;

  async function run(yes: boolean) {
    const result = compileDocument(document);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;

    const engine = createEngine({ seed: 'may' });
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 10,
      skills: [skill({ name: 'Gambler', weight: 1, abilities: [ability] })],
    });
    const foe = new Character('Foe', { maxHp: 100, maxMana: 10 });
    hero.team = 'you';
    foe.team = 'them';
    engine.registerPlayers([
      new Decider('You', [hero], 'you', yes),
      new Decider('Them', [foe], 'them', yes),
    ]);
    await engine.useAbility(hero, ability, { targets: [hero] });
    return { hero, foe };
  }

  it('runs the effect when the controller says yes', async () => {
    const { hero, foe } = await run(true);
    expect(foe.gauge('hp').current).toBe(90);
    expect(hero.gauge('hp').current).toBe(90);
  });

  it('skips it when they say no — and the rest of the ability still ran', async () => {
    const { hero, foe } = await run(false);
    expect(foe.gauge('hp').current).toBe(90);
    expect(hero.gauge('hp').current).toBe(100);
  });

  it('lowers to an optional step', () => {
    const result = compileDocument('You may deal 5 damage to this.');
    expect(result.ir.abilities[0]!.steps[0]!.optional).toBe(true);
  });

  it('asks only after an If condition holds', () => {
    const result = compileDocument('You may if there are 5 or more enemy characters, deal 5 damage to this.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const step = result.ir.abilities[0]!.steps[0]!;
    // Both recorded; the binder checks `when` first, so an impossible step
    // is never offered.
    expect(step.when).toBeDefined();
    expect(step.optional).toBe(true);
  });

  it('reads back as English', () => {
    const result = compileDocument('You may deal 5 damage to this.');
    expect(result.abilities[0]!.description).toBe('You may deal 5 damage to this.');
  });

  it('still parses "You win the game."', () => {
    const result = compileDocument('You win the game.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ir.abilities[0]!.steps[0]!.effects[0]).toEqual({
      kind: 'result',
      players: 'you',
      win: true,
    });
  });
});

describe('repeat', () => {
  /** Says yes a fixed number of times, then no — and counts the asks. */
  class Nagged extends Player {
    asked = 0;
    constructor(name: string, characters: Character[], team: string, private budget: number) {
      super(name, characters, team);
    }
    async decide(): Promise<Decision[]> {
      return [];
    }
    override async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
      if (request.kind !== 'confirm') return autoChoose(request);
      this.asked += 1;
      const yes = this.budget > 0;
      this.budget -= 1;
      return { kind: 'confirm', yes };
    }
  }

  async function run(text: string, budget: number) {
    const result = compileDocument(text);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const engine = createEngine({ seed: 'repeat' });
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 10,
      skills: [skill({ name: 'S', weight: 1, abilities: [ability] })],
    });
    const foe = new Character('Foe', { maxHp: 100, maxMana: 10 });
    hero.team = 'you';
    foe.team = 'them';
    const you = new Nagged('You', [hero], 'you', budget);
    engine.registerPlayers([you, new Nagged('Them', [foe], 'them', 0)]);
    await engine.useAbility(hero, ability, { targets: [hero] });
    return { hero, foe, you };
  }

  it('repeats while the player keeps choosing to — Ad Nauseam', async () => {
    const { hero, you } = await run('Repeat if you choose: deal 1 damage to this.', 3);
    // Three yesses, then a no: three iterations, four questions.
    expect(hero.gauge('hp').current).toBe(97);
    expect(you.asked).toBe(4);
  });

  it('does nothing when the first answer is no', async () => {
    const { hero, you } = await run('Repeat if you choose: deal 1 damage to this.', 0);
    expect(hero.gauge('hp').current).toBe(100);
    expect(you.asked).toBe(1);
  });

  it('a cap stops it even when the player keeps saying yes', async () => {
    const { hero, you } = await run('Repeat up to 2 times if you choose: deal 1 damage to this.', 99);
    expect(hero.gauge('hp').current).toBe(98);
    expect(you.asked).toBe(2);
  });

  it('a condition stops it, and is checked before the player is asked', async () => {
    // The condition is false from the start, so the player is never asked
    // about an iteration that could not have happened.
    const { hero, you } = await run(
      'Repeat while there are 5 or more enemy characters, if you choose: deal 1 damage to this.',
      99,
    );
    expect(hero.gauge('hp').current).toBe(100);
    expect(you.asked).toBe(0);
  });

  it('a condition the effects change terminates on its own', async () => {
    const result = compileDocument(`
      Ability Grind
      Repeat up to 10 times while this has hp > 95: deal 1 damage to this.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const arena = buildArena(ability);
    await runArena(arena, ability);
    // 100 → 95, then the condition is false.
    expect(arena.hero.gauge('hp').current).toBe(95);
  });

  it('lowers each clause independently', () => {
    const result = compileDocument(
      'Repeat up to 3 times while there are 2 or more enemy characters, if you choose: deal 1 damage to this.',
    );
    expect(result.ir.abilities[0]!.steps[0]!.repeat).toEqual({
      while: {
        kind: 'compare',
        op: '>=',
        left: { kind: 'count', query: { kind: 'all', who: 'enemy', other: false } },
        right: { kind: 'const', value: 2 },
      },
      confirm: true,
      max: 3,
    });
  });

  it('refuses a repeat with no bound at all', () => {
    const diags = errors('Repeat: deal 1 damage to this.');
    expect(diags[0]!.code).toBe('repeat-unbounded');
    expect(diags[0]!.message).toContain('never stops');
  });

  it('warns about a repeat bounded only by its condition', () => {
    const result = compileDocument('Repeat while there are 2 or more enemy characters: deal 1 damage to this.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.diagnostics.some((d) => d.code === 'repeat-uncapped')).toBe(true);
  });

  it('reads back as English', () => {
    const result = compileDocument('Repeat up to 3 times if you choose: deal 1 damage to this.');
    expect(result.abilities[0]!.description).toBe(
      'Repeat up to 3 times if you choose: deal 1 damage to this.',
    );
  });

  /* ------- the mandatory floor: "do it, then you may do it again" ------- */

  it('"1 or more times if you choose" does one, then asks — Ad Nauseam', async () => {
    // The real card's shape: the reveal happens, and only the *repeat* is
    // optional. A first "no" still leaves one iteration done.
    const { hero, you } = await run('Repeat 1 or more times if you choose: deal 1 damage to this.', 0);
    expect(hero.gauge('hp').current).toBe(99);
    expect(you.asked).toBe(1);
  });

  it('keeps going past the floor while the player agrees', async () => {
    const { hero, you } = await run('Repeat 1 or more times if you choose: deal 1 damage to this.', 2);
    // One mandatory, then two yesses and a no.
    expect(hero.gauge('hp').current).toBe(97);
    expect(you.asked).toBe(3);
  });

  it('a floor above one is asked about only after it is met', async () => {
    const { hero, you } = await run('Repeat 3 or more times if you choose: deal 1 damage to this.', 0);
    expect(hero.gauge('hp').current).toBe(97);
    expect(you.asked).toBe(1);
  });

  it('a range is a floor and a cap: "2 to 4 times"', async () => {
    const { hero, you } = await run('Repeat 2 to 4 times if you choose: deal 1 damage to this.', 99);
    // Two mandatory, then asked twice more up to the cap of four.
    expect(hero.gauge('hp').current).toBe(96);
    expect(you.asked).toBe(2);
  });

  it('a bare count is exact, and needs no choice at all', async () => {
    const { hero, you } = await run('Repeat 2 times: deal 1 damage to this.', 0);
    expect(hero.gauge('hp').current).toBe(98);
    expect(you.asked).toBe(0);
  });

  it('the condition still gates a mandatory iteration', async () => {
    // The floor says the player is not consulted — not that the effect
    // applies regardless.
    const { hero, you } = await run(
      'Repeat 2 or more times while there are 5 or more enemy characters, if you choose: deal 1 damage to this.',
      99,
    );
    expect(hero.gauge('hp').current).toBe(100);
    expect(you.asked).toBe(0);
  });

  it('lowers the floor as `min`', () => {
    const result = compileDocument('Repeat 1 or more times if you choose: deal 1 damage to this.');
    expect(result.ir.abilities[0]!.steps[0]!.repeat).toEqual({ confirm: true, min: 1 });
  });

  it('rejects a parity, which does not count iterations', () => {
    const diags = errors('Repeat an even number of times if you choose: deal 1 damage to this.');
    expect(diags[0]!.code).toBe('repeat-parity');
  });
});

describe('buff durations', () => {
  async function play(document: string, turns: number) {
    const result = compileDocument(document);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const arena = buildArena(ability);
    await runArena(arena, ability, { startTurn: false });
    const names = (): string[] => arena.goblin.statuses.map((status) => status.name);
    const before = names();
    const after: string[][] = [];
    for (let turn = 0; turn < turns; turn += 1) {
      await endTurn(arena.engine);
      after.push(names());
    }
    return { arena, before, after };
  }

  const mark = (options: string) => `
    Buff Mark (${options})
    Ability Brand
    Add Mark to target enemy character.
  `;

  it('"until end of turn" removes the buff at the turn\'s end', async () => {
    const { before, after } = await play(mark('until end of turn'), 1);
    expect(before).toContain('Mark');
    expect(after[0]).not.toContain('Mark');
  });

  it('without a duration the buff stays', async () => {
    const { before, after } = await play(mark('weight 1'), 2);
    expect(before).toContain('Mark');
    expect(after[1]).toContain('Mark');
  });

  it('"for 2 turns" survives one turn-end and goes on the second', async () => {
    const { after } = await play(mark('for 2 turns'), 2);
    expect(after[0]).toContain('Mark');
    expect(after[1]).not.toContain('Mark');
  });

  it('every stack of a duration buff expires together', async () => {
    const result = compileDocument(`
      Buff Mark (stacks, until end of turn)
      Ability Brand
      Add Mark to target enemy character.
      Add Mark to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const arena = buildArena(ability);
    await runArena(arena, ability, { startTurn: false });
    // Two instances, each with its own expiry trigger.
    expect(arena.goblin.statuses.filter((status) => status.name === 'Mark')).toHaveLength(2);
    await endTurn(arena.engine);
    expect(arena.goblin.statuses.filter((status) => status.name === 'Mark')).toHaveLength(0);
  });

  it('lowers to a duration on the buff, not an engine concept', () => {
    const result = compileDocument(mark('until end of turn'));
    expect(result.ir.buffs[0]!.duration).toEqual({ kind: 'endOfTurn' });
    // The engine has no expiry: it became an ordinary ability on the buff.
    expect(result.buffs[0]!.abilities?.map((a) => a.name)).toEqual(['Mark expires']);
  });

  it('rejects a zero-turn duration and names the other options', () => {
    expect(errors(mark('for 0 turns'))[0]!.code).toBe('duration-zero');
    expect(errors(mark('forever'))[0]!.message).toContain('until end of turn');
  });
});

describe('action modifiers', () => {
  /** Compiles a document, puts its buff on the Hero, and strikes once. */
  async function strike(buffSource: string, stacks = 1) {
    const result = compileDocument(`
      ${buffSource}

      Ability Strike
      Deal 20 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities.find((a) => a.name === 'Strike')!;
    const arena = buildArena(ability);
    for (let i = 0; i < stacks; i += 1) {
      await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    }
    await runArena(arena, ability, { startTurn: false });
    return arena;
  }

  it('Rage: increases outgoing damage — the buff this language could not write', async () => {
    const arena = await strike('Buff Rage (stacks)\n      Outgoing damage is increased by 5.');
    expect(arena.goblin.gauge('hp').current).toBe(40 - 25);
  });

  it('every stack applies, with no per-stack arithmetic to write', async () => {
    // The engine runs each attached instance's modifier in turn, so
    // stacking is free: three stacks of "+5" is +15.
    const arena = await strike('Buff Rage (stacks)\n      Outgoing damage is increased by 5.', 3);
    expect(arena.goblin.gauge('hp').current).toBe(40 - 35);
  });

  it('leaves healing alone', async () => {
    const result = compileDocument(`
      Buff Rage (stacks)
      Outgoing damage is increased by 5.

      Ability Mend
      Heal all other ally characters for 10.
    `);
    const ability = result.abilities.find((a) => a.name === 'Mend')!;
    const arena = buildArena(ability);
    arena.ally.gauge('hp').current = 50;
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await runArena(arena, ability, { startTurn: false });
    expect(arena.ally.gauge('hp').current).toBe(60);
  });

  it('leaves the wearer\'s own gauge writes alone', async () => {
    // "Damage you deal" means to something else — a self-inflicted cost is
    // not outgoing damage.
    const result = compileDocument(`
      Buff Rage (stacks)
      Outgoing damage is increased by 5.

      Ability Sacrifice
      Deal 10 damage to this.
    `);
    const ability = result.abilities.find((a) => a.name === 'Sacrifice')!;
    const arena = buildArena(ability);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await runArena(arena, ability, { startTurn: false });
    expect(arena.hero.gauge('hp').current).toBe(90);
  });

  it('an incoming modifier does not touch what the wearer deals', async () => {
    const arena = await strike('Buff Iron Hide\n      Incoming damage is reduced by 5.');
    expect(arena.goblin.gauge('hp').current).toBe(20);
  });

  it('`from` narrows an incoming modifier to the attacker\'s side', async () => {
    // "Incoming damage from enemy characters" must check who dealt the
    // damage, not who received it — the receiver is always the wearer, so
    // a target check against the wrong character would never fire.
    const result = compileDocument(`
      Buff Iron Hide
      Incoming damage from enemy characters is reduced by 3.

      Ability Noop
      Deal 1 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await arena.engine.damage(arena.hero.gauge('hp'), 10, arena.goblin); // enemy: reduced
    await arena.engine.damage(arena.hero.gauge('hp'), 10, arena.ally); // ally: untouched
    expect(arena.hero.gauge('hp').current).toBe(100 - 7 - 10);
  });

  it('`from` on an outgoing modifier narrows by who it is aimed at', async () => {
    const result = compileDocument(`
      Buff Predator
      Outgoing damage from enemy characters is increased by 5.

      Ability Noop
      Deal 1 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await arena.engine.damage(arena.goblin.gauge('hp'), 10, arena.hero); // enemy: boosted
    await arena.engine.damage(arena.ally.gauge('hp'), 10, arena.hero); // ally: untouched
    expect(arena.goblin.gauge('hp').current).toBe(40 - 15);
    expect(arena.ally.gauge('hp').current).toBe(90 - 10);
  });

  it('a buff-sourced incoming action never satisfies a `from` check', async () => {
    // Poison's tick carries no character source — the buff is the cause —
    // so "from enemy characters" must not treat that as a match.
    const result = compileDocument(`
      Buff Iron Hide
      Incoming damage from enemy characters is reduced by 100.

      Ability Noop
      Deal 1 damage to target enemy character.
    `);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await arena.engine.addBuff(arena.hero, poison);
    await startTurn(arena.engine); // runs the poison tick
    expect(arena.hero.gauge('hp').current).toBe(95); // full 5, not reduced to 0
  });

  it('a named gauge (`mana loss`) narrows to that gauge only', async () => {
    const result = compileDocument(`
      Buff Iron Will
      Incoming mana loss is prevented.

      Ability Noop
      Deal 1 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await arena.engine.damage(arena.hero.gauge('mana'), 10, arena.goblin); // prevented
    await arena.engine.damage(arena.hero.gauge('hp'), 10, arena.goblin); // untouched — wrong gauge
    expect(arena.hero.gauge('mana').current).toBe(40);
    expect(arena.hero.gauge('hp').current).toBe(90);
  });

  it('`gain` is the named-gauge spelling of `healing`', async () => {
    const result = compileDocument(`
      Buff Mana Ward
      Incoming mana gain is doubled.

      Ability Noop
      Deal 1 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await arena.engine.damage(arena.hero.gauge('mana'), 20, arena.goblin); // 40 -> 20, a loss: untouched
    await arena.engine.heal(arena.hero.gauge('mana'), 5, arena.goblin); // a gain: +5 doubled -> +10
    await arena.engine.damage(arena.hero.gauge('hp'), 10, arena.goblin); // untouched — wrong gauge
    expect(arena.hero.gauge('mana').current).toBe(30);
    expect(arena.hero.gauge('hp').current).toBe(90);
  });

  it('caps, prevents, doubles, halves and multiplies', async () => {
    const cases: Array<[string, number]> = [
      ['Outgoing damage is capped at 5.', 5],
      ['Outgoing damage is prevented.', 0],
      ['Outgoing damage is doubled.', 40],
      ['Outgoing damage is halved.', 10],
      ['Outgoing damage is reduced by 8.', 12],
      ['Outgoing damage is multiplied by 3.', 60],
    ];
    for (const [sentence, dealt] of cases) {
      const arena = await strike(`Buff M\n      ${sentence}`);
      expect(arena.goblin.gauge('hp').current, sentence).toBe(Math.max(0, 40 - dealt));
    }
  });

  it('a reduction never turns damage into healing', async () => {
    const arena = await strike('Buff Pillow\n      Outgoing damage is reduced by 50.');
    expect(arena.goblin.gauge('hp').current).toBe(40); // 0 damage, not +10 healing
  });

  it('two modifiers compose on the magnitude', async () => {
    const result = compileDocument(`
      Buff Rage
      Outgoing damage is increased by 5.

      Buff Focus
      Outgoing damage is doubled.

      Ability Strike
      Deal 20 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities.find((a) => a.name === 'Strike')!;
    const arena = buildArena(ability);
    for (const def of result.buffs) await arena.engine.addBuff(arena.hero, def);
    await runArena(arena, ability, { startTurn: false });
    // Both applied; whichever order, the result is a rescaled magnitude
    // rather than one modifier overwriting the other.
    expect(arena.goblin.gauge('hp').current).toBeLessThan(40 - 25);
  });

  it('a reduction overshooting past zero is picked up by a later increase', async () => {
    // "Reduced by 10" on 8 damage overshoots to -2; "increased by 5" must
    // still see this as damage (judged from the action's original intent,
    // not the live, now-crossed-zero sign) and add 5 to get 3 — not stop
    // at 0 because an intermediate step hit it exactly.
    const result = compileDocument(`
      Buff Ward
      Incoming damage is reduced by 10.

      Buff Spite
      Incoming damage is increased by 5.

      Ability Poke
      Deal 8 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities.find((a) => a.name === 'Poke')!;
    const ward = result.buffs.find((b) => b.name === 'Ward')!;
    const spite = result.buffs.find((b) => b.name === 'Spite')!;
    // Both orders: Ward (reduce) before Spite (increase), and reversed.
    for (const order of [[ward, spite], [spite, ward]]) {
      const arena = buildArena(ability);
      for (const def of order) await arena.engine.addBuff(arena.goblin, def);
      await runArena(arena, ability, { startTurn: false });
      expect(arena.goblin.gauge('hp').current, JSON.stringify(order.map((d) => d.name))).toBe(37); // 40 - 3
    }
  });

  it('a reduction can still never turn the net result into healing', async () => {
    // "Reduced by 50" then "increased by 5" on 10 damage: 10 - 50 + 5 =
    // -35 — net healing, by the pure arithmetic — but the one floor at
    // settlement time (judged from the action's `intent`) catches it: 0
    // damage, not +35 HP.
    const result = compileDocument(`
      Buff Ward
      Incoming damage is reduced by 50.

      Buff Spite
      Incoming damage is increased by 5.

      Ability Poke
      Deal 10 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities.find((a) => a.name === 'Poke')!;
    const arena = buildArena(ability);
    for (const def of result.buffs) await arena.engine.addBuff(arena.goblin, def);
    await runArena(arena, ability, { startTurn: false });
    expect(arena.goblin.gauge('hp').current).toBe(40); // 0 damage, not +35 healing
  });

  it('matches the hand-written TypeScript Rage exactly', async () => {
    // src/examples/08-27-2026/buffs/rage/index.ts is the same buff as a
    // `passiveActionModifier` closure — the one piece of roster content
    // this language could not express. Same ability, same board, both
    // buffs: the results must agree, at one stack and at three.
    const doc = compileDocument(`
      Buff Rage (stacks)
      Outgoing damage is increased by 5.

      Ability Strike
      Deal 20 damage to target enemy character.
    `);
    const ability = doc.abilities.find((a) => a.name === 'Strike')!;
    const run = async (def: BuffDef, stacks: number): Promise<number> => {
      const arena = buildArena(ability);
      for (let i = 0; i < stacks; i += 1) await arena.engine.addBuff(arena.hero, def);
      await runArena(arena, ability, { startTurn: false });
      return arena.goblin.gauge('hp').current;
    };
    for (const stacks of [1, 3]) {
      expect(await run(doc.buffs[0]!, stacks)).toBe(await run(handWrittenRage, stacks));
    }
  });

  it('lowers to a match and a rewrite', () => {
    const result = compileDocument('Buff Rage (stacks)\nOutgoing damage is increased by 5.');
    expect(result.ir.buffs[0]!.modifiers).toEqual([
      {
        id: 'rage-modifier-0',
        name: 'Rage Outgoing damage is increased by 5',
        // Bare `damage` claims the target's life gauge, not a literal 'hp'.
        match: { direction: 'outgoing', change: 'damage', gauge: { kind: 'life' } },
        rewrite: { kind: 'amount', op: 'add', by: { kind: 'const', value: 5 } },
      },
    ]);
  });

  it('lowers `from` to a relation predicate on the match', () => {
    const result = compileDocument(
      'Buff Iron Hide\nIncoming damage from enemy characters is reduced by 3.',
    );
    expect(result.ir.buffs[0]!.modifiers).toEqual([
      {
        id: 'iron-hide-modifier-0',
        name: 'Iron Hide Incoming damage from enemy characters is reduced by 3',
        match: {
          direction: 'incoming',
          change: 'damage',
          gauge: { kind: 'life' },
          target: { kind: 'relation', to: 'enemy' },
        },
        rewrite: { kind: 'amount', op: 'subtract', by: { kind: 'const', value: 3 } },
      },
    ]);
  });

  it('a bare `from characters` filters nothing', () => {
    // No adjective, no owner, no `with` — nothing for a relation predicate
    // to express, so the match carries no `target` at all.
    const result = compileDocument(
      'Buff M\nIncoming damage from characters is reduced by 3.',
    );
    expect(result.ir.buffs[0]!.modifiers![0]!.match).toEqual({
      direction: 'incoming',
      change: 'damage',
      gauge: { kind: 'life' },
    });
  });

  it('lowers a named gauge to `change` + `gauge` on the match', () => {
    const result = compileDocument('Buff M\nIncoming mana loss is prevented.');
    expect(result.ir.buffs[0]!.modifiers![0]!.match).toEqual({
      direction: 'incoming',
      change: 'damage',
      gauge: 'mana',
    });
  });

  it('a named gauge composes with `from`', async () => {
    const result = compileDocument(`
      Buff Iron Will
      Incoming mana loss from enemy characters is prevented.

      Ability Noop
      Deal 1 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ir.buffs[0]!.modifiers![0]!.match).toEqual({
      direction: 'incoming',
      change: 'damage',
      gauge: 'mana',
      target: { kind: 'relation', to: 'enemy' },
    });
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await arena.engine.damage(arena.hero.gauge('mana'), 10, arena.goblin); // enemy: prevented
    await arena.engine.damage(arena.hero.gauge('mana'), 10, arena.ally); // ally: not prevented
    expect(arena.hero.gauge('mana').current).toBe(30);
  });

  it('`gain` lowers to `change: heal`, same as `healing`', () => {
    const result = compileDocument('Buff M\nOutgoing hp gain is doubled.');
    expect(result.ir.buffs[0]!.modifiers![0]!.match).toEqual({
      direction: 'outgoing',
      change: 'heal',
      gauge: 'hp',
    });
  });

  it('reads back as English', () => {
    for (const sentence of [
      'Outgoing damage is increased by 5.',
      'Incoming healing is reduced by 3.',
      'Outgoing damage is doubled.',
      'Incoming damage is halved.',
      'Outgoing damage is multiplied by 3.',
      'Incoming damage is capped at 10.',
      'Incoming damage is prevented.',
      'Outgoing damage has a 25% chance to be multiplied by 3.',
      'Incoming damage from enemy characters is reduced by 3.',
      'Outgoing damage from ally characters owned by you is increased by 5.',
      'Incoming mana loss is prevented.',
      'Outgoing hp gain is doubled.',
    ]) {
      const result = compileDocument(`Buff M\n${sentence}`);
      expect(result.diagnostics.filter((d) => d.severity === 'error'), sentence).toEqual([]);
      expect(result.buffs[0]!.abilities?.[0]!.name).toContain(sentence.replace(/\.$/, ''));
    }
  });

  it('a chance is rolled per action, from the seeded PRNG', async () => {
    // A 0% chance never fires and a 100% chance always does, so the two
    // ends pin the roll down without depending on which number came up.
    const never = await strike('Buff M\n      Outgoing damage has a 0% chance to be multiplied by 3.');
    expect(never.goblin.gauge('hp').current).toBe(20);
    const always = await strike('Buff M\n      Outgoing damage has a 100% chance to be multiplied by 3.');
    expect(always.goblin.gauge('hp').current).toBe(0); // 60 damage, clamped at 0
  });

  it('a chance is reproducible from the seed', async () => {
    const outcome = async (seed: string): Promise<number> => {
      const result = compileDocument(`
        Buff M
        Outgoing damage has a 50% chance to be multiplied by 3.

        Ability Strike
        Deal 10 damage to target enemy character.
      `);
      const ability = result.abilities.find((a) => a.name === 'Strike')!;
      const arena = buildArena(ability, seed);
      await arena.engine.addBuff(arena.hero, result.buffs[0]!);
      await runArena(arena, ability, { startTurn: false });
      return arena.goblin.gauge('hp').current;
    };
    // Same seed, same roll — twice.
    expect(await outcome('chance-a')).toBe(await outcome('chance-a'));
  });

  it('lowers a chance alongside the rewrite', () => {
    const result = compileDocument('Buff M\nOutgoing damage has a 25% chance to be multiplied by 3.');
    expect(result.ir.buffs[0]!.modifiers![0]!).toMatchObject({
      match: { direction: 'outgoing', change: 'damage' },
      rewrite: { kind: 'amount', op: 'multiply', by: { kind: 'const', value: 3 } },
      chance: { kind: 'const', value: 25 },
    });
  });

  it('rejects a modifier outside a Buff', () => {
    const diags = errors('Ability A\nOutgoing damage is increased by 5.');
    expect(diags[0]!.code).toBe('modifier-outside-buff');
    expect(diags[0]!.message).toContain('Buff <name>');
  });

  it('names what it expected', () => {
    expect(errors('Buff M\nOutgoing by 5.')[0]!.message).toContain('"damage" or "healing"');
    expect(errors('Buff M\nOutgoing damage increased by 5.')[0]!.message).toContain('expected "is"');
    expect(errors('Buff M\nOutgoing damage is increased 5.')[0]!.message).toContain('expected "by"');
    expect(errors('Buff M\nOutgoing damage is capped by 5.')[0]!.message).toContain('expected "at"');
    expect(errors('Buff M\nIncoming mana by 5.')[0]!.message).toContain('expected "gain" or "loss"');
    expect(errors('Buff M\nIncoming stamina loss is prevented.')[0]!.message).toContain(
      '"damage" or "healing"',
    );
  });
});

describe('a formula wherever a number is expected', () => {
  it('Deal accepts a formula in place of a literal', async () => {
    const result = compileDocument('Ability Strike\nDeal (2 * 3) damage to target enemy character.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const arena = buildArena(ability);
    await runArena(arena, ability, { startTurn: false });
    expect(arena.goblin.gauge('hp').current).toBe(40 - 6);
  });

  it('a formula can read the caster\'s own gauge via `this`', async () => {
    const result = compileDocument('Ability Strike\nDeal (this.hp / 10) damage to target enemy character.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const arena = buildArena(ability); // hero hp 100 -> 10 damage
    await runArena(arena, ability, { startTurn: false });
    expect(arena.goblin.gauge('hp').current).toBe(40 - 10);
  });

  it('Heal accepts a formula in both word orders', async () => {
    const forOrder = compileDocument(
      'Ability Mend\nHeal target ally character for (2 + 3).',
    );
    const toOrder = compileDocument(
      'Ability Mend\nHeal (2 + 3) to target ally character.',
    );
    for (const result of [forOrder, toOrder]) {
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const ability = result.abilities[0]!;
      const arena = buildArena(ability);
      // "ally" includes the user, so either the Hero or Paladin may be
      // picked — set both to 50 and check whichever one actually was.
      arena.hero.gauge('hp').current = 50;
      arena.ally.gauge('hp').current = 50;
      const run = await runArena(arena, ability, { startTurn: false });
      expect((run.picked as typeof arena.ally).gauge('hp').current).toBe(55);
    }
  });

  it('a modifier rewrite amount accepts a formula, matching the equivalent literal', async () => {
    const formula = compileDocument(`
      Buff M
      Incoming damage is reduced by (1 + 2).

      Ability Strike
      Deal 10 damage to target enemy character.
    `);
    const literal = compileDocument(`
      Buff M
      Incoming damage is reduced by 3.

      Ability Strike
      Deal 10 damage to target enemy character.
    `);
    for (const result of [formula, literal]) {
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    }
    const run = async (doc: typeof formula) => {
      const ability = doc.abilities[0]!;
      const arena = buildArena(ability);
      await arena.engine.addBuff(arena.goblin, doc.buffs[0]!);
      await runArena(arena, ability, { startTurn: false });
      return arena.goblin.gauge('hp').current;
    };
    expect(await run(formula)).toBe(await run(literal));
    expect(await run(formula)).toBe(40 - 7);
  });

  it('a chance accepts a formula', async () => {
    const result = compileDocument(`
      Buff M
      Outgoing damage has a (10 * 10)% chance to be multiplied by 3.

      Ability Strike
      Deal 10 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const arena = buildArena(ability);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await runArena(arena, ability, { startTurn: false });
    expect(arena.goblin.gauge('hp').current).toBe(40 - 30); // 100% chance, always applies
  });

  it('a `with` gauge comparison accepts a formula', async () => {
    const result = compileDocument(
      'Ability Cull\nDestroy all enemy characters with hp < (this.hp / 2).',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const arena = buildArena(ability); // hero hp 100 -> threshold 50
    arena.goblin.gauge('hp').current = 40; // below the threshold
    arena.bruiser.gauge('hp').current = 55; // above it
    await runArena(arena, ability, { startTurn: false });
    expect(arena.goblin.destroyed).toBe(true);
    expect(arena.bruiser.destroyed).toBe(false);
  });

  it('a formula ending in a path does not swallow the next sentence on the same line', () => {
    // The sentence-ending period right after `this.hp` must not be read as
    // a property-access dot into whatever starts the next sentence.
    const result = compileDocument(
      'Buff M\nIncoming damage is reduced by this.hp. Outgoing damage is doubled.',
    );
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.buffs[0]!.abilities).toHaveLength(2);
  });

  it('reads a formula back in the generated name', () => {
    const result = compileDocument('Buff M\nIncoming damage is reduced by (1 + 2).');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.buffs[0]!.abilities?.[0]!.name).toContain('reduced by (1 + 2)');
  });

  it('lowers a literal to `const` and a formula to `expr`', () => {
    const result = compileDocument('Buff M\nIncoming damage is reduced by (1 + 2).');
    expect(result.ir.buffs[0]!.modifiers![0]!.rewrite).toEqual({
      kind: 'amount',
      op: 'subtract',
      by: { kind: 'expr', expression: { kind: 'binary', op: '+', left: { kind: 'number', value: 1 }, right: { kind: 'number', value: 2 } } },
    });
  });

  it('reports a malformed formula instead of a confusing downstream error', () => {
    const diags = errors('Ability Strike\nDeal (2 + damage to target enemy character.');
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0]!.severity).toBe('error');
  });
});

describe('redirect', () => {
  /** Same buff as `redirectGauge((t) => t.gauge('hp'), (t) => t.gauge('mana'), …)`, hand-written. */
  const handWrittenManaShield = buff({
    name: 'Mana Shield',
    weight: 1,
    abilities: [
      passiveActionModifier({
        name: 'Mana Shield',
        transform: redirectGauge((t) => t.gauge('hp'), (t) => t.gauge('mana'), {
          direction: 'incoming',
          intent: 'damage',
        }),
      }),
    ],
  });

  it('matches the hand-written `redirectGauge` buff exactly', async () => {
    const result = compileDocument(`
      Buff Mana Shield
      Incoming damage is redirected to mana.

      Ability Strike
      Deal 10 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = result.abilities[0]!;
    const run = async (def: BuffDef): Promise<[number, number]> => {
      const arena = buildArena(ability);
      await arena.engine.addBuff(arena.hero, def);
      await arena.engine.damage(arena.hero.gauge('hp'), 10, arena.goblin);
      return [arena.hero.gauge('hp').current, arena.hero.gauge('mana').current];
    };
    expect(await run(result.buffs[0]!)).toEqual(await run(handWrittenManaShield));
    expect(await run(result.buffs[0]!)).toEqual([100, 30]); // hp untouched, mana 40 -> 30
  });

  it('a named gauge narrows which loss redirects', async () => {
    const result = compileDocument(`
      Buff M
      Incoming mana loss is redirected to hp.

      Ability Noop
      Deal 1 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await arena.engine.damage(arena.hero.gauge('mana'), 10, arena.goblin); // redirected: hp loses 10 instead
    expect(arena.hero.gauge('hp').current).toBe(90);
    expect(arena.hero.gauge('mana').current).toBe(40);
    await arena.engine.damage(arena.hero.gauge('hp'), 5, arena.goblin); // not redirected: ordinary hp loss
    expect(arena.hero.gauge('hp').current).toBe(85);
  });

  it('redirecting a gauge to itself is a no-op', async () => {
    const result = compileDocument(`
      Buff M
      Incoming hp loss is redirected to hp.

      Ability Noop
      Deal 1 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await arena.engine.damage(arena.hero.gauge('hp'), 10, arena.goblin);
    expect(arena.hero.gauge('hp').current).toBe(90);
  });

  it('is a no-op when the character has no such gauge', async () => {
    const noMana = new Character('NoMana', { gauges: [{ id: 'hp', max: 40 }] });
    const engine = new GameEngine({ seed: 'redirect-no-gauge' });
    const you = new (class extends Player {
      async decide(): Promise<Decision[]> {
        return [];
      }
    })('You', [noMana], 'party');
    engine.registerPlayers([you]);
    const result = compileDocument('Buff M\nIncoming damage is redirected to mana.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    await engine.addBuff(noMana, result.buffs[0]!);
    await engine.damage(noMana.gauge('hp'), 10);
    expect(noMana.gauge('hp').current).toBe(30); // ordinary damage — nowhere to redirect to
  });

  it('lowers to a `redirect` rewrite', () => {
    const result = compileDocument('Buff M\nIncoming damage is redirected to mana.');
    expect(result.ir.buffs[0]!.modifiers).toEqual([
      {
        id: 'm-modifier-0',
        name: 'M Incoming damage is redirected to mana',
        match: { direction: 'incoming', change: 'damage', gauge: { kind: 'life' } },
        rewrite: { kind: 'redirect', gauge: 'mana' },
      },
    ]);
  });

  it('reads back as English', () => {
    const result = compileDocument('Buff M\nIncoming damage is redirected to mana.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.buffs[0]!.abilities?.[0]!.name).toContain('redirected to mana');
  });

  it('names what it expected', () => {
    expect(errors('Buff M\nIncoming damage is redirected 50.')[0]!.message).toContain('expected "to"');
    expect(errors('Buff M\nIncoming damage is redirected to stamina.')[0]!.message).toContain(
      'expected a gauge',
    );
  });
});

describe('`damage` is the life gauge, not every gauge', () => {
  /** A one-character board, so a gauge can be written without an ability. */
  function solo(character: Character) {
    const engine = new GameEngine({ seed: 'life-gauge' });
    const you = new (class extends Player {
      async decide(): Promise<Decision[]> {
        return [];
      }
    })('You', [character], 'party');
    engine.registerPlayers([you]);
    return engine;
  }

  it('a bare `damage` modifier does not touch a loss on another gauge', async () => {
    const result = compileDocument(`
      Buff Ward
      Incoming damage is reduced by 3.

      Ability Noop
      Deal 1 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    await arena.engine.addBuff(arena.hero, result.buffs[0]!);
    await arena.engine.damage(arena.hero.gauge('mana'), 10, arena.goblin);
    expect(arena.hero.gauge('mana').current).toBe(30); // full 10 — mana is not "damage"
    await arena.engine.damage(arena.hero.gauge('hp'), 10, arena.goblin);
    expect(arena.hero.gauge('hp').current).toBe(93); // reduced by 3 — hp is this character's life
  });

  it('follows a life gauge that is not hp', async () => {
    // This character declares `stamina` as its life and has no hp gauge at
    // all — standing in for anything whose life is somewhere else (a card
    // game's planeswalker and its `loyalty`). The same word, "damage",
    // claims stamina here, with the sentence naming neither gauge.
    const dancer = new Character('Dancer', {
      gauges: [{ id: 'stamina', max: 20 }, { id: 'mana', max: 10 }],
      lifeGauge: 'stamina',
    });
    const engine = solo(dancer);
    const result = compileDocument('Buff Ward\nIncoming damage is reduced by 3.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    await engine.addBuff(dancer, result.buffs[0]!);
    await engine.damage(dancer.gauge('stamina'), 10);
    expect(dancer.gauge('stamina').current).toBe(13); // 20 - (10 - 3)
    await engine.damage(dancer.gauge('mana'), 10);
    expect(dancer.gauge('mana').current).toBe(0); // untouched by a damage modifier
  });

  it('claims nothing on a character that declares no life gauge', async () => {
    const thing = new Character('Thing', { gauges: [{ id: 'charges', max: 20 }] });
    expect(thing.lifeGauge).toBeUndefined();
    const engine = solo(thing);
    const result = compileDocument('Buff Ward\nIncoming damage is prevented.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    await engine.addBuff(thing, result.buffs[0]!);
    await engine.damage(thing.gauge('charges'), 10);
    expect(thing.gauge('charges').current).toBe(10); // not prevented — nothing is its life
  });

  it('`Deal … damage` moves the life gauge, not a hard-coded hp', async () => {
    // `Deal 5 damage` used to write a literal 'hp', so anything whose
    // declared life gauge is not hp took nothing at all — a silent no-op,
    // while the modifier side was meanwhile claiming that thing's real
    // life gauge. The Dancer below declares `stamina` and has no hp.
    const doc = compileDocument('Ability Hit\nDeal 5 damage to this.');
    expect(doc.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = doc.abilities[0]!;
    const dancer = new Character('Dancer', {
      gauges: [{ id: 'stamina', max: 20 }],
      lifeGauge: 'stamina',
      skills: [skill({ name: 'Kit', weight: 1, abilities: [ability] })],
    });
    const engine = solo(dancer);
    await engine.useAbility(dancer, ability, { targets: [dancer] });
    expect(dancer.gauge('stamina').current).toBe(15);
  });

  it('`Heal … for n` moves the life gauge too', async () => {
    const doc = compileDocument('Ability Mend\nHeal this for 4.');
    expect(doc.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ability = doc.abilities[0]!;
    const dancer = new Character('Dancer', {
      gauges: [{ id: 'stamina', max: 20, current: 10 }],
      lifeGauge: 'stamina',
      skills: [skill({ name: 'Kit', weight: 1, abilities: [ability] })],
    });
    const engine = solo(dancer);
    await engine.useAbility(dancer, ability, { targets: [dancer] });
    expect(dancer.gauge('stamina').current).toBe(14);
  });

  it('`when this takes damage` watches the life gauge', async () => {
    // The third site that meant 'hp': the trigger's event filter. Thorns
    // never fired at all on a character whose life gauge is not hp.
    const doc = compileDocument(
      'Buff Thorns\nwhen this takes damage then deal 3 damage to the source character.',
    );
    expect(doc.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const dancer = new Character('Dancer', {
      gauges: [{ id: 'stamina', max: 20 }],
      lifeGauge: 'stamina',
    });
    const foe = new Character('Foe', { maxHp: 50 });
    const engine = new GameEngine({ seed: 'life-trigger' });
    const idle = class extends Player {
      async decide(): Promise<Decision[]> {
        return [];
      }
    };
    engine.registerPlayers([new idle('You', [dancer], 'party'), new idle('Them', [foe], 'foes')]);
    await engine.addBuff(dancer, doc.buffs[0]!);
    await engine.damage(dancer.gauge('stamina'), 5, foe);
    expect(dancer.gauge('stamina').current).toBe(15);
    expect(foe.gauge('hp').current).toBe(47); // thorns fired: 50 - 3
  });

  it('a later `damage` modifier no longer follows a redirected action', async () => {
    // The whole point of the narrowing: once an action is redirected onto
    // mana, it is a mana loss, not damage — so a generic damage modifier
    // sitting later in the chain has nothing to claim.
    const result = compileDocument(`
      Buff A
      Incoming damage is increased by 5.

      Buff B
      Incoming hp loss is redirected to mana.

      Buff C
      Incoming damage is increased by 3.

      Ability Noop
      Deal 1 damage to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const arena = buildArena(result.abilities[0]!);
    for (const def of result.buffs) await arena.engine.addBuff(arena.hero, def);
    await arena.engine.damage(arena.hero.gauge('hp'), 10, arena.goblin);
    expect(arena.hero.gauge('hp').current).toBe(100); // all of it moved to mana
    expect(arena.hero.gauge('mana').current).toBe(25); // 40 - (10 + 5), C never applied
  });
});

describe('takes damage, and the source', () => {
  it('matches the hand-written TypeScript Thorns exactly', async () => {
    // src/examples/08-27-2026/buffs/thorns/index.ts is the same buff as an
    // `auto` closure that narrows `'source' in ctx.event`, checks
    // `wasTakenBy`, and excludes self-inflicted damage. Same ability, same
    // board, both buffs: the results must agree.
    const doc = compileDocument(`
      Buff Thorns (weight 2)
      when this takes damage then deal 8 damage to the source character.

      Ability Strike
      Deal 10 damage to target enemy character.
    `);
    expect(doc.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const strike = doc.abilities.find((a) => a.name === 'Strike')!;

    const run = async (def: BuffDef): Promise<[number, number]> => {
      const arena = buildArena(strike);
      // Thorns on the victim, so striking it retaliates at the Hero.
      await arena.engine.addBuff(arena.goblin, def);
      await runArena(arena, strike, { startTurn: false });
      return [arena.goblin.gauge('hp').current, arena.hero.gauge('hp').current];
    };
    expect(await run(doc.buffs[0]!)).toEqual(await run(handWrittenThorns));
    expect(await run(doc.buffs[0]!)).toEqual([30, 92]);
  });

  it('lowers to a gauge event with a direction, since damage is not its own event', () => {
    const result = compileDocument('Buff T\nwhen this takes damage then deal 8 damage to the source character.');
    const ir = result.ir.buffs[0]!.triggers[0]!;
    expect(ir.event).toBe('gauge:changed');
    // "takes damage" watches the triggering entity's life gauge, resolved
    // per event — not a hard-coded 'hp'.
    expect(ir.gauge).toEqual({ kind: 'life' });
    expect(ir.change).toBe('damage');
    expect(ir.steps[0]!.effects[0]).toEqual({
      kind: 'gauge',
      query: { kind: 'event', role: 'source', sourceType: 'character' },
      gauge: { kind: 'life' },
      op: 'subtract',
      amount: { kind: 'const', value: 8 },
    });
  });

  it('ignores healing, and the other gauges', async () => {
    const doc = compileDocument(`
      Buff Thorns
      when this takes damage then deal 8 damage to the source character.

      Ability Mend
      Heal all other ally characters for 10.
    `);
    const mend = doc.abilities.find((a) => a.name === 'Mend')!;
    const arena = buildArena(mend);
    arena.ally.gauge('hp').current = 50;
    await arena.engine.addBuff(arena.ally, doc.buffs[0]!);
    await runArena(arena, mend, { startTurn: false });
    expect(arena.ally.gauge('hp').current).toBe(60);
    expect(arena.hero.gauge('hp').current).toBe(100); // healing is not damage
  });

  it('a self-inflicted cost has no source to retaliate against', async () => {
    const doc = compileDocument(`
      Buff Thorns
      when this takes damage then deal 8 damage to the source character.

      Ability Sacrifice
      Deal 10 damage to this.
    `);
    const sacrifice = doc.abilities.find((a) => a.name === 'Sacrifice')!;
    const arena = buildArena(sacrifice);
    await arena.engine.addBuff(arena.hero, doc.buffs[0]!);
    await runArena(arena, sacrifice, { startTurn: false });
    // The cost landed; nothing retaliated, because the only candidate was
    // the owner itself.
    expect(arena.hero.gauge('hp').current).toBe(90);
  });

  it('"is healed" is the other direction', () => {
    const result = compileDocument('Buff T\nwhen this is healed then deal 1 damage to the source character.');
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.ir.buffs[0]!.triggers[0]!.change).toBe('heal');
  });

  it('reads back as English', () => {
    const result = compileDocument('Buff T\nwhen this takes damage then deal 8 damage to the source character.');
    expect(result.ir.buffs[0]!.triggers[0]!.name).toBe(
      'When this takes damage, deal 8 damage to the source character.',
    );
  });

  it('requires the kind, since an event\'s cause may be a character or a buff', () => {
    const diags = errors('Buff T\nwhen this takes damage then deal 8 damage to the source.');
    expect(diags[0]!.code).toBe('source-kind');
    expect(diags[0]!.message).toContain('"the source character"');
  });

  it('names the player case as not yet possible', () => {
    const diags = errors('Buff T\nwhen this takes damage then deal 8 damage to the source player.');
    expect(diags[0]!.code).toBe('future-feature');
    expect(diags[0]!.message).toContain('characters and buffs');
  });

  it('a buff-sourced trigger answers buffs, not characters', async () => {
    // Poison's tick is sourced to the buff, so a card that answers
    // characters does not see it — which is exactly what writing the kind
    // makes visible.
    const result = compileDocument(`
      Buff Thorns
      when this takes damage then deal 8 damage to the source character.

      Buff Poison
      When the turn starts, deal 3 damage to this.

      Ability Afflict
      Add Poison to target enemy character.
    `);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const afflict = result.abilities[0]!;
    const arena = buildArena(afflict);
    const thornsDef = result.buffs.find((b) => b.name === 'Thorns')!;
    await arena.engine.addBuff(arena.goblin, thornsDef);
    await runArena(arena, afflict); // poison lands, turn starts, it ticks
    // The goblin took poison damage, and nothing retaliated: the cause was
    // a buff, and this Thorns answers characters.
    expect(arena.goblin.gauge('hp').current).toBeLessThan(40);
    expect(arena.hero.gauge('hp').current).toBe(100);
  });
});