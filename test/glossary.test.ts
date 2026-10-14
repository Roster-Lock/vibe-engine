/**
 * Tests for the **glossary** — terms, their definitions, and finding terms in
 * text (`src/english/glossary.ts`).
 *
 * These are the headless half of the "click a word you don't understand"
 * feature. The React layer (`src/ui/glossary/`) only *renders* what this module
 * resolves, so the interesting claims live here:
 *
 * - a term resolves to a definition from every source (words, card words,
 *   keywords, buffs, zones, permanents);
 * - a richer definition wins the same word, whichever order sources are built;
 * - `annotate` finds the terms in a run of text — longest match, word
 *   boundaries, no overlaps — which is what makes card rules text clickable;
 * - a caller's own `givens` beat the scanner, which is how a token created by
 *   an effect shows the stat block of the thing it named.
 */
import { describe, expect, it } from 'vitest';
import { Character, buff } from '../src/engine/index.js';
import { BuffDictionary } from '../src/english/dictionary.js';
import {
  Glossary,
  KeywordRegistry,
  defaultKeywords,
  languageGlossary,
  termKey,
  type Glyph,
  type PermanentDef,
  type Term,
} from '../src/english/glossary.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import { compileCardDocument } from '../src/english/index.js';

const rage = buff({ name: 'Rage', description: '+3 power', weight: 5, stacks: true });

const buffs = new BuffDictionary([{ name: 'Rage', def: rage }]);

const mountainGoblins: PermanentDef = {
  name: 'Mountain Goblins',
  summary: 'Small, angry, and numerous.',
  abilities: ['Rush'],
  make: () =>
    new Character('Mountain Goblins', {
      gauges: [{ id: 'hp', max: 2 }],
      stats: { power: 2 },
    }),
};

function glossary(overrides: Partial<ConstructorParameters<typeof Glossary>[0]> = {}): Glossary {
  return new Glossary({
    keywords: defaultKeywords(),
    buffs,
    zones: new ZoneDictionary(['deck', 'hand']),
    characters: [mountainGoblins],
    ...overrides,
  });
}

/** The names found in a text, in order — the useful shape for assertions. */
function found(g: Glossary, text: string, givens: readonly Glyph[] = []): string[] {
  return g.annotate(text, undefined, givens).spans.map((span) => span.name);
}

/** The text of each span, so a mismatch names the wrong word, not just a count. */
function hits(g: Glossary, text: string): string[] {
  return g.annotate(text).spans.map((span) => text.slice(span.start, span.end));
}

describe('the glossary — resolving a term', () => {
  it('resolves a vocabulary word', () => {
    const term = glossary().resolveText('owned');
    expect(term?.ref.kind).toBe('word');
    expect(term?.summary).toContain('owned by');
  });

  it('resolves a keyword and prefers it over the plain word', () => {
    // `taunt` is both a registered keyword and (via the card words) a word.
    const term = glossary().resolveText('taunt');
    expect(term?.ref.kind).toBe('keyword');
    expect(term?.ref.name).toBe('Taunt');
    expect(term?.summary).toContain('Enemies must attack this creature before its allies.');
  });

  it('resolves a buff, with its weight as a fact', () => {
    const term = glossary().resolveText('rage');
    expect(term?.ref.kind).toBe('buff');
    expect(term?.summary).toBe('+3 power');
    expect(term?.facts).toContainEqual({ label: 'Stacks', value: 'yes' });
  });

  it('resolves a zone the game declared, and the engine’s own zones', () => {
    expect(glossary().resolveText('deck')?.ref.kind).toBe('zone');
    expect(glossary().resolveText('garbage')?.summary).toContain('garbage');
  });

  it('resolves a permanent, reading its stat block from a fresh instance', () => {
    const term = glossary().resolveText('Mountain Goblins');
    expect(term?.ref.kind).toBe('character');
    expect(term?.facts).toContainEqual({ label: 'HP', value: '2' });
    expect(term?.facts).toContainEqual({ label: 'Power', value: '2' });
    expect(term?.details).toContain('Rush');
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    const g = glossary();
    expect(g.resolveText('RAGE')?.ref.name).toBe('Rage');
    expect(g.resolveText('  Rage  ')?.ref.name).toBe('Rage');
    expect(new Set([termKey(' Mountain   Goblins ')])).toEqual(new Set(['mountain goblins']));
  });

  it('answers `has` for a word it can define and not for one it cannot', () => {
    const g = glossary();
    expect(g.has('target')).toBe(true);
    expect(g.has('flibbertigibbet')).toBe(false);
  });
});

