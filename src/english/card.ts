/**
 * The **Card Document** — the card-game surface of the Ability Language.
 *
 * An ability document is a list of `Ability` / `Buff` sections. A card
 * document is the same idea with `Card` sections, so a player authors a
 * whole card — its cost, its body, and its effect — in English:
 *
 * ```
 * Card Fireball
 * { "cost": 4, "type": "spell" }
 * Deal 6 damage to target enemy character.
 * ```
 *
 * ```
 * Card Shieldbearer
 * { "cost": 2, "type": "creature", "creatureConfig": { "power": 1, "health": 4 } }
 * Taunt.
 * ```
 *
 * ```
 * Card Elven Archer
 * { "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 1 } }
 * When this enters play then Deal 1 damage to target enemy character.
 * ```
 *
 * ```
 * Creature Giant Golem
 * { "type": "creature", "creatureConfig": { "power": 6, "health": 6 } }
 * Taunt.
 * ```
 *
 * ## The grammar
 *
 * A card is a heading line (`Card <name>`) followed by a **header** — a JSON
 * object holding the card's data: `"cost"`, `"type"` (`"spell"` or `"creature"`),
 * and for settings that belong to a kind of permanent, a key of their own
 * (`"creatureConfig": { "power", "health" }`) — then its **effect lines**, which
 * are raw text in the language. A `Creature <name>` definition (a token that
 * effects make) takes the same header without a cost. The header may be one line
 * or spread over several.
 *
 * - a `Spell`'s effect sentences are written bare, exactly like an
 *   ability's body (`Deal …`, `Heal …`, `Destroy …`, `Add …`);
 * - a creature's **entering-play** effect is written
 *   `When this enters play then <effect>.` — the engine has no summon
 *   event, so the card layer fires it the moment the creature lands;
 * - `When this is destroyed then <effect>.` is an ordinary trigger, like any other
 *   the creature carries on the board (`When this is damaged then …`);
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
import type { AnyTriggeredAbility, BuffDef, ManualAbility, TargetPattern, ZoneDef } from '../engine/index.js';
import type { ContestIR, DocumentIR, ZoneBinding } from '../ir/index.js';
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
import { emptyZoneDictionary, ZoneDictionary } from './zone-dictionary.js';

/* ------------------------------- the shapes ------------------------------ */

export type CardKind = 'creature' | 'spell';

/**
 * Exceptions to the standing "a creature cannot act the turn it enters play" rule, as a
 * creature card states them:
 *
 * - `This can act the turn it enters play.` — `act`
 * - `This can attack the turn it enters play.` — `attack`
 * - `This can use Open Wide the turn it enters play.` — `abilities: ['Open Wide']`
 * - `This can use any ability the turn it enters play.` — `abilities: ['*']`
 *   (every ability other than attacking, which has its own line)
 * - `Creatures you own can act / attack the turn they enter play.` — `ownedAct` / `ownedAttack`,
 *   which hold for as long as the creature is in play
 */
export interface EntryRules {
  readonly act?: true;
  readonly attack?: true;
  readonly abilities?: readonly string[];
  readonly ownedAct?: true;
  readonly ownedAttack?: true;
}

/** Reads one `…the turn it enters play.` exception line, or `undefined` if it is not one. */
export function parseEntryRule(content: string): EntryRules | undefined {
  const text = content.trim().replace(/\.$/, '');
  let match = /^this can (act|attack) the turn it enters play$/i.exec(text);
  if (match) return match[1]!.toLowerCase() === 'act' ? { act: true } : { attack: true };
  // `This can use any ability …` — and the shorter `This can any ability …`.
  if (/^this can (?:use )?any ability the turn it enters play$/i.test(text)) return { abilities: ['*'] };
  match = /^this can use (.+?) the turn it enters play$/i.exec(text);
  if (match) return { abilities: [match[1]!] };
  match = /^creatures you own can (act|attack) the turn (?:they|it) enters? play$/i.exec(text);
  if (match) return match[1]!.toLowerCase() === 'act' ? { ownedAct: true } : { ownedAttack: true };
  return undefined;
}

