/**
 * Tests for the glossary's **React** layer (`src/ui/glossary/`).
 *
 * The project has no DOM test environment, so — like `test/ui-card-pages.test.ts`
 * — these use `react-dom/server`. That is enough to prove the claims this layer
 * owns:
 *
 * - a term in a run of text renders as something **selectable** (a real
 *   element, with the term and its kind on it), and the rest of the text is
 *   still plain text;
 * - a caller's own spans win over the scan (a token knows what it is);
 * - an unresolvable name degrades to plain text rather than a dead link;
 * - the panel renders a summary first and the details on demand.
 *
 * Effects do not run under server rendering, which is why the panel is asserted
 * in its initial (collapsed) state — exactly what a player sees first.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Character, buff } from '../src/engine/index.js';
import { BuffDictionary } from '../src/english/dictionary.js';
import { defaultKeywords } from '../src/english/glossary.js';
import {
  DefinitionBody,
  GlossaryProvider,
  Gloss,
  Term,
  TermPanel,
} from '../src/ui/glossary/index.js';
import { DefinitionText } from '../src/ui/glossary/Term.js';
import type { Term as Definition } from '../src/english/index.js';
import { uiGlossary, uiGlossaryOptions } from '../src/ui/glossary/catalogs.js';

// The provider imports the card vocabulary only for its default; no Monaco is
// involved in this file, but the editor modules are pulled in by the barrel.
vi.mock('monaco-editor/editor/editor.main.js', () => ({ languages: {}, editor: {} }));

const rage = buff({
  name: 'Rage',
  description: '+3 power',
  weight: 5,
  stacks: true,
});

function options(): ReturnType<typeof uiGlossaryOptions> {
  return uiGlossaryOptions({
    // The catalog a screen would supply: the permanents it can describe.
    characters: [
      {
        name: 'Mountain Goblins',
        summary: 'Small, angry, and numerous.',
        abilities: ['Rush'],
        make: () => new Character('Mountain Goblins', { gauges: [{ id: 'hp', max: 2 }], stats: { power: 2 } }),
      },
    ],
    extra: { buffs: new BuffDictionary([{ name: 'Rage', def: rage }]), keywords: defaultKeywords() },
  });
}

/** The visible text of a rendered tree — tags stripped, entities decoded. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Renders Gloss inside a provider, and returns the markup. */
function renderGloss(text: string, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(
      GlossaryProvider,
      { options: options() },
      createElement(Gloss, { text, ...extra }),
    ),
  );
}

describe('Gloss — rendering terms', () => {
  it('marks a known word as a selectable term and leaves the rest alone', () => {
    const html = renderGloss('Deal 1 damage to target enemy character.');
    expect(html).toContain('data-term="target"');
    expect(html).toContain('data-term-kind="word"');
    // The words that are not terms are still there, as text.
    expect(html).toContain('Deal');
    expect(html).toContain('damage');
  });

  it('carries a one-line definition for a plain hover', () => {
    const html = renderGloss('target');
    expect(html).toContain('title="');
    expect(html).toContain('role="link"');
    expect(html).toContain('tabindex="0"');
  });

  it('renders a buff in card text as a buff term', () => {
    const html = renderGloss('Rage');
    expect(html).toContain('data-term="Rage"');
    expect(html).toContain('data-term-kind="buff"');
  });

  it('leaves an unknown name as plain text, with no dead link', () => {
    const html = renderGloss('Flibbertigibbet');
    expect(html).not.toContain('data-term=');
    expect(html).toContain('Flibbertigibbet');
  });

  it('renders nothing but the fallback for empty text', () => {
    const html = renderGloss('', { fallback: createElement('span', null, '—') });
    expect(html).toBe('<span>—</span>');
  });

  it('lets a caller’s own span win — a token knows what it named', () => {
    const text = 'create 3 Mountain Goblins';
    const start = text.indexOf('Mountain Goblins');
    const html = renderGloss(text, {
      givens: [
        {
          start,
          end: start + 'Mountain Goblins'.length,
          ref: { kind: 'permanent', name: 'Mountain Goblins' },
        },
      ],
    });
    // The reference resolved through the glossary's permanent source.
    expect(html).toContain('data-term="Mountain Goblins"');
  });

  it('keeps every character of the original text', () => {
    const text = 'Deal 1 damage to target enemy character and Rage.';
    const html = renderGloss(text).replace(/<[^>]+>/g, '');
    expect(html.replace(/&amp;/g, '&')).toBe(text);
  });
});

