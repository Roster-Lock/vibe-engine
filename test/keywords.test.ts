/**
 * Tests for **registered keywords** — the seam a host uses to add a gameplay
 * keyword like Discover (`src/english/glossary.ts`, wired into
 * `src/english/card.ts`).
 *
 * The claim this file holds to account is that a keyword is registered **once**
 * and then exists everywhere at the same time: it compiles as a card line, it
 * completes in the editor, and it is explained on hover. Before this, `Taunt`
 * was known in five unconnected places and a new keyword had to be found in all
 * of them.
 *
 * The other half is the deliberate seam for a keyword that is **named but not
 * yet executable**: a document may use it, it is printed on the card, it is
 * explained — and it cannot silently masquerade as a keyword the game runs.
 */
import { describe, expect, it } from 'vitest';
import {
  compileCardDocument,
  completeCardAt,
  cardWordDoc,
} from '../src/english/card.js';
import {
  BUILTIN_KEYWORDS,
  Glossary,
  KeywordRegistry,
  defaultKeywords,
} from '../src/english/glossary.js';
import type { Diagnostic } from '../src/english/ast.js';

/**
 * A Discover keyword as a host registers it **before** the engine can run it:
 * named, explained, accepts its `2`, and executes nothing. `handled: false` is
 * what stops the card layer from granting a keyword it cannot honour.
 */
function discoverRegistry(handled = false): KeywordRegistry {
  return defaultKeywords().add({
    name: 'Discover',
    summary: 'Reveal cards from the top of your library until you find one you can afford.',
    details: '**Discover <n>** — reveal from the top of your library until you reveal a card with cost n or less, put it into play, and put the rest on the bottom in a random order.',
    cardKinds: ['creature', 'spell'],
    handled,
    // One argument: the cost ceiling. Declared so a wrong count is a diagnostic
    // rather than a silent no-op.
    arity: [1, 1],
    // No real `parse` yet: the behaviour's English sentence lands with the
    // parser work. An empty parse is the honest placeholder — it reads its
    // argument and means nothing by it, rather than refusing a syntax the
    // keyword really has.
    parse: () => [],
  });
}

const errors = (diagnostics: readonly Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((d) => d.severity === 'error');

const codes = (diagnostics: readonly Diagnostic[]): string[] =>
  errors(diagnostics).map((d) => d.code ?? '');

const document = (lines: readonly string[]): string => lines.join('\n');

describe('registered keywords — compiling', () => {
  it('accepts a registered keyword as a legal card line', () => {
    const result = compileCardDocument(
      document(['Card Shieldbearer', 'Cost 2', 'Creature 1/4', 'Taunt.']),
      { keywords: defaultKeywords() },
    );
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.cards[0]?.keywords).toEqual(['taunt']);
  });

  it('accepts a keyword the game does not implement, and does not grant it', () => {
    const result = compileCardDocument(
      document(['Card Goblin Scout', 'Cost 2', 'Creature 2/2', 'Discover(2).']),
      { keywords: discoverRegistry() },
    );
    expect(errors(result.diagnostics)).toEqual([]);
    // Named, printed on the card, but not handed to the engine as a keyword.
    expect(result.cards[0]?.rulesText).toContain('Discover(2)');
    expect(result.cards[0]?.keywords).toEqual([]);
  });

  it('refuses arguments on a keyword that cannot read them yet', () => {
    const result = compileCardDocument(
      document(['Card Shieldbearer', 'Cost 2', 'Creature 1/4', 'Taunt(3).']),
      { keywords: defaultKeywords() },
    );
    expect(codes(result.diagnostics)).toContain('card-keyword-argument');
  });

  it('tells the author at the parens when a keyword’s argument count is wrong', () => {
    const result = compileCardDocument(
      document(['Card Goblin Scout', 'Cost 2', 'Creature 2/2', 'Discover().']),
      { keywords: discoverRegistry() },
    );
    const diagnostic = errors(result.diagnostics).find((d) => d.code === 'card-keyword-arity');
    expect(diagnostic?.message).toContain('takes 1 argument');
    // The span lands on the author's line, not on a synthetic one.
    expect(document(['Card Goblin Scout', 'Cost 2', 'Creature 2/2', 'Discover().']).slice(
      diagnostic!.start,
      diagnostic!.end,
    )).toContain('Discover');
  });

  it('refuses words after the parentheses — arguments go inside them', () => {
    const result = compileCardDocument(
      document(['Card Goblin Scout', 'Cost 2', 'Creature 2/2', 'Discover(2) and also 3.']),
      { keywords: discoverRegistry() },
    );
    expect(codes(result.diagnostics)).toContain('card-keyword-trailing');
  });

  it('rejects the old space-separated form with a hint, rather than two readings', () => {
    // `Discover 2.` used to be the spelling. Keeping it working *and* adding
    // `Discover(2)` would make the argument syntax ambiguous the first time a
    // keyword takes a word-shaped argument (`Discover land` — one argument, or
    // a keyword called `Discover land`?). So the old form is an error that says
    // where the argument belongs.
    const result = compileCardDocument(
      document(['Card Goblin Scout', 'Cost 2', 'Creature 2/2', 'Discover 2.']),
      { keywords: discoverRegistry() },
    );
    const diagnostic = errors(result.diagnostics).find((d) => d.code === 'card-keyword-trailing');
    expect(diagnostic?.message).toContain('parentheses');
  });

  it('reports an unclosed parenthesis instead of reading it as bare', () => {
    const result = compileCardDocument(
      document(['Card Goblin Scout', 'Cost 2', 'Creature 2/2', 'Discover(2']),
      { keywords: discoverRegistry() },
    );
    expect(codes(result.diagnostics)).toContain('card-keyword-unclosed');
  });

  it('reads a two-argument keyword, because arity is a range', () => {
    const keywords = defaultKeywords().add({
      name: 'Discover',
      summary: '…',
      arity: [1, 2],
      parse: () => [],
    });
    const result = compileCardDocument(
      document(['Card Goblin Scout', 'Cost 2', 'Creature 2/2', 'Discover(2, land).']),
      { keywords },
    );
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.cards[0]?.rulesText).toContain('Discover(2, land)');
  });

  it('keeps the keyword wording on the card face', () => {
    const result = compileCardDocument(
      document(['Card Shieldbearer', 'Cost 2', 'Creature 1/4', 'Taunt.']),
      { keywords: defaultKeywords() },
    );
    expect(result.cards[0]?.rulesText).toContain('Taunt.');
  });

  it('still rejects a card-shaped word that is not a known line', () => {
    const result = compileCardDocument(
      document(['Card Shieldbearer', 'Cost 2', 'Creature 1/4', 'Creature 2/3', 'Taunt.']),
      { keywords: defaultKeywords() },
    );
    const message = errors(result.diagnostics).map((d) => d.message).join('\n');
    expect(message).toContain('already says it is a creature');
  });

  it('says so when a keyword is written on the wrong card kind', () => {
    const result = compileCardDocument(
      document(['Card Fireball', 'Cost 4', 'Spell', 'Taunt.', 'Deal 6 damage to target enemy character.']),
      { keywords: defaultKeywords() },
    );
    expect(codes(result.diagnostics)).toContain('card-spell-keyword');
  });

  it('lets a keyword declare it works on spells', () => {
    const keywords = defaultKeywords().add({
      name: 'Cantrip',
      summary: 'A spell that replaces itself.',
      cardKinds: ['spell'],
    });
    const result = compileCardDocument(
      document(['Card Insight', 'Cost 1', 'Spell', 'Cantrip.', 'Heal 1 to target ally character.']),
      { keywords },
    );
    expect(codes(result.diagnostics)).not.toContain('card-spell-keyword');
  });

  it('keeps a host registration that replaces a built-in name', () => {
    const keywords = defaultKeywords().add({
      name: 'Taunt',
      summary: 'A house rule: taunting is different here.',
      handled: false,
    });
    const result = compileCardDocument(
      document(['Card Shieldbearer', 'Cost 2', 'Creature 1/4', 'Taunt.']),
      { keywords },
    );
    expect(errors(result.diagnostics)).toEqual([]);
  });
});

