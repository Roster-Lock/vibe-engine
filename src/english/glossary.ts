/**
 * **The glossary** — what a word in the game means, in one place.
 *
 * A player who does not understand a word should be able to select it and be
 * told. That is one mechanism, and this module is it: a term resolves to a
 * definition, and a run of text can be annotated with the terms inside it.
 * Every surface — the card table, a buff badge, the combat log, the editor's
 * hover, the card face — asks this module the same question and renders the
 * answer its own way.
 *
 * ## Three layers, and why the split is where it is
 *
 * | Layer | Game-specific? | Where it lives |
 * | --- | --- | --- |
 * | **Definition** — a `TermRef` resolves to a `Term` | yes | here, as *sources* |
 * | **Detection** — which words in this text are terms | yes | `annotate`, as data |
 * | **Interaction** — hover, click, the panel | no | `src/ui/glossary/` |
 *
 * "Displaying a value is different from game to game": that is the *definition*
 * layer. A keyword is prose, a buff is a markdown body, a character is a stat
 * block — all three are a `Term`, and only a character needs a host hook
 * (`define`) to show live numbers.
 *
 * "Selecting a word is different from game to game": that is the *detection*
 * layer. Card text and a log line are prose, so they are **scanned**; a buff
 * badge and a minion token already know what they are, so they are **declared**
 * (both forms are in `annotate`).
 *
 * The interaction layer is shared, which is the whole point: one click handler,
 * one panel, and a newly registered keyword is explained everywhere at once.
 *
 * ## Terms are merged by source order
 *
 * The same word is often defined at several resolutions — `taunt` is both a
 * card keyword and the vocabulary word, `hp` is both a gauge word and a buff's
 * rules text. Sources are ordered, and a **later source wins the same key**.
 * Every key that resolves is also a key the annotator can find, so adding a
 * source cannot break an existing tooltip: a richer definition displaces a
 * thinner one by being declared later, not by being special-cased.
 */
import type { BuffDef, Character, CharacterDef } from '../engine/index.js';
import { describeEngineBuff } from './buff-info.js';
import { BuffDictionary } from './dictionary.js';
import { ENGINE_ZONES, ZoneDictionary } from './zone-dictionary.js';
import { WORD_DOCS } from './vocabulary.js';

/* --------------------------------- terms -------------------------------- */

/**
 * What kind of thing a term is.
 *
 * The kind is what a surface colours, groups and orders by — it is not the
 * lookup key. Two sources may define the same *word* under different kinds
 * (`taunt` the keyword, `taunt` the vocabulary word); source order decides
 * which one a player sees.
 */
export type TermKind =
  /** A gameplay keyword: `Taunt`, `Charge`, `Discover`. */
  | 'keyword'
  /** Grammar vocabulary: `this`, `target`, `owned by`. */
  | 'word'
  /** A buff definition. */
  | 'buff'
  /** A character/permanent definition. */
  | 'character'
  /**
   * A **reference** to one of the above, as named in text — "create 3 Mountain
   * Goblins" names something rather than defining it. Resolution goes through
   * a host's `define` hook, which is how a reference can show live numbers.
   */
  | 'permanent'
  /** A zone a game declares. */
  | 'zone'
  | 'skill'
  | 'card'
  /** A rule of the game, as opposed to a word of the language. */
  | 'rule';

/** How a term is identified, independent of how it is spelled in a sentence. */
export interface TermRef {
  readonly kind: TermKind;
  /** The canonical name: `Taunt`, `Rage`, `Mountain Goblins`. */
  readonly name: string;
}

/** One labelled fact — `HP 3/3`, `Weight 5`, `Stackable`. */
export interface TermFact {
  readonly label: string;
  readonly value: string;
}

/**
 * A definition, ready to display.
 *
 * `summary` is one line and is what a hover or a badge shows; `details` is
 * markdown and is what a click opens. That split is deliberate: a buff with
 * three triggers should not be a wall of text the moment a cursor crosses it,
 * and a player who wants the wall can ask for it.
 */
export interface Term {
  readonly ref: TermRef;
  /** How it was written where it was found — `Taunt`, not `taunt`. */
  readonly glyph: string;
  /** One line: the hover text, the badge tooltip. */
  readonly summary: string;
  /** Markdown: the click panel. Falls back to `summary` when absent. */
  readonly details?: string;
  /** Structured numbers worth showing prominently (`HP 3/3`). */
  readonly facts?: readonly TermFact[];
  /** Things that read like the thing — a panel's footer. */
  readonly examples?: readonly string[];
  /** Related terms, offered as links by the interaction layer. */
  readonly links?: readonly TermRef[];
}

