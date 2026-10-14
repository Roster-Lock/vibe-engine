/**
 * The React half of the glossary: one context, one panel, one click handler.
 *
 * Everything here is deliberately **not game-specific**. A page hands in a
 * `Glossary` (built from its own content) and this layer does the rest:
 * renders annotated text, opens a definition when a word is selected, and
 * keeps a trail so a definition can be navigated through.
 *
 * ```tsx
 * <GlossaryProvider options={{ buffs, zones, characters }}>
 *   <CardTable />
 * </GlossaryProvider>
 * ```
 *
 * A page that wraps nothing still works: `useGlossary` falls back to a
 * language-only glossary, so a word is explained even where no content was
 * supplied.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Glossary,
  languageGlossary,
  type Annotated,
  type GlossaryOptions,
  type GlossaryScope,
  type Glyph,
  type Term,
  type TermRef,
} from '../../english/index.js';
import { CARD_WORD_DOCS } from '../../english/card.js';
import { TermPanel } from './TermPanel.js';

/** The language-only glossary, used where a page supplied none. */
let fallback: Glossary | undefined;

function fallbackGlossary(): Glossary {
  // Built lazily: a page with no content should not pay for one, and the card
  // vocabulary is only reachable from here (`src/english/glossary.ts` cannot
  // import `card.ts`, which depends on it).
  fallback ??= languageGlossary({ cardWords: CARD_WORD_DOCS });
  return fallback;
}

export interface TermPanelState {
  readonly current: Term | undefined;
  /** Every definition opened, oldest first. */
  readonly trail: readonly Term[];
  readonly open: (term: Term) => void;
  /** Closes the panel. */
  readonly close: () => void;
  /** Closes the loop by re-opening the trail's last entry — `Trail` has it. */
  readonly back: () => void;
  /** Jumps back to a step of the trail, for a breadcrumb. */
  readonly goTo: (index: number) => void;
}

interface GlossaryContextValue {
  readonly glossary: Glossary;
  /** Resolves a definition in this surface's scope. */
  readonly define: (ref: TermRef) => Term | undefined;
  readonly resolveText: (word: string) => Term | undefined;
  /** Finds the terms in a run of text, in this surface's scope. */
  readonly annotate: (text: string, givens?: readonly Glyph[]) => Annotated;
  /** Opens a definition; repeated clicks push a trail. */
  readonly open: (term: Term) => void;
  readonly close: () => void;
  /** Back one step; a no-op at the first. */
  readonly back: () => void;
  /** Jump to a step of the trail — what a breadcrumb does. */
  readonly goTo: (index: number) => void;
  /** Every definition opened, oldest first. */
  readonly trail: readonly Term[];
  /** A term or nothing — the panel renders the last one. */
  readonly current: Term | undefined;
}

const GlossaryContext = createContext<GlossaryContextValue | undefined>(undefined);

export interface GlossaryProviderProps {
  readonly children: ReactNode;
  /** The definition sources for this surface. */
  readonly options?: GlossaryOptions;
  /**
   * What the sources should read — the document being edited, the match being
   * played. Passed to every `define`/`resolveText` call, so a host hook can
   * show live state rather than the printed value.
   */
  readonly scope?: GlossaryScope;
  /** Rendered instead of the built-in panel. */
  readonly panel?: (state: TermPanelState) => ReactNode;
  /**
   * Definitions to show immediately, oldest first.
   *
   * The trail is real state, and real state needs a way in: restoring an open
   * chain (a reload, a deep link, a server-rendered shell) is the same problem
   * as a player's first click, and mounting with nothing then opening in an
   * effect would flash closed. It is also what lets a test render a panel.
   */
  readonly initialTrail?: readonly Term[];
}

export function GlossaryProvider({ children, options, scope, panel, initialTrail }: GlossaryProviderProps) {
  const glossary = useMemo(() => new Glossary(options ?? { cardWords: CARD_WORD_DOCS }), [options]);
  // A ref, so the callbacks below keep a stable identity while still reading
  // the latest scope.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const [trail, setTrail] = useState<readonly Term[]>(initialTrail ?? []);

  const define = useCallback(
    (ref: TermRef) => glossary.define(ref, scopeRef.current),
    [glossary],
  );
  const resolveText = useCallback(
    (word: string) => glossary.resolveText(word, scopeRef.current),
    [glossary],
  );
  const annotate = useCallback(
    (text: string, givens?: readonly Glyph[]) => glossary.annotate(text, scopeRef.current, givens),
    [glossary],
  );
  const open = useCallback((term: Term) => {
    setTrail((previous) => {
      // Re-selecting the definition already on screen is a no-op rather than
      // a duplicate step, so clicking the same word twice does not build a
      // trail that has to be walked back through.
      if (previous.at(-1)?.ref.name === term.ref.name) return previous;
      return [...previous, term];
    });
  }, []);
  const close = useCallback(() => setTrail([]), []);
  const back = useCallback(() => setTrail((previous) => previous.slice(0, -1)), []);
  const goTo = useCallback((index: number) => setTrail((previous) => previous.slice(0, index + 1)), []);

  const value = useMemo<GlossaryContextValue>(
    () => ({ glossary, define, resolveText, annotate, open, close, back, goTo, trail, current: trail.at(-1) }),
    [glossary, define, resolveText, annotate, open, close, back, goTo, trail],
  );

  const state = useMemo<TermPanelState>(
    () => ({ current: value.current, trail, open, close, back, goTo }),
    [value.current, trail, open, close, back, goTo],
  );

  return (
    <>
      <GlossaryContext.Provider value={value}>{children}</GlossaryContext.Provider>
      {/*
        The panel is rendered **inside** its own view of the context, so a
        definition's text is resolved by the same glossary that opened it and a
        term inside a definition is selectable. It sits outside the provider
        that wraps `children` so a page cannot accidentally shadow it.
      */}
      {panel ? (
        <GlossaryContext.Provider value={value}>{panel(state)}</GlossaryContext.Provider>
      ) : (
        <GlossaryContext.Provider value={value}>
          <TermPanel onClose={close} />
        </GlossaryContext.Provider>
      )}
    </>
  );
}

/** The glossary in scope, falling back to the language's own words. */
export function useGlossary(): Glossary {
  return useContext(GlossaryContext)?.glossary ?? fallbackGlossary();
}

/**
 * The resolution and panel controls for a surface that renders its own terms
 * (`annotate` by hand, then a custom affordance).
 */
export function useTermPanel(): Omit<GlossaryContextValue, 'glossary'> {
  const value = useContext(GlossaryContext);
  return (
    value ?? {
      define: (ref: TermRef) => fallbackGlossary().define(ref),
      resolveText: (word: string) => fallbackGlossary().resolveText(word),
      annotate: (text: string, givens?: readonly Glyph[]) => fallbackGlossary().annotate(text, undefined, givens),
      open: () => {},
      close: () => {},
      back: () => {},
      goTo: () => {},
      trail: [],
      current: undefined,
    }
  );
}