describe('the glossary — defining a reference', () => {
  it('resolves a permanent reference through the catalog', () => {
    const term = glossary().define({ kind: 'permanent', name: 'Mountain Goblins' });
    expect(term?.facts).toContainEqual({ label: 'HP', value: '2' });
  });

  it('falls back to the name-keyed definition when the kind was guessed wrong', () => {
    // A caller that said "permanent" about a buff should still be told what
    // Rage is rather than nothing.
    const term = glossary().define({ kind: 'permanent', name: 'Rage' });
    expect(term?.ref.kind).toBe('buff');
    expect(term?.summary).toBe('+3 power');
  });

  it('lets the host’s define hook have the last word — live state goes here', () => {
    const g = glossary({
      define: (ref, _scope, base) =>
        ref.kind === 'character' || ref.kind === 'permanent'
          ? { ...(base ?? { ref, glyph: ref.name, summary: '' }), summary: '3/3 right now' }
          : undefined,
    });
    expect(g.define({ kind: 'permanent', name: 'Mountain Goblins' })?.summary).toBe('3/3 right now');
    // A word is untouched by the hook.
    expect(g.resolveText('target')?.summary).toContain('picks one character');
  });

  it('accepts a custom source for content the built-ins do not know', () => {
    const g = glossary({
      sources: [
        {
          name: 'keyword',
          terms: { discover: { summary: 'Look at the top card until you find one worth playing.' } },
        },
      ],
    });
    expect(g.resolveText('discover')?.summary).toContain('top card');
  });
});

describe('the glossary — a newly registered keyword', () => {
  it('is explained the moment it is registered', () => {
    const keywords = defaultKeywords().add({
      name: 'Discover',
      summary: 'Reveal cards until you find one you can afford, then take it.',
      details: '**Discover <n>** — reveal from the top of your library …',
      handled: false,
    });
    const g = glossary({ keywords });
    const term = g.resolveText('discover');
    expect(term?.ref.kind).toBe('keyword');
    expect(term?.summary).toContain('Reveal cards');
    expect(term?.facts).toContainEqual({ label: 'Keyword', value: 'named only' });
  });

  it('matches a bare keyword as a whole word only', () => {
    const keywords = defaultKeywords().add({ name: 'Discover', summary: '…' });
    const bare = keywords.matchAtStart('Taunt.');
    expect(bare?.def.name).toBe('Taunt');
    expect(bare?.parenthesised).toBe(false);
    expect(bare?.trailing).toBe('.');
    // `Discovery` is a different word and must not match `Discover`.
    expect(keywords.matchAtStart('Discovery')).toBeUndefined();
  });

  it('reads arguments out of parentheses, split on commas', () => {
    const keywords = defaultKeywords().add({ name: 'Discover', summary: '…', arity: [1, 2] });
    const one = keywords.matchAtStart('Discover(2).');
    expect(one?.def.name).toBe('Discover');
    expect(one?.args).toEqual(['2']);
    expect(one?.parenthesised).toBe(true);
    expect(one?.trailing).toBe('.');

    const two = keywords.matchAtStart('Discover(2, land)');
    expect(two?.args).toEqual(['2', 'land']);
  });

  it('points the argument span at the author’s text', () => {
    const keywords = defaultKeywords().add({ name: 'Discover', summary: '…', arity: [1, 1] });
    const line = 'Discover(2).';
    const invocation = keywords.matchAtStart(line)!;
    expect(line.slice(invocation.argsSpan.start, invocation.argsSpan.end)).toBe('2');
    // With the line indented, the span must move with it rather than drifting.
    const indented = '    Discover(2).';
    const shifted = keywords.matchAtStart(indented.slice(4), 4)!;
    expect(indented.slice(shifted.argsSpan.start, shifted.argsSpan.end)).toBe('2');
  });

  it('reports an unclosed paren instead of silently reading a bare keyword', () => {
    const keywords = defaultKeywords().add({ name: 'Discover', summary: '…', arity: [1, 1] });
    const invocation = keywords.matchAtStart('Discover(2')!;
    expect(invocation.unterminated).toBe(true);
    expect(invocation.args).toEqual([]);
  });

  it('accepts whitespace inside the parentheses', () => {
    const keywords = defaultKeywords().add({ name: 'Discover', summary: '…', arity: [1, 1] });
    expect(keywords.matchAtStart('Discover( 2 ).')?.args).toEqual(['2']);
  });

  it('prefers the longer registered spelling', () => {
    const keywords = defaultKeywords()
      .add({ name: 'Discover', summary: 'short' })
      .add({ name: 'Discover Twice', summary: 'long' });
    expect(keywords.matchAtStart('Discover Twice')?.def.name).toBe('Discover Twice');
    expect(keywords.matchAtStart('Discover(2)')?.def.name).toBe('Discover');
  });
});