/** The minimal shape a term source must produce. */
export interface TermSeed {
  /**
   * The canonical spelling, when it differs from the key it is found by.
   * A buff found by `rage` is still *Rage*; omitting this means "the key is
   * the name".
   */
  readonly name?: string;
  readonly summary: string;
  readonly details?: string;
  readonly facts?: readonly TermFact[];
  readonly examples?: readonly string[];
  readonly links?: readonly TermRef[];
}

/**
 * A named collection of definitions, plus how to resolve what a plain key
 * lookup cannot answer.
 *
 * `terms` is keyed by the **lowercased text a player would select** — the
 * word, the keyword, the buff name. `resolve` is for references that are not a
 * key lookup at all (a permanent named in text, a skill referenced by id).
 */
export interface GlossarySource {
  readonly name: string;
  readonly terms: Readonly<Record<string, TermSeed>>;
  readonly resolve?: (ref: TermRef, scope?: GlossaryScope) => TermSeed | undefined;
}

/**
 * Context a resolver may need — which game, which document, whose board.
 * Opaque to this module on purpose: the sources interpret it.
 */
export interface GlossaryScope {
  /** The game whose content is in play (`'card-game'`, a save id). */
  readonly game?: string;
  /** The document being edited, when there is one. */
  readonly documentId?: string;
  /** Anything a host resolver needs that the standard fields do not cover. */
  readonly [key: string]: unknown;
}

/** A host hook that enriches or invents a definition — live state goes here. */
export type TermDefiner = (ref: TermRef, scope?: GlossaryScope, base?: Term) => Term | undefined;

export interface GlossarySources {
  /** Grammar vocabulary (`WORD_DOCS`). */
  readonly words?: Readonly<Record<string, string>>;
  /** Card-shaped vocabulary (`CARD_WORD_DOCS`). */
  readonly cardWords?: Readonly<Record<string, string>>;
  /** Registered gameplay keywords. */
  readonly keywords?: KeywordRegistry;
  /** Buff definitions, by name. */
  readonly buffs?: BuffDictionary;
  /** Zone names; the engine's own zones are always known. */
  readonly zones?: ZoneDictionary;
  /**
   * Character/permanent **catalog** definitions, by name — the things buffs
   * attach to, including heroes. A permanent's numbers are read from a fresh
   * instance its own `make()` builds, so a definition needs no second copy of
   * its stat block.
   */
  readonly characters?: readonly PermanentDef[];
  /** Extra sources, applied in the order given (last wins). */
  readonly sources?: readonly GlossarySource[];
}

/**
 * A **permanent** the glossary can describe — a hero, a creature, a token.
 *
 * Deliberately tiny, and deliberately *not* the engine's `CharacterDef`: the
 * engine stores the def, but what a player wants to see is the **built**
 * character's numbers, and a definition already knows how to build one. So a
 * catalog entry is a name, a line of flavour, its abilities, and a `make()`.
 *
 * ```ts
 * { name: 'Mountain Goblins', summary: '2/2', abilities: ['Rush'],
 *   make: () => new Character('Mountain Goblins', { stats: { power: 2 }, maxHp: 2 }) }
 * ```
 *
 * The numbers are read from a fresh instance every time the glossary is
 * built, so one definition cannot go stale against the content it names.
 */
export interface PermanentDef {
  readonly name: string;
  /** One line of flavour used as the summary. */
  readonly summary?: string;
  /** The abilities it is printed with, by name. */
  readonly abilities?: readonly string[];
  /** Builds a fresh instance whose gauges and stats the glossary reads. */
  readonly make?: () => Character;
  /** Facts for a definition that has no `make()` (e.g. read from a document). */
  readonly facts?: readonly TermFact[];
}

/** The lookup key for a name: lowercased, whitespace collapsed. */
export function termKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/* ------------------------------- keywords -------------------------------- */

/**
 * A gameplay keyword, registered once.
 *
 * ### Why this exists
 *
 * `Taunt` and `Charge` used to be known in five unconnected places: a union
 * type, a regex in the card line classifier, two entries in the hover docs, a
 * token list in the Monaco tokenizer, and two hard-coded labels on the card
 * face. A new keyword had to be found in all five, and missing one gave a
 * keyword that autocompleted but would not compile, or compiled but could not
 * be explained. Registering it here is the one place.
 *
 * ### Actually doing something is a separate step
 *
 * `parse` is what makes a keyword *mean* something: it turns the words after
 * the keyword (`Discover 2`) into ordinary sentences, which then compile
 * through the ordinary pipeline — same diagnostics, same IR, same `cast`. A
 * keyword registered **without** `parse` is still a legal line and is still
 * explained on hover; it simply does nothing yet. That is the seam a keyword
 * like Discover lands in: named and explained first, behaviour after.
 *
 * `handled` says whether the *card game* implements the keyword. Only handled
 * keywords reach a playable card's keyword list, so a keyword the game cannot
 * yet execute is never silently granted as a no-op.
 */
