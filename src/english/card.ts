/**
 * The **Card Document** — the card-game surface of the Ability Language.
 *
 * An ability document is a list of `Ability` / `Buff` sections. A card
 * document is the same idea with `Card` sections, so a player authors a
 * whole card — its cost, its body, and its effect — in English:
 *
 * ```
 * Card Fireball
 * Cost 4
 * Spell
 * Deal 6 damage to target enemy character.
 * ```
 *
 * ```
 * Card Shieldbearer
 * Cost 2
 * Creature 1/4
 * Taunt.
 * ```
 *
 * ```
 * Card Elven Archer
 * Cost 1
 * Creature 1/1
 * When this enters play then Deal 1 damage to target enemy character.
 * ```
 *
 * ```
 * Card Cursed Idol
 * Cost 2
 * Creature 2/1
 * When this dies then Deal 2 damage to all enemy characters.
 * ```
 *
 * ## The grammar
 *
 * A card is a heading line (`Card <name>`) followed by **header lines** —
 * `Cost <n>`, exactly one of `Creature <power>/<health>` or `Spell` — then
 * its **effect lines**:
 *
 * - a `Spell`'s effect sentences are written bare, exactly like an
 *   ability's body (`Deal …`, `Heal …`, `Destroy …`, `Add …`);
 * - a creature's **entering-play** effect is written
 *   `When this enters play then <effect>.` — the engine has no summon
 *   event, so the card layer fires it the moment the creature lands;
 * - `When this dies then <effect>.` is an ordinary trigger, like any other
 *   the creature carries on the board (`When this takes damage then …`);
 * - `Taunt.` / `Charge.` are keywords.
 *
 * The event words are the explicit ones, with no card-game shorthand: the
 * same `When …`/`then …` grammar as an ability document, so there is one
 * way to say "this happens when …".
 *
 * `Buff` sections are **document-level**, exactly as in an ability document,
 * and any card may reference them.
 *
 * ## Why this module delegates
 *
 * Every effect line is handed to the real Ability Language compiler
 * (`compileDocument`), so a card's effect *is* an engine `cast` ability —
 * the same code path, the same diagnostics, the same IR. This module only
 * owns what is genuinely card-shaped: the header lines, the sectioning, and
 * a line map that translates the compiler's spans back into the player's
 * document so squiggles land on the words that caused them.
 */
import type { AnyTriggeredAbility, BuffDef, ManualAbility, TargetPattern } from '../engine/index.js';
import type { DocumentIR } from '../ir/index.js';
import type { CharsPhrase, Diagnostic, Doc, Sentence, Span } from './ast.js';
import { compileDocument, type CompileOptions } from './compile.js';
import { completeAt, wordDoc, type Suggestion } from './complete.js';
import { BuffDictionary, emptyDictionary, slug, type DictionaryEntry } from './dictionary.js';
import {
  BUILTIN_KEYWORDS,
  KeywordRegistry,
  arityAccepts,
  arityWords,
  type KeywordDef,
  type KeywordInvocation,
} from './glossary.js';
import { emptyZoneDictionary, type ZoneDictionary } from './zone-dictionary.js';

/* ------------------------------- the shapes ------------------------------ */

export type CardKind = 'creature' | 'spell';

/**
 * The keywords the **card game** acts on, as the compiled card reports them.
 *
 * This is deliberately narrower than `KeywordDef`: a registered keyword may be
 * named in a document without the game implementing it (see
 * `KeywordRegistry.isHandled`), and only implemented ones reach a playable
 * card's keyword list.
 */
export type CardKeyword = 'taunt' | 'charge';

/** A card compiled from the document, ready to hand to a card game. */
export interface CompiledCard {
  readonly id: string;
  readonly name: string;
  readonly cost: number;
  readonly kind: CardKind;
  /** Creature stat line — absent on spells. */
  readonly power?: number;
  readonly health?: number;
  readonly keywords: readonly CardKeyword[];
  /**
   * The card's **play-time** effect: a spell's body, or a creature's
   * `When this enters play …` effect when that effect picks a target (the
   * target is chosen as the card is played — `targeting` below). An arrival
   * effect that picks nothing is a real trigger and lives in `triggers`
   * instead, so it fires however the creature arrives.
   */
  readonly ability?: ManualAbility;
  /**
   * The `from <zone>` clause on the card's own arrival effect, when that
   * effect is the play-time kind. The card layer fires `ability` only when
   * the creature actually arrived from that zone — an effect written
   * `from stack` cannot be reached by playing the card normally.
   */
  readonly entersFrom?: string;
  /**
   * The pattern the effect picks, or `undefined` when the effect finds its
   * own victims (`Deal 2 damage to all enemies.`) — the card layer treats
   * those as untargeted.
   */
  readonly targeting?: TargetPattern;
  /** Triggers the creature carries in play (`When this dies then …`, …). */
  readonly triggers: readonly AnyTriggeredAbility[];
  /** Printed rules text — the card's effect lines, for the card face. */
  readonly rulesText: string;
  /** The card's compiled IR — the share format, produced even with errors. */
  readonly ir?: DocumentIR;
  /** Span of the whole heading line. */
  readonly headingSpan: Span;
  /** Span of just the card's name. */
  readonly nameSpan: Span;
}

export interface CardCompileResult {
  readonly diagnostics: Diagnostic[];
  readonly cards: CompiledCard[];
  /** Name + span of every `Buff` section the document declares. */
  readonly buffs: readonly { readonly name: string; readonly span: Span }[];
  /** The bound `BuffDef`s the document's `Buff` sections compiled to. */
  readonly buffDefs: readonly BuffDef[];
}

export interface CardCompileOptions extends CompileOptions {
  /** Buffs the host supplies beyond the document's own `Buff` lines. */
  readonly dictionary?: BuffDictionary;
  /**
   * The **gameplay keywords** this document may use (`Taunt`, `Charge`,
   * `Discover`, …). The built-ins are always registered; a host adds its own.
   *
   * A keyword registered here is a legal card line even when nothing executes
   * it yet — naming a mechanic before it works is deliberate, so a keyword can
   * be written, explained on hover and saved before its behaviour lands.
   */
  readonly keywords?: KeywordRegistry;
}