describe('the glossary — finding terms in text', () => {
  it('annotates a card’s rules text, keyword included', () => {
    const compiled = compileCardDocument(
      ['Card Shieldbearer', 'Cost 2', 'Creature 1/4', 'Taunt.'].join('\n'),
    );
    const card = compiled.cards[0]!;
    const marked = glossary().annotate(card.rulesText);
    const keywordSpan = marked.spans.find((span) => span.kind === 'keyword');
    expect(keywordSpan?.name).toBe('Taunt');
    expect(card.rulesText.slice(keywordSpan!.start, keywordSpan!.end)).toBe('Taunt');
  });

  it('finds several terms in one sentence, in order', () => {
    const names = found(
      glossary(),
      'Deal 1 damage to target enemy character.',
    );
    expect(names).toEqual(['deal', 'target', 'enemy', 'character']);
  });

  it('prefers the longest match — a multi-word name is not its last word', () => {
    const dictionary = new BuffDictionary([
      { name: 'Rage', def: rage },
      { name: 'Rage of the Ancients', def: buff({ name: 'Rage of the Ancients', weight: 1 }) },
    ]);
    const marked = glossary({ buffs: dictionary }).annotate('Add Rage of the Ancients to this character.');
    expect(marked.spans.map((span) => span.name)).toContain('Rage of the Ancients');
    expect(marked.spans.map((span) => span.name)).not.toContain('Rage');
  });

  it('respects word boundaries', () => {
    // `hp` sits inside `hpmax` and must not be found there.
    expect(hits(glossary(), 'hpmax')).toEqual([]);
    expect(hits(glossary(), 'hp is 3')).toEqual(['hp']);
  });

  it('stays quiet about function words, but still resolves them', () => {
    const g = glossary();
    expect(hits(g, 'the to and')).toEqual([]);
    expect(g.resolveText('the')?.summary).toContain('the game');
    // A scan that wants them anyway can ask.
    const loud = glossary({ scanAll: true });
    expect(hits(loud, 'the to and')).toEqual(['the', 'to', 'and']);
  });

  it('claims each range once — no overlapping spans', () => {
    const marked = glossary().annotate('target enemy character and target enemy character');
    const ranges = marked.spans.map((span) => [span.start, span.end] as const);
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i]![0]).toBeGreaterThanOrEqual(ranges[i - 1]![1]);
    }
  });

  it('finds a multi-word buff name', () => {
    const dictionary = new BuffDictionary([
      { name: 'Toxic Tentacles', def: buff({ name: 'Toxic Tentacles', weight: 1 }) },
    ]);
    expect(found(glossary({ buffs: dictionary }), 'Add Toxic Tentacles to this character.')).toContain(
      'Toxic Tentacles',
    );
  });

  it('lets a caller’s given span beat the scanner — a token’s own definition', () => {
    const text = 'create 3 Mountain Goblins';
    const start = text.indexOf('Mountain Goblins');
    const givens: Glyph[] = [
      { start, end: start + 'Mountain Goblins'.length, ref: { kind: 'permanent', name: 'Mountain Goblins' } },
    ];
    const marked = glossary().annotate(text, undefined, givens);
    const span = marked.spans.find((s) => s.name === 'Mountain Goblins');
    expect(span?.kind).toBe('permanent');
    expect(span?.term.facts).toContainEqual({ label: 'HP', value: '2' });
  });

  it('skips a given span whose reference cannot be resolved', () => {
    const text = 'create 3 Nothing In Particular';
    const marked = glossary().annotate(text, undefined, [
      { start: 9, end: 29, ref: { kind: 'permanent', name: 'Nothing In Particular' } },
    ]);
    expect(marked.spans.some((span) => span.name === 'Nothing In Particular')).toBe(false);
  });

  it('ignores a given span that falls outside the text', () => {
    const marked = glossary().annotate('deal 1 damage', undefined, [
      { start: 900, end: 999, ref: { kind: 'permanent', name: 'Mountain Goblins' } },
    ]);
    expect(marked.spans.every((span) => span.end <= 'deal 1 damage'.length)).toBe(true);
  });

  it('annotates plain text as no terms at all', () => {
    expect(found(glossary(), 'once upon a time')).toEqual([]);
  });

  it('is total — every span is a slice of the text that was passed', () => {
    const text = 'When this takes damage then Deal 2 damage to all enemy characters.';
    const marked = glossary().annotate(text);
    for (const span of marked.spans) {
      expect(text.slice(span.start, span.end).length).toBeGreaterThan(0);
      expect(span.end).toBeLessThanOrEqual(text.length);
    }
  });
});