describe('the UI catalog — what a screen can actually explain', () => {
  it('knows the card keywords, the buffs and the zones the app shows', () => {
    const g = uiGlossary();
    expect(g.resolveText('Taunt')?.ref.kind).toBe('keyword');
    expect(g.resolveText('Rage')?.ref.kind).toBe('buff');
    expect(g.resolveText('play')?.ref.kind).toBe('zone');
    // A card-shaped word from the card vocabulary.
    expect(g.resolveText('cost')?.summary).toContain('mana');
  });

  it('finds the terms in a real card line, keyword and all', () => {
    const names = uiGlossary()
      .annotate('Taunt. When this enters play then Deal 6 damage to target enemy character.')
      .spans.map((span) => span.name);
    expect(names).toContain('Taunt');
    expect(names).toContain('deal');
    expect(names).toContain('target');
    // Function words are quiet, so a long line does not become a link farm.
    expect(names).not.toContain('the');
    expect(names).not.toContain('to');
  });
});

describe('Term — the selectable word', () => {
  const term = {
    ref: { kind: 'keyword' as const, name: 'Taunt' },
    glyph: 'Taunt',
    summary: 'Enemies must attack this creature first.',
    details: '**Taunt.** Enemies must attack this creature first.',
  };

  it('renders the glyph and the term identity', () => {
    const html = renderToStaticMarkup(
      createElement(GlossaryProvider, { options: options() }, createElement(Term, { term })),
    );
    expect(html).toContain('data-term="Taunt"');
    expect(html).toContain('data-term-kind="keyword"');
    expect(html).toContain('Taunt');
  });

  it('renders its children instead of the glyph when given them', () => {
    const html = renderToStaticMarkup(
      createElement(GlossaryProvider, { options: options() }, createElement(Term, { term }, '🛡 taunt')),
    );
    expect(html).toContain('🛡 taunt');
  });
});

describe('TermPanel — the definition', () => {
  const term = {
    ref: { kind: 'character' as const, name: 'Mountain Goblins' },
    glyph: 'Mountain Goblins',
    summary: 'HP 2/2 · Power 2',
    details: '**HP** 2/2\n\n**Abilities**\n- Rush\n',
    facts: [
      { label: 'HP', value: '2/2' },
      { label: 'Power', value: '2' },
    ],
  };

  /**
   * The panel is **connected** now (it reads the trail and resolution from the
   * context), so it cannot be rendered from a prop. This harness opens a chosen
   * trail at mount — what a player's clicks would have done — and renders the
   * panel in place of the provider's default one, so the *current* context is
   * visible to server rendering.
   */
  const renderPanel = (trail: readonly Definition[]): string =>
    renderToStaticMarkup(
      createElement(GlossaryProvider, {
        options: options(),
        initialTrail: trail,
        panel: () => createElement(TermPanel, { onClose: () => {} }),
      }),
    );

  it('shows the summary and facts first', () => {
    const html = renderPanel([term]);
    expect(html).toContain('Mountain Goblins');
    // The summary is *glossed*, so "HP" is a term rather than plain text — the
    // recursion. Compare the visible text, not the markup.
    expect(visibleText(html)).toContain('HP 2/2 · Power 2');
    expect(html).toContain('data-term="hp"');
    expect(html).toContain('<dt>HP</dt>');
    // Details are behind "More…" until asked for.
    expect(html).toContain('More…');
    expect(html).not.toContain('Rush');
  });

  it('renders nothing when no term is open', () => {
    expect(renderPanel([])).toBe('');
  });

  it('shows the back affordance only when there is somewhere to go back to', () => {
    const deeper = { ...term, ref: { kind: 'buff' as const, name: 'Rage' }, glyph: 'Rage' };
    expect(renderPanel([term])).not.toContain('term-back');
    expect(renderPanel([term, deeper])).toContain('term-back');
  });

  it('shows the trail as breadcrumbs, with the current step not a link', () => {
    const deeper = { ...term, ref: { kind: 'buff' as const, name: 'Rage' }, glyph: 'Rage' };
    const html = renderPanel([term, deeper]);
    expect(html).toContain('term-trail');
    // The earlier step is a jump back; the current one is just text.
    expect(html).toContain('term-step-link');
    expect(html).toContain('term-step-current');
    expect(html).toContain('Mountain Goblins');
    expect(html).toContain('Rage');
  });
});