/* ------------------------------ source lines ----------------------------- */

interface SourceLine {
  /** The line's full text, without its newline. */
  readonly text: string;
  /** Offset of the line's first character. */
  readonly start: number;
  /** Offset of the line's first non-space character. */
  readonly contentStart: number;
  /** Offset one past the line's last non-space character. */
  readonly contentEnd: number;
  /** 1-based line number. */
  readonly number: number;
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let number = 1;
  while (true) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const raw = text.slice(start, end);
    let cs = 0;
    while (cs < raw.length && /\s/.test(raw[cs]!)) cs += 1;
    let ce = raw.length;
    while (ce > cs && /\s/.test(raw[ce - 1]!)) ce -= 1;
    lines.push({ text: raw, start, contentStart: start + cs, contentEnd: start + ce, number });
    if (end === text.length) break;
    start = end + 1;
    number += 1;
  }
  return lines;
}

/** The line's meaningful text (no leading/trailing whitespace). */
function lineText(line: SourceLine): string {
  return line.text.slice(line.contentStart - line.start, line.contentEnd - line.start);
}

/** True for a blank line or a `#` comment. */
function isIgnorable(line: SourceLine): boolean {
  const trimmed = lineText(line);
  return trimmed.length === 0 || trimmed.startsWith('#');
}

/* ------------------------------- sectioning ------------------------------ */

interface CardSection {
  readonly kind: 'card';
  readonly heading: SourceLine;
  readonly name: string;
  readonly nameSpan: Span;
  readonly lines: SourceLine[];
}

interface BuffSectionSrc {
  readonly kind: 'buff';
  readonly heading: SourceLine;
  readonly name: string;
  readonly nameSpan: Span;
  readonly lines: SourceLine[];
}

type Section = CardSection | BuffSectionSrc;

interface SplitResult {
  readonly sections: Section[];
  readonly cards: CardSection[];
  readonly buffs: BuffSectionSrc[];
  readonly diagnostics: Diagnostic[];
}

/**
 * The name on a heading line, and the span it occupies.
 *
 * A card's name is the whole rest of the line (`Card Elven Archer`); a
 * buff's name stops at the option list (`Buff Frailty (stacks)`).
 */
