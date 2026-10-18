/**
 * The editor's glossary — the definition sources a **document** can explain.
 *
 * In the game a word means what the content says it means. In the editor the
 * document being typed is itself a source of meaning: a `Buff Frailty`
 * line declares something the sentences below it refer to, and the author
 * should be able to select `Frailty` and see what they declared. That is a
 * source, not a special case, which is why it lives here rather than in the
 * Monaco glue.
 *
 * The `Buff` declaration source is **text-level on purpose**: an editor is
 * looking at a half-written document most of the time, and a scan for heading
 * lines works when the body below them is mid-sentence and does not compile.
 */
import {
  Glossary,
  KeywordRegistry,
  type GlossaryOptions,
  type GlossaryScope,
  type Term,
  type TermRef,
} from '../../english/index.js';
import { CARD_WORD_DOCS } from '../../english/card.js';
import { BUILTIN_KEYWORDS } from '../../english/glossary.js';
import { BuffDictionary } from '../../english/dictionary.js';
import { ZoneDictionary } from '../../english/zone-dictionary.js';

/** A `Buff <name>` heading found in the document being edited. */
export interface DeclaredBuff {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** Legacy parenthesised options as written (the language no longer has any). */
  readonly options: string;
}

/** Every `Buff <name>` heading in the source, whether or not it compiles. */
export function declaredBuffsIn(source: string): DeclaredBuff[] {
  const found: DeclaredBuff[] = [];
  const pattern = /^[ \t]*Buff[ \t]+([^()\n]+?)[ \t]*(\([^)\n]*\))?[ \t]*$/gim;
  let match = pattern.exec(source);
  while (match) {
    const name = match[1]!.trim();
    if (name.length > 0) {
      const at = match.index + match[0]!.indexOf(match[1]!);
      found.push({ name, start: at, end: at + name.length, options: match[2] ?? '' });
    }
    match = pattern.exec(source);
  }
  return found;
}

/**
 * A source over the buffs the document declares. The definition is the heading
 * plus its options — the body belongs to the ability grammar, which reports its
 * own diagnostics, and pretending to summarise a half-written body here would
 * only produce a confident wrong answer.
 */
export function documentSource(source: string) {
  const terms: Record<string, { summary: string; details: string; facts: { label: string; value: string }[] }> = {};
  for (const buff of declaredBuffsIn(source)) {
    const options = buff.options.replace(/[()]/g, '').trim();
    const facts: { label: string; value: string }[] = [];
    for (const option of options.split(/[\s,]+/).filter((part) => part.length > 0)) {
      facts.push({ label: 'Option', value: option });
    }
    terms[buff.name] = {
      summary: 'Declared in this document.',
      details: `**${buff.name}** — declared in this document${options ? ` (${options})` : ''}.`,
      facts,
    };
  }
  return { name: 'document', terms };
}

export interface EditorGlossaryOptions {
  /** The document being edited; its own declarations become definitions. */
  readonly source?: string;
  /** Buffs the host supplies beyond the document's own. */
  readonly dictionary?: BuffDictionary;
  /** Zones the hosting game declares. */
  readonly zones?: ZoneDictionary;
  /** Whether this document has card-shaped words (`Cost`, `Spell`). */
  readonly card?: boolean;
  readonly extra?: Partial<GlossaryOptions>;
}

/**
 * The last glossary built, keyed by the text it was built from.
 *
 * Hover fires on every mouse move, and building a glossary walks every word in
 * the language; rebuilding per mouse-move would make hovering the editor feel
 * like a compile. The cache is one entry because an editor has one document —
 * the thing being typed is always what was asked about last.
 */
let cached: { source: string; card: boolean; glossary: Glossary } | undefined;

/** The glossary an editor should hover with. */
export function editorGlossary(options: EditorGlossaryOptions = {}): Glossary {
  const source = options.source ?? '';
  if (cached && cached.source === source && cached.card === (options.card ?? false)) return cached.glossary;
  const built = buildEditorGlossary(options);
  cached = { source, card: options.card ?? false, glossary: built };
  return built;
}

function buildEditorGlossary(options: EditorGlossaryOptions): Glossary {
  const keywords = new KeywordRegistry(BUILTIN_KEYWORDS);
  return new Glossary({
    keywords,
    ...(options.card ? { cardWords: CARD_WORD_DOCS } : {}),
    ...(options.dictionary ? { buffs: options.dictionary } : {}),
    ...(options.zones ? { zones: options.zones } : {}),
    sources: options.source ? [documentSource(options.source)] : [],
    ...options.extra,
  });
}

/** A term found at an offset, and the span to underline for it. */
export interface GlossaryHit {
  readonly term: Term;
  readonly start: number;
  readonly end: number;
}

/**
 * The **single** lookup every editor surface asks: is there a definition for
 * the word at this offset?
 *
 * Monaco's hover provider, its definition provider and (in future) a
 * click-through all need the same answer, and before this each re-implemented
 * the "which word is under the cursor" question differently — which is how the
 * two card and ability editors ended up disagreeing about buffs.
 *
 * A `resolve` hook lets a caller that is span-accurate (a buff reference, whose
 * extent the parser knows exactly) contribute its own answer first; the scan is
 * the fallback.
 */
export function glossaryAt(
  text: string,
  offset: number,
  glossary: Glossary,
  options: { readonly scope?: GlossaryScope; readonly resolve?: () => GlossaryHit | undefined } = {},
): GlossaryHit | undefined {
  const precise = options.resolve?.();
  if (precise) return precise;
  if (offset < 0 || offset > text.length) return undefined;
  const spans = glossary.annotate(text, options.scope).spans;
  // Half-open, so the cursor just past a word belongs to the *next* word
  // rather than to the one it left — otherwise hovering the space between two
  // terms shows the term on the left.
  for (const span of spans) {
    if (span.start <= offset && offset < span.end) return { term: span.term, start: span.start, end: span.end };
  }
  // The very end of the document has no next word to belong to.
  const last = spans.at(-1);
  return last && offset === last.end ? { term: last.term, start: last.start, end: last.end } : undefined;
}

/** Resolves a reference for a host that only has one in hand. */
export function defineRef(glossary: Glossary, ref: TermRef, scope?: GlossaryScope): Term | undefined {
  return glossary.define(ref, scope);
}