describe('TermPanel — recursion', () => {
  /**
   * A definition that mentions other things — which is the whole point. The
   * summary names a buff, the details name a keyword and a zone.
   */
  const linking = {
    ref: { kind: 'keyword' as const, name: 'Discover' },
    glyph: 'Discover',
    summary: 'Reveal from the top of Rage until you find one.',
    details: 'Reveal cards from your DECK until you find one you can afford.',
  };

  /** The renderer the panel passes to the markdown layer. */
  const termText = (text: string, key: string) => createElement(DefinitionText, { key, text });

  const renderOpen = (term: Definition): string =>
    renderToStaticMarkup(
      createElement(GlossaryProvider, {
        options: options(),
        initialTrail: [term],
        panel: () => createElement(TermPanel, { onClose: () => {} }),
      }),
    );

  it('makes a term inside a definition selectable, in the summary', () => {
    const html = renderOpen(linking);
    // "Rage" is a buff in this glossary, so the summary is not plain text.
    expect(html).toContain('data-term="Rage"');
    expect(html).toContain('data-term-kind="buff"');
  });

  it('marks up the details too, through the same renderer', () => {
    // The details only appear once expanded, and expanding is state that server
    // rendering does not replay — so this drives `DefinitionBody` directly,
    // with the same text renderer the panel passes it.
    const html = renderToStaticMarkup(
      createElement(
        GlossaryProvider,
        { options: options() },
        createElement(DefinitionBody, { markdown: linking.details, renderText: termText }),
      ),
    );
    // "DECK" is a zone in this glossary, so the details are not plain text.
    expect(html).toContain('data-term="deck"');
    expect(html).toContain('data-term-kind="zone"');
    expect(visibleText(html)).toContain('Reveal cards from your DECK until you find one you can afford.');
  });

  it('stops short words from becoming links — a definition is dense prose', () => {
    // Without the floor, a one-letter vocabulary entry turns nearly every "a"
    // in a definition into a link and the sentence stops being readable.
    const dense = {
      ref: { kind: 'rule' as const, name: 'Rule' },
      glyph: 'Rule',
      summary: 'a b hp',
      details: 'a b hp',
    };
    const html = renderOpen(dense);
    // `hp` survives the floor; the single letters do not.
    expect(html).toContain('data-term="hp"');
    expect(html).not.toContain('data-term="a"');
    expect(html).not.toContain('data-term="b"');
  });

  it('a definition naming itself cannot grow the trail', () => {
    // `open` treats re-selecting the current term as a no-op, so a
    // self-referential definition is a dead link rather than an infinite one.
    const selfNaming = {
      ref: { kind: 'keyword' as const, name: 'Rage' },
      glyph: 'Rage',
      summary: 'Rage is Rage.',
      details: 'Rage is Rage.',
    };
    const html = renderOpen(selfNaming);
    // No breadcrumb, because the trail never grew past one step.
    expect(html).not.toContain('term-trail');
  });
});
