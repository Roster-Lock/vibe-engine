/**
 * Monaco glue for the **Card Document** language (`src/english/card.ts`).
 *
 * The same three providers the ability editor has, over the card grammar:
 *
 * - completion from the position-aware `completeCardAt` model (shared with
 *   the unit tests), so every word typed is offered or rejected before it
 *   is written;
 * - hover with one-line help for the card words and for declared buffs;
 * - Ctrl/Cmd+Click on a buff reference jumps to its `Buff` declaration;
 * - `applyDiagnostics` turns the compiler's spans into editor squiggles.
 */
import * as monaco from 'monaco-editor/editor/editor.main.js';
import type { BuffDef } from '../../engine/index.js';
import {
  compileCardDocument,
  completeCardAt,
  describeEngineBuff,
  emptyZoneDictionary,
  type Diagnostic,
  type Span,
  type ZoneDictionary,
} from '../../english/index.js';
import { describeTerm } from '../glossary/describe.js';
import { editorGlossary, glossaryAt } from './glossary-editor.js';
import { applyDiagnostics, spanToRange } from './language.js';

export const TINYQUEST_CARD_LANG = 'tinyquest-card';
export { applyDiagnostics };

/** Words the card tokenizer colors as keywords. */
const KEYWORDS = [
  // Card shape.
  'Card', 'Cost', 'Creature', 'Spell', 'Taunt', 'Charge',
  // Events — named explicitly, in the same `When …`/`then …` grammar the
  // ability language uses.
  'When', 'Then', 'Enters', 'Play', 'Dies', 'Takes', 'Healed', 'Survives',
  // The ability vocabulary the effect bodies reuse.
  'Buff', 'Deal', 'Heal', 'Destroy', 'Add', 'Remove', 'Toggle',
  'You', 'All', 'Players', 'Win', 'Wins', 'Lose', 'Loses',
  'Target', 'This', 'Other', 'Enemy', 'Ally', 'Allied',
  'Character', 'Characters', 'Owned', 'Opponent', 'The', 'Game',
  'To', 'From', 'For', 'By', 'Weight', 'Stacks', 'Damage',
  'With', 'Hp', 'Mana', 'And', 'Or', 'If', 'May', 'Repeat',
  // Lowercase forms — the editor does not force capitalization.
  'card', 'cost', 'creature', 'spell', 'taunt', 'charge',
  'when', 'then', 'enters', 'play', 'dies', 'takes', 'healed', 'survives',
  'buff', 'deal', 'heal', 'destroy', 'add', 'remove', 'toggle',
  'you', 'all', 'players', 'win', 'wins', 'lose', 'loses',
  'target', 'this', 'other', 'enemy', 'ally', 'allied',
  'character', 'characters', 'owned', 'opponent', 'the', 'game',
  'to', 'from', 'for', 'by', 'weight', 'stacks', 'damage',
  'with', 'hp', 'mana', 'and', 'or', 'if', 'may', 'repeat',
];

let registered = false;
/** The zones the editor's completion offers — set by the hosting page. */
let editorZones: ZoneDictionary = emptyZoneDictionary();

/**
 * Registers the card language and its providers once. `zones` is the
 * hosting game's zone list (the engine's `play`/`graveyard` are always
 * known), so `from active` is offered exactly where the document may name
 * it.
 */
export function ensureTinyQuestCardLanguage(zones: ZoneDictionary = emptyZoneDictionary()): void {
  editorZones = zones;
  if (registered) return;
  registered = true;

  (self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
    // Vite builds ./monaco-worker.ts as a module worker asset.
    getWorker: () => new Worker(new URL('./monaco-worker.ts', import.meta.url), { type: 'module' }),
  };

  monaco.languages.register({ id: TINYQUEST_CARD_LANG });
  monaco.languages.setLanguageConfiguration(TINYQUEST_CARD_LANG, {
    brackets: [['(', ')']],
    autoClosingPairs: [{ open: '(', close: ')' }],
  });
  monaco.languages.setMonarchTokensProvider(TINYQUEST_CARD_LANG, {
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
        [/[<>=/]/, 'delimiter'],
      ],
    },
  } as monaco.languages.IMonarchLanguage);

  monaco.languages.registerCompletionItemProvider(TINYQUEST_CARD_LANG, {
    triggerCharacters: [' ', ':'],
    provideCompletionItems: (model, position) => {
      const offset = model.getOffsetAt(position);
      const suggestions = completeCardAt(model.getValue(), offset, undefined, editorZones);
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

  monaco.languages.registerHoverProvider(TINYQUEST_CARD_LANG, {
    provideHover: (model, position) => {
      const word = model.getWordAtPosition(position);
      if (!word) return undefined;
      const offset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn });
      const text = model.getValue();
      // The same single lookup the ability editor uses: the document's own
      // declarations are a source, so a buff written two lines up is explained
      // from what the author wrote rather than from a second scan for it.
      const glossary = editorGlossary({ source: text, card: true, zones: editorZones });
      const hit = glossaryAt(text, offset, glossary, {
        resolve: () => {
          const match = declaredBuffs(text).find((buff) => buff.name.toLowerCase() === word.word.toLowerCase());
          if (!match) return undefined;
          const term = glossary.define({ kind: 'buff', name: match.name });
          return {
            term: {
              ref: { kind: 'buff', name: match.name },
              glyph: match.name,
              summary: term?.summary ?? `A buff declared in this document.`,
              details: match.def ? describeEngineBuff(match.def) : describeTerm(term ?? {
                ref: { kind: 'buff', name: match.name },
                glyph: match.name,
                summary: `**${match.name}** — a buff declared in this document.`,
              }),
            },
            start: match.span.start,
            end: match.span.end,
          };
        },
      });
      if (!hit) return undefined;
      return {
        range: spanToRange(model, { start: hit.start, end: hit.end }),
        contents: [{ value: hit.term.details ?? hit.term.summary }],
      };
    },
  });

  // Ctrl/Cmd+Click on a buff reference jumps to its `Buff` declaration.
  monaco.languages.registerDefinitionProvider(TINYQUEST_CARD_LANG, {
    provideDefinition: (model, position) => {
      const word = model.getWordAtPosition(position);
      if (!word) return [];
      const wordStart = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn });
      const declaration = declaredBuffs(model.getValue()).find(
        (buff) => buff.name.toLowerCase() === word.word.toLowerCase(),
      );
      if (!declaration) return [];
      // Already on the declaration itself? Nothing to jump to.
      if (wordStart >= declaration.span.start && wordStart < declaration.span.end) return [];
      return [{ uri: model.uri, range: spanToRange(model, declaration.span) }];
    },
  });
}

/** The `Buff` declarations of a card document, name + span + bound def. */
function declaredBuffs(text: string): { name: string; span: Span; def: BuffDef | undefined }[] {
  const compiled = compileCardDocument(text);
  return compiled.buffs.map((buff, index) => ({
    name: buff.name,
    span: buff.span,
    def: compiled.buffDefs[index],
  }));
}

/** Squiggles for a card document (thin alias, for symmetry with the ability editor). */
export function applyCardDiagnostics(
  model: monaco.editor.ITextModel,
  diagnostics: readonly Diagnostic[],
): void {
  applyDiagnostics(model, diagnostics, 'tinyquest-card');
}