function mergeEntry(a: EntryRules, b: EntryRules): EntryRules {
  return {
    ...a,
    ...b,
    ...(a.abilities || b.abilities ? { abilities: [...(a.abilities ?? []), ...(b.abilities ?? [])] } : {}),
  };
}

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
  /** A creature definition that effects make (`Creature Giant Golem 6/6`), not a card for a deck. */
  readonly token?: true;
  /** What it may do the turn it enters play, despite the standing rule. */
  readonly entry?: EntryRules;
  /** Abilities the card gives itself (`Suspend: Move this card to the Suspend zone …`), usable from the hand. */
  readonly handAbilities?: readonly { readonly name: string; readonly ability: ManualAbility }[];
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
  /** Triggers the creature carries in play (`When this is destroyed then …`, …). */
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
  /** The zones the document declares (`Zone Suspend (per-player, public)`). */
  readonly zoneDefs: readonly ZoneDef[];
  /** The rules each `Zone` section keeps, to apply once a game's zones and players exist. */
  readonly zones: readonly ZoneBinding[];
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
  /** True for a line the splitter made from the JSON header — the only place `Cost`/`Spell`/`Creature p/h` are read. */
  readonly generated?: true;
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
  /** A creature definition (`Creature Giant Golem` + a header), not a card: it has no cost and is never in a deck. */
  readonly token?: true;
  readonly heading: SourceLine;
  readonly name: string;
  readonly nameSpan: Span;
  readonly lines: SourceLine[];
  /** Where the JSON header object is, once the section has read it. */
  headerSpan?: Span;
}

/** `Zone Suspend (per-player, public)` — a zone the document declares, with the rules it keeps. */
interface ZoneSectionSrc {
  readonly kind: 'zone';
  readonly heading: SourceLine;
  readonly name: string;
  readonly nameSpan: Span;
  readonly options: readonly string[];
  readonly lines: SourceLine[];
}