describe('the glossary — sources and precedence', () => {
  it('a later custom source wins the same word', () => {
    const g = glossary({
      sources: [{ name: 'rule', terms: { rage: { summary: 'a rule called rage' } } }],
    });
    expect(g.resolveText('rage')?.summary).toBe('a rule called rage');
  });

  it('falls back to the word source when no richer source defines a word', () => {
    const sparse = new Glossary({ words: { word: 'A word.' } });
    expect(sparse.resolveText('word')?.summary).toBe('A word.');
    // Nothing else is known, because nothing else was supplied.
    expect(sparse.resolveText('target')).toBeUndefined();
  });

  it('ships a default glossary with keywords but no host content', () => {
    const g = languageGlossary();
    expect(g.resolveText('taunt')?.ref.kind).toBe('keyword');
    expect(g.resolveText('Rage')).toBeUndefined();
  });

  it('lists its vocabulary, longest first', () => {
    const vocabulary = glossary().vocabulary;
    expect(vocabulary).toContain('rage');
    expect(vocabulary).toContain('mountain goblins');
    expect(vocabulary.indexOf('mountain goblins')).toBeLessThan(vocabulary.indexOf('target'));
  });

  it('is stable: two builds of the same sources agree', () => {
    const first = glossary().annotate('Deal 1 damage to target enemy character.');
    const second = glossary().annotate('Deal 1 damage to target enemy character.');
    expect(first.spans.map((s: { name: string }) => s.name)).toEqual(
      second.spans.map((s: { name: string }) => s.name),
    );
  });
});

describe('the glossary — the definition a surface needs', () => {
  it('every term has a summary, because that is the hover', () => {
    const g = glossary();
    for (const word of ['taunt', 'rage', 'deck', 'target', 'Mountain Goblins']) {
      const term = g.resolveText(word);
      expect(term, `no term for ${word}`).toBeDefined();
      expect(term!.summary.length).toBeGreaterThan(0);
    }
  });

  it('a term with details is richer than its summary', () => {
    const term = glossary().resolveText('Rage');
    expect(term?.details?.length ?? 0).toBeGreaterThan(term?.summary.length ?? 0);
  });

  it('carries the canonical name even when the text spelled it differently', () => {
    const marked = glossary().annotate('RAGE');
    expect(marked.spans[0]?.name).toBe('Rage');
    const term: Term | undefined = marked.spans[0]?.term;
    expect(term?.glyph).toBe('RAGE');
  });
});
