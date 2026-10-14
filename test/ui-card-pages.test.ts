/**
 * A render smoke test for the two new card screens.
 *
 * There is no DOM test environment in this project, so these pages are
 * rendered with `react-dom/server` (no effects, no Monaco) purely to catch
 * render-time errors and prove the initial state is right: the card game's
 * setup screen, and the creator compiling its default sample into a card
 * face.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The editor module touches the DOM on import; the pages under test only use
// it inside effects, which server rendering never runs.
vi.mock('monaco-editor/editor/editor.main.js', () => ({ languages: {}, editor: {} }));

const { CardGamePage } = await import('../src/ui/pages/CardGamePage.js');
const { CardCreatePage } = await import('../src/ui/pages/CardCreatePage.js');

describe('card screens — render smoke', () => {
  it('renders the card table’s setup screen', () => {
    const html = renderToStaticMarkup(
      createElement(CardGamePage, { onMenu: () => {}, onCreate: () => {} }),
    );
    expect(html).toContain('Start a match');
    expect(html).toContain('You vs the AI');
    expect(html).toContain('Two players, one screen');
    expect(html).toContain('Watch two AIs');
    expect(html).toContain('Deal');
  });

  it('renders the card creator with its default sample already compiled', () => {
    const html = renderToStaticMarkup(
      createElement(CardCreatePage, { onBack: () => {}, onPlay: () => {} }),
    );
    expect(html).toContain('Card creator');
    // The sample is a Fireball, so the compiled pane shows it immediately.
    expect(html).toContain('Fireball');
    expect(html).toContain('picks an enemy');
    expect(html).toContain('0 errors');
  });
});