/** `Contest Rock Paper Scissors` and its body, read by the ability parser like any other section. */
interface ContestSectionSrc {
  readonly kind: 'contest';
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

type Section = CardSection | BuffSectionSrc | ZoneSectionSrc | ContestSectionSrc;

interface SplitResult {
  readonly sections: Section[];
  readonly cards: CardSection[];
  readonly buffs: BuffSectionSrc[];
  readonly zoneSections: ZoneSectionSrc[];
  readonly contestSections: ContestSectionSrc[];
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

/* ------------------------------ the JSON header --------------------------- */

const HEADER_SHAPE_CARD = '{ "cost": 3, "type": "spell" } or { "cost": 2, "type": "creature", "creatureConfig": { "power": 2, "health": 3 } }';
const HEADER_SHAPE_TOKEN = '{ "type": "creature", "creatureConfig": { "power": 6, "health": 6 } }';

/**
 * Where a header object ends: the line holding its closing brace, counting braces outside strings.
 * An object that never closes runs to the end of the document (and then fails to parse, with a message).
 */
function headerEnd(lines: readonly SourceLine[], from: number): number {
  let depth = 0;
  let inString = false;
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index]!;
    const content = lineText(line);
    for (let i = 0; i < content.length; i += 1) {
      const ch = content[i]!;
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    inString = false;
  }
  return lines.length - 1;
}

/**
 * Reads a card's JSON header — `{ "cost": 3, "type": "creature", "creatureConfig": { "power": 2, "health": 3 } }` —
 * and returns the `Cost` / `Creature p/h` / `Spell` lines the rest of the card layer reads, mapped back onto the
 * header's own span. Problems are reported on the key that caused them.
 */
function headerLines(
  raw: string,
  base: number,
  token: boolean,
  first: SourceLine,
  last: SourceLine,
  push: (diagnostic: Diagnostic) => void,
): SourceLine[] {
  const whole: Span = { start: base, end: base + raw.length };
  const shape = token ? HEADER_SHAPE_TOKEN : HEADER_SHAPE_CARD;
  const fail = (message: string, code: string, at: Span = whole): void =>
    push({ severity: 'error', message, code, start: at.start, end: Math.max(at.end, at.start + 1) });
  /** The span of `"key"` in the header (after `from`), or the whole header. */
  const keySpan = (key: string, from = 0): Span => {
    const at = raw.indexOf(`"${key}"`, from);
    return at === -1 ? whole : { start: base + at, end: base + at + key.length + 2 };
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail(`the header is not valid JSON (${(error as Error).message}) — write ${shape}`, 'card-header-json');
    return [];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`the header is an object — write ${shape}`, 'card-header-json');
    return [];
  }
  const object = value as Record<string, unknown>;
  let ok = true;
  const known = token ? ['type', 'creatureConfig'] : ['cost', 'type', 'creatureConfig'];
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) {
      fail(`"${key}" is not a header field — the fields are ${known.map((k) => `"${k}"`).join(', ')}`, 'card-header-field', keySpan(key));
      ok = false;
    }
  }
  const whole0 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  let cost = 0;
  if (!token) {
    if (!whole0(object['cost'])) {
      fail('"cost" is the mana the card costs — a whole number, e.g. "cost": 3', 'card-cost-missing', 'cost' in object ? keySpan('cost') : whole);
      ok = false;
    } else cost = object['cost'];
  }
  const type = token ? (object['type'] ?? 'creature') : object['type'];
  if (type !== 'spell' && type !== 'creature') {
    fail('"type" is "spell" or "creature", e.g. "type": "spell"', 'card-kind-missing', 'type' in object ? keySpan('type') : whole);
    ok = false;
  }
  if (token && type === 'spell') {
    fail('a creature definition is a creature — "type": "creature"', 'card-kind-missing', keySpan('type'));
    ok = false;
  }
  let power = 0;
  let health = 0;
  if (type === 'creature') {
    const config = object['creatureConfig'];
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      fail('a creature needs "creatureConfig": { "power": 2, "health": 3 }', 'card-creature-config', 'creatureConfig' in object ? keySpan('creatureConfig') : whole);
      ok = false;
    } else {
      const fields = config as Record<string, unknown>;
      const at = raw.indexOf('"creatureConfig"');
      for (const key of Object.keys(fields)) {
        if (key !== 'power' && key !== 'health') {
          fail(`"${key}" is not a creature field — "creatureConfig" holds "power" and "health"`, 'card-header-field', keySpan(key, at));
          ok = false;
        }
      }
      for (const key of ['power', 'health'] as const) {
        if (!whole0(fields[key])) {
          fail(`"${key}" is a whole number, e.g. "${key}": 2`, 'card-creature-config', key in fields ? keySpan(key, at) : keySpan('creatureConfig'));
          ok = false;
        }
      }
      if (whole0(fields['power'])) power = fields['power'];
      if (whole0(fields['health'])) health = fields['health'];
    }
  } else if (type === 'spell' && 'creatureConfig' in object) {
    fail('a spell has no "creatureConfig" — that is for creatures', 'card-creature-config', keySpan('creatureConfig'));
    ok = false;
  }
  if (!ok) return [];
  const generated = (text: string): SourceLine => ({
    text,
    start: first.start,
    contentStart: first.contentStart,
    contentEnd: last.contentEnd,
    number: first.number,
    generated: true,
  });
  return [generated(`Cost ${cost}`), generated(type === 'creature' ? `Creature ${power}/${health}` : 'Spell')];
}