function headingName(line: SourceLine, keyword: string, stopAtParens: boolean): { name: string; span: Span } {
  const content = lineText(line);
  const rest = content.slice(keyword.length);
  const body = rest.replace(/^[\s:]+/, '');
  const cut = stopAtParens ? body.search(/[(\s]/) : -1;
  const name = (cut === -1 ? body : body.slice(0, cut)).trim();
  const at = line.contentStart + keyword.length + (rest.length - body.length);
  return { name, span: { start: at, end: at + name.length } };
}

function splitSections(text: string): SplitResult {
  const lines = sourceLines(text);
  const sections: Section[] = [];
  const diagnostics: Diagnostic[] = [];
  let current: Section | undefined;

  for (const line of lines) {
    if (isIgnorable(line)) continue;
    const content = lineText(line);
    const heading = /^(card|buff)\b/i.exec(content);
    if (heading) {
      const keyword = heading[1]!;
      const isCard = keyword.toLowerCase() === 'card';
      const { name, span } = headingName(line, keyword, !isCard);
      if (isCard) {
        const section: CardSection = { kind: 'card', heading: line, name, nameSpan: span, lines: [] };
        sections.push(section);
        current = section;
        if (name.length === 0) {
          diagnostics.push({
            severity: 'error',
            message: 'a card needs a name — write "Card <name>", e.g. "Card Fireball"',
            code: 'card-name-missing',
            start: line.contentStart,
            end: line.contentEnd,
          });
        }
      } else {
        const section: BuffSectionSrc = { kind: 'buff', heading: line, name, nameSpan: span, lines: [] };
        sections.push(section);
        current = section;
        if (name.length === 0) {
          diagnostics.push({
            severity: 'error',
            message: 'a buff needs a name — write "Buff <name>", e.g. "Buff Frailty (stacks)"',
            code: 'buff-name-missing',
            start: line.contentStart,
            end: line.contentEnd,
          });
        }
      }
      continue;
    }
    if (!current) {
      diagnostics.push({
        severity: 'error',
        message: `"${content}" belongs to no card — start a card with a "Card <name>" heading, or declare a buff with "Buff <name>"`,
        code: 'card-orphan-line',
        start: line.contentStart,
        end: line.contentEnd,
      });
      continue;
    }
    current.lines.push(line);
  }

  const cards = sections.filter((s): s is CardSection => s.kind === 'card');
  const buffs = sections.filter((s): s is BuffSectionSrc => s.kind === 'buff');
  return { sections, cards, buffs, diagnostics };
}

/* ---------------------- synthetic document + line map -------------------- */

interface Origin {
  /** Where the synthetic line's mapped text starts in the document. */
  readonly contentStart: number;
  /** Where the mapped text ends in the document. */
  readonly contentEnd: number;
  /**
   * How many characters at the start of the synthetic line are *generated*
   * (not present in the document). Diagnostics that land there clamp to
   * `contentStart`.
   */
  readonly synthPrefix: number;
  /** For a generated heading line: the span the whole line maps back to. */
  readonly wholeSpan?: Span;
}

interface SynthLine {
  readonly text: string;
  readonly origin: Origin;
}

interface Synthetic {
  readonly text: string;
  /** Maps an offset in the synthetic text back to the document. */
  map(offset: number): number;
}

/** Copies a source line verbatim into the synthetic document. */
function verbatim(line: SourceLine): SynthLine {
  return {
    text: lineText(line),
    origin: { contentStart: line.contentStart, contentEnd: line.contentEnd, synthPrefix: 0 },
  };
}

function buildSynthetic(lines: readonly SynthLine[], documentLength: number): Synthetic {
  const starts: number[] = [];
  let text = '';
  for (const line of lines) {
    starts.push(text.length);
    text += line.text + '\n';
  }
  const map = (offset: number): number => {
    if (lines.length === 0) return 0;
    let index = 0;
    for (let i = 0; i < starts.length; i += 1) {
      if (starts[i]! <= offset) index = i;
      else break;
    }
    const line = lines[index]!;
    if (line.origin.wholeSpan) {
      return Math.min(offset - starts[index]! + line.origin.wholeSpan.start, line.origin.wholeSpan.end);
    }
    const within = offset - starts[index]!;
    const over = Math.max(0, within - line.origin.synthPrefix);
    return Math.min(Math.max(line.origin.contentStart + over, line.origin.contentStart), line.origin.contentEnd);
  };
  return { text, map: (offset) => Math.min(Math.max(map(offset), 0), documentLength) };
}

function remap(diagnostic: Diagnostic, synthetic: Synthetic, length: number): Diagnostic {
  const start = synthetic.map(diagnostic.start);
  const end = Math.max(synthetic.map(diagnostic.end), start + 1);
  return { ...diagnostic, start, end: Math.min(Math.max(end, start + 1), Math.max(length, start + 1)) };
}

/* ------------------------------- line kinds ------------------------------ */

type LineClass =
  | { readonly kind: 'cost'; readonly value: number }
  | { readonly kind: 'creature'; readonly power: number; readonly health: number }
  | { readonly kind: 'spell' }
  | { readonly kind: 'keyword'; readonly keyword: CardKeyword }
  /**
   * A line naming a **registered keyword** — `Taunt.`, or a keyword with
   * words after it (`Discover 2.`). Separate from the `keyword` variant
   * above because a registered keyword is open-ended: the card layer keeps
   * only the ones it implements, while the line itself is legal and is
   * printed.
   */
  | { readonly kind: 'registered'; readonly invocation: KeywordInvocation }
  /**
   * `When this enters play [from <zone>] then <effect>.` — the creature's
   * arrival effect.
   *
   * The engine has no summon event, so how this compiles depends on the
   * effect: an effect that **picks a target** is the card's play-time
   * effect (the UI chooses the target as the card is played), while one
   * that picks nothing is a real `zone:changed` trigger and fires however
   * the creature arrives. `origin` is the optional `from <zone>` clause,
   * which either guards the play-time effect or rides along in the trigger.
   */
  | {
      readonly kind: 'entersPlay';
      readonly body: string;
      readonly bodyStart: number;
      readonly origin?: string;
      readonly originSpan?: Span;
    }
  /** Any other `When … then …` — a trigger the creature carries in play. */
  | { readonly kind: 'trigger' }
  | { readonly kind: 'effect' }
  /** A word that used to be card shorthand (`Battlecry:`, `Deathrattle:`). */
  | { readonly kind: 'legacy'; readonly word: 'battlecry' | 'deathrattle' }
  | { readonly kind: 'unknown' };

/** `When this enters play [from <zone>] …` — `this`, `this card`, `this character`. */
const ENTERS_PLAY = /^when\s+this(?:\s+(?:card|character))?\s+enters\s+play\b/i;

/**
 * The `<effect>` of a `… then <effect>.` line, and where it starts. Returns
 * an empty body at the end of the line when there is no `then` yet, which
 * the caller reports as a diagnostic.
 */
function thenBody(content: string, contentStart: number, after: number): { body: string; bodyStart: number } {
  const rest = content.slice(after);
  const then = /\bthen\b/i.exec(rest);
  if (!then) return { body: '', bodyStart: contentStart + content.length };
  const tail = rest.slice(then.index + then[0].length);
  const body = tail.replace(/^\s+/, '');
  return {
    body,
    bodyStart: contentStart + after + then.index + then[0].length + (tail.length - body.length),
  };
}

/** The keyword registry used when a caller does not supply one. */
const BUILTIN_REGISTRY = new KeywordRegistry(BUILTIN_KEYWORDS);

/**
 * Classifies one card line by its leading word.
 *
 * A caller editing a document passes its own registry (so a host keyword
 * completes); everything else falls back to the built-ins.
 */
function classify(
  line: SourceLine,
  keywords: KeywordRegistry = BUILTIN_REGISTRY,
  offset = 0,
): LineClass {
  const content = lineText(line);
  const lower = content.toLowerCase();

  if (/^cost\b/.test(lower)) {
    const match = /^cost\s+([0-9]+)\s*\.?\s*$/i.exec(content);
    return match ? { kind: 'cost', value: Number(match[1]) } : { kind: 'unknown' };
  }
  if (/^creature\b/.test(lower)) {
    const match = /^creature\s+([0-9]+)\s*\/\s*([0-9]+)\s*\.?\s*$/i.exec(content);
    return match
      ? { kind: 'creature', power: Number(match[1]), health: Number(match[2]) }
      : { kind: 'unknown' };
  }
  if (/^spell\s*\.?\s*$/.test(lower)) return { kind: 'spell' };
  // A registered keyword: the longest registered spelling at the line's start.
  // The built-ins are registered by default, so this subsumes `Taunt.` and
  // `Charge.`; a host's `Discover(2).` arrives the same way.
  const keyword = keywords.matchAtStart(content, offset);
  if (keyword) {
    const named: CardKeyword | undefined =
      keyword.def.name.toLowerCase() === 'taunt'
        ? 'taunt'
        : keyword.def.name.toLowerCase() === 'charge'
          ? 'charge'
          : undefined;
    // A **bare** keyword keeps the engine-facing shape, so the card layer's
    // `keywords` list and its tests are untouched. Anything with parentheses or
    // a `parse` goes through the open path.
    if (named && !keyword.parenthesised && keyword.trailing.replace(/\.$/, '').trim().length === 0) {
      return { kind: 'keyword', keyword: named };
    }
    return { kind: 'registered', invocation: keyword };
  }
  if (/^battlecry\b/.test(lower)) return { kind: 'legacy', word: 'battlecry' };
  if (/^deathrattle\b/.test(lower)) return { kind: 'legacy', word: 'deathrattle' };
  if (/^when\b/.test(lower)) {
    const match = ENTERS_PLAY.exec(content);
    if (!match) return { kind: 'trigger' };
    // The optional `from <zone>` between the event and `then`.
    const rest = content.slice(match[0].length);
    const from = /^\s+from\s+([A-Za-z][A-Za-z0-9'-]*)/i.exec(rest);
    if (!from) return { kind: 'entersPlay', ...thenBody(content, line.contentStart, match[0].length) };
    const origin = from[1]!;
    const at = match[0].length + from.index + from[0].length - origin.length;
    return {
      kind: 'entersPlay',
      ...thenBody(content, line.contentStart, match[0].length + from.index + from[0].length),
      origin,
      originSpan: { start: line.contentStart + at, end: line.contentStart + at + origin.length },
    };
  }
  if (/^(cost|creature|spell|taunt|charge|card|buff)\b/.test(lower)) return { kind: 'unknown' };
  return { kind: 'effect' };
}

/** The synthetic line an effect line contributes, or `undefined`. */
function synthFor(line: SourceLine, cls: LineClass): SynthLine | undefined {
  switch (cls.kind) {
    case 'entersPlay':
      // The body is an ordinary sentence: it joins the card's `cast`.
      return {
        text: cls.body,
        origin: { contentStart: cls.bodyStart, contentEnd: line.contentEnd, synthPrefix: 0 },
      };
    case 'trigger':
    case 'effect':
      return verbatim(line);
    default:
      return undefined;
  }
}

/* ------------------------------- compiling ------------------------------- */

interface CardParse {
  readonly cost: number | undefined;
  readonly kind: CardKind | undefined;
  readonly power: number | undefined;
  readonly health: number | undefined;
  readonly keywords: CardKeyword[];
  /** Lines naming a registered keyword — legal, printed, maybe not executed. */
  readonly registered: { readonly line: SourceLine; readonly cls: Extract<LineClass, { kind: 'registered' }> }[];
  readonly diagnostics: Diagnostic[];
  readonly effectLines: readonly { readonly line: SourceLine; readonly cls: LineClass }[];
  /** Printed effect text, for the card face. */
  readonly rulesText: string;
}

function parseCard(section: CardSection, registry: KeywordRegistry): CardParse {
  const diagnostics: Diagnostic[] = [];
  const keywords: CardKeyword[] = [];
  const registered: { line: SourceLine; cls: Extract<LineClass, { kind: 'registered' }> }[] = [];
  const effectLines: { line: SourceLine; cls: LineClass }[] = [];
  const keywordLines: SourceLine[] = [];
  const legacyLines: { line: SourceLine; word: 'battlecry' | 'deathrattle' }[] = [];
  let cost: number | undefined;
  let kind: CardKind | undefined;
  let power: number | undefined;
  let health: number | undefined;
  let sawKindLine: SourceLine | undefined;
  let sawCostLine: SourceLine | undefined;
  const text: string[] = [];

  const fail = (line: SourceLine, message: string, code: string): void => {
    diagnostics.push({ severity: 'error', message, code, start: line.contentStart, end: line.contentEnd });
  };

  for (const line of section.lines) {
    const cls = classify(line, registry, line.contentStart);
    switch (cls.kind) {
      case 'cost':
        if (sawCostLine) {
          fail(line, `"${section.name}" already says its cost — keep one "Cost <n>" line`, 'card-cost-duplicate');
          break;
        }
        sawCostLine = line;
        cost = cls.value;
        break;
      case 'creature':
      case 'spell':
        if (sawKindLine) {
          fail(
            line,
            `"${section.name}" already says it is a ${kind} — a card is either a "Creature <power>/<health>" or a "Spell"`,
            'card-kind-duplicate',
          );
          break;
        }
        sawKindLine = line;
        if (cls.kind === 'creature') {
          kind = 'creature';
          power = cls.power;
          health = cls.health;
        } else {
          kind = 'spell';
        }
        break;
      case 'keyword':
        keywords.push(cls.keyword);
        keywordLines.push(line);
        text.push(cls.keyword === 'taunt' ? 'Taunt.' : 'Charge.');
        break;
      case 'registered':
        registered.push({ line, cls });
        keywordLines.push(line);
        text.push(lineText(line).replace(/\s+$/, ''));
        // Arguments a keyword cannot read are a write error, not something to
        // ignore: `Charge(2).` quietly behaving like `Charge.` would hide a
        // mechanic the author believes exists.
        // Order matters here, and getting it wrong was a real bug: a keyword
        // written `Discover 2.` has **trailing text and zero arguments**, so an
        // arity check that ran first reported "takes 1 argument, but got 0" —
        // true, and useless. The question the author needs answered is where the
        // argument goes, so that is checked first.
        if (cls.invocation.unterminated) {
          fail(
            line,
            `"${cls.invocation.spelling}(" is never closed — write "${cls.invocation.spelling}(…)"`,
            'card-keyword-unclosed',
          );
        } else if (cls.invocation.trailing.replace(/\.$/, '').trim().length > 0) {
          fail(
            line,
            cls.invocation.parenthesised
              ? `"${lineText(line)}" has words after "${cls.invocation.spelling}(…)" — the arguments go inside the parentheses`
              : `"${cls.invocation.spelling}" takes its arguments in parentheses — write "${cls.invocation.spelling}(${cls.invocation.trailing.replace(/\.$/, '').trim()})."`,
            'card-keyword-trailing',
          );
        } else if (cls.invocation.args.length > 0 && cls.invocation.def.parse === undefined) {
          fail(
            line,
            `"${cls.invocation.spelling}" takes no arguments yet — write "${cls.invocation.spelling}." on its own`,
            'card-keyword-argument',
          );
        } else if (!arityAccepts(cls.invocation.def, cls.invocation.args.length)) {
          fail(
            line,
            `"${cls.invocation.spelling}" takes ${arityWords(cls.invocation.def)}, but got ${cls.invocation.args.length}`,
            'card-keyword-arity',
          );
        }
        break;
      case 'entersPlay':
      case 'trigger':
      case 'effect':
        effectLines.push({ line, cls });
        text.push(lineText(line));
        break;
      case 'legacy':
        legacyLines.push({ line, word: cls.word });
        break;
      case 'unknown': {
        const known = registry.names.map((name) => `${name}.`).join(', ');
        fail(
          line,
          `"${lineText(line)}" is not a card line — use "Cost <n>", "Creature <power>/<health>", "Spell", one of the keywords (${known}), "When … then …", or an effect sentence`,
          'card-unknown-line',
        );
        break;
      }
    }
  }

  if (!sawCostLine) {
    fail(section.heading, `"${section.name}" has no cost — add a "Cost <n>" line`, 'card-cost-missing');
  }
  if (!sawKindLine) {
    fail(
      section.heading,
      `"${section.name}" does not say what it is — add "Creature <power>/<health>" or "Spell"`,
      'card-kind-missing',
    );
  }

  // The retired shorthand: name the explicit event to write instead. The
  // kind is only known after the whole card is read, so this waits.
  for (const { line, word } of legacyLines) {
    const explicit = word === 'battlecry' ? 'When this enters play then <effect>' : 'When this dies then <effect>';
    fail(
      line,
      kind === 'spell'
        ? `"${word}:" belongs to creatures — a spell writes its effect as a plain sentence, e.g. "Deal 6 damage to target enemy character."`
        : `"${word}:" is card shorthand this language does not use — write "${explicit}" instead`,
      `card-legacy-${word}`,
    );
  }

  if (kind === 'spell') {
    for (const { line, cls } of effectLines) {
      if (cls.kind === 'entersPlay') {
        fail(line, 'a spell never enters play — write its effect as a plain sentence', 'card-spell-enters-play');
      } else if (cls.kind === 'trigger') {
        fail(line, 'a spell cannot carry a "When …" trigger — put it on a creature, or on a "Buff" section', 'card-spell-trigger');
      }
    }
    for (const { line, cls } of registered) {
      if (allowsKind(cls.invocation.def, kind)) continue;
      fail(
        line,
        `a spell cannot be ${cls.invocation.def.name} — ${cls.invocation.def.summary.replace(/\.$/, '')}, so it belongs on a creature`,
        'card-spell-keyword',
      );
    }
    for (const line of keywordLines) {
      if (registered.some((entry) => entry.line === line)) continue;
      fail(line, 'a spell cannot be a taunting or charging creature — keywords belong to creatures', 'card-spell-keyword');
    }
    if (effectLines.length === 0 && legacyLines.length === 0) {
      fail(
        section.heading,
        `"${section.name}" is a spell with no effect — add an effect sentence, e.g. "Deal 6 damage to target enemy character."`,
        'card-spell-empty',
      );
    }
  } else if (kind === 'creature') {
    for (const { line, cls } of effectLines) {
      if (cls.kind === 'entersPlay') {
        if (cls.body.length === 0) {
          fail(
            line,
            `"When this enters play" needs an effect — write "When this enters play then <effect>", e.g. "When this enters play then Deal 1 damage to target enemy character."`,
            'card-enters-play-empty',
          );
        }
        continue;
      }
      if (cls.kind !== 'effect') continue;
      fail(
        line,
        `a creature's one-shot effect needs a word to say *when* it happens — write "When this enters play then ${lineText(line)}" for entering play, "When this dies then ${lineText(line)}" for dying, or "When … then …" for a standing trigger`,
        'card-creature-effect-bare',
      );
    }
  }

  return {
    cost,
    kind,
    power,
    health,
    keywords,
    registered,
    diagnostics,
    effectLines,
    rulesText: text.join(' '),
  };
}

/** Whether a keyword may appear on a card of this kind. */
function allowsKind(def: KeywordDef, kind: CardKind | undefined): boolean {
  if (kind === undefined) return true;
  return (def.cardKinds ?? ['creature']).includes(kind);
}

/** True when any sentence picks the ability's target (`target …`). */
function picksTarget(sentence: Sentence): boolean {
  switch (sentence.kind) {
    case 'deal':
    case 'heal':
    case 'destroy':
    case 'addBuff':
    case 'removeBuff':
    case 'toggleBuff':
      return sentence.chars.quantifier === 'target';
    case 'result':
      return false;
  }
}

export function compileCardDocument(text: string, options: CardCompileOptions = {}): CardCompileResult {
  const hostDictionary = options.dictionary ?? emptyDictionary();
  // The built-ins are always registered, so `Taunt.` compiles whether or not
  // the host supplied a registry; a host registration of the same name wins,
  // because a later `add` replaces the spelling.
  const keywords = new KeywordRegistry(BUILTIN_KEYWORDS);
  for (const def of options.keywords?.defs ?? []) keywords.add(def);
  const split = splitSections(text);
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  const push = (diagnostic: Diagnostic): void => {
    const key = `${diagnostic.code}|${diagnostic.start}|${diagnostic.end}|${diagnostic.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };
  for (const diagnostic of split.diagnostics) push(diagnostic);

  // Declared buffs are document-level: compile them once as a library, so a
  // buff's body is checked in one place and its `BuffDef` is built once.
  const libraryLines: SynthLine[] = [
    {
      text: 'Ability Card Library',
      origin: { contentStart: 0, contentEnd: 0, synthPrefix: 0, wholeSpan: { start: 0, end: 0 } },
    },
    ...split.buffs.flatMap((section) => [verbatim(section.heading), ...section.lines.map(verbatim)]),
  ];
  let buffDefs: readonly BuffDef[] = [];
  const used = new Set<string>();
  if (split.buffs.length > 0) {
    const library = buildSynthetic(libraryLines, text.length);
    const compiled = compileDocument(library.text, { ...options, dictionary: hostDictionary });
    buffDefs = compiled.buffs;
    collectBuffReferences(compiled.doc, used);
    for (const diagnostic of compiled.diagnostics) {
      // Unused-buff is answered below, from the whole document at once.
      if (diagnostic.code === 'unused-buff') continue;
      push(remap(diagnostic, library, text.length));
    }
  }

  // Every card compiles as its own ability document, with the document's
  // buff headings appended (names only) so `Add <buff>` resolves.
  const cards: CompiledCard[] = [];
  const zones = options.zones ?? emptyZoneDictionary();
  for (const section of split.cards) {
    const parsed = parseCard(section, keywords);
    for (const diagnostic of parsed.diagnostics) push(diagnostic);

    // How each arrival effect compiles — see `arrivalLine`.
    const arrivalLines: SynthLine[] = [];
    let entersFrom: string | undefined;
    let oneShot = false;
    for (const { line, cls } of parsed.effectLines) {
      if (cls.kind === 'effect') {
        arrivalLines.push(verbatim(line));
        oneShot = true;
        continue;
      }
      if (cls.kind === 'trigger') {
        // `When this dies then …` and other standing triggers: the ability
        // grammar compiles them, and the creature carries them in play.
        arrivalLines.push(verbatim(line));
        continue;
      }
      if (cls.kind !== 'entersPlay') continue;
      if (cls.body.length === 0) continue; // reported by parseCard
      if (cls.origin !== undefined && !zones.has(cls.origin)) {
        const known = zones.names.map((name) => `"${name}"`).join(', ');
        const suggestions = zones.suggest(cls.origin);
        push({
          severity: 'error',
          message:
            `unknown zone "${cls.origin}" — known zones are ${known}` +
            (suggestions.length > 0 ? `. Did you mean ${suggestions.map((s) => `"${s}"`).join(' or ')}?` : ''),
          code: 'unknown-zone',
          start: cls.originSpan?.start ?? line.contentStart,
          end: cls.originSpan?.end ?? line.contentEnd,
        });
      }
      // An effect that picks a target cannot be a plain trigger — the
      // player chooses the target as the card is played — so it joins the
      // card's cast. One that picks nothing is a real zone trigger and
      // fires however the creature arrives, `from <zone>` and all.
      const body = compileDocument(`Ability ${section.name || 'Card'}\n${cls.body}`, {
        ...options,
        dictionary: hostDictionary,
      });
      const sentences = body.doc.abilities[0]?.sentences ?? [];
      if (sentences.length === 1 && !picksTarget(sentences[0]!)) {
        arrivalLines.push(verbatim(line));
        continue;
      }
      oneShot = true;
      entersFrom ??= cls.origin;
      arrivalLines.push({
        text: cls.body,
        origin: { contentStart: cls.bodyStart, contentEnd: line.contentEnd, synthPrefix: 0 },
      });
    }

    const lines: SynthLine[] = [
      {
        text: `Ability ${section.name || 'Card'}`,
        origin: {
          contentStart: section.heading.contentStart,
          contentEnd: section.heading.contentEnd,
          synthPrefix: 0,
          wholeSpan: { start: section.heading.contentStart, end: section.heading.contentEnd },
        },
      },
      ...arrivalLines,
      ...split.buffs.map((buff) => verbatim(buff.heading)),
    ];
    const synthetic = buildSynthetic(lines, text.length);
    const compiled = compileDocument(synthetic.text, { ...options, dictionary: hostDictionary });
    collectBuffReferences(compiled.doc, used);
    for (const diagnostic of compiled.diagnostics) {
      if (diagnostic.code === 'unused-buff') continue;
      push(remap(diagnostic, synthetic, text.length));
    }

    const document = compiled.doc.abilities[0];
    const picks = document?.sentences.some(picksTarget) === true || (document?.targets?.length ?? 0) > 0;
    const ability = oneShot ? compiled.abilities[0] : undefined;
    cards.push({
      id: slug(section.name),
      name: section.name,
      cost: parsed.cost ?? 0,
      kind: parsed.kind ?? 'spell',
      ...(parsed.kind === 'creature'
        ? { power: parsed.power ?? 0, health: parsed.health ?? 1 }
        : {}),
      keywords: parsed.keywords,
      ...(ability ? { ability } : {}),
      ...(ability && picks ? { targeting: ability.targeting } : {}),
      ...(entersFrom !== undefined ? { entersFrom } : {}),
      triggers: compiled.triggers,
      rulesText: parsed.rulesText,
      ...(compiled.ir ? { ir: compiled.ir } : {}),
      headingSpan: { start: section.heading.contentStart, end: section.heading.contentEnd },
      nameSpan: section.nameSpan,
    });
  }

  // A declared buff nothing references gets one warning. The compiler's own
  // scan does not look inside trigger effects, so this reads the AST.
  for (const section of split.buffs) {
    if (used.has(slug(section.name)) || used.has(section.name.toLowerCase())) continue;
    push({
      severity: 'warning',
      message: `"${section.name}" is declared but no card adds, removes or checks it`,
      code: 'unused-buff',
      start: section.nameSpan.start,
      end: section.nameSpan.end,
    });
  }

  return {
    diagnostics: sortDiagnostics(diagnostics),
    cards,
    buffs: split.buffs.map((section) => ({ name: section.name, span: section.nameSpan })),
    buffDefs,
  };
}

/* -------------------------------- helpers -------------------------------- */

/**
 * Every buff name a compiled document references — from sentences, from
 * `with <buff>` filters, and from trigger effects.
 *
 * `compileDocument`'s own unused-buff scan walks abilities' and buffs'
 * sentences, but a buff named only inside a `When … then add X to this.`
 * effect lives on a trigger's effect instead. Reading the AST here keeps
 * the card editor from warning about a buff that is unmistakably used.
 */
function collectBuffReferences(doc: Doc, into: Set<string>): void {
  const note = (name: string): void => {
    into.add(name.toLowerCase());
    into.add(slug(name));
  };
  const visitChars = (chars: CharsPhrase): void => {
    for (const condition of chars.withClause?.conditions ?? []) {
      if (condition.kind === 'buff') note(condition.buffName);
    }
  };
  const visit = (sentence: Sentence): void => {
    switch (sentence.kind) {
      case 'addBuff':
      case 'removeBuff':
      case 'toggleBuff':
        note(sentence.buffName);
        visitChars(sentence.chars);
        break;
      case 'deal':
      case 'heal':
      case 'destroy':
        visitChars(sentence.chars);
        break;
      case 'result':
        break;
    }
  };
  for (const ability of doc.abilities) for (const sentence of ability.sentences) visit(sentence);
  for (const buff of doc.buffs) {
    for (const sentence of buff.sentences) visit(sentence);
    for (const trigger of buff.triggers) for (const effect of trigger.effects) visit(effect);
  }
  for (const trigger of doc.triggers) for (const effect of trigger.effects) visit(effect);
}

/** The host dictionary extended with the document's own buff declarations. */
function withDeclaredBuffs(dictionary: BuffDictionary, declared: readonly BuffSectionSrc[]): BuffDictionary {
  if (declared.length === 0) return dictionary;
  const entries: DictionaryEntry[] = [
    ...declared.map((section) => ({ name: section.name, def: { name: section.name, weight: 1 } })),
    ...dictionary.entries,
  ];
  return new BuffDictionary(entries);
}

function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => a.start - b.start || a.end - b.end);
}

/* ------------------------------- completion ------------------------------ */

/** Card heading words, shown at the start of a line inside a card. */
export const CARD_LINE_STARTERS = [
  'Cost',
  'Creature',
  'Spell',
  'Taunt.',
  'Charge.',
  'When',
  'Buff',
] as const;

/** Hover help for the card-shaped words. */
export const CARD_WORD_DOCS: Readonly<Record<string, string>> = {
  card: '`Card <name>` starts a card section. Everything until the next "Card"/"Buff" heading belongs to it.',
  cost: '`Cost <n>` — the mana the card costs to play. Required, once per card.',
  creature: '`Creature <power>/<health>` — a minion with a stat line, e.g. "Creature 3/2".',
  spell: '`Spell` — a one-shot card. Its effect sentences are written plainly, without a prefix.',
  // Derived from the registered keywords, so the wording lives in one place
  // (`src/english/glossary.ts`).
  taunt: BUILTIN_KEYWORDS.find((def) => def.name === 'Taunt')!.details!,
  charge: BUILTIN_KEYWORDS.find((def) => def.name === 'Charge')!.details!,
  when: '`When … then …` names the event and what happens: "When this enters play then …", "When this dies then …", "When this takes damage then …".',
  enters: '`When this enters play then <effect>.` — the creature\'s effect the moment it lands. It may pick a target, exactly like an ability.',
  play: '`enters play` — the moment the creature is put onto the board.',
  dies: '`When this dies then <effect>.` — the creature\'s last words, a trigger on `character:destroyed`.',
  buff: '`Buff <name> (stacks)` declares a buff the document\'s cards can add. Buff sections are document-level, like in an ability document.',
};

/** Vocabulary help for a word in a card document (card words first). */
export function cardWordDoc(word: string): string | undefined {
  return CARD_WORD_DOCS[word.toLowerCase()] ?? wordDoc(word);
}

function suggestion(label: string, doc?: string): Suggestion {
  return { label, kind: 'keyword', ...(doc ? { detail: doc.split('\n')[0], doc } : {}) };
}

const HEADING_SUGGESTIONS: readonly Suggestion[] = [
  suggestion('Card', CARD_WORD_DOCS['card']),
  suggestion('Buff', CARD_WORD_DOCS['buff']),
];

const STARTER_SUGGESTIONS: readonly Suggestion[] = CARD_LINE_STARTERS.map((label) =>
  suggestion(label, CARD_WORD_DOCS[label.replace(/[:.]$/, '').toLowerCase()]),
);

/** True for the first word of a sentence the ability grammar understands. */
const SENTENCE_FIRST_WORDS = new Set([
  'deal',
  'heal',
  'destroy',
  'add',
  'remove',
  'toggle',
  'you',
  'all',
  'if',
  'repeat',
  'when',
  'incoming',
  'outgoing',
  'available',
]);

/** Suggestions for the start of a line inside a card. */
function lineStarters(
  section: CardSection | undefined,
  keywords: KeywordRegistry = BUILTIN_REGISTRY,
): Suggestion[] {
  if (!section) return [...HEADING_SUGGESTIONS];
  let kind: CardKind | undefined;
  let hasCost = false;
  for (const line of section.lines) {
    const cls = classify(line, BUILTIN_REGISTRY, line.contentStart);
    if (cls.kind === 'cost') hasCost = true;
    if (cls.kind === 'creature') kind = 'creature';
    if (cls.kind === 'spell') kind = 'spell';
  }
  const byLabel = (label: string): Suggestion =>
    STARTER_SUGGESTIONS.find((s) => s.label === label) ?? suggestion(label, cardWordDoc(label));
  const out: Suggestion[] = [];
  if (!hasCost) out.push(byLabel('Cost'));
  if (!kind) {
    out.push(byLabel('Creature'), byLabel('Spell'));
  } else if (kind === 'creature') {
    // A creature's one-shot effect names its event (`When … then …`), plus
    // every keyword registered for creatures.
    for (const def of keywords.defs) {
      if (!(def.cardKinds ?? ['creature']).includes('creature')) continue;
      // A keyword that takes arguments completes as `Discover(…)`, so the
      // author sees there is something to fill in rather than a bare word
      // that will then be rejected for having no argument.
      const needsArgs = (def.arity?.[0] ?? 0) > 0;
      const label = needsArgs ? `${def.name}(…)` : `${def.name}.`;
      out.push(suggestion(label, def.details ?? def.summary));
    }
    out.push(byLabel('When'));
  } else {
    // A spell's body is ordinary sentences — no `When …`.
    for (const label of ['Deal', 'Heal', 'Destroy', 'Add', 'Remove', 'Toggle', 'You', 'All', 'If', 'Repeat']) {
      out.push(byLabel(label));
    }
  }
  out.push(byLabel('Buff'));
  return out;
}

/** Whole event phrases offered on a `When …` line before its `then`. */
const TRIGGER_EVENT_SUGGESTIONS: readonly Suggestion[] = [
  suggestion('this enters play', 'When this enters play then <effect> — fires the moment the creature lands.'),
  suggestion('this dies', 'When this dies then <effect> — the creature\'s last words.'),
  suggestion('this takes damage', 'When this takes damage then <effect>.'),
  suggestion('this is healed', 'When this is healed then <effect>.'),
  suggestion('a character dies', 'When a character dies then <effect>.'),
  suggestion('1 or more characters die', 'When 1 or more characters die then <effect>.'),
  suggestion('characters survive', 'When characters survive then <effect>.'),
];

/**
 * Position-aware completion for a card document. Header lines get card
 * words; every effect line is delegated to the Ability Language's own
 * `completeAt`, so an entering-play effect, an on-death trigger or a spell
 * sentence completes exactly as it would in an ability document.
 */
export function completeCardAt(
  text: string,
  offset: number,
  dictionary: BuffDictionary = emptyDictionary(),
  zones: ZoneDictionary = emptyZoneDictionary(),
  keywords: KeywordRegistry = BUILTIN_REGISTRY,
): Suggestion[] {
  const lines = sourceLines(text);
  let line = lines[0];
  for (const candidate of lines) {
    if (candidate.start <= offset) line = candidate;
    else break;
  }
  if (!line) return [...HEADING_SUGGESTIONS];

  const before = text.slice(line.contentStart, offset);
  const trimmed = before.trim();
  const lower = trimmed.toLowerCase();

  const split = splitSections(text);
  const declared = withDeclaredBuffs(dictionary, split.buffs);
  const section = [...split.sections].reverse().find((candidate) => candidate.heading.start <= line.start);

  // A heading line: the name after "Card"/"Buff" is free text.
  if (section && section.heading.start === line.start) {
    if (/^buff\b/i.test(trimmed)) {
      return trimmed.includes('(') && !trimmed.includes(')') ? [suggestion('stacks'), suggestion('weight')] : [];
    }
    if (/^card\b/i.test(trimmed)) return [];
    return [...HEADING_SUGGESTIONS];
  }

  // Inside a Buff section the ability grammar owns the whole body.
  if (section?.kind === 'buff') {
    const body = text.slice(section.heading.contentEnd, offset).replace(/^\s*\n/, '');
    const head = `Buff ${section.name}\n`;
    return completeAt(`${head}${body}\n`, head.length + body.length, declared, zones);
  }

  // A fresh line: offer the card's header/effect starters.
  if (trimmed.length === 0) {
    return lineStarters(section?.kind === 'card' ? section : undefined, keywords);
  }

  if (/^cost\b/i.test(lower) || /^creature\b/i.test(lower)) return [];
  // Already a keyword line: nothing more to offer on it.
  if (keywords.matchAtStart(trimmed)) return [];
  if (/^spell\s*\.?\s*$/i.test(lower)) {
    return lineStarters(section?.kind === 'card' ? section : undefined, keywords);
  }
  // A partial card word ("Battl") still offers the card's starters; a
  // sentence word is handed to the ability grammar below.
  if (!/\s/.test(trimmed) && !SENTENCE_FIRST_WORDS.has(lower)) {
    return lineStarters(section?.kind === 'card' ? section : undefined, keywords);
  }

  // A `When …` line: before its `then`, offer whole event phrases; after
  // `then`, the effect is an ordinary sentence and the ability grammar
  // completes it. An entering-play line is the same shape.
  const cls = classify(line, keywords, line.contentStart);
  if (cls.kind === 'entersPlay' || cls.kind === 'trigger') {
    if (cls.kind === 'entersPlay' && /\bfrom\s+[A-Za-z'-]*$/i.test(before)) {
      // `… enters play from <zone>` — the origin is a zone name.
      return zoneSuggestions(zones, typedWord(before));
    }
    if (!THEN_WORD.test(before)) {
      return cls.kind === 'entersPlay'
        ? [
            suggestion('from', 'Name where it arrived from: "when this enters play from active then …".'),
            suggestion('then', 'Follow the event with "then <effect>" — e.g. "When this enters play then Deal 1 damage to target enemy character."'),
          ]
        : [...TRIGGER_EVENT_SUGGESTIONS];
    }
    const context = buildEffectContext(section?.kind === 'card' ? section : undefined, line, completionPrefix(cls, before));
    return completeAt(context, context.length, declared, zones);
  }

  const card = section?.kind === 'card' ? section : undefined;
  const context = buildEffectContext(card, line, completionPrefix(cls, before));
  return completeAt(context, context.length, declared);
}

const THEN_WORD = /\bthen\b/i;

/** The partial word being typed at the end of `before`, lowercased. */
function typedWord(before: string): string {
  const match = /([A-Za-z][A-Za-z0-9'-]*)$/.exec(before);
  return match ? match[1]!.toLowerCase() : '';
}

/** The zone names a game declared, as completion items. */
function zoneSuggestions(zones: ZoneDictionary, prefix: string): Suggestion[] {
  const names = prefix ? zones.names.filter((name) => name.toLowerCase().startsWith(prefix)) : zones.names;
  return names.map((name) => suggestion(name, `\`${name}\` — a zone this game declares.`));
}

/**
 * Builds the Ability Language document for the effect line under the
 * cursor: the card's own `Ability` heading, every earlier effect line of
 * the card (transformed the way the compiler transforms them), and the text
 * of the current line up to the cursor.
 */
function buildEffectContext(card: CardSection | undefined, line: SourceLine, before: string): string {
  const parts: string[] = [`Ability ${card?.name ?? 'Card'}`];
  for (const earlier of card?.lines ?? []) {
    if (earlier.start >= line.start) break;
    const synth = synthFor(earlier, classify(earlier, BUILTIN_REGISTRY, earlier.contentStart));
    if (synth) parts.push(synth.text);
  }
  parts.push(before);
  return `${parts.join('\n')}\n`;
}

/**
 * The text to *complete* for the current line — which is not always the
 * text as written. A `When … then …` effect is the part after `then`;
 * handing the grammar that alone is what lets `When this enters play then
 * Deal 2 ` suggest `damage`.
 */
function completionPrefix(cls: LineClass, before: string): string {
  if (cls.kind === 'entersPlay' || cls.kind === 'trigger') {
    const then = THEN_WORD.exec(before);
    if (then) return before.slice(then.index + then[0].length).replace(/^\s+/, '');
  }
  return before;
}
