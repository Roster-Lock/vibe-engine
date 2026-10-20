/**
 * The Ability Language — a small English-shaped scripting surface that
 * compiles into engine abilities (docs/creator/01-ability-language.md).
 *
 * Public surface (used by the Create page, tests, and future tools):
 *
 * ```ts
 * const result = compileDocument(`
 *   Ability Fireball
 *   Deal 40 damage to target enemy character.
 * `);
 * result.abilities[0]  // an engine ManualAbility, ready for a skill
 * result.diagnostics   // grammar + semantic errors with exact spans
 * ```
 */
export type {
  Doc,
  AbilitySection,
  BuffSection,
  Sentence,
  DealSentence,
  HealSentence,
  DestroySentence,
  AddBuffSentence,
  RemoveBuffSentence,
  ResultSentence,
  CharsPhrase,
  Quantifier,
  Who,
  Owner,
  WithClause,
  WithCondition,
  BooleanCondition,
  ImportSection,
  ConditionJoiner,
  GaugeCondition,
  BuffCondition,
  WithOperator,
  Span,
  Diagnostic,
  Severity,
} from './ast.js';

export type { Token, TokenKind } from './lexer.js';
export { lex, lineColAt } from './lexer.js';
export type { ParseResult } from './parser.js';
export { parseDocument } from './parser.js';
export type { Suggestion, SuggestionKind } from './complete.js';
export { completeAt, wordDoc } from './complete.js';
export type { CompileOptions, CompileResult } from './compile.js';
export { lowerDocument } from './lower.js';
export type { RenderGap, RenderResult } from './render.js';
export { GAP_MARKER, renderDocument } from './render.js';
export {
  compileDocument,
  charsToString,
  conditionToLatex,
  effectSummary,
  targetingSummary,
} from './compile.js';
export type {
  CardKind,
  CardKeyword,
  CompiledCard,
  CardCompileResult,
  CardCompileOptions,
} from './card.js';
export {
  compileCardDocument,
  completeCardAt,
  cardWordDoc,
  documentKeywords,
  CARD_WORD_DOCS,
  CARD_LINE_STARTERS,
} from './card.js';
export {
  ZoneDictionary,
  emptyZoneDictionary,
  ENGINE_ZONES,
} from './zone-dictionary.js';
export {
  BuffDictionary,
  emptyDictionary,
  slug,
  type DictionaryEntry,
} from './dictionary.js';
export {
  BASIC_WORDS,
  BUILTIN_KEYWORDS,
  Glossary,
  KeywordRegistry,
  arityAccepts,
  arityWords,
  defaultKeywords,
  keywordWritten,
  splitKeywordArgs,
  languageGlossary,
  standardSources,
  termKey,
  type Annotated,
  type GlossaryOptions,
  type GlossaryScope,
  type GlossarySource,
  type GlossarySources,
  type Glyph,
  type DocSpan,
  type KeywordDef,
  type KeywordInvocation,
  type KeywordParse,
  type PermanentDef,
  type Term,
  type TermDefiner,
  type TermFact,
  type TermKind,
  type TermRef,
  type TermSeed,
  type TermSpan,
} from './glossary.js';
export {
  DefinitionIndex,
  type DefinitionCandidate,
  type DefinitionKind,
  type DefinitionLocation,
  type DefinitionMap,
  type DefinitionSource,
} from './definitions.js';
export { indexDocuments } from './definitions.js';
export { buildArena, runArena, type Arena, type ArenaRun } from './simulate.js';
export {
  buffReferenceInfo,
  describeBuffReference,
  describeEngineBuff,
  type BuffReferenceInfo,
} from './buff-info.js';
export { WORD_DOCS } from './vocabulary.js';
export {
  evaluateMathExpression,
  mathToLatex,
  mathToSource,
  parseMathExpression,
  type MathContext,
  type MathExpression,
} from '../ir/math-expression.js';
export {
  applyOneRewrite,
  applyRewriteChain,
  constValue,
  foldRewriteChain,
  rewriteChainSteps,
  rewriteChainToLatex,
  settle,
} from '../ir/rewrite-math.js';

/**
 * The compilation target (`src/ir/`), re-exported so a tool that consumes
 * `CompileResult.ir` needs one import. The IR is plain JSON — it is the
 * share format as much as the compiler's output (docs/GOAL.md).
 */
export type {
  AbilityIR,
  ActionMatchIR,
  ActionRewriteIR,
  ValueIR,
  BuffIR,
  DocumentIR,
  EffectIR,
  EntityQueryIR,
  ModifierIR,
  PredicateIR,
  StepIR,
  TargetingIR,
  TriggerIR,
  TriggerMode,
  TriggerScope,
} from '../ir/index.js';
export { IR_VERSION, bindDocument, type BindOptions, type BindResult, type ZoneBinding } from '../ir/index.js';