function splitSections(text: string): SplitResult {
  const lines = sourceLines(text);
  const sections: Section[] = [];
  const diagnostics: Diagnostic[] = [];
  let current: Section | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    if (isIgnorable(line)) continue;
    const content = lineText(line);
    // `Creature Giant Golem` — a creature definition: a card without a cost that effects make. Its
    // header follows, like a card's. (`Creature 2/2` inside a card is the retired stat line, not a heading.)
    const definition = /^creature\s+(.+?)\s*\.?$/i.exec(content);
    const isHeading = definition && (/\s\d+\s*\/\s*\d+$/.test(definition[1]!) || !definition[1]!.includes('/'));
    if (definition && isHeading && !(current?.kind === 'card' && /^\d+\s*\/\s*\d+$/.test(definition[1]!))) {
      const name = definition[1]!.trim();
      const at = line.contentStart + content.indexOf(name);
      const section: CardSection = {
        kind: 'card',
        token: true,
        heading: line,
        name,
        nameSpan: { start: at, end: at + name.length },
        lines: [],
      };
      if (/\s\d+\s*\/\s*\d+$/.test(name)) {
        diagnostics.push({
          severity: 'error',
          message: `a creature definition's stats are in its header now — write "Creature ${name.replace(/\s+\d+\s*\/\s*\d+$/, '')}" and then ${HEADER_SHAPE_TOKEN}`,
          code: 'card-header-old',
          start: line.contentStart,
          end: line.contentEnd,
        });
      }
      sections.push(section);
      current = section;
      continue;
    }
    // The JSON header: the first thing under a card's heading.
    if (current?.kind === 'card' && current.lines.length === 0 && current.headerSpan === undefined && content.startsWith('{')) {
      const endIndex = headerEnd(lines, lineIndex);
      const last = lines[endIndex]!;
      const raw = text.slice(line.contentStart, last.contentEnd);
      current.headerSpan = { start: line.contentStart, end: last.contentEnd };
      current.lines.push(...headerLines(raw, line.contentStart, current.token === true, line, last, (d) => diagnostics.push(d)));
      lineIndex = endIndex;
      continue;
    }
    if (/^contest\b/i.test(content)) {
      const { name, span } = headingName(line, 'Contest', false);
      const section: ContestSectionSrc = { kind: 'contest', heading: line, name, nameSpan: span, lines: [] };
      sections.push(section);
      current = section;
      if (name.length === 0) {
        diagnostics.push({
          severity: 'error',
          message: 'a contest needs a name — write "Contest <name>", e.g. "Contest Rock Paper Scissors"',
          code: 'contest-name-missing',
          start: line.contentStart,
          end: line.contentEnd,
        });
      }
      continue;
    }
    const zoneHeading = /^zone\b/i.exec(content);
    if (zoneHeading) {
      const { name, span } = headingName(line, 'Zone', true);
      const parens = /\(([^)]*)\)\s*$/.exec(content);
      const section: ZoneSectionSrc = {
        kind: 'zone',
        heading: line,
        name,
        nameSpan: span,
        options: parens ? parens[1]!.split(',').map((o) => o.trim().toLowerCase()).filter((o) => o.length > 0) : [],
        lines: [],
      };
      sections.push(section);
      current = section;
      if (name.length === 0) {
        diagnostics.push({
          severity: 'error',
          message: 'a zone needs a name — write "Zone <name>", e.g. "Zone Suspend (per-player, public)"',
          code: 'zone-name-missing',
          start: line.contentStart,
          end: line.contentEnd,
        });
      }
      continue;
    }
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
            message: 'a buff needs a name — write "Buff <name>", e.g. "Buff Frailty"',
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

  for (const section of sections) {
    if (section.kind === 'card' && section.token && section.headerSpan === undefined && !diagnostics.some((d) => d.code === 'card-header-old' && d.start === section.heading.contentStart)) {
      diagnostics.push({
        severity: 'error',
        message: `"${section.name}" needs a header under its name — ${HEADER_SHAPE_TOKEN}`,
        code: 'card-header-missing',
        start: section.heading.contentStart,
        end: section.heading.contentEnd,
      });
    }
  }
  const cards = sections.filter((s): s is CardSection => s.kind === 'card');
  const buffs = sections.filter((s): s is BuffSectionSrc => s.kind === 'buff');
  const zoneSections = sections.filter((s): s is ZoneSectionSrc => s.kind === 'zone');
  const contestSections = sections.filter((s): s is ContestSectionSrc => s.kind === 'contest');
  return { sections, cards, buffs, zoneSections, contestSections, diagnostics };
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
  | { readonly kind: 'entry'; readonly rules: EntryRules }
  | { readonly kind: 'cardAbility'; readonly name: string; readonly body: string; readonly bodyStart: number }
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