export interface KeywordDef {
  /** The canonical spelling: `Taunt`, `Discover`. */
  readonly name: string;
  /** One line, shown on hover and in completion. */
  readonly summary: string;
  /** Markdown for the click panel. Falls back to `summary`. */
  readonly details?: string;
  /** Other spellings that select the same keyword. */
  readonly aliases?: readonly string[];
  /**
   * Which card kinds the keyword may appear on. Defaults to `['creature']`,
   * which is what a combat keyword is; a spell-only keyword says so.
   */
  readonly cardKinds?: readonly ('creature' | 'spell')[];
  /**
   * The sentences this keyword means, given its **arguments** — `[]` for a bare
   * `Taunt.`, `['2']` for `Discover(2)`.
   *
   * Variadic on purpose. The keyword set is open, and the first one to take an
   * argument will not be the last: a signature that promises exactly one string
   * would have to change the day a keyword wants two (`Discover(2, land)`), and
   * every existing `parse` would have to change with it. An argument **list**
   * costs nothing today and is the shape the syntax now advertises.
   *
   * `undefined` = named but not yet executable.
   */
  readonly parse?: (args: readonly string[]) => readonly KeywordParse[];
  /**
   * How many arguments the keyword takes, when it is written with parentheses.
   * Used for a diagnostic that names the right number and for completion
   * (§"Does the author know what goes inside them?"). Omit for a bare keyword.
   *
   * An array is a **range**: `[1]` means exactly one, `[1, 2]` means one or
   * two. A keyword taking a variable number says `[1, Infinity]`.
   */
  readonly arity?: readonly [number, number];
  /** Whether the card game acts on it. Defaults to `true`. */
  readonly handled?: boolean;
}

/**
 * One sentence a keyword means, as text the ordinary compiler already reads.
 *
 * Deliberately **text**, not an AST or an `Action`: a keyword that lowers to
 * the same sentences a player could have written gets the same diagnostics,
 * the same IR and the same runtime, and needs no second compilation path.
 */
export interface KeywordParse {
  readonly text: string;
}

/**
 * A keyword as it was actually written on a card line.
 *
 * The distinction the syntax now carries: a keyword with **no** parentheses is
 * bare (`Taunt.`), while one with parentheses takes **arguments**
 * (`Discover(2)`). That is deliberately not the same as "has a `parse`" — a
 * keyword can be written bare today and grow an argument later without every
 * document that used it becoming ambiguous.
 */
export interface KeywordInvocation {
  readonly def: KeywordDef;
  /** The spelling as written (`Discover`, or an alias). */
  readonly spelling: string;
  /** What was inside the parentheses, split on commas; `[]` when bare. */
  readonly args: readonly string[];
  /**
   * Whatever followed the closing paren or the bare keyword, trimmed, with any
   * final `.` still on it (`Taunt.`). Trailing text after a **parenthesised**
   * keyword is a mistake the card layer reports rather than ignores.
   */
  readonly trailing: string;
  /** Span of just the arguments, for a diagnostic that lands on them. */
  readonly argsSpan: DocSpan;
  /** Whether the keyword was written with parentheses at all. */
  readonly parenthesised: boolean;
  /** True when the opening paren was never closed — reported, not guessed at. */
  readonly unterminated: boolean;
}

/** An offset range in the document being authored. */
export interface DocSpan {
  readonly start: number;
  readonly end: number;
}

/** `Discover(2, land)` — the canonical way to write a keyword with arguments. */
export function keywordWritten(invocation: { def: KeywordDef; args: readonly string[] }): string {
  const args = invocation.args.filter((arg) => arg.trim().length > 0);
  return args.length === 0 ? `${invocation.def.name}.` : `${invocation.def.name}(${args.join(', ')}).`;
}

/**
 * A keyword's argument list as written inside the parentheses.
 *
 * Only a split — each keyword decides what its own arguments mean, and a
 * keyword that wants `a, b` as separate arguments says so with its arity.
 */
export function splitKeywordArgs(inside: string): string[] {
  return inside
    .split(',')
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
}

/** Whether a count of arguments is inside a keyword's declared arity. */
export function arityAccepts(def: KeywordDef, count: number): boolean {
  const [min, max] = def.arity ?? [0, 0];
  return count >= min && count <= max;
}

/** `1 argument`, `2 arguments` — for a diagnostic that reads like English. */
export function arityWords(def: KeywordDef): string {
  const [min, max] = def.arity ?? [0, 0];
  const plural = (n: number): string => `${n} argument${n === 1 ? '' : 's'}`;
  if (min === max) return plural(min);
  if (max === Number.POSITIVE_INFINITY) return `${min} or more arguments`;
  return `${min} to ${max} arguments`;
}