describe('registered keywords — completing', () => {
  it('offers a keyword with arguments as a template, so the parens are visible', () => {
    const source = document(['Card Goblin Scout', 'Cost 2', 'Creature 2/2', '']);
    const labels = completeCardAt(source, source.length, undefined, undefined, discoverRegistry()).map(
      (s) => s.label,
    );
    // Not `Discover.` — a keyword that takes an argument completes with the
    // parentheses, or the author writes a bare word and is then told off.
    expect(labels).toContain('Discover(…)');
  });

  it('offers a built-in keyword without a host registry', () => {
    const source = document(['Card X', 'Cost 1', 'Creature 1/1', '']);
    const suggestions = completeCardAt(source, source.length);
    expect(suggestions.map((s) => s.label)).toContain('Taunt.');
  });

  it('does not offer a creature-only keyword on a spell', () => {
    const source = document(['Card Fireball', 'Cost 4', 'Spell', '']);
    const labels = completeCardAt(source, source.length, undefined, undefined, defaultKeywords()).map(
      (s) => s.label,
    );
    expect(labels).not.toContain('Taunt.');
  });
});

describe('registered keywords — explaining', () => {
  it('explains the keyword the moment it is registered', () => {
    const g = new Glossary({ keywords: discoverRegistry() });
    const term = g.resolveText('discover');
    expect(term?.ref.kind).toBe('keyword');
    expect(term?.summary).toContain('Reveal cards from the top');
    expect(term?.details).toContain('cost n or less');
    // The panel says it is named only, because nothing executes it yet.
    expect(term?.facts).toContainEqual({ label: 'Keyword', value: 'named only' });
  });

  it('marks an implemented keyword as in play', () => {
    const g = new Glossary({ keywords: discoverRegistry(true) });
    expect(g.resolveText('discover')?.facts).toContainEqual({ label: 'Keyword', value: 'in play' });
    const builtins = new Glossary({ keywords: defaultKeywords() });
    expect(builtins.resolveText('charge')?.facts).toContainEqual({ label: 'Keyword', value: 'in play' });
  });

  it('finds a registered keyword in a card’s printed rules text', () => {
    const g = new Glossary({ keywords: discoverRegistry() });
    const marked = g.annotate('Discover 2.');
    expect(marked.spans[0]?.name).toBe('Discover');
  });

  it('feeds the card editor’s hover docs from the same definition', () => {
    // The card word doc for a built-in keyword is derived, not restated.
    expect(cardWordDoc('taunt')).toBe(BUILTIN_KEYWORDS.find((d) => d.name === 'Taunt')?.details);
  });
});
