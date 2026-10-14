/**
 * `Term` and `Gloss` — a term rendered selectable, and a run of text with all
 * of its terms selectable.
 *
 * These are the whole visible feature: anywhere the game shows a word, wrap it
 * in one of these and the player can click it.
 *
 * `Gloss` is the common case (prose — card rules, a log line). It annotates the
 * text with the glossary in scope and marks up every term it finds. A caller
 * that already knows where its terms are — a buff badge, a token an effect
 * created — passes `givens`, and the caller's spans win over the scan.
 */
import { useCallback, type MouseEvent, type ReactNode } from 'react';
import type { Glyph, Term as Definition } from '../../english/index.js';
import { useTermPanel } from './GlossaryProvider.js';
import type { TextRenderer } from './markdown.js';

export function Term({ term, children }: { term: Definition; children?: ReactNode }) {
  const { open } = useTermPanel();
  const select = useCallback(
    (event: MouseEvent<HTMLSpanElement>) => {
      // A term often sits inside something already clickable (a card in hand,
      // a minion token). Selecting the word must win, or the click would play
      // the card or start an attack instead of explaining a word.
      event.stopPropagation();
      event.preventDefault();
      open(term);
    },
    [open, term],
  );

  return (
    <span
      className={`term term-${term.ref.kind}`}
      role="link"
      tabIndex={0}
      // The one-line definition is available without clicking, for a mouse
      // that only passes over it and for a screen reader.
      title={term.summary}
      data-term={term.ref.name}
      data-term-kind={term.ref.kind}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        open(term);
      }}
    >
      {children ?? term.glyph}
    </span>
  );
}

/**
 * **A definition's own text, with its terms selectable too.**
 *
 * This is the recursion: the definition on screen is annotated by the same
 * mechanism as the card text that opened it, so a term inside a definition is
 * itself openable — "discover" mentions a library, and the library can be
 * asked about. The mechanism is the same `annotate` the prose uses; there is no
 * second code path.
 *
 * A definition that mentions itself (`Discover` saying "discover") simply
 * re-opens the current term, which `open` treats as a no-op rather than a step,
 * so the trail cannot grow a cycle.
 */
export function DefinitionText({ text, className }: { text: string; className?: string }) {
  const { annotate } = useTermPanel();
  const { spans } = annotate(text);

  const pieces: ReactNode[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) pieces.push(text.slice(at, span.start));
    pieces.push(
      <Term key={`term-${span.start}`} term={span.term}>
        {text.slice(span.start, span.end)}
      </Term>,
    );
    at = span.end;
  }
  if (at < text.length) pieces.push(text.slice(at));

  return <span className={className}>{pieces}</span>;
}

/**
 * A text renderer for the markdown layer: every plain run becomes selectable
 * terms. This is what `DefinitionBody` calls for each inline span it renders.
 */
export function useTermTextRenderer(): TextRenderer {
  return (text: string, key: string) => <DefinitionText key={key} text={text} />;
}

export interface GlossProps {
  /** The text to show, with its terms selectable. */
  readonly text: string;
  /**
   * Spans the caller already knows. They win over the scanner, which is how a
   * token created by an effect shows the stat block of what it names.
   */
  readonly givens?: readonly Glyph[];
  /** Rendered when there is no text at all. */
  readonly fallback?: ReactNode;
  readonly className?: string;
}

export function Gloss({ text, givens, fallback, className }: GlossProps) {
  const { annotate, define } = useTermPanel();

  if (text.length === 0) return <>{fallback ?? null}</>;

  // One call does the whole job — scanning, the caller's own spans, and the
  // claim arbitration between them — because `annotate` is the mechanism and
  // this component only draws its answer.
  const resolved: Glyph[] = (givens ?? []).map((glyph) => ({
    ...glyph,
    term: glyph.term ?? define(glyph.ref),
  }));
  const { spans } = annotate(text, resolved);

  const pieces: ReactNode[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) pieces.push(<span key={`text-${at}`}>{text.slice(at, span.start)}</span>);
    pieces.push(
      <Term key={`term-${span.start}`} term={span.term}>
        {text.slice(span.start, span.end)}
      </Term>,
    );
    at = span.end;
  }
  if (at < text.length) pieces.push(<span key={`text-${at}`}>{text.slice(at)}</span>);

  return <span className={className}>{pieces}</span>;
}