/** The keywords a document may use, indexed by every spelling. */
export class KeywordRegistry {
  readonly #defs: KeywordDef[] = [];
  readonly #byKey = new Map<string, KeywordDef>();

  constructor(defs: readonly KeywordDef[] = []) {
    for (const def of defs) this.add(def);
  }

  /** Adds a keyword. A later registration of the same spelling wins. */
  add(def: KeywordDef): this {
    this.#defs.push(def);
    this.#byKey.set(termKey(def.name), def);
    for (const alias of def.aliases ?? []) this.#byKey.set(termKey(alias), def);
    return this;
  }

  /** Every registered keyword, in registration order. */
  get defs(): readonly KeywordDef[] {
    return this.#defs;
  }

  /** The canonical names, in registration order. */
  get names(): readonly string[] {
    return this.#defs.map((def) => def.name);
  }

  /** Resolves any spelling of a keyword. */
  get(nameOrAlias: string): KeywordDef | undefined {
    return this.#byKey.get(termKey(nameOrAlias));
  }

  has(nameOrAlias: string): boolean {
    return this.#byKey.has(termKey(nameOrAlias));
  }

  /** Whether the card game implements it (so a card may keep it). */
  isHandled(nameOrAlias: string): boolean {
    return this.#byKey.get(termKey(nameOrAlias))?.handled !== false;
  }

  /** The spelling a definition is canonically shown as. */
  displayName(nameOrAlias: string): string {
    return this.#byKey.get(termKey(nameOrAlias))?.name ?? nameOrAlias.trim();
  }

