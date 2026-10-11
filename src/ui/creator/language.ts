/**
 * Monaco glue for the Ability Language (the Create page's editor).
 *
 * - registers the `tinyquest-english` language (token colors only — the
 *   real checking is our parser);
 * - completion items come from the position-aware `completeAt` model in
 *   src/english (shared with the unit tests), mapped onto the word under
 *   the cursor;
 * - hover shows one-line help for the vocabulary words;
 * - `applyDiagnostics` turns the compiler's spans into editor squiggles.
 */
import * as monaco from 'monaco-editor/editor/editor.main.js';
import {
  buffReferenceInfo,
  completeAt,
  describeBuffReference,
  wordDoc,
  type Diagnostic,
  type Span,
} from '../../english/index.js';

export const TINYQUEST_LANG = 'tinyquest-english';

/** The vocabulary words, colored as keywords by the tokenizer. */
const KEYWORDS = [
  'Ability', 'Buff', 'Deal', 'Heal', 'Destroy', 'Add', 'Remove',
  'You', 'All', 'Players', 'Win', 'Wins', 'Lose', 'Loses',
  'Target', 'This', 'Other', 'Enemy', 'Ally', 'Allied',
  'Character', 'Characters', 'Owned', 'Opponent', 'The', 'Game',
  'To', 'From', 'For', 'By', 'Weight', 'Stacks', 'Damage',
  'When', 'Then', 'Creature', 'Transform', 'Summon',
  'With', 'Hp', 'Mana', 'And', 'Or',
  // Planned events vocabulary — the batch-event count phrase words
  // (BATCH_EVENT_COUNT_WORDS in src/english/vocabulary.ts) and the
  // event verbs of the examples ("characters die", "characters survive").
  'One', 'More', 'Less', 'Die', 'Survive',
  // Lowercase forms — the editor does not force capitalization.
  'ability', 'buff', 'deal', 'heal', 'destroy', 'add', 'remove', 'you', 'all',
  'win', 'wins', 'lose', 'loses', 'target', 'this', 'other',
  'enemy', 'ally', 'allied', 'character', 'characters', 'owned',
  'opponent', 'players', 'the', 'game', 'to', 'from', 'for', 'by',
  'with', 'hp', 'mana', 'and', 'or',
  'one', 'more', 'less', 'die', 'survive',
];

let registered = false;

/** Idempotent one-time registration of the language and its providers. */
export function ensureTinyQuestLanguage(): void {
  if (registered) return;
  registered = true;

  (self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
    // Vite builds ./monaco-worker.ts as a module worker asset.
    getWorker: () => new Worker(new URL('./monaco-worker.ts', import.meta.url), { type: 'module' }),
  };

  monaco.languages.register({ id: TINYQUEST_LANG });
  monaco.languages.setLanguageConfiguration(TINYQUEST_LANG, {
    brackets: [['(', ')']],
    autoClosingPairs: [{ open: '(', close: ')' }],
  });
  monaco.languages.setMonarchTokensProvider(TINYQUEST_LANG, {
    defaultToken: '',
    ignoreCase: false,
    keywords: KEYWORDS,
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/[0-9]+(?:\.[0-9]+)?/, 'number'],
        [/[A-Za-z][A-Za-z']*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/[()]/, '@brackets'],
        [/[.,]/, 'delimiter'],
        [/[<>=]/, 'delimiter'],
      ],
    },
  } as monaco.languages.IMonarchLanguage);

  monaco.languages.registerCompletionItemProvider(TINYQUEST_LANG, {
    triggerCharacters: [' '],
    provideCompletionItems: (model, position) => {
      const offset = model.getOffsetAt(position);
      const suggestions = completeAt(model.getValue(), offset);
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const kinds = {
        keyword: monaco.languages.CompletionItemKind.Keyword,
        class: monaco.languages.CompletionItemKind.Class,
        operator: monaco.languages.CompletionItemKind.Operator,
      } as const;
      return {
        suggestions: suggestions.map((s) => ({
          label: s.label,
          kind: kinds[s.kind],
          detail: s.detail,
          documentation: s.doc ? { value: s.doc } : undefined,
          insertText: s.label,
          range,
          filterText: s.label,
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider(TINYQUEST_LANG, {
    provideHover: (model, position) => {
      const word = model.getWordAtPosition(position);
      if (!word) return undefined;
      const offset = model.getOffsetAt({
        lineNumber: position.lineNumber,
        column: word.startColumn,
      });
      // Buff names show what the buff does; every other word gets its
      // one-line vocabulary help.
      const buff = buffReferenceInfo(model.getValue(), offset);
      if (buff) {
        return {
          range: spanToRange(model, buff.span),
          contents: [{ value: describeBuffReference(buff) }],
        };
      }
      const doc = wordDoc(word.word);
      if (!doc) return undefined;
      return {
        range: word
          ? new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
          : undefined,
        contents: [{ value: doc }],
      };
    },
  });

  // Ctrl/Cmd+Click on a buff reference jumps to its `Buff` declaration.
  monaco.languages.registerDefinitionProvider(TINYQUEST_LANG, {
    provideDefinition: (model, position) => {
      const word = model.getWordAtPosition(position);
      if (!word) return [];
      const offset = model.getOffsetAt({
        lineNumber: position.lineNumber,
        column: word.startColumn,
      });
      const buff = buffReferenceInfo(model.getValue(), offset);
      if (!buff?.declared || !buff.section) return [];
      // Already on the declaration itself? Nothing to jump to.
      if (buff.span.start >= buff.section.nameSpan.start && buff.span.end <= buff.section.nameSpan.end) {
        return [];
      }
      return [{ uri: model.uri, range: spanToRange(model, buff.section.nameSpan) }];
    },
  });
}

/** Converts an english span (offsets) into a Monaco range on a model. */
function spanToRange(model: monaco.editor.ITextModel, span: Span): monaco.Range {
  const start = model.getPositionAt(span.start);
  const end = model.getPositionAt(span.end);
  return new monaco.Range(
    start.lineNumber,
    start.column,
    end.lineNumber,
    Math.max(end.column, start.column + 1),
  );
}

/** Squiggles from the compiler's diagnostics (spans → line/column). */
export function applyDiagnostics(
  model: monaco.editor.ITextModel,
  diagnostics: readonly Diagnostic[],
): void {
  const markers: monaco.editor.IMarkerData[] = diagnostics.map((d) => {
    const start = model.getPositionAt(d.start);
    const end = model.getPositionAt(d.end);
    return {
      severity:
        d.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : d.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
      message: d.message,
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: Math.max(end.column, start.column + 1),
    };
  });
  monaco.editor.setModelMarkers(model, 'tinyquest-english', markers);
}