/** `When this enters play [from <zone>] …` — `this`. */
const ENTERS_PLAY = /^when\s+this\s+enters\s+play\b/i;

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

  // `Cost`, `Creature p/h` and `Spell` are read only from the line the JSON header was turned into.
  if (/^cost\b/.test(lower)) {
    const match = line.generated ? /^cost\s+([0-9]+)\s*\.?\s*$/i.exec(content) : null;
    return match ? { kind: 'cost', value: Number(match[1]) } : { kind: 'unknown' };
  }
  if (/^creature\b/.test(lower)) {
    const match = line.generated ? /^creature\s+([0-9]+)\s*\/\s*([0-9]+)\s*\.?\s*$/i.exec(content) : null;
    return match
      ? { kind: 'creature', power: Number(match[1]), health: Number(match[2]) }
      : { kind: 'unknown' };
  }
  if (/^spell\s*\.?\s*$/.test(lower)) return line.generated ? { kind: 'spell' } : { kind: 'unknown' };
  const entry = parseEntryRule(content);
  if (entry) return { kind: 'entry', rules: entry };
  // `Suspend: Move this card to the Suspend zone with 5 counters on it.` — an ability the card has in hand.
  const named = /^([A-Za-z][A-Za-z' -]*?)\s*:\s*(\S.*)$/.exec(content);
  if (named && !/^(battlecry|deathrattle)$/i.test(named[1]!)) {
    const colon = content.indexOf(':');
    return { kind: 'cardAbility', name: named[1]!, body: named[2]!, bodyStart: line.contentStart + colon + 1 + (content.slice(colon + 1).length - content.slice(colon + 1).trimStart().length) };
  }
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
  // `When they are ready, reveal.` closes a sealed round: an ordinary sentence, not a trigger.
  if (/^when\s+(they|all\s+players)\s+are\s+ready\b/.test(lower)) return { kind: 'effect' };
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
  readonly entry: EntryRules;
  readonly cardAbilities: { readonly name: string; readonly body: string; readonly bodyStart: number; readonly line: SourceLine }[];
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
  let entry: EntryRules = {};
  const entryLines: SourceLine[] = [];
  const cardAbilities: CardParse['cardAbilities'] = [];
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
      case 'cardAbility':
        cardAbilities.push({ name: cls.name, body: cls.body, bodyStart: cls.bodyStart, line });
        text.push(lineText(line));
        break;
      case 'entry':
        entry = mergeEntry(entry, cls.rules);
        entryLines.push(line);
        text.push(lineText(line));
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
          /^(cost\b|creature\s+\d|spell\s*\.?$)/i.test(lineText(line))
            ? `"${lineText(line)}" — the card's cost and type are a JSON header now: ${HEADER_SHAPE_CARD}`
            : `"${lineText(line)}" is not a card line — the header is a JSON object, then one of the keywords (${known}), "When … then …", or an effect sentence`,
          /^(cost\b|creature\s+\d|spell\s*\.?$)/i.test(lineText(line)) ? 'card-header-old' : 'card-unknown-line',
        );
        break;
      }
    }
  }

  if (!sawCostLine) {
    if (section.headerSpan === undefined) {
      fail(section.heading, `"${section.name}" has no header — add ${HEADER_SHAPE_CARD}`, 'card-header-missing');
    }
  }
  // The retired shorthand: name the explicit event to write instead. The
  // kind is only known after the whole card is read, so this waits.
  for (const { line, word } of legacyLines) {
    const explicit = word === 'battlecry' ? 'When this enters play then <effect>' : 'When this is destroyed then <effect>';
    fail(
      line,
      kind === 'spell'
        ? `"${word}:" belongs to creatures — a spell writes its effect as a plain sentence, e.g. "Deal 6 damage to target enemy character."`
        : `"${word}:" is card shorthand this language does not use — write "${explicit}" instead`,
      `card-legacy-${word}`,
    );
  }

  if (kind === 'spell') {
    for (const line of entryLines) {
      fail(line, 'a spell never enters play — only a creature has something to say about the turn it enters play', 'card-spell-enters-play');
    }
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
        `a creature's one-shot effect needs a word to say *when* it happens — write "When this enters play then ${lineText(line)}" for entering play, "When this is destroyed then ${lineText(line)}" for dying, or "When … then …" for a standing trigger`,
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
    entry,
    cardAbilities,
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
    case 'roll':
    case 'store':
    case 'draw':
    case 'scry':
    case 'revealCard':
    case 'castCard':
    case 'moveCard':
    case 'moveCards':
    case 'revealCards':
    case 'split':
    case 'removeCounters':
    case 'play':
    case 'create':
    case 'castCards':
    case 'choosePile':
    case 'zoneAbility':
    case 'choose':
    case 'reveal':
    case 'moveChosen':
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

  // Zones the document declares (`Zone Suspend (per-player, public)`) are known to every card
  // and to the zone rules, on top of the host's. A copy: the host's dictionary is shared.
  const hostZones = options.zones ?? emptyZoneDictionary();
  const declaredZones = new ZoneDictionary(hostZones.names);
  const zoneDefs: ZoneDef[] = [];
  for (const section of split.zoneSections) {
    if (section.name.length === 0) continue;
    declaredZones.add(section.name);
    zoneDefs.push(zoneDefOf(section));
  }
  // Contests the document defines (`Contest Rock Paper Scissors`) can be played by name.
  // They are read by the same parser as everything else: the sections go through the language
  // verbatim, and what comes out is each contest as data.
  const contests: ContestIR[] = [...(options.contests ?? [])];
  if (split.contestSections.length > 0) {
    const lines: SynthLine[] = split.contestSections.flatMap((section) => [verbatim(section.heading), ...section.lines.map(verbatim)]);
    const synthetic = buildSynthetic(lines, text.length);
    const compiled = compileDocument(synthetic.text, { ...options, zones: declaredZones });
    contests.push(...compiled.contests);
    for (const diagnostic of compiled.diagnostics) push(remap(diagnostic, synthetic, text.length));
  }
  const creatureNames = split.cards.filter((section) => section.token).map((section) => section.name);
  options = { ...options, zones: declaredZones, contests, creatures: [...(options.creatures ?? []), ...creatureNames] };

  // Declared buffs are document-level: compile them once as a library, so a
  // buff's body is checked in one place and its `BuffDef` is built once.
  const libraryLines: SynthLine[] = [
    {
      text: 'Ability Card Library',
      origin: { contentStart: 0, contentEnd: 0, synthPrefix: 0, wholeSpan: { start: 0, end: 0 } },
    },
    ...split.buffs.flatMap((section) => [verbatim(section.heading), ...section.lines.map(verbatim)]),
    ...split.zoneSections.flatMap((section) => [
      {
        // The heading without its option list: the options declare the zone, they are not part of its rules.
        text: `Zone ${section.name}`,
        origin: {
          contentStart: section.heading.contentStart,
          contentEnd: section.heading.contentEnd,
          synthPrefix: 0,
          wholeSpan: { start: section.heading.contentStart, end: section.heading.contentEnd },
        },
      },
      ...section.lines.map(verbatim),
    ]),
  ];
  let buffDefs: readonly BuffDef[] = [];
  let zoneBindings: readonly ZoneBinding[] = [];
  const used = new Set<string>();
  if (split.buffs.length > 0 || split.zoneSections.length > 0) {
    const library = buildSynthetic(libraryLines, text.length);
    const compiled = compileDocument(library.text, { ...options, dictionary: hostDictionary });
    buffDefs = compiled.buffs;
    zoneBindings = compiled.zones;
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
  const zones = declaredZones;
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
        // `When this is destroyed then …` and other standing triggers: the ability
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

    // Abilities the card gives itself, usable from the hand.
    const handAbilities: { name: string; ability: ManualAbility }[] = [];
    for (const own of parsed.cardAbilities) {
      const body = compileDocument(`Ability ${own.name}\n${own.body}`, { ...options, dictionary: hostDictionary });
      for (const diagnostic of body.diagnostics) {
        if (diagnostic.code === 'unused-buff') continue;
        const at = own.bodyStart;
        push({ ...diagnostic, start: at, end: Math.max(at + 1, own.line.contentEnd) });
      }
      const ability = body.abilities[0];
      if (ability) handAbilities.push({ name: own.name, ability });
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
      ...(section.token ? { token: true as const } : {}),
      ...(Object.keys(parsed.entry).length > 0 ? { entry: parsed.entry } : {}),
      handAbilities,
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
    zoneDefs,
    zones: zoneBindings,
  };
}

/* -------------------------------- helpers -------------------------------- */

/**
 * The zone a `Zone` heading declares. Options, comma separated: `per-player` or `shared`
 * (default shared); `public`, `owner` or `hidden` for who may look (default public);
 * `ordered`; `owner-only` (only its owner's cards may be put in).
 */
function zoneDefOf(section: ZoneSectionSrc): ZoneDef {
  const has = (option: string): boolean => section.options.includes(option);
  return {
    id: section.name,
    scope: has('per-player') ? 'per-player' : 'shared',
    visibility: has('hidden') ? 'hidden' : has('owner') ? 'owner' : 'public',
    ...(has('ordered') ? { ordered: true } : {}),
    ...(has('owner-only') ? { ownerOnly: true } : {}),
  };
}

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
      case 'roll':
        for (const row of sentence.table ?? []) for (const nested of row.sentences) visit(nested);
        break;
      case 'store':
      case 'draw':
      case 'scry':
      case 'revealCard':
      case 'castCard':
      case 'moveCard':
      case 'moveCards':
      case 'revealCards':
      case 'split':
      case 'removeCounters':
      case 'play':
      case 'create':
      case 'castCards':
      case 'choosePile':
      case 'zoneAbility':
      case 'choose':
      case 'reveal':
      case 'moveChosen':
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
  '{ "cost"',
  'Taunt.',
  'Charge.',
  'When',
  'Buff',
] as const;