  /**
   * Matches a keyword at the start of `text` — bare (`Taunt.`) or with
   * arguments (`Discover(2)`).
   *
   * The **longest** registered spelling wins, because a keyword set is open:
   * `Discover` and `Discover Twice` may both be registered, and the longer
   * registration is the one the author meant.
   *
   * What is *inside* the parentheses is not interpreted here beyond splitting on
   * commas — each keyword owns its own arguments. `offset` is where `text`
   * starts in the document, so the returned spans point at the author's file.
   */
  matchAtStart(text: string, offset = 0): KeywordInvocation | undefined {
    const leading = text.length - text.trimStart().length;
    const trimmed = text.slice(leading);
    const lower = trimmed.toLowerCase();
    let best: KeywordInvocation | undefined;
    for (const [spelling, def] of this.#byKey) {
      if (!lower.startsWith(spelling)) continue;
      // The next character must end the word: `Charge` must not match
      // `Charger`. A `(` is a valid next character — that is the argument form.
      const next = lower.charAt(spelling.length);
      if (next !== '' && next !== '(' && /[a-z0-9']/.test(next)) continue;
      if (best && best.spelling.length >= spelling.length) continue;
      best = readInvocation(def, spelling, trimmed, offset + leading);
    }
    return best;
  }

  /** Close spellings, for a typo diagnostic. */
  suggest(name: string): string[] {
    const wanted = termKey(name);
    return [...new Set([...this.#byKey.keys()])]
      .filter((candidate) => candidate.includes(wanted) || wanted.includes(candidate))
      .map((candidate) => this.displayName(candidate))
      .filter((candidate, index, all) => all.indexOf(candidate) === index)
      .slice(0, 5);
  }
}

/**
 * The keywords the language itself ships.
 *
 * This is their **only** definition. The card editor's word docs, its
 * completion list and its tokenizer all read from here, which is what stops
 * `Taunt` from meaning one thing on hover and another in the grammar — the
 * failure mode the five-places problem used to produce.
 */
export const BUILTIN_KEYWORDS: readonly KeywordDef[] = [
  {
    name: 'Taunt',
    summary: 'Enemies must attack this creature before its allies. Creatures only.',
    details:
      '`Taunt.` — enemies must attack this creature before its allies. Creatures only.',
    cardKinds: ['creature'],
  },
  {
    name: 'Charge',
    summary: 'This creature may attack the turn it lands. Creatures only.',
    details: '`Charge.` — this creature may attack the turn it lands. Creatures only.',
    cardKinds: ['creature'],
  },
];

/** A registry with every built-in keyword registered. */
export function defaultKeywords(): KeywordRegistry {
  return new KeywordRegistry(BUILTIN_KEYWORDS);
}

/**
 * Reads the arguments of one invocation: `spelling` plus whatever follows.
 *
 * An unclosed `(` is reported rather than guessed at — the caller turns it into
 * a diagnostic, because silently reading `Discover(2` as `Discover` would hide
 * the typo behind a keyword that then does nothing.
 */
function readInvocation(def: KeywordDef, spelling: string, rest: string, at: number): KeywordInvocation {
  const argsStart = at + spelling.length;
  if (rest.charAt(spelling.length) !== '(') {
    return {
      def,
      spelling,
      args: [],
      trailing: rest.slice(spelling.length).trim(),
      argsSpan: { start: argsStart, end: argsStart },
      parenthesised: false,
      unterminated: false,
    };
  }
  const close = rest.indexOf(')', spelling.length);
  if (close === -1) {
    return {
      def,
      spelling,
      args: [],
      trailing: '',
      argsSpan: { start: argsStart, end: at + rest.length },
      parenthesised: true,
      unterminated: true,
    };
  }
  const inside = rest.slice(spelling.length + 1, close);
  return {
    def,
    spelling,
    args: splitKeywordArgs(inside),
    trailing: rest.slice(close + 1).trim(),
    argsSpan: { start: argsStart + 1, end: at + close },
    parenthesised: true,
    unterminated: false,
  };
}

/* -------------------------------- glossary ------------------------------- */

/** One resolved lexicon entry: the term, and the spelling that found it. */
interface LexiconEntry {
  readonly term: Term;
  /** Source order, so a scan can prefer the later (richer) definition. */
  readonly rank: number;
  /** Set when the key is not a plain word (`hp < 10`, `owned by`). */
  readonly pattern?: RegExp;
}

/** A term found in a run of text. */
export interface TermSpan {
  readonly start: number;
  readonly end: number;
  /** The term's canonical name — `Taunt` even when the text says `taunt`. */
  readonly name: string;
  readonly kind: TermKind;
  /** The definition, resolved. */
  readonly term: Term;
}

/** A term a caller already knows about — a badge, a token, an entity. */
export interface Glyph {
  readonly start: number;
  readonly end: number;
  /** The text as displayed, if the caller wants to override the slice. */
  readonly text?: string;
  readonly ref: TermRef;
  /** A definition the caller already resolved; `define` is asked otherwise. */
  readonly term?: Term;
}

/** A run of text plus the terms in it, ready to render. */
export interface Annotated {
  readonly text: string;
  readonly spans: readonly TermSpan[];
}

export interface GlossaryOptions extends GlossarySources {
  /** The host's live-state hook, applied last to every resolved term. */
  readonly define?: TermDefiner;
  /**
   * Spans the caller marks as **already known** — a reference in hand beats the
   * scanner's guess. Applied to every `annotate` call for this glossary.
   */
  readonly givens?: readonly Glyph[];
  /**
   * The function words a scan does **not** mark up. They still resolve — a
   * hover or a script asking about `the` gets an answer — but a card face
   * where every "the" and "to" is a link is noise, so the scan is quiet about
   * them by default. `scanAll` turns that off.
   */
  readonly basicWords?: readonly string[];
  /** Mark up even the `BASIC_WORDS`. Defaults to `false`. */
  readonly scanAll?: boolean;
  /**
   * The shortest term a scan will mark up, in characters. Defaults to `2`.
   *
   * A definition is prose *about terms*, which makes it the densest possible
   * text to annotate — a one-letter vocabulary entry turns almost every "a" in
   * a sentence into a link, and a reader stops seeing the sentence. Two keeps
   * real short terms (`hp`, `xp`, a game's `ai`) and drops only the noise.
   * `1` marks up everything; a script that wants a full index should call
   * `resolveText` per word rather than scanning.
   */
  readonly minAnnotatedLength?: number;
}

/**
 * Function words that carry no meaning worth clicking: articles, prepositions,
 * conjunctions. They remain resolvable; a scan simply does not mark them up
 * (see `GlossaryOptions.basicWords`).
 */
export const BASIC_WORDS: readonly string[] = [
  'the', 'a', 'an', 'to', 'from', 'for', 'on', 'of', 'by', 'and', 'or', 'is', 'are', 'has', 'then', 'with',
];

/**
 * An immutable, merged view of every definition source.
 *
 * Build one per surface (the editor for a document; the card table for a
 * match) and resolve everything through it. Building is cheap enough to do
 * once per screen render, and immutability is what lets a React tree hold one
 * in context without stale-definition bugs.
 */
export class Glossary {
  readonly #entries = new Map<string, LexiconEntry>();
  readonly #lexicon: readonly { key: string; entry: LexiconEntry }[];
  readonly #resolvers = new Map<TermKind, (ref: TermRef, scope?: GlossaryScope) => TermSeed | undefined>();
  readonly #definer: TermDefiner | undefined;
  readonly #givens: readonly Glyph[];
  readonly #quiet: ReadonlySet<string>;
  readonly #minLength: number;

  constructor(options: GlossaryOptions = {}) {
    let rank = 0;
    for (const source of standardSources(options)) {
      for (const [key, seed] of Object.entries(source.terms)) {
        const normalised = termKey(key);
        if (normalised.length === 0) continue;
        // A later source always wins the same key; an earlier source never
        // overwrites a later one, so merge order is the whole precedence rule.
        const existing = this.#entries.get(normalised);
        if (existing && existing.rank > rank) continue;
        this.#entries.set(normalised, {
          term: makeTerm(refForSource(source.name, key), key, seed),
          rank,
          ...(isPlainWord(normalised) ? {} : { pattern: new RegExp(escapeRegex(normalised), 'gi') }),
        });
      }
      if (source.resolve) {
        for (const kind of kindsOf(source.name)) this.#resolvers.set(kind, source.resolve);
      }
      rank += 1;
    }
    for (const source of options.sources ?? []) {
      for (const [key, seed] of Object.entries(source.terms)) {
        const normalised = termKey(key);
        if (normalised.length === 0) continue;
        this.#entries.set(normalised, {
          term: makeTerm({ kind: 'rule', name: key }, key, seed),
          rank,
          ...(isPlainWord(normalised) ? {} : { pattern: new RegExp(escapeRegex(normalised), 'gi') }),
        });
      }
      if (source.resolve) {
        for (const kind of ['permanent', 'rule'] as const) this.#resolvers.set(kind, source.resolve);
      }
      rank += 1;
    }

    this.#lexicon = [...this.#entries]
      .map(([key, entry]) => ({ key, entry }))
      // Longest spelling first, so "all players" beats "players".
      .sort((a, b) => b.key.length - a.key.length);
    this.#definer = options.define;
    this.#givens = options.givens ?? [];
    this.#quiet = options.scanAll ? new Set() : new Set((options.basicWords ?? BASIC_WORDS).map(termKey));
    this.#minLength = Math.max(1, options.minAnnotatedLength ?? 2);
  }

  /** Every key this glossary can find in text, longest first. */
  get vocabulary(): readonly string[] {
    return this.#lexicon.map(({ key }) => key);
  }

  /** Whether a word has a definition — the question `annotate` asks. */
  has(word: string): boolean {
    return this.#entries.has(termKey(word));
  }

  /**
   * Resolves a word as it appears in text.
   *
   * `scope` is passed to the host's `define` hook, so a document-scoped buff
   * and a match-scoped permanent resolve correctly.
   */
  resolveText(word: string, scope?: GlossaryScope): Term | undefined {
    const entry = this.#entries.get(termKey(word));
    return entry ? this.#enrich(entry.term, scope) : undefined;
  }

  /**
   * Resolves a reference — a badge, a token, a link — to a definition.
   *
   * The key lookup is by **name**, not by kind: a `permanent` reference to
   * "Rage" should find the buff definition rather than nothing. The host's
   * `define` hook gets the last word either way, which is how a reference
   * shows live state.
   */
  define(ref: TermRef, scope?: GlossaryScope): Term | undefined {
    const base = this.#entries.get(termKey(ref.name))?.term;
    const seed = this.#resolvers.get(ref.kind)?.(ref, scope);
    const resolved = seed ? makeTerm(ref, ref.name, seed) : base;
    return this.#enrich(resolved, scope, ref);
  }

  /**
   * Finds every term in a run of text.
   *
   * Two inputs, and the distinction is the "selecting is game-specific" half of
   * the design:
   *
   * - `givens` are spans the caller already knows (a buff badge, a token an
   *   effect created). They always win over a scan of the same range.
   * - everything else is **scanned**: the longest registered spelling at each
   *   position, word-boundary checked, non-overlapping.
   */
  annotate(text: string, scope?: GlossaryScope, givens: readonly Glyph[] = []): Annotated {
    const spans: TermSpan[] = [];
    const claimed: { start: number; end: number }[] = [];
    const lower = text.toLowerCase();

    for (const glyph of [...this.#givens, ...givens]) {
      if (glyph.start < 0 || glyph.end > text.length || glyph.end <= glyph.start) continue;
      if (claimed.some((range) => rangesOverlap(range, glyph))) continue;
      const resolved = glyph.term ?? this.define(glyph.ref, scope);
      if (!resolved) continue;
      const term: Term = { ...resolved, glyph: glyph.text ?? text.slice(glyph.start, glyph.end) };
      spans.push({ start: glyph.start, end: glyph.end, name: term.ref.name, kind: term.ref.kind, term });
      claimed.push({ start: glyph.start, end: glyph.end });
    }

    const free = (start: number, end: number): boolean =>
      !claimed.some((range) => rangesOverlap(range, { start, end }));

    for (const { key, entry } of this.#lexicon) {
      // A function word resolves on request but is not marked up by a scan.
      if (this.#quiet.has(key)) continue;
      if (key.length < this.#minLength) continue;
      if (entry.pattern) {
        entry.pattern.lastIndex = 0;
        let match = entry.pattern.exec(text);
        while (match) {
          const start = match.index;
          const end = start + match[0].length;
          if (free(start, end)) {
            const term: Term = { ...this.#enrich(entry.term, scope), glyph: text.slice(start, end) };
            spans.push({ start, end, name: term.ref.name, kind: term.ref.kind, term });
            claimed.push({ start, end });
          }
          if (match[0].length === 0) entry.pattern.lastIndex += 1;
          match = entry.pattern.exec(text);
        }
        continue;
      }
      // A plain word must begin and end on a word boundary, so "hp" does not
      // match inside "hpmax".
      let from = 0;
      for (;;) {
        const at = lower.indexOf(key, from);
        if (at === -1) break;
        const end = at + key.length;
        from = at + 1;
        if (!boundaryAt(text, at - 1) || !boundaryAt(text, end)) continue;
        if (!free(at, end)) continue;
        const term: Term = { ...this.#enrich(entry.term, scope), glyph: text.slice(at, end) };
        spans.push({ start: at, end, name: term.ref.name, kind: term.ref.kind, term });
        claimed.push({ start: at, end });
      }
    }

    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    return { text, spans };
  }

  /**
   * Applies the host's `define` hook, which always gets the last word.
   * Generic in the input so a caller that passed a resolved `Term` gets one
   * back, and a caller that may have nothing still may have nothing.
   */
  #enrich<T extends Term | undefined>(term: T, scope?: GlossaryScope, ref?: TermRef): T {
    if (!this.#definer) return term;
    const wanted = ref ?? term?.ref;
    if (!wanted) return term;
    return (this.#definer(wanted, scope, term) ?? term) as T;
  }
}

/* ------------------------------ construction ----------------------------- */

/** The standard sources, in the order they are merged (later wins). */
export function standardSources(options: GlossarySources): GlossarySource[] {
  // Card words come first so a card-shaped word (`cost`) can opt to override
  // the generic reading of the same spelling; keywords then override both,
  // because `Taunt` is a keyword before it is a word.
  //
  // Both default to *empty*, deliberately: the card vocabulary lives in
  // `card.ts`, which depends on this module, so a surface that wants it passes
  // it (see `src/ui/glossary/build.ts`). Defaulting to the word docs keeps a
  // bare glossary useful without reintroducing the cycle.
  const sources: GlossarySource[] = [
    cardWordSource(options.cardWords ?? {}),
    wordSource(options.words ?? WORD_DOCS),
  ];
  if (options.keywords) sources.push(keywordSource(options.keywords));
  if (options.buffs) sources.push(buffSource(options.buffs));
  if (options.zones) sources.push(zoneSource(options.zones));
  if (options.characters) sources.push(characterSource(options.characters));
  return sources;
}

function wordSource(docs: Readonly<Record<string, string>>): GlossarySource {
  return {
    name: 'word',
    terms: Object.fromEntries(
      Object.entries(docs).map(([word, doc]) => [word, { summary: firstLine(doc), details: doc }]),
    ),
  };
}

function cardWordSource(docs: Readonly<Record<string, string>>): GlossarySource {
  return {
    name: 'cardWord',
    terms: Object.fromEntries(
      Object.entries(docs).map(([word, doc]) => [word, { summary: firstLine(doc), details: doc }]),
    ),
  };
}

function keywordSource(registry: KeywordRegistry): GlossarySource {
  const terms: Record<string, TermSeed> = {};
  for (const def of registry.defs) {
    const seed: TermSeed = {
      summary: def.summary,
      details: def.details ?? def.summary,
      facts: [{ label: 'Keyword', value: registry.isHandled(def.name) ? 'in play' : 'named only' }],
    };
    for (const spelling of [def.name, ...(def.aliases ?? [])]) terms[spelling] = seed;
  }
  return { name: 'keyword', terms };
}

function zoneSource(zones: ZoneDictionary): GlossarySource {
  const terms: Record<string, TermSeed> = {};
  for (const name of [...ENGINE_ZONES, ...zones.names]) {
    terms[name] = {
      summary: `The ${name} zone.`,
      details: `\`${name}\` — a zone. Zones hold entities, and an entity is in exactly one zone.`,
    };
  }
  return { name: 'zone', terms };
}

function buffSource(dictionary: BuffDictionary): GlossarySource {
  const terms: Record<string, TermSeed> = {};
  for (const entry of dictionary.entries) {
    terms[entry.name] = {
      summary: entry.def.description ?? firstLine(describeEngineBuff(entry.def)),
      details: describeEngineBuff(entry.def),
      facts: buffFacts(entry.def),
    };
  }
  return {
    name: 'buff',
    terms,
    // A buff the host resolves by id rather than by name — content may name a
    // buff it did not declare inline.
    resolve: (ref) => {
      const def = dictionary.resolve(ref.name);
      return def
        ? { summary: def.description ?? firstLine(describeEngineBuff(def)), details: describeEngineBuff(def), facts: buffFacts(def) }
        : undefined;
    },
  };
}

function characterSource(characters: readonly PermanentDef[]): GlossarySource {
  const terms: Record<string, TermSeed> = {};
  for (const def of characters) {
    if (!def.name) continue;
    terms[def.name] = permanentSeed(def);
  }
  return {
    name: 'character',
    terms,
    // A reference to a permanent (`create 3 Mountain Goblins`) resolves here
    // when the host supplied the catalog, so a name in text shows a stat block.
    resolve: (ref) => {
      const wanted = termKey(ref.name);
      const def = characters.find((candidate) => termKey(candidate.name) === wanted);
      return def ? permanentSeed(def) : undefined;
    },
  };
}

/** Reads a permanent's stat block from a fresh instance, once per build. */
function permanentSeed(def: PermanentDef): TermSeed {
  const built = def.make?.();
  const facts: TermFact[] = [];
  for (const gauge of built?.gauges ?? []) {
    facts.push({ label: gauge.id.toUpperCase(), value: `${gauge.max}` });
  }
  for (const key of built?.statBaseKeys() ?? []) {
    if (key === 'speed') continue;
    const value = built?.stat(key);
    if (value !== undefined) facts.push({ label: capitalise(key), value: String(value) });
  }
  if (built && built.speed !== 0) facts.push({ label: 'Speed', value: String(built.speed) });
  facts.push(...(def.facts ?? []));

  const statLine = facts.map((fact) => `${fact.label} ${fact.value}`).join(' · ');
  const abilities = def.abilities ?? [];
  const details = [
    def.summary ? `> ${def.summary}` : undefined,
    statLine.length > 0 ? statLine : undefined,
    '**Abilities**',
    abilities.length > 0 ? abilities.map((name) => `- ${name}`).join('\n') : '_None._',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n\n');

  return {
    summary: def.summary ?? (statLine.length > 0 ? statLine : 'A permanent.'),
    details,
    facts,
  };
}

/** The kind a standard source's own name implies, so a caller need not restate it. */
function refForSource(sourceName: string, key: string): TermRef {
  return { kind: defaultKindOf(sourceName), name: key };
}

/**
 * The reference kinds a source can answer. A character source answers a
 * `permanent` reference too: "create 3 Mountain Goblins" names a permanent,
 * and the catalog entry that describes it is the character's.
 */
function kindsOf(sourceName: string): readonly TermKind[] {
  switch (sourceName) {
    case 'word':
    case 'cardWord':
      return ['word'];
    case 'keyword':
      return ['keyword'];
    case 'buff':
      return ['buff'];
    case 'zone':
      return ['zone'];
    case 'character':
      return ['character', 'permanent'];
    default:
      return ['permanent', 'rule'];
  }
}

function defaultKindOf(sourceName: string): TermKind {
  return kindsOf(sourceName)[0]!;
}

/* -------------------------------- shaping -------------------------------- */

function makeTerm(ref: TermRef, glyph: string, seed: TermSeed): Term {
  return {
    ref: seed.name && seed.name !== ref.name ? { ...ref, name: seed.name } : ref,
    glyph,
    summary: seed.summary,
    ...(seed.details !== undefined ? { details: seed.details } : {}),
    ...(seed.facts !== undefined ? { facts: seed.facts } : {}),
    ...(seed.examples !== undefined ? { examples: seed.examples } : {}),
    ...(seed.links !== undefined ? { links: seed.links } : {}),
  };
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A plain word is scanned literally; anything else gets a regex. */
const isPlainWord = (key: string): boolean => /^[a-z0-9][a-z0-9 '-]*$/.test(key) && !key.includes('  ');

/** A word boundary: not another word character. */
function boundaryAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true;
  return !/[A-Za-z0-9_']/.test(text[index]!);
}

function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function firstLine(markdown: string): string {
  const line = markdown.split('\n').find((candidate) => candidate.trim().length > 0) ?? markdown;
  return line.replace(/[*`_>]/g, '').trim();
}

function buffFacts(def: BuffDef): TermFact[] {
  const facts: TermFact[] = [{ label: 'Weight', value: String(def.weight) }];
  if (def.stacks) facts.push({ label: 'Stacks', value: 'yes' });
  if (def.removable === false) facts.push({ label: 'Removable', value: 'no' });
  if (def.removedOnDefeat === false) facts.push({ label: 'Survives its wearer', value: 'yes' });
  return facts;
}

function capitalise(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

/* ------------------------------ the defaults ----------------------------- */

/**
 * A glossary with no host content: the language's own words and keywords.
 * The shape the editor falls back to, and what tests exercise.
 */
export function languageGlossary(options: GlossaryOptions = {}): Glossary {
  return new Glossary({ keywords: defaultKeywords(), ...options });
}