/** Hover help for the card-shaped words. */
export const CARD_WORD_DOCS: Readonly<Record<string, string>> = {
  card: '`Card <name>` starts a card section. Everything until the next "Card"/"Buff" heading belongs to it.',
  cost: '`"cost": <n>` — in the card\'s JSON header: the mana the card costs to play. Required.',
  creature: '`"type": "creature"` with `"creatureConfig": { "power": 3, "health": 2 }` — a minion with a stat line. Settings that belong to a kind of permanent live under their own key.',
  spell: '`"type": "spell"` — a one-shot card. Its effect sentences are written plainly, without a prefix.',
  // Derived from the registered keywords, so the wording lives in one place
  // (`src/english/glossary.ts`).
  taunt: BUILTIN_KEYWORDS.find((def) => def.name === 'Taunt')!.details!,
  charge: BUILTIN_KEYWORDS.find((def) => def.name === 'Charge')!.details!,
  when: '`When … then …` names the event and what happens: "When this enters play then …", "When this is destroyed then …", "When this is damaged then …".',
  enters: '`When this enters play then <effect>.` — the creature\'s effect the moment it lands. It may pick a target, exactly like an ability.',
  play: '`enters play` — the moment the creature is put onto the board.',
  destroyed: '`When this is destroyed then <effect>.` — the creature\'s last words, a trigger on `character:destroyed`.',
  buff: '`Buff <name>` declares a buff the document\'s cards can add. Buff sections are document-level, like in an ability document.',
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
  if (!hasCost && !kind) {
    out.push(
      suggestion('{ "cost": 3, "type": "spell" }', 'The card header, for a spell.'),
      suggestion('{ "cost": 2, "type": "creature", "creatureConfig": { "power": 2, "health": 3 } }', 'The card header, for a creature.'),
    );
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
  suggestion('this is destroyed', 'When this is destroyed then <effect> — the creature\'s last words.'),
  suggestion('this is damaged', 'When this is damaged then <effect>.'),
  suggestion('this is healed', 'When this is healed then <effect>.'),
  suggestion('a character is destroyed', 'When a character is destroyed then <effect>.'),
  suggestion('1 or more characters are destroyed', 'When 1 or more characters are destroyed then <effect>.'),
  suggestion('characters survives', 'When characters survives then <effect>.'),
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
      return [];
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

  if (/^cost\b/i.test(lower) || /^creature\b/i.test(lower) || trimmed.startsWith('{')) return [];
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
