/**
 * Recursive-descent parser for the Ability Language (docs/creator/01-ability-language.md).
 *
 * Error-tolerant: a bad sentence reports one diagnostic and skips to the
 * next sentence boundary (a `.`, the next `Ability`/`Buff` heading, or end
 * of input), so the editor can squiggle several independent mistakes at
 * once instead of stopping at the first.
 */
import { rollStatOf } from './rounds.js';
import {
  ADJECTIVES,
  BATCH_EVENT_COUNT_WORDS,
  CHANGE_WORDS,
  COUNT_JOINERS,
  DIRECTION_WORDS,
  EVENT_PHRASES,
  GAIN_LOSS_WORDS,
  GAUGE_WORDS,
  MODIFIER_REWRITES,
  NUMBER_WORDS,
  EVENT_VERBS,
  THEN,
  BUFF_STOP_WORDS,
  CHAR_WORDS,
  FUTURE_WORDS,
  GAME_WORDS,
  OWNER_WORDS,
  OWNED,
  QUANTIFIERS,
  RESULT_VERBS,
  SECTION_WORDS,
  SENTENCE_STARTERS,
} from './vocabulary.js';
import type { EventPhrase } from './vocabulary.js';
import type {
  AbilitySection,
  BuffSection,
  CharsPhrase,
  CountPhrase,
  IfClause,
  ModifierSentence,
  TargetBinding,
  RepeatClause,
  TriggerSentence,
  ZonePhrase,
  ConditionJoiner,
  Diagnostic,
  Doc,
  Owner,
  Sentence,
  TableRow,
  ZoneSection,
  ValueTest,
  Span,
  Who,
  WithClause,
  WithCondition,
  WithOperator,
} from './ast.js';
import { lex, type Token } from './lexer.js';
import { ZoneDictionary, emptyZoneDictionary } from './zone-dictionary.js';
import type { CardOrderIR, CardSelectorIR, CardSourceIR, ContestIR, ContestPlayersIR, MathExpression, PlayerListIR, RestIR, ZoneRefIR } from '../ir/index.js';

export interface ParseResult {
  readonly doc: Doc;
  readonly diagnostics: Diagnostic[];
}

export interface ParseOptions {
  /** The zone names a trigger may name (a game's deck, stack, active slot…). */
  readonly zones?: ZoneDictionary;
  /** Contests a sentence may refer to by name (`Each player plays Rock Paper Scissors.`). */
  readonly contests?: readonly ContestIR[];
  /** Creature definitions a sentence may create by name. */
  readonly creatures?: readonly string[];
}

const ABILITY_NAME_FALLBACK = 'Untitled';

const BUFF_OPTION_HINT =
  'expected "stacks", "weight <number>", "until end of turn", "for <n> turns", or ")" here';

interface BuffOptions {
  readonly stacks: boolean;
  readonly weight: number;
  readonly duration: BuffSection['duration'];
  readonly end: number;
}

export function parseDocument(text: string, options: ParseOptions = {}): ParseResult {
  return new Parser(text, options).parse();
}

class Parser {
  readonly #tokens: Token[];
  readonly #diagnostics: Diagnostic[] = [];
  readonly #text: string;
  /** The zone names this document may name — engine zones plus the host's. */
  readonly #zones: ZoneDictionary;
  /** Contests the host or the document defines, by name. */
  readonly #contests: readonly ContestIR[];
  readonly #creatures: readonly string[];
  /** Whether a contest has been played yet in this document (`the winners` need one). */
  #contestPlayed = false;
  #index = 0;
  /**
   * While true, a comma **ends** a condition instead of reading as `and`.
   *
   * A `with` clause spells conjunction with commas (`with poison, thorns,
   * and hp < 10`), but an `If …,` clause uses the comma as the separator
   * between its condition and its effect — so inside one, the comma cannot
   * also mean `and`. There, `and` must be written out.
   */
  #commaEndsCondition = false;

  constructor(text: string, options: ParseOptions = {}) {
    this.#text = text;
    this.#tokens = lex(text);
    this.#zones = options.zones ?? emptyZoneDictionary();
    this.#contests = options.contests ?? [];
    this.#creatures = options.creatures ?? [];
  }

  parse(): ParseResult {
    const doc = this.#parseDoc();
    return { doc, diagnostics: this.#diagnostics };
  }

  /* ---------------------------- document ---------------------------- */

  #parseDoc(): Doc {
    const abilities: AbilitySection[] = [];
    const buffs: BuffSection[] = [];
    const imports: import('./ast.js').ImportSection[] = [];
    const zones: ZoneSection[] = [];
    const docTriggers: TriggerSentence[] = [];
    const pending: Sentence[] = [];
    let currentAbility: AbilitySection | undefined;
    let currentBuff: BuffSection | undefined;
    let currentZone: ZoneSection | undefined;
    let seenHeading = false;

    while (true) {
      const token = this.#peek();
      if (token.kind === 'eof') break;
      if (token.kind === 'word' && token.atLineStart && SECTION_WORDS.includes(token.lower as (typeof SECTION_WORDS)[number])) {
        seenHeading = true;
        currentZone = undefined;
        if (token.lower === 'zone') {
          const section = this.#parseZoneHeading();
          if (section) {
            zones.push(section);
            currentZone = section;
          }
          currentAbility = undefined;
          currentBuff = undefined;
        } else if (token.lower === 'ability') {
          const section = this.#parseAbilityHeading();
          if (section) {
            abilities.push(section);
            currentAbility = section;
            currentBuff = undefined;
          }
        } else {
          const buff = this.#parseBuffHeading();
          if (buff) {
            buffs.push(buff);
            currentBuff = buff;
            currentAbility = undefined;
          }
        }
        continue;
      }
      if (token.kind === 'word' && token.atLineStart && token.lower === 'import') {
        const imported = this.#parseImport();
        if (imported) imports.push(imported);
        currentAbility = undefined;
        currentBuff = undefined;
        continue;
      }
      if (token.kind === 'punct' && token.text === '.') {
        this.#fail(token, 'unexpected "." — a sentence or heading belongs here', 'syntax');
        this.#advance();
        continue;
      }
      // `Target <n> <chars> as <name> [and <n> [different] <chars> as
      // <name>]*.` — the ability's named picks.
      if (token.kind === 'word' && token.atLineStart && token.lower === 'target') {
        const bindings = this.#parseTargetSentence();
        if (bindings === null) {
          this.#recover();
          continue;
        }
        if (bindings) {
          if (!currentAbility) {
            this.#diagnostics.push({
              severity: 'error',
              message: 'a "Target …" sentence names an ability\'s picks, so it belongs under an "Ability <name>" heading',
              code: 'targets-outside-ability',
              start: bindings[0]!.span.start,
              end: bindings[bindings.length - 1]!.span.end,
            });
          } else if (currentAbility.targets) {
            this.#diagnostics.push({
              severity: 'error',
              message: `"${currentAbility.name}" already names its picks — put every binding in one "Target …" sentence, joined with "and"`,
              code: 'targets-duplicate',
              start: bindings[0]!.span.start,
              end: bindings[bindings.length - 1]!.span.end,
            });
          } else {
            currentAbility.targets = bindings;
          }
          continue;
        }
      }

      // `Available while <condition>.` — an availability clause on the
      // ability it sits under, not an effect.
      if (token.kind === 'word' && token.lower === 'available') {
        const clause = this.#parseAvailableClause();
        if (clause === null) {
          this.#recover();
          continue;
        }
        if (clause) {
          if (!currentAbility) {
            this.#diagnostics.push({
              severity: 'error',
              message: 'an "Available while …" clause says when an ability can be used, so it belongs under an "Ability <name>" heading',
              code: 'available-outside-ability',
              start: clause.span.start,
              end: clause.span.end,
            });
          } else if (currentAbility.available) {
            this.#diagnostics.push({
              severity: 'error',
              message: `"${currentAbility.name}" already has an "Available while …" clause — combine the conditions with "and"`,
              code: 'available-duplicate',
              start: clause.span.start,
              end: clause.span.end,
            });
          } else {
            currentAbility.available = clause;
          }
          continue;
        }
      }

      // A modifier sentence — only meaningful on a buff, since it is the
      // attachment that decides whose actions it rewrites.
      if (
        token.kind === 'word' &&
        DIRECTION_WORDS.includes(token.lower as (typeof DIRECTION_WORDS)[number])
      ) {
        const modifier = this.#parseModifierSentence();
        if (modifier === null) {
          this.#recover();
          continue;
        }
        if (modifier) {
          if (currentBuff) currentBuff.modifiers.push(modifier);
          else {
            this.#diagnostics.push({
              severity: 'error',
              message:
                'a modifier changes what happens to its wearer\'s actions, so it belongs under a "Buff <name>" heading',
              code: 'modifier-outside-buff',
              start: modifier.span.start,
              end: modifier.span.end,
            });
          }
          continue;
        }
      }

      // `when <count> <subject> <verb> then <effect>.` — a trigger, not an
      // effect. A buff's triggers ride along on the buff; one written
      // outside any Buff belongs to no status, and the host places it.
      if (token.kind === 'word' && token.lower === 'when' && this.#looksLikeTrigger()) {
        const trigger = this.#parseTriggerSentence();
        if (trigger) {
          if (currentBuff) currentBuff.triggers.push(trigger);
          else docTriggers.push(trigger);
        }
        continue;
      }

      // A sentence. Before any heading they collect into an implicit
      // "Untitled" ability; afterwards they must belong to an Ability or Buff.
      const sentence = this.#parseSentence();
      if (sentence) {
        // "Cards in this zone" belongs to a `Zone` section, and a `Zone` section holds nothing else.
        const aboutThisZone = sentence.kind === 'zoneAbility' && sentence.owners === 'this';
        if (currentZone) {
          // A standing rule of the zone (`At the start of your turn, …`) is about it too.
          if (aboutThisZone || (sentence.event !== undefined && sentence.event.startsWith('turn:'))) currentZone.sentences.push(sentence);
          else {
            this.#diagnostics.push({
              severity: 'error',
              message:
                'a Zone section is about its own zone — write "Cards in this zone have <ability> for <players>." or a rule that starts "At the start of your turn, …"',
              code: 'zone-section-sentence',
              start: sentence.span.start,
              end: sentence.span.end,
            });
          }
          continue;
        }
        if (aboutThisZone) {
          this.#diagnostics.push({
            severity: 'error',
            message:
              '"this zone" needs a zone to be about — put the sentence under a "Zone <name>" heading, or name the zone: "Cards in your boxed zone have …"',
            code: 'this-zone-outside-zone',
            start: sentence.span.start,
            end: sentence.span.end,
          });
          continue;
        }
        if (currentAbility) {
          currentAbility.sentences.push(sentence);
        } else if (currentBuff) {
          currentBuff.sentences.push(sentence);
        } else if (!seenHeading) {
          pending.push(sentence);
        } else {
          this.#diagnostics.push({
            severity: 'error',
            message:
              'this sentence has no section to belong to — put it under an "Ability <name>" or "Buff <name>" heading',
            code: 'no-ability',
            start: sentence.span.start,
            end: sentence.span.end,
          });
        }
      }
    }

    if (pending.length > 0) {
      const first = pending[0]!;
      const last = pending[pending.length - 1]!;
      abilities.unshift({
        kind: 'ability',
        span: { start: first.span.start, end: last.span.end },
        name: ABILITY_NAME_FALLBACK,
        nameSpan: { start: first.span.start, end: first.span.start },
        sentences: pending,
      });
    }
    // Close each ability's span over its sentences.
    for (let i = 0; i < abilities.length; i += 1) {
      const section = abilities[i]!;
      const lastSentence = section.sentences[section.sentences.length - 1];
      if (lastSentence) {
        abilities[i] = {
          ...section,
          span: { start: section.span.start, end: lastSentence.span.end },
        };
      }
    }
    // Close each buff's span over its sentences.
    for (let i = 0; i < buffs.length; i += 1) {
      const section = buffs[i]!;
      const lastSentence = section.sentences[section.sentences.length - 1];
      if (lastSentence) {
        buffs[i] = {
          ...section,
          span: { start: section.span.start, end: lastSentence.span.end },
        };
      }
    }
    return { abilities, buffs, imports, triggers: docTriggers, zones };
  }

  #parseImport(): import('./ast.js').ImportSection | undefined {
    const start = this.#advance();
    const name = this.#peek();
    if (name.kind !== 'word') {
      this.#fail(name, 'expected a name after "import"', 'syntax');
      this.#skipToNextLine();
      return undefined;
    }
    this.#advance();
    if (!(this.#peek().kind === 'word' && this.#peek().lower === 'from')) {
      this.#fail(this.#peek(), 'expected "from" in an import, e.g. "import Poison from \\"./Poison.buff\\""', 'syntax');
      this.#skipToNextLine();
      return undefined;
    }
    this.#advance();
    const path = this.#peek();
    if (path.kind !== 'string') {
      this.#fail(path, 'expected a quoted module path after "from"', 'syntax');
      this.#skipToNextLine();
      return undefined;
    }
    this.#advance();
    return {
      kind: 'import',
      span: { start: start.start, end: path.end },
      name: name.text,
      nameSpan: { start: name.start, end: name.end },
      path: path.text,
      pathSpan: { start: path.start, end: path.end },
    };
  }

  /* ----------------------------- headings ---------------------------- */

  #parseAbilityHeading(): AbilitySection | undefined {
    const start = this.#advance(); // 'ability'
    const nameTokens: Token[] = [];
    while (this.#isWordOnLine(this.#peek())) {
      nameTokens.push(this.#advance());
    }
    if (nameTokens.length === 0) {
      this.#fail(start, 'expected an ability name after "Ability", e.g. "Ability Fireball"', 'syntax');
      this.#skipToNextLine();
      return undefined;
    }
    // A trailing "." on the heading line is tolerated.
    if (this.#peek().kind === 'punct' && this.#peek().text === '.') this.#advance();
    const first = nameTokens[0]!;
    const last = nameTokens[nameTokens.length - 1]!;
    const name = nameTokens.map((t) => t.text).join(' ');
    return {
      kind: 'ability',
      span: { start: start.start, end: last.end },
      name,
      nameSpan: { start: first.start, end: last.end },
      sentences: [],
    };
  }

  /** `Zone boxed` — the heading of a section about one of the game's zones. */
  #parseZoneHeading(): ZoneSection | undefined {
    const start = this.#advance(); // 'zone'
    const nameStart = this.#peek();
    if (!this.#isWordOnLine(nameStart)) {
      this.#fail(start, 'expected a zone name after "Zone", e.g. "Zone boxed"', 'syntax');
      this.#skipToNextLine();
      return undefined;
    }
    const zone = this.#parseZoneName('expected a zone name after "Zone", e.g. "Zone boxed"');
    if (zone === null) {
      this.#skipToNextLine();
      return undefined;
    }
    if (this.#peek().kind === 'punct' && this.#peek().text === '.') this.#advance();
    return {
      kind: 'zone',
      span: { start: start.start, end: this.#previous().end },
      zone,
      nameSpan: { start: nameStart.start, end: nameStart.end },
      sentences: [],
    };
  }

  #parseBuffHeading(): BuffSection | undefined {
    const start = this.#advance(); // 'buff'
    const nameTokens: Token[] = [];
    // The name ends at the options paren or at a line break.
    while (this.#peek().kind === 'word' && !this.#peek().atLineStart) {
      nameTokens.push(this.#advance());
    }
    if (nameTokens.length === 0) {
      this.#fail(start, 'expected a buff name after "Buff", e.g. "Buff Frailty (stacks)"', 'syntax');
      this.#skipToNextLine();
      return undefined;
    }
    const first = nameTokens[0]!;
    const last = nameTokens[nameTokens.length - 1]!;
    const name = nameTokens.map((t) => t.text).join(' ');

    let stacks = false;
    let weight = 1;
    let duration: BuffSection['duration'];
    let end = last.end;
    if (this.#peek().kind === 'punct' && this.#peek().text === '(') {
      const parsed = this.#parseBuffOptions();
      if (!parsed) {
        this.#skipToNextLine();
        return undefined;
      }
      stacks = parsed.stacks;
      weight = parsed.weight;
      duration = parsed.duration;
      end = parsed.end;
    }
    return {
      kind: 'buff',
      span: { start: start.start, end },
      name,
      nameSpan: { start: first.start, end: last.end },
      stacks,
      weight,
      ...(duration ? { duration } : {}),
      sentences: [],
      triggers: [],
      modifiers: [],
    };
  }

  /** Parses `(stacks, weight 2)` after a buff name. Returns undefined on error. */
  #parseBuffOptions(): BuffOptions | undefined {
    this.#advance(); // '('
    let stacks = false;
    let weight = 1;
    let duration: BuffSection['duration'];
    let closed = false;
    let sawOption = false;
    while (true) {
      const token = this.#peek();
      if (token.kind === 'eof' || token.atLineStart) {
        break;
      }
      if (token.kind === 'punct' && token.text === ')') {
        this.#advance();
        closed = true;
        break;
      }
      if (token.kind === 'punct' && token.text === ',') {
        this.#advance();
        continue;
      }
      if (token.kind === 'word') {
        const lower = token.lower;
        if (lower === 'stacks') {
          this.#advance();
          stacks = true;
          sawOption = true;
          continue;
        }
        if (lower === 'weight') {
          this.#advance();
          const number = this.#expectNumber('after "weight"', 'syntax');
          if (!number) return undefined;
          weight = number.value;
          sawOption = true;
          continue;
        }
        // "until end of turn" — gone when this turn ends.
        if (lower === 'until') {
          this.#advance();
          if (!(this.#matchWord('end') && this.#matchWord('of') && this.#matchWord('turn'))) {
            this.#failHere('expected "end of turn" — write "until end of turn"', 'syntax');
            return undefined;
          }
          duration = { kind: 'endOfTurn' };
          sawOption = true;
          continue;
        }
        // "for <n> turns" — gone after that many turn-ends.
        if (lower === 'for') {
          this.#advance();
          const number = this.#expectNumber('after "for"', 'syntax');
          if (!number) return undefined;
          if (!(this.#matchWord('turns') || this.#matchWord('turn'))) {
            this.#failHere('expected "turns" — write "for 2 turns"', 'syntax');
            return undefined;
          }
          if (number.value < 1) {
            this.#fail(this.#previous(), 'a duration needs at least 1 turn', 'duration-zero');
            return undefined;
          }
          duration = { kind: 'turns', count: number.value };
          sawOption = true;
          continue;
        }
        this.#fail(token, BUFF_OPTION_HINT, 'syntax');
        return undefined;
      }
      this.#fail(token, BUFF_OPTION_HINT, 'syntax');
      return undefined;
    }
    if (!sawOption) {
      this.#fail(this.#peek(), `expected a buff option inside the parentheses — ${BUFF_OPTION_HINT}`, 'syntax');
      return undefined;
    }
    if (!closed) {
      this.#fail(
        this.#peek(),
        'expected ")" to close the buff options',
        'syntax',
      );
      return undefined;
    }
    return { stacks, weight, duration, end: this.#previous().end };
  }

  /* ----------------------------- sentences ---------------------------- */



  #peekOffset(offset: number): Token | undefined {
    return this.#tokens[this.#index + offset];
  }

  #parseEventPrefix(): string | undefined {
    const mark = this.#index;
    const token = this.#peek();
    if (token.kind !== 'word') return undefined;

    // `At the start of your turn,` — each time the turn is the owner's.
    if (
      token.lower === 'at' &&
      this.#peekOffset(1)?.lower === 'the' &&
      this.#peekOffset(2)?.lower === 'start' &&
      this.#peekOffset(3)?.lower === 'of' &&
      this.#peekOffset(4)?.lower === 'your' &&
      this.#peekOffset(5)?.lower === 'turn'
    ) {
      this.#index += 6;
      if (this.#peek().kind === 'punct' && this.#peek().text === ',') this.#advance();
      return 'turn:start:yours';
    }

    if (token.lower === 'when') {
      const t1 = this.#peekOffset(1);
      // "when the turn starts/ends,"
      if (t1?.lower === 'the') {
        const t2 = this.#peekOffset(2);
        const t3 = this.#peekOffset(3);
        if (t2?.lower === 'turn') {
          let ev: string | undefined;
          if (t3?.lower === 'start' || t3?.lower === 'starts') ev = 'turn:start';
          else if (t3?.lower === 'end' || t3?.lower === 'ends') ev = 'turn:end';
          if (ev) {
            this.#index += 4;
            if (this.#peek().kind === 'word' && this.#peek().lower === 'then') this.#advance();
            if (this.#peek().kind === 'punct' && this.#peek().text === ',') this.#advance();
            return ev;
          }
        }
      }
      // "when turn starts/ends," (no "the")
      if (t1?.lower === 'turn' || t1?.lower === 'turn:start' || t1?.lower === 'turn:end') {
        let ev: string | undefined;
        if (t1.lower === 'turn:start') ev = 'turn:start';
        else if (t1.lower === 'turn:end') ev = 'turn:end';
        else {
          const t2 = this.#peekOffset(2);
          if (t2?.lower === 'start' || t2?.lower === 'starts') ev = 'turn:start';
          else if (t2?.lower === 'end' || t2?.lower === 'ends') ev = 'turn:end';
        }
        if (ev) {
          this.#index += t1.lower.startsWith('turn:') ? 2 : 3;
          if (this.#peek().kind === 'word' && this.#peek().lower === 'then') this.#advance();
          if (this.#peek().kind === 'punct' && this.#peek().text === ',') this.#advance();
          return ev;
        }
      }
    }

    this.#index = mark;
    return undefined;
  }


  /**
   * Distinguishes `when <count> <subject> <verb> then …` from the turn
   * prefix `When the turn starts, …`, which `#parseEventPrefix` owns.
   * Cheap lookahead, so a malformed trigger still reports a trigger error
   * rather than falling through to a generic one.
   */
  #looksLikeTrigger(): boolean {
    const next = this.#peek(1);
    if (next.kind === 'word' && next.lower === 'the') return false; // "when the turn …"
    if (this.#startsReveal()) return false; // "when they are ready, reveal"
    if (next.kind === 'word' && (next.lower === 'turn' || next.lower.startsWith('turn:'))) return false;
    return true;
  }

  /**
   * `when <count>? <subject> <verb> then <effect>.`
   *
   * The count phrase sits where a character phrase's quantifier normally
   * goes, so the subject is parsed by the same code every other noun
   * phrase uses — adjectives, `owned by` and `with …` all work, and they
   * filter the **triggering** characters.
   */
  #parseTriggerSentence(): TriggerSentence | undefined {
    const start = this.#advance(); // 'when'

    const count = this.#parseCountPhrase();
    if (count === null) return this.#abort();

    // Three subject shapes, all singular except the counted group:
    //   "when a character dies"      — one event, any character
    //   "when this character dies"   — one event, the owner itself
    //   "when <count> characters die" — the batch
    let singular = false;
    let quantifier: 'this' | 'all' = 'all';
    if (!count) {
      if (this.#matchWord('a') || this.#matchWord('an')) {
        singular = true;
      } else if (this.#peek().kind === 'word' && this.#peek().lower === 'this') {
        this.#advance();
        singular = true;
        quantifier = 'this';
      }
    }

    const subject = this.#parseCharsBody(quantifier, this.#peek().start, this.#peek().start);
    if (!subject) return this.#abort();

    const verbToken = this.#peek();
    if (verbToken.kind !== 'word') {
      this.#fail(verbToken, `expected an event verb after the subject — ${this.#eventVerbList()}`, 'syntax');
      return this.#abort();
    }
    // A **zone movement** is its own verb shape — `enters <zone> [from
    // <zone>]` / `leaves <zone> [to <zone>]` — because the zone names it,
    // not an `EventPhrase` entry from a fixed table.
    const zone = this.#parseZoneVerb();
    if (zone === null) return this.#abort();
    // Verbs may be several words ("takes damage"), so match the longest
    // sequence that fits.
    const matched = zone ? undefined : this.#matchEventVerb();
    if (!zone && !matched) {
      this.#fail(
        verbToken,
        `"${verbToken.text}" is not an event verb — ${this.#eventVerbList()}`,
        'unknown-event',
      );
      return this.#abort();
    }
    const phrase = matched?.phrase;

    const mode: 'single' | 'batch' = singular ? 'single' : 'batch';
    if (!this.#matchWord(THEN)) {
      this.#failHere('expected "then" before the effect, e.g. "when 2 or more characters die then …"', 'syntax');
      return this.#abort();
    }

    const effect = this.#parseSentence();
    if (!effect) return undefined; // already reported
    return {
      kind: 'trigger',
      span: { start: start.start, end: effect.span.end },
      event: zone
        ? mode === 'batch'
          ? 'zone:changed:batch'
          : 'zone:changed'
        : mode === 'batch'
          ? phrase!.batchEvent
          : phrase!.event,
      mode,
      ...(phrase?.gauge !== undefined ? { gauge: phrase.gauge } : {}),
      ...(phrase?.change !== undefined ? { change: phrase.change } : {}),
      ...(zone ? { zone } : {}),
      count: count ?? undefined,
      subject,
      eventSpan: { start: verbToken.start, end: this.#previous().end },
      effects: [effect],
    };
  }

  /**
   * `enters <zone> [from <zone>]` / `leaves <zone> [to <zone>]` — the
   * game-agnostic zone-movement verb.
   *
   * Returns `undefined` when this is not a zone phrase (so the caller falls
   * back to the ordinary event table), the phrase when it parsed, and
   * `null` when it *is* one but malformed — an error, not an absence.
   */
  #parseZoneVerb(): ZonePhrase | undefined | null {
    const verb = this.#peek();
    if (verb.kind !== 'word') return undefined;
    const enters = verb.lower === 'enters' || verb.lower === 'enter';
    const leaves = verb.lower === 'leaves' || verb.lower === 'leave';
    if (!enters && !leaves) return undefined;
    const kind = enters ? 'enters' : 'leaves';
    this.#advance();

    const preposition = kind === 'enters' ? 'from' : 'to';
    const zone = this.#parseZoneName(
      kind === 'enters'
        ? 'expected the zone it enters, e.g. "enters play"'
        : 'expected the zone it leaves, e.g. "leaves play"',
    );
    if (zone === null) return null;

    // The optional other end. `enters` takes `from`, `leaves` takes `to` —
    // the wrong one is worth naming rather than reporting as a stray word.
    let opposite: string | undefined;
    const next = this.#peek();
    if (next.kind === 'word' && (next.lower === 'from' || next.lower === 'to')) {
      if (next.lower !== preposition) {
        this.#fail(
          next,
          `"${kind}" takes "${preposition} <zone>" — the zone it ${
            kind === 'enters' ? 'came from' : 'goes to'
          } — not "${next.lower}"`,
          'zone-preposition',
        );
        return null;
      }
      this.#advance();
      const other = this.#parseZoneName(`expected a zone after "${preposition}", e.g. "${kind} play ${preposition} hand"`);
      if (other === null) return null;
      opposite = other;
    }

    return {
      verb: kind,
      id: zone,
      ...(opposite !== undefined ? { opposite } : {}),
      span: { start: verb.start, end: this.#previous().end },
    };
  }

  /**
   * One zone name, resolved to the host's canonical spelling. A name the
   * dictionary does not know is reported with the names it does know — the
   * same courtesy an unknown buff gets.
   */
  #parseZoneName(expectation: string): string | null {
    // "enters a graveyard" / "enters the graveyard" read as English; the
    // article carries no meaning, so it is skipped.
    const article = this.#peek();
    if (article.kind === 'word' && (article.lower === 'a' || article.lower === 'an' || article.lower === 'the')) {
      this.#advance();
    }
    const token = this.#peek();
    if (token.kind !== 'word') {
      this.#fail(token, expectation, 'syntax');
      return null;
    }
    this.#advance();
    const resolved = this.#zones.resolve(token.text);
    if (resolved === undefined) {
      const suggestions = this.#zones.suggest(token.text);
      const known = this.#zones.names.map((name) => `"${name}"`).join(', ');
      this.#fail(
        token,
        `unknown zone "${token.text}" — known zones are ${known}` +
          (suggestions.length > 0 ? `. Did you mean ${suggestions.map((s) => `"${s}"`).join(' or ')}?` : ''),
        'unknown-zone',
      );
      return null;
    }
    return resolved;
  }

  /**
   * Consumes the event verb if one fits here. Verbs may be several words
   * (`takes damage`), so the longest matching sequence wins.
   */
  #matchEventVerb(): { phrase: EventPhrase; words: readonly string[] } | undefined {
    let best: { phrase: EventPhrase; words: readonly string[] } | undefined;
    for (const phrase of EVENT_PHRASES) {
      for (const words of phrase.verbs) {
        if (best && words.length <= best.words.length) continue;
        if (words.every((word, offset) => this.#peek(offset).lower === word)) {
          best = { phrase, words };
        }
      }
    }
    if (!best) return undefined;
    for (let i = 0; i < best.words.length; i += 1) this.#advance();
    return best;
  }

  #eventVerbList(): string {
    const verbs = [...EVENT_VERBS, 'enters <zone>', 'leaves <zone>'];
    return `try ${verbs.map((verb) => `"${verb}"`).join(', ')}`;
  }

  /**
   * The count phrase: `one or more`, `<n> or more`, `<n> to <m>`,
   * `<n> or less`. Returns `undefined` when there is none (the subject is
   * singular or a bare plural), or `null` on a malformed one — which is an
   * error, not an absence.
   *
   * A bare plural (`when characters die`) is `one or more`, the default.
   */
  #parseCountPhrase(): CountPhrase | undefined | null {
    const first = this.#peek();

    // "an even number of …" / "an odd number of …" — a parity, not a range.
    if (first.kind === 'word' && (first.lower === 'an' || first.lower === 'a')) {
      const parityWord = this.#peek(1);
      if (
        parityWord.kind === 'word' &&
        (parityWord.lower === 'even' || parityWord.lower === 'odd')
      ) {
        if (!(this.#peek(2).lower === 'number' && this.#peek(3).lower === 'of')) {
          this.#fail(
            parityWord,
            `write "an ${parityWord.lower} number of" — e.g. "when an ${parityWord.lower} number of characters die then …"`,
            'syntax',
          );
          return null;
        }
        this.#advance();
        this.#advance();
        this.#advance();
        const last = this.#advance();
        return {
          kind: 'parity',
          span: { start: first.start, end: last.end },
          parity: parityWord.lower === 'even' ? 'even' : 'odd',
          text: `an ${parityWord.lower} number of`,
        };
      }
    }

    // Counts are written as digits — `1 or more`, not `one or more`.
    if (first.kind === 'word' && NUMBER_WORDS[first.lower] !== undefined) {
      this.#fail(
        first,
        `write counts as numbers — "${NUMBER_WORDS[first.lower]}" instead of "${first.text}"`,
        'count-word',
      );
      return null;
    }

    if (first.kind !== 'number') return undefined;
    const value = Number(first.text);
    const joiner = this.#peek(1);
    if (joiner.kind !== 'word' || !COUNT_JOINERS.includes(joiner.lower as (typeof COUNT_JOINERS)[number])) {
      this.#fail(
        joiner,
        `expected "or more", "or less", or "to <n>" after ${first.text} — e.g. "when ${first.text} or more characters die then …"`,
        'syntax',
      );
      return null;
    }
    if (joiner.lower === 'to') {
      const upper = this.#peek(2);
      if (upper.kind !== 'number') {
        this.#fail(upper, `expected a number after "${first.text} to"`, 'syntax');
        return null;
      }
      const max = Number(upper.text);
      if (max < value) {
        this.#fail(upper, `"${first.text} to ${upper.text}" counts down — the larger number goes last`, 'count-range');
        return null;
      }
      this.#advance();
      this.#advance();
      const last = this.#advance();
      return {
        kind: 'range',
        span: { start: first.start, end: last.end },
        min: value,
        max,
        text: `${first.text} to ${upper.text}`,
      };
    }
    const bound = this.#peek(2);
    if (bound.kind !== 'word' || (bound.lower !== 'more' && bound.lower !== 'less')) {
      this.#fail(bound, `expected "more" or "less" after "${first.text} or"`, 'syntax');
      return null;
    }
    this.#advance();
    this.#advance();
    const last = this.#advance();
    // A batch event only fires when the batch held at least one, so an
    // upper bound is 1..n in practice.
    const range =
      bound.lower === 'more'
        ? { min: value, max: null as number | null }
        : { min: 1, max: value };
    return {
      kind: 'range',
      span: { start: first.start, end: last.end },
      ...range,
      text: `${first.text} or ${bound.lower}`,
    };
  }

  /**
   * `If <condition>, <effect>.` — the guard in front of an effect.
   *
   * Returns `undefined` when there is no `if` (the common case) and `null`
   * when there is one that did not parse, which is an error rather than an
   * absence.
   */
  #parseIfGuard(): IfClause | undefined | null {
    const token = this.#peek();
    if (token.kind !== 'word' || token.lower !== 'if') return undefined;
    this.#advance();
    const clause = this.#parseConditionClause(token);
    if (!clause) return null;
    if (!(this.#peek().kind === 'punct' && this.#peek().text === ',')) {
      this.#failHere('expected "," between the condition and the effect', 'syntax');
      return null;
    }
    this.#advance();
    return clause;
  }

  /**
   * The condition shapes shared by `if …,` and `repeat while …` — `there
   * are <count> <subject>`, and `any`/`every`/`this` `… has <condition>`.
   * `start` is the keyword token, for the clause's span.
   */
  #parseConditionClause(start: Token): IfClause | undefined {
    const token = start;
    let clause: IfClause | undefined;
    const next = this.#peek();

    if (next.kind === 'word' && next.lower === 'there') {
      this.#advance();
      if (!this.#matchWord('are')) {
        this.#failHere('expected "are" — write "if there are 2 or more enemy characters, …"', 'syntax');
        return undefined;
      }
      const count = this.#parseCountPhrase();
      if (!count) {
        if (count === undefined) {
          this.#failHere('expected a count — "there are 2 or more enemy characters"', 'syntax');
        }
        return undefined;
      }
      const subject = this.#parseCharsBody('all', this.#peek().start, this.#peek().start);
      if (!subject) return undefined;
      clause = {
        kind: 'count',
        span: { start: token.start, end: subject.span.end },
        count,
        subject,
      };
    } else if (
      next.kind === 'word' &&
      (next.lower === 'any' || next.lower === 'every' || next.lower === 'this')
    ) {
      const word = next.lower;
      this.#advance();
      const subject = this.#parseCharsBody(
        word === 'this' ? 'this' : 'all',
        this.#peek().start,
        this.#peek().start,
      );
      if (!subject) return undefined;
      if (!this.#matchWord('has')) {
        this.#failHere(`expected "has" after "${next.text} …" — write "if ${next.text} … has hp < 10, …"`, 'syntax');
        return undefined;
      }
      const conditions: WithCondition[] = [];
      const joiners: ConditionJoiner[] = [];
      this.#commaEndsCondition = true;
      const condition = this.#parseBooleanOr(conditions, joiners);
      this.#commaEndsCondition = false;
      if (!condition) return undefined;
      clause = {
        // `this` is one thing, so "any of it" is the condition on it.
        kind: word === 'every' ? 'every' : 'any',
        span: { start: token.start, end: condition.span.end },
        subject,
        condition,
      };
    } else {
      const value = this.#tryValueCondition(token);
      if (value === null) return undefined; // a value condition, malformed — already reported
      if (!value) {
        this.#fail(
          next,
          `expected "there are …", "any …", "every …", "this …", or a value like "that total is 10 or more" after "${start.text}"`,
          'syntax',
        );
        return undefined;
      }
      clause = value;
    }
    return clause;
  }

  /**
   * `<value> is <test>` — tried, not assumed. Returns the clause, `null` when it
   * *is* a value condition but its test is malformed (reported), and `undefined`
   * when it is not one at all, so the caller can name every shape the `if` takes.
   *
   * "Is a value condition" means the words before `is` read as one amount and
   * `is` follows it directly: `that total is …` and `AttackerRoll is …` qualify;
   * `the board is full` does not (`the` is not an amount), so it keeps the
   * message that lists the other shapes.
   */
  #tryValueCondition(start: Token): IfClause | null | undefined {
    if (!this.#looksLikeValueCondition()) return undefined;
    const mark = this.#index;
    const diagnosticsBefore = this.#diagnostics.length;
    const value = this.#parseMathExpr();
    const next = this.#peek();
    if (!value || next.kind !== 'word' || next.lower !== 'is') {
      this.#index = mark;
      this.#diagnostics.length = diagnosticsBefore;
      return undefined;
    }
    this.#advance(); // 'is'
    const test = this.#parseValueTest();
    if (!test) return null;
    return { kind: 'value', span: { start: start.start, end: this.#previous().end }, value, test };
  }

  /** True when an `is` comes before the clause's comma: `that total is 10 or more,`. */
  #looksLikeValueCondition(): boolean {
    for (let offset = 0; offset < 14; offset += 1) {
      const token = this.#peekOffset(offset);
      if (!token || token.kind === 'eof') return false;
      if (token.kind === 'word' && token.lower === 'is') return offset > 0;
      if (token.kind === 'punct' && token.text === ',') return false;
      if (token.kind === 'punct' && token.text === '.') {
        // A property dot (`roll.total`) is glued to the words either side of it;
        // a sentence's own full stop is not.
        const before = this.#peekOffset(offset - 1);
        const after = this.#peekOffset(offset + 1);
        const property = before && after && after.kind === 'word' && this.#adjacent(before, token) && this.#adjacent(token, after);
        if (!property) return false;
      }
    }
    return false;
  }

  /**
   * What follows `is`: `10`, `2 to 5`, `10 or more`, `5 or less`, or a
   * comparison — `higher than <amount>`, `lower than <amount>`, `the same as
   * <amount>`.
   */
  #parseValueTest(): ValueTest | undefined {
    const first = this.#peek();
    const hint = 'write "that total is 10 or more", "… is 2 to 5", "… is higher than <value>", or "… is the same as <value>"';
    if (first.kind === 'word') {
      let op: '>' | '<' | '=' | undefined;
      if (first.lower === 'higher' && this.#peek(1).lower === 'than') {
        op = '>';
        this.#advance();
        this.#advance();
      } else if (first.lower === 'lower' && this.#peek(1).lower === 'than') {
        op = '<';
        this.#advance();
        this.#advance();
      } else if (first.lower === 'the' && this.#peek(1).lower === 'same' && this.#peek(2).lower === 'as') {
        op = '=';
        this.#advance();
        this.#advance();
        this.#advance();
      }
      if (!op) {
        this.#fail(first, `expected a number or a comparison after "is" — ${hint}`, 'syntax');
        return undefined;
      }
      const other = this.#parseMathExpr();
      if (!other) return undefined;
      return { kind: 'compare', op, other };
    }
    if (first.kind !== 'number') {
      this.#fail(first, `expected a number or a comparison after "is" — ${hint}`, 'syntax');
      return undefined;
    }
    this.#advance();
    const low = Number(first.text);
    const joiner = this.#peek();
    if (joiner.kind === 'word' && joiner.lower === 'to') {
      this.#advance();
      const upper = this.#peek();
      if (upper.kind !== 'number') {
        this.#fail(upper, `expected a number after "${first.text} to"`, 'syntax');
        return undefined;
      }
      this.#advance();
      const high = Number(upper.text);
      if (high < low) {
        this.#fail(upper, `"${first.text} to ${upper.text}" counts down — the larger number goes last`, 'count-range');
        return undefined;
      }
      return { kind: 'range', exact: false, min: low, max: high, text: `${first.text} to ${upper.text}` };
    }
    if (joiner.kind === 'word' && joiner.lower === 'or') {
      this.#advance();
      const bound = this.#peek();
      if (bound.kind !== 'word' || (bound.lower !== 'more' && bound.lower !== 'less')) {
        this.#fail(bound, `expected "more" or "less" after "${first.text} or"`, 'syntax');
        return undefined;
      }
      this.#advance();
      return bound.lower === 'more'
        ? { kind: 'range', exact: false, min: low, max: null, text: `${first.text} or more` }
        : { kind: 'range', exact: false, min: null, max: low, text: `${first.text} or less` };
    }
    return { kind: 'range', exact: true, min: low, max: low, text: first.text };
  }

  /**
   * `You may <effect>.` — the controller is asked when the effect runs, and
   * a no skips it. Distinguished from `You win the game.` by the `may`.
   */
  #parseMayPrefix(): boolean {
    if (!(this.#peek().kind === 'word' && this.#peek().lower === 'you')) return false;
    if (!(this.#peek(1).kind === 'word' && this.#peek(1).lower === 'may')) return false;
    this.#advance();
    this.#advance();
    return true;
  }

  /**
   * `Repeat [up to <n> times] [while <condition>] [if you choose]: <effect>.`
   *
   * Returns `undefined` when there is no `repeat`, `null` when there is one
   * that did not parse.
   */
  #parseRepeatPrefix(): RepeatClause | undefined | null {
    const start = this.#peek();
    if (start.kind !== 'word' || start.lower !== 'repeat') return undefined;
    this.#advance();

    let min = 0;
    let max: number | undefined;
    let countText: string | undefined;
    let condition: IfClause | undefined;
    let confirm = false;

    // How many times. `up to <n>` is sugar for `0 to <n>`; otherwise it is
    // an ordinary count phrase, whose **lower bound is the mandatory
    // floor** — "1 or more times if you choose" does one, then asks.
    if (this.#peek().kind === 'word' && this.#peek().lower === 'up') {
      this.#advance();
      if (!this.#matchWord('to')) {
        this.#failHere('expected "to" — write "repeat up to 3 times: …"', 'syntax');
        return null;
      }
      const count = this.#peek();
      if (count.kind !== 'number') {
        this.#fail(count, 'expected a number of times after "up to"', 'syntax');
        return null;
      }
      this.#advance();
      max = Number(count.text);
      countText = `up to ${count.text}`;
      if (!this.#matchTimes()) return null;
    } else if (this.#peek().kind === 'number' || this.#startsParityPhrase()) {
      // A bare number is exact: "repeat 2 times" runs twice.
      if (
        this.#peek().kind === 'number' &&
        this.#peek(1).kind === 'word' &&
        (this.#peek(1).lower === 'times' || this.#peek(1).lower === 'time')
      ) {
        const count = this.#advance();
        min = Number(count.text);
        max = min;
        countText = count.text;
        if (!this.#matchTimes()) return null;
      } else {
        const count = this.#parseCountPhrase();
        if (!count) return null;
        if (count.kind === 'parity') {
          this.#diagnostics.push({
            severity: 'error',
            message: 'a "repeat" counts iterations, so a parity ("an even number of") does not apply here',
            code: 'repeat-parity',
            start: count.span.start,
            end: count.span.end,
          });
          return null;
        }
        min = count.min;
        max = count.max ?? undefined;
        countText = count.text;
        if (!this.#matchTimes()) return null;
      }
    }

    // "while <condition>"
    if (this.#peek().kind === 'word' && this.#peek().lower === 'while') {
      const whileToken = this.#advance();
      condition = this.#parseConditionClause(whileToken);
      if (!condition) return null;
      if (this.#peek().kind === 'punct' && this.#peek().text === ',') this.#advance();
    }

    // "if you choose"
    if (this.#peek().kind === 'word' && this.#peek().lower === 'if') {
      this.#advance();
      if (!this.#matchWord('you')) {
        this.#failHere('expected "you choose" — write "repeat if you choose: …"', 'syntax');
        return null;
      }
      if (!(this.#matchWord('choose') || this.#matchWord('agree'))) {
        this.#failHere('expected "choose" after "if you"', 'syntax');
        return null;
      }
      confirm = true;
    }

    if (!(this.#peek().kind === 'punct' && this.#peek().text === ':')) {
      this.#failHere('expected ":" before the effect — write "repeat if you choose: …"', 'syntax');
      return null;
    }
    const colon = this.#advance();
    if (max === undefined && !confirm && !condition) {
      this.#diagnostics.push({
        severity: 'error',
        message:
          'a "repeat" needs at least one of: "up to <n> times", "while <condition>", or "if you choose" — otherwise it never stops',
        code: 'repeat-unbounded',
        start: start.start,
        end: colon.end,
      });
      return null;
    }
    if (max === undefined && !confirm) {
      this.#diagnostics.push({
        severity: 'warning',
        message:
          'this "repeat" stops only when its condition turns false — add "up to <n> times" or "if you choose" if the effects might not change it',
        code: 'repeat-uncapped',
        start: start.start,
        end: colon.end,
      });
    }
    if (min > 0 && confirm && max !== undefined && min > max) {
      this.#diagnostics.push({
        severity: 'error',
        message: `"${countText}" counts down — the larger number goes last`,
        code: 'count-range',
        start: start.start,
        end: colon.end,
      });
      return null;
    }
    return {
      span: { start: start.start, end: colon.end },
      condition,
      confirm,
      min,
      max,
      countText,
    };
  }

  /** True when a parity count phrase (`an even number of`) starts here. */
  #startsParityPhrase(): boolean {
    const first = this.#peek();
    if (!(first.kind === 'word' && (first.lower === 'a' || first.lower === 'an'))) return false;
    const next = this.#peek(1);
    return next.kind === 'word' && (next.lower === 'even' || next.lower === 'odd');
  }

  /** `times` / `time` after a repeat's count. */
  #matchTimes(): boolean {
    if (this.#matchWord('times') || this.#matchWord('time')) return true;
    this.#failHere('expected "times" after the number', 'syntax');
    return false;
  }

  /**
   * `<verb> [outgoing|incoming] <damage|healing> [by|at <n>].`
   *
   * A modifier, not an effect: it never happens, it changes what happens.
   * Returns `undefined` when the sentence is not one, `null` when it is one
   * that did not parse.
   */
  /**
   * `Target <n> <chars> as <name> [and <n> [different] <chars> as <name>]*.`
   *
   * Returns `undefined` when the sentence is not one, `null` when it is one
   * that did not parse.
   */
  #parseTargetSentence(): TargetBinding[] | undefined | null {
    // `Target 1 …` — a bare `target character` phrase starts with a noun,
    // not a number, so the number is what tells them apart.
    if (!(this.#peek(1).kind === 'number')) return undefined;
    this.#advance(); // 'target'

    const bindings: TargetBinding[] = [];
    while (true) {
      const countToken = this.#peek();
      if (countToken.kind !== 'number') {
        this.#fail(countToken, 'expected how many to pick, e.g. "Target 1 character as victim."', 'syntax');
        return null;
      }
      this.#advance();
      const count = Number(countToken.text);
      if (count < 1) {
        this.#fail(countToken, 'a binding picks at least 1', 'target-count');
        return null;
      }
      const distinct = this.#matchWord('different');
      const chars = this.#parseCharsBody('all', this.#peek().start, this.#peek().start);
      if (!chars) return null;
      if (!this.#matchWord('as')) {
        this.#failHere('expected "as <name>" — write "Target 1 character as victim."', 'syntax');
        return null;
      }
      const nameToken = this.#peek();
      if (nameToken.kind !== 'word') {
        this.#fail(nameToken, 'expected a name after "as"', 'syntax');
        return null;
      }
      this.#advance();
      bindings.push({
        span: { start: countToken.start, end: nameToken.end },
        name: nameToken.text,
        nameSpan: { start: nameToken.start, end: nameToken.end },
        count,
        distinct,
        chars,
      });
      if (this.#matchWord('and')) continue;
      break;
    }
    if (this.#expectSentenceEnd() === undefined) return null;
    return bindings;
  }

  /**
   * `Available while <condition>.` — returns `undefined` when the sentence
   * is not one, `null` when it is one that did not parse.
   */
  #parseAvailableClause(): IfClause | undefined | null {
    const start = this.#peek();
    if (!(start.kind === 'word' && start.lower === 'available')) return undefined;
    this.#advance();
    if (!this.#matchWord('while')) {
      this.#failHere('expected "while" — write "Available while this has Charged."', 'syntax');
      return null;
    }
    const clause = this.#parseConditionClause(start);
    if (!clause) return null;
    if (this.#expectSentenceEnd() === undefined) return null;
    return clause;
  }

  #parseModifierSentence(): ModifierSentence | undefined | null {
    const start = this.#peek();
    if (start.kind !== 'word') return undefined;
    if (!DIRECTION_WORDS.includes(start.lower as (typeof DIRECTION_WORDS)[number])) return undefined;
    this.#advance();
    const direction = start.lower === 'outgoing' ? 'outgoing' : 'incoming';

    // The subject's change word: either the HP-generic `damage`/`healing`
    // (matches a loss/gain on any gauge), or a named gauge followed by
    // `gain`/`loss` (`incoming mana loss`) — the same two shapes, spelled
    // for a specific gauge.
    const subjectToken = this.#peek();
    let change: 'damage' | 'heal';
    let gauge: string | undefined;
    if (subjectToken.kind === 'word' && GAUGE_WORDS.includes(subjectToken.lower as (typeof GAUGE_WORDS)[number])) {
      this.#advance();
      gauge = subjectToken.lower;
      const gainLossToken = this.#peek();
      if (
        gainLossToken.kind !== 'word' ||
        !GAIN_LOSS_WORDS.includes(gainLossToken.lower as (typeof GAIN_LOSS_WORDS)[number])
      ) {
        this.#fail(gainLossToken, `expected "gain" or "loss" after "${subjectToken.text}"`, 'syntax');
        return null;
      }
      this.#advance();
      change = gainLossToken.lower === 'loss' ? 'damage' : 'heal';
    } else if (
      subjectToken.kind === 'word' &&
      CHANGE_WORDS.includes(subjectToken.lower as (typeof CHANGE_WORDS)[number])
    ) {
      this.#advance();
      change = subjectToken.lower === 'damage' ? 'damage' : 'heal';
    } else {
      this.#fail(
        subjectToken,
        `expected "damage" or "healing" (or a gauge like "mana" followed by "gain"/"loss") after "${start.text}"`,
        'syntax',
      );
      return null;
    }

    // `from enemy characters` — narrows by who is on the other side of the
    // action. Bare group form, no quantifier of its own, like a trigger's
    // subject ("when 2 to 5 enemy characters … die").
    let target: CharsPhrase | undefined;
    if (this.#matchWord('from')) {
      const here = this.#peek().start;
      const subject = this.#parseCharsBody('all', here, here);
      if (!subject) return null;
      target = subject;
    }

    // Two frames: `… is <rewrite>.` and `… has a <n>% chance to be <rewrite>.`
    let chance: MathExpression | undefined;
    if (this.#matchWord('has')) {
      if (!(this.#matchWord('a') || this.#matchWord('an'))) {
        this.#failHere('expected "a" — write "… has a 25% chance to be doubled."', 'syntax');
        return null;
      }
      const percent = this.#expectAmount('after "a"', 'syntax');
      if (!percent) return null;
      if (!(this.#peek().kind === 'punct' && this.#peek().text === '%')) {
        this.#failHere('expected "%" after the number — write "a 25% chance"', 'syntax');
        return null;
      }
      this.#advance();
      if (!this.#matchWord('chance')) {
        this.#failHere('expected "chance" — write "… has a 25% chance to be doubled."', 'syntax');
        return null;
      }
      if (!(this.#matchWord('to') && this.#matchWord('be'))) {
        this.#failHere('expected "to be" before the change', 'syntax');
        return null;
      }
      chance = percent.value;
    } else if (!this.#matchWord('is')) {
      this.#failHere(
        `expected "is" or "has a <n>% chance to be" — write "${start.text} ${subjectToken.text} is capped at 50."`,
        'syntax',
      );
      return null;
    }

    const rewrite = this.#parseModifierRewrite();
    if (!rewrite) return null;

    const end = this.#expectSentenceEnd();
    if (end === undefined) return null;
    return {
      kind: 'modifier',
      span: { start: start.start, end },
      direction,
      change,
      ...(gauge ? { gauge } : {}),
      ...(target ? { target } : {}),
      rewrite,
      ...(chance !== undefined ? { chance } : {}),
    };
  }

  /** The past-participle rewrite of a modifier sentence. */
  #parseModifierRewrite(): ModifierSentence['rewrite'] | undefined {
    const token = this.#peek();
    if (
      token.kind !== 'word' ||
      !MODIFIER_REWRITES.includes(token.lower as (typeof MODIFIER_REWRITES)[number])
    ) {
      this.#fail(
        token,
        `expected one of ${MODIFIER_REWRITES.map((word) => `"${word}"`).join(', ')}`,
        'syntax',
      );
      return undefined;
    }
    this.#advance();
    switch (token.lower) {
      case 'prevented':
        return { kind: 'prevent' };
      case 'doubled':
        return { kind: 'amount', op: 'multiply', by: { kind: 'number', value: 2 } };
      case 'halved':
        return { kind: 'amount', op: 'multiply', by: { kind: 'number', value: 0.5 } };
      case 'capped': {
        if (!this.#matchWord('at')) {
          this.#failHere('expected "at" — write "is capped at 50"', 'syntax');
          return undefined;
        }
        const amount = this.#expectAmount('after "at"', 'syntax');
        return amount ? { kind: 'cap', at: amount.value } : undefined;
      }
      case 'redirected': {
        if (!this.#matchWord('to')) {
          this.#failHere('expected "to" — write "is redirected to mana"', 'syntax');
          return undefined;
        }
        const gaugeToken = this.#peek();
        if (gaugeToken.kind !== 'word' || !GAUGE_WORDS.includes(gaugeToken.lower as (typeof GAUGE_WORDS)[number])) {
          this.#failHere('expected a gauge ("hp" or "mana") after "to"', 'syntax');
          return undefined;
        }
        this.#advance();
        return { kind: 'redirect', gauge: gaugeToken.lower };
      }
      default: {
        if (!this.#matchWord('by')) {
          this.#failHere(`expected "by" — write "is ${token.text} by 5"`, 'syntax');
          return undefined;
        }
        const amount = this.#expectAmount('after "by"', 'syntax');
        if (!amount) return undefined;
        const op =
          token.lower === 'increased' ? 'add' : token.lower === 'reduced' ? 'subtract' : 'multiply';
        return { kind: 'amount', op, by: amount.value };
      }
    }
  }

  #parseSentence(): Sentence | undefined {
    const prefix = this.#parseEventPrefix();
    const repeat = this.#parseRepeatPrefix();
    if (repeat === null) {
      this.#recover();
      return undefined;
    }
    const optional = this.#parseMayPrefix();
    const guard = this.#parseIfGuard();
    if (guard === null) {
      this.#recover();
      return undefined;
    }
    const token = this.#peek();
    if (token.kind !== 'word') {
      this.#fail(token, 'expected a sentence — a verb like "Deal", "Heal", "Destroy", "Add", or "Remove"', 'syntax');
      this.#recover();
      return undefined;
    }
    const word = token.lower;
    let sentence: Sentence | undefined;
    switch (word) {
      case 'deal':
        sentence = this.#parseDeal();
        break;
      case 'heal':
        sentence = this.#parseHeal();
        break;
      case 'destroy':
        sentence = this.#parseDestroy();
        break;
      case 'add':
        sentence = this.#parseAddRemove(true);
        break;
      case 'remove':
        sentence = this.#looksLikeCounters() ? this.#parseRemoveCounters() : this.#parseAddRemove(false);
        break;
      case 'toggle':
        sentence = this.#parseToggle();
        break;
      case 'roll':
        sentence = this.#parseRoll();
        break;
      case 'store':
        sentence = this.#parseStore();
        break;
      case 'cards':
        sentence = this.#parseZoneAbility();
        break;
      case 'reveal':
        sentence = this.#startsCardSelector(1) ? this.#parseRevealCards() : this.#parseRevealCard();
        break;
      case 'cast':
        sentence = this.#startsCardSelector(1) ? this.#parseCastCards() : this.#parseCastCard();
        break;
      case 'move':
        sentence = this.#startsCardSelector(1) ? this.#parseMoveCards() : this.#parseMoveCard();
        break;
      case 'draw':
        sentence = this.#parseDraw();
        break;
      case 'scry':
      case 'surveil':
        sentence = this.#parseDraw();
        break;
      case 'target':
        sentence = this.#parseSplit();
        break;
      case 'create':
      case 'the':
        sentence = this.#parseCreate();
        break;
      case 'you': {
        // `You win the game.` / `You choose …` / `You commit …` / `You put the card …`
        const verbWord = this.#peek(1).lower;
        const afterVerb = this.#peek(2).lower;
        sentence =
          verbWord === 'create' ? this.#parseCreate() : verbWord === 'play' || (verbWord === 'and' && this.#peek(2).lower === 'target' && this.#peek(4).lower === 'play')
            ? this.#parsePlay()
            : verbWord === 'separate'
            ? this.#parseSplit()
            : verbWord === 'choose' && afterVerb !== 'a' && afterVerb !== 'an'
              ? this.#parseChoosePile()
              : verbWord === 'choose' || verbWord === 'commit'
            ? this.#parseChoose()
            : verbWord === 'put'
              ? this.#parseMoveChosen()
              : this.#parseResultSentence();
        break;
      }
      case 'all':
        sentence = this.#parseResultSentence();
        break;
      case 'each': {
        const verbWord = this.#peek(2).lower;
        sentence =
          verbWord === 'creates' ? this.#parseCreate() : verbWord === 'plays' ? this.#parsePlay() : verbWord === 'puts' ? this.#parseMoveChosen() : this.#parseChoose();
        break;
      }
      case 'when':
        sentence = this.#parseReveal();
        break;
      case 'starting':
      case 'ending':
      case 'in':
        sentence = this.#parseOpenVote();
        break;
      default:
        sentence = this.#unexpectedSentenceStart(token);
        break;
    }

    if (!sentence) return sentence;
    return {
      ...sentence,
      ...(prefix ? { event: prefix } : {}),
      ...(guard ? { guard } : {}),
      ...(optional ? { optional: true } : {}),
      ...(repeat ? { repeat } : {}),
    };
  }

  #unexpectedSentenceStart(token: Token): undefined {
    const future = FUTURE_WORDS.find((f) => f.word === token.lower);
    if (future) {
      this.#fail(token, this.#futureSentenceMessage(token, future.message), 'future-feature');
    } else if (token.lower === 'players') {
      this.#fail(token, '"All players …" starts with "All" — write "All players lose the game."', 'syntax');
    } else if (QUANTIFIERS.includes(token.lower as (typeof QUANTIFIERS)[number])) {
      this.#fail(token, `"${token.text}" names characters, but an action comes first — write the verb first, e.g. "Destroy all enemy characters."`, 'syntax');
    } else if (ADJECTIVES.includes(token.lower as (typeof ADJECTIVES)[number])) {
      this.#fail(token, `"${token.text}" needs a quantifier first — "all enemy characters", "target enemy character"`, 'syntax');
    } else {
      const starters = SENTENCE_STARTERS.map((s) => `"${s[0]!.toUpperCase()}${s.slice(1)}"`).join(', ');
      this.#fail(token, `unexpected "${token.text}" — start a sentence with a verb (${starters})`, 'syntax');
    }
    this.#recover();
    return undefined;
  }

  /**
   * The diagnostic message for a future-feature sentence start. A plain
   * "when" keeps its generic next-milestone hint; when the sentence body
   * carries one of the planned batch-event count phrases
   * (BATCH_EVENT_COUNT_WORDS — see the language docs' "Kept in mind:
   * events and batch triggers"), the message names the range so the editor
   * recognizes the specced vocabulary instead of guessing.
   */
  #futureSentenceMessage(token: Token, fallback: string): string {
    if (token.lower !== 'when') return fallback;
    const phrase = this.#scanBatchEventCountPhrase();
    if (phrase) {
      return `Events are the next milestone — batch-event counts like "${phrase}" (e.g. "when ${phrase} characters die then …") are not available yet.`;
    }
    return fallback;
  }

  /**
   * Scans the current sentence (from the "when" token to the next
   * sentence boundary) for a planned count phrase: `one or more`,
   * `<n> or more`, `<n> to <m>`, or `<n> or less`. Returns the phrase in
   * its canonical spelling, or undefined.
   */
  #scanBatchEventCountPhrase(): string | undefined {
    for (let i = this.#index; i < this.#tokens.length - 1; i += 1) {
      const token = this.#tokens[i]!;
      if (token.kind === 'eof') return undefined;
      if (token.kind === 'punct' && token.text === '.') return undefined;
      if (token.kind === 'word' && token.atLineStart && SECTION_WORDS.includes(token.lower as (typeof SECTION_WORDS)[number])) {
        return undefined;
      }
      const next = this.#tokens[i + 1]!;
      const after = this.#tokens[i + 2];
      const isCountWord = (t: Token | undefined, word: string): boolean =>
        t !== undefined && t.kind === 'word' && t.lower === word;
      if (token.kind === 'word' && token.lower === 'one' && isCountWord(next, 'or') && isCountWord(after, 'more')) {
        return 'one or more';
      }
      if (token.kind === 'number') {
        if (isCountWord(next, 'or') && after !== undefined && after.kind === 'word' && BATCH_EVENT_COUNT_WORDS.includes(after.lower as (typeof BATCH_EVENT_COUNT_WORDS)[number])) {
          return `${token.text} or ${after.lower}`;
        }
        if (isCountWord(next, 'to') && after !== undefined && after.kind === 'number') {
          return `${token.text} to ${after.text}`;
        }
      }
    }
    return undefined;
  }

  #parseDeal(): Sentence | undefined {
    const start = this.#advance(); // 'deal'
    const amount = this.#expectAmount('after "Deal"', 'syntax');
    if (!amount) return this.#abort();
    if (!this.#matchWord('damage')) {
      this.#failHere('expected "damage" after the amount, e.g. "Deal 5 damage to …"', 'syntax');
      return this.#abort();
    }
    if (!this.#matchWord('to')) {
      this.#failHere('expected "to", e.g. "Deal 5 damage to all enemy characters."', 'syntax');
      return this.#abort();
    }
    const chars = this.#parseCharsPhrase();
    if (!chars) return this.#abort();
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return {
      kind: 'deal',
      span: { start: start.start, end },
      amount: amount.value,
      amountSpan: amount.span,
      chars,
    };
  }

  #parseHeal(): Sentence | undefined {
    const start = this.#advance(); // 'heal'
    // Two word orders: "Heal <chars> for <n>." and "Heal <n> to <chars>."
    // The amount-first order only kicks in when the amount can't be
    // mistaken for a chars-phrase quantifier — a bare number, or a formula
    // that *starts* with something no quantifier word does (`(`, `Σ`). A
    // formula starting with a bare identifier is ambiguous with "all"/
    // "target"/etc. here, so it needs the "for <n>" order instead.
    const startsAmount =
      this.#peek().kind === 'number' ||
      this.#peekPunct('(') ||
      (this.#peek().kind === 'punct' && (this.#peek().text === 'Σ' || this.#peek().text === '∑'));
    if (startsAmount) {
      const amount = this.#expectAmount('after "Heal"', 'syntax');
      if (!amount) return this.#abort();
      if (!this.#matchWord('to')) {
        this.#failHere('expected "to", e.g. "Heal 25 to all ally characters."', 'syntax');
        return this.#abort();
      }
      const chars = this.#parseCharsPhrase();
      if (!chars) return this.#abort();
      const end = this.#expectSentenceEnd();
      if (!end) return this.#abort();
      return {
        kind: 'heal',
        span: { start: start.start, end },
        amount: amount.value,
        amountSpan: amount.span,
        chars,
      };
    }
    const chars = this.#parseCharsPhrase();
    if (!chars) return this.#abort();
    if (!this.#matchWord('for')) {
      this.#failHere('expected "for", e.g. "Heal all ally characters for 25."', 'syntax');
      return this.#abort();
    }
    const amount = this.#expectAmount('after "for"', 'syntax');
    if (!amount) return this.#abort();
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return {
      kind: 'heal',
      span: { start: start.start, end },
      amount: amount.value,
      amountSpan: amount.span,
      chars,
    };
  }

  #parseDestroy(): Sentence | undefined {
    const start = this.#advance(); // 'destroy'
    const chars = this.#parseCharsPhrase();
    if (!chars) return this.#abort();
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return { kind: 'destroy', span: { start: start.start, end }, chars };
  }

  #parseAddRemove(add: boolean): Sentence | undefined {
    const start = this.#advance(); // 'add' | 'remove'
    const buffTokens: Token[] = [];
    while (this.#peek().kind === 'word') {
      const lower = this.#peek().lower;
      if (BUFF_STOP_WORDS.includes(lower as (typeof BUFF_STOP_WORDS)[number])) break;
      buffTokens.push(this.#advance());
    }
    if (buffTokens.length === 0) {
      this.#failHere(
        add ? 'expected the buff name after "Add", e.g. "Add Poison to …"' : 'expected the buff name after "Remove", e.g. "Remove Poison from …"',
        'syntax',
      );
      return this.#abort();
    }
    const buffFirst = buffTokens[0]!;
    const buffLast = buffTokens[buffTokens.length - 1]!;
    const buffName = buffTokens.map((t) => t.text).join(' ');
    const separator = add ? 'to' : 'from';
    if (!this.#matchWord(separator)) {
      this.#failHere(add ? `expected "to", e.g. "Add ${buffName} to target enemy character."` : `expected "from", e.g. "Remove ${buffName} from all characters."`, 'syntax');
      return this.#abort();
    }
    const chars = this.#parseCharsPhrase();
    if (!chars) return this.#abort();
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    if (add) {
      return {
        kind: 'addBuff',
        span: { start: start.start, end },
        buffName,
        buffSpan: { start: buffFirst.start, end: buffLast.end },
        chars,
      };
    }
    return {
      kind: 'removeBuff',
      span: { start: start.start, end },
      buffName,
      buffSpan: { start: buffFirst.start, end: buffLast.end },
      chars,
    };
  }

  /** `You win the game.` / `All players lose the game.` */
  /**
   * `Toggle <buff> [on <chars>].` — with no `on …` it flips the buff on
   * the ability's own owner.
   */
  #parseToggle(): Sentence | undefined {
    const start = this.#advance(); // 'toggle'
    const buffTokens: Token[] = [];
    while (this.#peek().kind === 'word') {
      const lower = this.#peek().lower;
      if (lower === 'on' || BUFF_STOP_WORDS.includes(lower as (typeof BUFF_STOP_WORDS)[number])) break;
      buffTokens.push(this.#advance());
    }
    if (buffTokens.length === 0) {
      this.#failHere('expected the buff name after "Toggle", e.g. "Toggle Immolation Aura."', 'syntax');
      return this.#abort();
    }
    const first = buffTokens[0]!;
    const last = buffTokens[buffTokens.length - 1]!;
    const name = {
      text: buffTokens.map((t) => t.text).join(' '),
      span: { start: first.start, end: last.end },
    };
    let chars: CharsPhrase;
    if (this.#matchWord('on')) {
      const parsed = this.#parseCharsPhrase();
      if (!parsed) return this.#abort();
      chars = parsed;
    } else {
      // The implied subject: whatever is using the ability.
      chars = {
        kind: 'chars',
        span: { start: name.span.end, end: name.span.end },
        quantifier: 'this',
        bare: true,
        other: false,
        who: undefined,
        owner: undefined,
        withClause: undefined,
      };
    }
    const end = this.#expectSentenceEnd();
    if (end === undefined) return this.#abort();
    return {
      kind: 'toggleBuff',
      span: { start: start.start, end },
      buffName: name.text,
      buffSpan: name.span,
      chars,
    };
  }

  #parseResultSentence(): Sentence | undefined {
    const start = this.#advance(); // 'you' | 'all'
    let playersSpan = { start: start.start, end: start.end };
    let players: 'you' | 'allPlayers';
    if (start.lower === 'you') {
      players = 'you';
    } else {
      if (!this.#matchWord('players')) {
        this.#failHere('"all" at a sentence start begins "All players …"; for characters write the action first, e.g. "Destroy all characters owned by you."', 'syntax');
        return this.#abort();
      }
      players = 'allPlayers';
      playersSpan = { start: start.start, end: this.#previous().end };
    }
    const verb = this.#peek();
    if (verb.kind !== 'word' || !RESULT_VERBS.includes(verb.lower as (typeof RESULT_VERBS)[number])) {
      this.#fail(verb, 'expected "win", "wins", "lose", or "loses" — e.g. "You lose the game."', 'syntax');
      return this.#abort();
    }
    this.#advance();
    const win = verb.lower.startsWith('win');
    if (!this.#matchWord('the')) {
      this.#failHere('expected "the game" after the result, e.g. "You lose the game."', 'syntax');
      return this.#abort();
    }
    if (!this.#matchWord('game')) {
      this.#failHere('expected "game" after "the", e.g. "You lose the game."', 'syntax');
      return this.#abort();
    }
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return {
      kind: 'result',
      span: { start: start.start, end },
      players,
      playersSpan,
      win,
    };
  }

  /* ------------------------------ this card ------------------------------ */

  /** `this card` after a verb. Anything else is a pointed error, not a stray word. */
  #expectThisCard(verb: string, example: string): boolean {
    if (this.#matchWord('this') && this.#matchWord('card')) return true;
    this.#failHere(
      `"${verb}" here acts on the card an ability belongs to — write "this card", e.g. "${example}"`,
      'syntax',
    );
    return false;
  }

  /** `its owner's <zone>` — the pile of whoever the card came from. */
  #parseOwnersZone(example: string): string | null {
    if (!(this.#matchWord('its') && this.#matchWord("owner's"))) {
      this.#failHere(`expected "its owner's <zone>" — e.g. "${example}"`, 'syntax');
      return null;
    }
    return this.#parseZoneName(`expected the zone — e.g. "${example}"`);
  }

  /**
   * `Cards in your boxed zone have Open Present for each opponent.`
   *
   * Whose zone (`your` / `each player's` / `each opponent's` / `the`), the zone's
   * name and an optional `zone`, `have`, the ability's name (as written, up to
   * `for` or the full stop), and who may use it (default: anyone).
   */
  #parseZoneAbility(): Sentence | undefined {
    const example = 'Cards in your boxed zone have Open Present for each opponent.';
    const start = this.#advance(); // 'cards'
    if (!this.#matchWord('in')) {
      this.#failHere(`write "Cards in <whose> <zone> have <ability>" — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    let owners: 'you' | 'each' | 'opponents' | 'shared' | 'this';
    // `Cards in this zone` — the zone of the `Zone` section it is written in.
    const thisZone = this.#peek().lower === 'this' && this.#peek(1).lower === 'zone';
    if (thisZone) {
      this.#advance();
      this.#advance();
      owners = 'this';
    } else if (this.#matchWord('your')) owners = 'you';
    else if (this.#peek().lower === 'each' && this.#peek(1).lower === "player's") {
      this.#advance();
      this.#advance();
      owners = 'each';
    } else if (this.#peek().lower === 'each' && this.#peek(1).lower === "opponent's") {
      this.#advance();
      this.#advance();
      owners = 'opponents';
    } else if (this.#matchWord('the')) owners = 'shared';
    else {
      this.#failHere(`whose zone? — "your", "each player's", "each opponent's" or "the" — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    const zoneStart = this.#peek();
    const zone = owners === 'this' ? '' : this.#parseZoneName(`expected the zone — e.g. "${example}"`);
    if (zone === null) return this.#abort();
    const zoneSpan = { start: zoneStart.start, end: owners === 'this' ? this.#previous().end : this.#previous().end };
    if (owners !== 'this') this.#matchWord('zone'); // optional: "your hand" / "your boxed zone"
    // `no longer have` takes the ability away instead of giving it.
    let remove = false;
    if (this.#peek().lower === 'no' && this.#peek(1).lower === 'longer') {
      this.#advance();
      this.#advance();
      remove = true;
    }
    if (!this.#matchWord('have')) {
      this.#failHere(`expected "have <ability>" — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    const first = this.#peek();
    let last = first;
    while (
      (this.#peek().kind === 'word' && this.#peek().lower !== 'for') ||
      this.#peek().kind === 'number'
    ) {
      last = this.#advance();
    }
    if (last === first && !(first.kind === 'word' && first.lower !== 'for') && first.kind !== 'number') {
      this.#fail(first, `expected the name of an ability after "have" — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    const abilitySpan = { start: first.start, end: last.end };
    const ability = this.#text.slice(abilitySpan.start, abilitySpan.end);
    let users: 'you' | 'each' | 'opponents' = 'each';
    if (remove && this.#peek().lower === 'for') {
      this.#failHere('"no longer have" takes the ability away from everyone it was given to — drop the "for …"', 'syntax');
      return this.#abort();
    }
    if (this.#matchWord('for')) {
      if (this.#matchWord('you')) users = 'you';
      else if (this.#matchWord('each')) {
        if (this.#matchWord('player')) users = 'each';
        else if (this.#matchWord('opponent')) users = 'opponents';
        else {
          this.#failHere('"each" is followed by "player" or "opponent" — e.g. "for each opponent"', 'syntax');
          return this.#abort();
        }
      } else {
        this.#failHere('who may use it? — "for you", "for each player" or "for each opponent"', 'syntax');
        return this.#abort();
      }
    }
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return {
      kind: 'zoneAbility',
      span: { start: start.start, end },
      zone,
      zoneSpan,
      owners,
      ability,
      abilitySpan,
      users,
      ...(remove ? { remove: true as const } : {}),
    };
  }

  /** `Reveal this card.` */
  #parseRevealCard(): Sentence | undefined {
    const start = this.#advance(); // 'reveal'
    if (!this.#expectThisCard('Reveal', 'Reveal this card.')) return this.#abort();
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return { kind: 'revealCard', span: { start: start.start, end } };
  }

  /**
   * `Move the top 3 cards from your library to your hand.` —
   * `Move <cards> from <zone> to <zone>.`
   */
  #parseMoveCards(): Sentence | undefined {
    const example = 'Move the top 3 cards from your library to your hand.';
    const start = this.#advance(); // 'move'
    const selectStart = this.#peek();
    const select = this.#parseCardSelector(example);
    if (!select) return this.#abort();
    const selectSpan = { start: selectStart.start, end: this.#previous().end };
    const fromStart = this.#peek();
    const from = this.#parseCardSource(example);
    if (!from) return this.#abort();
    const fromSpan = { start: fromStart.start, end: this.#previous().end };
    if (!this.#matchWord('to')) {
      this.#failHere(`expected "to <zone>" — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    const toStart = this.#peek();
    const to = this.#parseZoneRef(true, example);
    if (!to) return this.#abort();
    const toSpan = { start: toStart.start, end: this.#previous().end };
    const order = this.#parseOrderOfChoice();
    let rest: RestIR | undefined;
    if (this.#peek().lower === 'and' && this.#peek(1).lower === 'the' && this.#peek(2).lower === 'rest') {
      if (!select.any) {
        this.#failHere('"the rest" means the cards not picked — it needs "any number of …" to say which are picked', 'syntax');
        return this.#abort();
      }
      this.#advance();
      this.#advance();
      this.#advance();
      if (!(this.#matchWord('on') || this.#matchWord('to') || this.#matchWord('in') || this.#matchWord('into'))) {
        this.#failHere(`expected where the rest go — e.g. "and the rest on the top of your deck"`, 'syntax');
        return this.#abort();
      }
      const restTo = this.#parseZoneRef(true, example);
      if (!restTo) return this.#abort();
      const restOrder = this.#parseOrderOfChoice();
      rest = { to: restTo, ...(restOrder ? { order: restOrder } : {}) };
    }
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return {
      kind: 'moveCards',
      span: { start: start.start, end },
      select,
      selectSpan,
      from,
      fromSpan,
      to,
      toSpan,
      ...(order ? { order } : {}),
      ...(rest ? { rest } : {}),
    };
  }

  /**
   * `Each player plays Rock Paper Scissors.` / `You and target opponent play Rock Paper Scissors.`
   * — the contest is defined elsewhere (a `Contest` section, or the host's), and receives the list of players.
   */
  #parsePlay(): Sentence | undefined {
    const example = 'You and target opponent play Rock Paper Scissors.';
    const start = this.#peek();
    let players: ContestPlayersIR;
    if (this.#peek().lower === 'you' && this.#peek(1).lower === 'and' && this.#peek(2).lower === 'target' && this.#peek(3).lower === 'opponent') {
      for (let i = 0; i < 5; i += 1) this.#advance(); // you and target opponent play
      players = 'you-and-opponent';
    } else if (this.#matchWord('you')) {
      this.#advance(); // play
      players = 'you';
    } else {
      this.#advance(); // each
      if (this.#matchWord('player')) players = 'each';
      else if (this.#matchWord('opponent')) players = 'opponents';
      else {
        this.#failHere('"Each" is followed by "player" or "opponent" — e.g. "Each player plays Rock Paper Scissors."', 'syntax');
        return this.#abort();
      }
      this.#advance(); // plays
    }
    // The contest's name: the words up to the sentence end.
    const first = this.#peek();
    const words: Token[] = [];
    while (this.#peek().kind === 'word') words.push(this.#advance());
    const name = words.map((w) => w.text).join(' ');
    const found = this.#contests.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      const known = this.#contests.map((c) => `"${c.name}"`).join(', ');
      this.#fail(
        first,
        name.length === 0
          ? `play what? — name a contest (${known || 'none are defined'}), e.g. "${example}"`
          : `unknown contest "${name}"${known ? ` — the contests are ${known}` : ' — none are defined; define one with a "Contest" section'}`,
        'unknown-contest',
      );
      return this.#abort();
    }
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    this.#contestPlayed = true;
    return { kind: 'play', span: { start: start.start, end }, players, contest: found };
  }

  /**
   * `Create a Giant Golem.` / `The winners create a Giant Golem.` / `Each player creates a Giant Golem.` —
   * a creature defined elsewhere (`Creature Giant Golem 6/6`), made in play for each of the players.
   */
  #parseCreate(): Sentence | undefined {
    const example = 'The winners create a Giant Golem.';
    const start = this.#peek();
    let players: PlayerListIR;
    if (this.#matchWord('create')) players = 'you';
    else if (this.#matchWord('you')) {
      this.#advance(); // create
      players = 'you';
    } else if (this.#matchWord('the')) {
      const which = this.#peek();
      if (!(which.lower === 'winners' || which.lower === 'losers') || this.#peek(1).lower !== 'create') {
        this.#failHere(`"The" here is "The winners create …" or "The losers create …" — e.g. "${example}"`, 'syntax');
        return this.#abort();
      }
      if (!this.#contestPlayed) {
        this.#failHere(`"the ${which.lower}" are the result of a contest — play one first, e.g. "Each player plays Rock Paper Scissors."`, 'syntax');
        return this.#abort();
      }
      players = which.lower as 'winners' | 'losers';
      this.#advance();
      this.#advance();
    } else {
      this.#advance(); // each
      if (this.#matchWord('player')) players = 'each';
      else if (this.#matchWord('opponent')) players = 'opponents';
      else {
        this.#failHere('"Each" is followed by "player" or "opponent" — e.g. "Each player creates a Giant Golem."', 'syntax');
        return this.#abort();
      }
      this.#advance(); // creates
    }
    if (!(this.#matchWord('a') || this.#matchWord('an'))) {
      this.#failHere(`expected "a" and the creature's name — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    const first = this.#peek();
    const words: Token[] = [];
    while (this.#peek().kind === 'word') words.push(this.#advance());
    const name = words.map((w) => w.text).join(' ');
    const found = this.#creatures.find((c) => c.toLowerCase() === name.toLowerCase());
    if (!found) {
      const known = this.#creatures.map((c) => `"${c}"`).join(', ');
      this.#fail(
        first,
        `unknown creature "${name}"${known ? ` — the creatures are ${known}` : ' — none are defined; define one with "Creature <name> <power>/<health>"'}`,
        'unknown-creature',
      );
      return this.#abort();
    }
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return { kind: 'create', span: { start: start.start, end }, players, creature: found };
  }

  /** The temporary piles named so far in this document. */
  readonly #tempNames = new Set<string>();

  /** `Target opponent separates Pool into Fact and Fiction.` / `You separate Pool into …` */
  #parseSplit(): Sentence | undefined {
    const example = 'Target opponent separates Pool into Fact and Fiction.';
    const start = this.#peek();
    let chooser: 'you' | 'opponent';
    if (this.#matchWord('target')) {
      if (!this.#matchWord('opponent') || !this.#matchWord('separates')) {
        this.#failHere(`expected "Target opponent separates …" — e.g. "${example}"`, 'syntax');
        return this.#abort();
      }
      chooser = 'opponent';
    } else {
      this.#advance(); // you
      this.#advance(); // separate
      chooser = 'you';
    }
    const from = this.#parseZoneRef(false, example);
    if (!from || from.whose !== 'temporary') {
      if (from) this.#failHere(`only a temporary zone can be separated into piles — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    if (!this.#matchWord('into')) {
      this.#failHere(`expected "into <pile> and <pile>" — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    const first = this.#peek();
    if (first.kind !== 'word') {
      this.#failHere('expected the first pile\'s name', 'syntax');
      return this.#abort();
    }
    this.#advance();
    if (!this.#matchWord('and')) {
      this.#failHere(`two piles — "into ${first.text} and <another>"`, 'syntax');
      return this.#abort();
    }
    const second = this.#peek();
    if (second.kind !== 'word') {
      this.#failHere('expected the second pile\'s name', 'syntax');
      return this.#abort();
    }
    this.#advance();
    this.#tempNames.add(first.text);
    this.#tempNames.add(second.text);
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return { kind: 'split', span: { start: start.start, end }, chooser, from, into: [first.text, second.text] };
  }

  /** `You choose Fact or Fiction.` */
  #parseChoosePile(): Sentence | undefined {
    const start = this.#advance(); // you
    this.#advance(); // choose
    const first = this.#peek();
    const known = (t: Token): boolean => t.kind === 'word' && this.#tempNames.has(t.text);
    if (!known(first)) {
      this.#failHere('which piles? — name two piles made by "separates … into …", e.g. "You choose Fact or Fiction."', 'syntax');
      return this.#abort();
    }
    this.#advance();
    if (!this.#matchWord('or') || !known(this.#peek())) {
      this.#failHere(`choose between two piles — e.g. "You choose ${first.text} or <the other pile>."`, 'syntax');
      return this.#abort();
    }
    const second = this.#advance();
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return { kind: 'choosePile', span: { start: start.start, end }, options: [first.text, second.text] };
  }

  /** `in the order of your choice` — the controller puts the moved cards down in an order they pick. */
  #parseOrderOfChoice(): CardOrderIR | undefined {
    if (
      this.#peek().lower === 'in' &&
      this.#peek(1).lower === 'the' &&
      this.#peek(2).lower === 'order' &&
      this.#peek(3).lower === 'of' &&
      ['your', 'their'].includes(this.#peek(4).lower) &&
      this.#peek(5).lower === 'choice'
    ) {
      for (let i = 0; i < 6; i += 1) this.#advance();
      return 'chosen';
    }
    return undefined;
  }

  /** True when the token `ahead` places on is where a card selector starts (`the`, `a`, `all`, a count). */
  #startsCardSelector(ahead: number): boolean {
    const token = this.#peek(ahead);
    return token.kind === 'number' || ['the', 'a', 'an', 'all', 'any'].includes(token.lower);
  }

  /**
   * Where the cards are taken from: `from your hand`, or `castable by target opponent` —
   * everything that player could cast, wherever it is.
   */
  #parseCardSource(example: string): CardSourceIR | null {
    if (this.#matchWord('castable')) {
      if (!this.#matchWord('by')) {
        this.#failHere('expected "by <player>" — e.g. "castable by target opponent"', 'syntax');
        return null;
      }
      if (this.#matchWord('you')) return { castableBy: 'you' };
      if (this.#peek().lower === 'target' && this.#peek(1).lower === 'opponent') {
        this.#advance();
        this.#advance();
        return { castableBy: 'opponent' };
      }
      if (this.#peek().lower === 'each' && this.#peek(1).lower === 'opponent') {
        this.#advance();
        this.#advance();
        return { castableBy: 'opponents' };
      }
      if (this.#peek().lower === 'each' && this.#peek(1).lower === 'player') {
        this.#advance();
        this.#advance();
        return { castableBy: 'each' };
      }
      this.#failHere('castable by whom? — "you", "target opponent", "each opponent" or "each player"', 'syntax');
      return null;
    }
    if (!this.#matchWord('from')) {
      this.#failHere(`expected "from <zone>" or "castable by <player>" after the cards — e.g. "${example}"`, 'syntax');
      return null;
    }
    return this.#parseZoneRef(false, example);
  }

  /** `Remove a counter from …` / `Remove 2 counters from …` — as opposed to `Remove Poison from …`. */
  #looksLikeCounters(): boolean {
    const first = this.#peek(1);
    if (!(first.kind === 'number' || first.lower === 'a' || first.lower === 'an')) return false;
    for (const ahead of [2, 3]) {
      if (['counter', 'counters'].includes(this.#peek(ahead).lower)) return true;
    }
    return false;
  }

  /** `Remove a counter from all cards in this zone.` */
  #parseRemoveCounters(): Sentence | undefined {
    const example = 'Remove a counter from all cards in this zone.';
    const start = this.#advance(); // 'remove'
    let count = 1;
    if (this.#peek().kind === 'number') count = Number(this.#advance().text);
    else this.#advance(); // a / an
    let counterKind: string | undefined;
    if (!['counter', 'counters'].includes(this.#peek().lower)) counterKind = this.#advance().text;
    this.#advance(); // counter(s)
    if (!this.#matchWord('from')) {
      this.#failHere(`expected "from <cards>" — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    const select = this.#parseCardSelector(example);
    if (!select) return this.#abort();
    if (!(this.#matchWord('in') || this.#matchWord('from'))) {
      this.#failHere(`expected "in <zone>" — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    const from = this.#parseZoneRef(false, example);
    if (!from) return this.#abort();
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return {
      kind: 'removeCounters',
      span: { start: start.start, end },
      count,
      ...(counterKind ? { counterKind } : {}),
      select,
      from,
    };
  }

  /** `Cast all cards with no counters from this zone without paying their cost.` */
  #parseCastCards(): Sentence | undefined {
    const example = 'Cast all cards with no counters from this zone without paying their cost.';
    const start = this.#advance(); // 'cast'
    const select = this.#parseCardSelector(example);
    if (!select) return this.#abort();
    if (!this.#matchWord('from')) {
      this.#failHere(`expected "from <zone>" — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    const from = this.#parseZoneRef(false, example);
    if (!from) return this.#abort();
    let free = false;
    if (this.#peek().lower === 'without' && this.#peek(1).lower === 'paying') {
      this.#advance();
      this.#advance();
      if (!(this.#matchWord('their') || this.#matchWord('its')) || !this.#matchWord('cost')) {
        this.#failHere('expected "their cost" — e.g. "without paying their cost"', 'syntax');
        return this.#abort();
      }
      free = true;
    }
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return { kind: 'castCards', span: { start: start.start, end }, select, from, ...(free ? { free: true as const } : {}) };
  }

  /** `Reveal all cards castable by target opponent.` / `Reveal the top 2 cards from your deck.` */
  #parseRevealCards(): Sentence | undefined {
    const example = 'Reveal all cards castable by target opponent.';
    const start = this.#advance(); // 'reveal'
    const selectStart = this.#peek();
    const select = this.#parseCardSelector(example);
    if (!select) return this.#abort();
    const selectSpan = { start: selectStart.start, end: this.#previous().end };
    const fromStart = this.#peek();
    const from = this.#parseCardSource(example);
    if (!from) return this.#abort();
    const fromSpan = { start: fromStart.start, end: this.#previous().end };
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return { kind: 'revealCards', span: { start: start.start, end }, select, selectSpan, from, fromSpan };
  }

  /**
   * Which cards: `the top card`, `the bottom 2 cards`, `a card`, `2 cards`, `a random card`,
   * `all cards` — each optionally `creature` or `spell` cards.
   */
  #parseCardSelector(example: string): CardSelectorIR | null {
    let how: CardSelectorIR['how'];
    let count = 1;
    let counted = false;
    const any = this.#peek().lower === 'any' && this.#peek(1).lower === 'number' && this.#peek(2).lower === 'of';
    if (any) {
      this.#advance();
      this.#advance();
      this.#advance();
    }
    if (this.#matchWord('the')) {
      const end = this.#peek();
      if (this.#matchWord('top')) how = 'top';
      else if (this.#matchWord('bottom')) how = 'bottom';
      else {
        this.#fail(end, `"the" here is "the top …" or "the bottom …" — e.g. "${example}"`, 'syntax');
        return null;
      }
    } else if (this.#matchWord('all')) {
      how = 'all';
      count = 0;
    } else if (this.#matchWord('a') || this.#matchWord('an')) {
      how = this.#matchWord('random') ? 'random' : 'choose';
    } else if (this.#peek().kind === 'number') {
      count = Number(this.#advance().text);
      counted = true;
      how = this.#matchWord('random') ? 'random' : 'choose';
      if (!Number.isInteger(count) || count < 1) {
        this.#failHere('how many cards? — a whole number, 1 or more', 'syntax');
        return null;
      }
    } else {
      this.#failHere(`which cards? — "the top card", "a card", "2 cards", "a random card" or "all cards" — e.g. "${example}"`, 'syntax');
      return null;
    }
    if ((how === 'top' || how === 'bottom') && this.#peek().kind === 'number') {
      count = Number(this.#advance().text);
      counted = true;
      if (!Number.isInteger(count) || count < 1) {
        this.#failHere('how many cards? — a whole number, 1 or more', 'syntax');
        return null;
      }
    }
    void counted;
    let cardKind: 'creature' | 'spell' | undefined;
    if (this.#matchWord('creature')) cardKind = 'creature';
    else if (this.#matchWord('spell')) cardKind = 'spell';
    if (!(this.#matchWord('card') || this.#matchWord('cards'))) {
      this.#failHere(`expected "card" or "cards" — e.g. "${example}"`, 'syntax');
      return null;
    }
    let counters: 'none' | undefined;
    if (this.#peek().lower === 'with' && this.#peek(1).lower === 'no' && this.#peek(2).lower === 'counters') {
      this.#advance();
      this.#advance();
      this.#advance();
      counters = 'none';
    }
    if (any) {
      if (how === 'all') {
        this.#failHere('"any number of" picks from a group — "all cards" has nothing to pick', 'syntax');
        return null;
      }
      if (how === 'choose' || how === 'random') count = 0; // no pool size: any number of the cards in the zone
      if (how === 'random') {
        this.#failHere('"any number of" is chosen by a player, so it cannot be "random"', 'syntax');
        return null;
      }
    }
    return {
      how,
      count,
      ...(cardKind ? { cardKind } : {}),
      ...(any ? { any: true as const } : {}),
      ...(counters ? { counters } : {}),
    };
  }

  /** `your hand` / `its owner's garbage` / `target opponent's hand` / `each opponent's hand` / `each player's hand` / `the play`. */
  #parseZoneRef(allowOwner: boolean, example: string): ZoneRefIR | null {
    if (this.#peek().lower === 'this' && this.#peek(1).lower === 'zone') {
      this.#advance();
      this.#advance();
      return { whose: 'this', zone: 'this' };
    }
    // A temporary pile: named where it is made (`the temporary zone Pool`), then by its name.
    if (this.#peek().lower === 'the' && this.#peek(1).lower === 'temporary' && this.#peek(2).lower === 'zone') {
      const name = this.#peek(3);
      if (name.kind !== 'word') {
        this.#fail(name, 'expected the temporary zone\'s name — e.g. "the temporary zone Pool"', 'syntax');
        return null;
      }
      for (let i = 0; i < 4; i += 1) this.#advance();
      this.#tempNames.add(name.text);
      return { whose: 'temporary', zone: name.text };
    }
    if (this.#peek().lower === 'the' && ['chosen', 'other'].includes(this.#peek(1).lower) && this.#peek(2).lower === 'pile') {
      const which = this.#peek(1).lower;
      for (let i = 0; i < 3; i += 1) this.#advance();
      return { whose: 'temporary', zone: which === 'chosen' ? '@chosen' : '@other' };
    }
    if (this.#peek().kind === 'word' && this.#tempNames.has(this.#peek().text)) {
      return { whose: 'temporary', zone: this.#advance().text };
    }
    let position: 'top' | 'bottom' | undefined;
    if (allowOwner && this.#peek().lower === 'the' && ['top', 'bottom'].includes(this.#peek(1).lower) && this.#peek(2).lower === 'of') {
      position = this.#peek(1).lower as 'top' | 'bottom';
      this.#advance();
      this.#advance();
      this.#advance();
    }
    let whose: ZoneRefIR['whose'];
    if (this.#matchWord('your')) whose = 'you';
    else if (this.#peek().lower === 'its' && this.#peek(1).lower === "owner's") {
      if (!allowOwner) {
        this.#failHere('"its owner\'s" names where a card goes back to — the cards are taken from a zone that is named outright, e.g. "from your garbage"', 'syntax');
        return null;
      }
      this.#advance();
      this.#advance();
      whose = 'owner';
    } else if (this.#peek().lower === 'target' && this.#peek(1).lower === "opponent's") {
      this.#advance();
      this.#advance();
      whose = 'opponent';
    } else if (this.#peek().lower === 'each' && this.#peek(1).lower === "opponent's") {
      this.#advance();
      this.#advance();
      whose = 'opponents';
    } else if (this.#peek().lower === 'each' && this.#peek(1).lower === "player's") {
      this.#advance();
      this.#advance();
      whose = 'each';
    } else if (allowOwner && this.#matchWord('their')) whose = 'owner';
    else if (this.#matchWord('the')) whose = 'shared';
    else if (this.#peek().kind === 'word' && this.#zones.resolve(this.#peek().text) !== undefined) whose = 'shared';
    else {
      this.#failHere(`whose zone? — "your", "its owner\'s", "target opponent\'s", "each opponent\'s", "each player\'s" or "the" — e.g. "${example}"`, 'syntax');
      return null;
    }
    const zone = this.#parseZoneName(`expected the zone — e.g. "${example}"`);
    if (zone === null) return null;
    this.#matchWord('zone'); // optional: "your stolen zone"
    return { whose, zone, ...(position ? { position } : {}) };
  }

  /** `Move this card to its owner's garbage.` */
  #parseMoveCard(): Sentence | undefined {
    const example = "Move this card to its owner's garbage.";
    const start = this.#advance(); // 'move'
    if (!this.#expectThisCard('Move', example)) return this.#abort();
    if (!this.#matchWord('to')) {
      this.#failHere(`expected "to its owner's <zone>" — e.g. "${example}"`, 'syntax');
      return this.#abort();
    }
    const zoneStart = this.#peek();
    // `to the Suspend zone` — a zone named outright, the card's owner's — or `to its owner's garbage`.
    let article: 'the' | undefined;
    let zone: string | null;
    if (this.#peek().lower === 'the' && this.#peek(1).lower !== 'top' && this.#peek(1).lower !== 'bottom') {
      this.#advance();
      zone = this.#parseZoneName(`expected the zone — e.g. "Move this card to the Suspend zone with 5 counters on it."`);
      if (zone !== null) {
        this.#matchWord('zone');
        article = 'the';
      }
    } else {
      zone = this.#parseOwnersZone(example);
    }
    if (zone === null) return this.#abort();
    const zoneSpan = { start: zoneStart.start, end: this.#previous().end };
    // `with 5 counters on it` (or `with 3 time counters on it`)
    let counters: { count: number; kind?: string } | undefined;
    if (this.#matchWord('with')) {
      const count = this.#expectNumber('after "with"', 'syntax');
      if (!count) return this.#abort();
      let kind: string | undefined;
      if (this.#peek().kind === 'word' && !['counter', 'counters'].includes(this.#peek().lower)) kind = this.#advance().text;
      if (!(this.#matchWord('counter') || this.#matchWord('counters')) || !this.#matchWord('on') || !this.#matchWord('it')) {
        this.#failHere('expected "counters on it" — e.g. "with 5 counters on it"', 'syntax');
        return this.#abort();
      }
      counters = { count: count.value, ...(kind ? { kind } : {}) };
    }
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return {
      kind: 'moveCard',
      span: { start: start.start, end },
      zone,
      zoneSpan,
      ...(article ? { article } : {}),
      ...(counters ? { counters } : {}),
    };
  }

  /**
   * `Cast this card if you can.` /
   * `Cast this card if you can, otherwise move it to its owner's garbage.`
   */
  #parseCastCard(): Sentence | undefined {
    const example = "Cast this card if you can, otherwise move it to its owner's garbage.";
    const start = this.#advance(); // 'cast'
    if (!this.#expectThisCard('Cast', example)) return this.#abort();
    if (!(this.#matchWord('if') && this.#matchWord('you') && this.#matchWord('can'))) {
      this.#failHere(
        'whether a card can be cast is the game\'s to say, so write "if you can" — e.g. "Cast this card if you can."',
        'syntax',
      );
      return this.#abort();
    }
    let otherwise: { zone: string; zoneSpan: { start: number; end: number } } | undefined;
    if (this.#peekPunct(',')) {
      this.#advance();
      if (!(this.#matchWord('otherwise') && this.#matchWord('move') && this.#matchWord('it') && this.#matchWord('to'))) {
        this.#failHere(`after the comma write "otherwise move it to its owner's <zone>" — e.g. "${example}"`, 'syntax');
        return this.#abort();
      }
      const zoneStart = this.#peek();
      const zone = this.#parseOwnersZone(example);
      if (zone === null) return this.#abort();
      otherwise = { zone, zoneSpan: { start: zoneStart.start, end: this.#previous().end } };
    }
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return { kind: 'castCard', span: { start: start.start, end }, ...(otherwise ? { otherwise } : {}) };
  }

  /* ------------------------ variables and drawing ------------------------ */

  /** `Store that value as AttackerRoll.` */
  #parseStore(): Sentence | undefined {
    const start = this.#advance(); // 'store'
    const value = this.#parseMathExpr();
    if (!value) return this.#abort();
    if (!this.#matchWord('as')) {
      this.#failHere('expected "as <Name>" — e.g. "Store that value as AttackerRoll."', 'syntax');
      return this.#abort();
    }
    const nameToken = this.#peek();
    if (nameToken.kind !== 'word') {
      this.#fail(nameToken, 'expected a name made of letters — e.g. "Store that value as AttackerRoll."', 'syntax');
      return this.#abort();
    }
    this.#advance();
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return {
      kind: 'store',
      span: { start: start.start, end },
      value,
      name: nameToken.text,
      nameSpan: { start: nameToken.start, end: nameToken.end },
    };
  }

  /** `Draw(you, 2).` / `Draw(each player, 1).` — `draw(player, count)`. */
  #parseDraw(): Sentence | undefined {
    const start = this.#advance(); // 'draw' | 'scry'
    const verb = start.lower === 'scry' ? 'Scry' : start.lower === 'surveil' ? 'Surveil' : 'Draw';
    const shape = `write it like "${verb}(you, ${verb === 'Draw' ? 2 : 3})." — the player (you / each player / each opponent), then a number`;
    if (!this.#peekPunct('(')) {
      this.#failHere(`"${verb}" takes a player and a number — ${shape}`, 'syntax');
      return this.#abort();
    }
    this.#advance();
    let players: PlayerListIR;
    if (this.#matchWord('you')) players = 'you';
    else if (this.#peek().lower === 'the' && ['winners', 'losers'].includes(this.#peek(1).lower)) {
      players = this.#peek(1).lower as 'winners' | 'losers';
      if (!this.#contestPlayed) {
        this.#failHere(`"the ${players}" are the result of a contest — play one first, e.g. "Each player plays Rock Paper Scissors."`, 'syntax');
        return this.#abort();
      }
      this.#advance();
      this.#advance();
    }
    else if (this.#matchWord('each')) {
      if (this.#matchWord('player')) players = 'each';
      else if (this.#matchWord('opponent')) players = 'opponents';
      else {
        this.#failHere('"each" is followed by "player" or "opponent" — e.g. "${verb}(each player, 1)."', 'syntax');
        return this.#abort();
      }
    } else {
      // The old order, `Draw(2, you)`, deserves a pointer, not a stray-word error.
      const first = this.#peek();
      const looksLikeCount = first.kind === 'number' || (first.kind === 'word' && first.lower === 'that');
      this.#failHere(
        looksLikeCount
          ? `the player comes first — ${shape}`
          : `the player is "you", "each player" or "each opponent" — ${shape}`,
        'syntax',
      );
      return this.#abort();
    }
    if (!this.#peekPunct(',')) {
      this.#failHere(`"${verb}" needs a number after the player — ${shape}`, 'syntax');
      return this.#abort();
    }
    this.#advance();
    const count = this.#parseMathExpr();
    if (!count) return this.#abort();
    if (!this.#peekPunct(')')) {
      this.#failHere(`expected ")" to close "${verb}(…" — ${shape}`, 'syntax');
      return this.#abort();
    }
    this.#advance();
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return verb === 'Draw'
      ? { kind: 'draw', span: { start: start.start, end }, count, players }
      : { kind: 'scry', span: { start: start.start, end }, count, players, ...(verb === 'Surveil' ? { surveil: true as const } : {}) };
  }

  /* -------------------------------- dice --------------------------------- */

  /** True while a table's result line is being parsed (see `#parseTableRow`). */
  #inTableRow = false;

  /** `Roll a d20.` / `Roll 2d6.` */
  #parseRoll(): Sentence | undefined {
    const start = this.#advance(); // 'roll'
    const hint = 'write "Roll a d20." for one die or "Roll 2d6." for several';
    let count = 1;
    let countToken: Token | undefined;
    if (this.#peek().kind === 'number') {
      countToken = this.#advance();
      count = Number(countToken.text);
    } else if (!this.#matchWord('a')) {
      this.#failHere(`expected a number of dice — ${hint}`, 'syntax');
      return this.#abort();
    }
    const d = this.#peek();
    // `2d6` / `d20`: the `d` is glued to the number after it (and to the count before it).
    const sidesToken = this.#peek(1);
    if (
      d.kind !== 'word' ||
      d.lower !== 'd' ||
      sidesToken.kind !== 'number' ||
      !this.#adjacent(d, sidesToken) ||
      (countToken && !this.#adjacent(countToken, d))
    ) {
      this.#failHere(`expected a die like "d20" or "2d6", with no spaces — ${hint}`, 'syntax');
      return this.#abort();
    }
    this.#advance();
    this.#advance();
    const sides = Number(sidesToken.text);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      this.#diagnostics.push({
        severity: 'error',
        message: `${countToken?.text ?? count} dice is not a number of dice — roll between 1 and 100`,
        code: 'roll-dice',
        start: (countToken ?? d).start,
        end: (countToken ?? d).end,
      });
      return this.#abort();
    }
    if (!Number.isInteger(sides) || sides < 2) {
      this.#diagnostics.push({
        severity: 'error',
        message: `"d${sidesToken.text}" is not a die — a die has at least 2 sides, e.g. "d6"`,
        code: 'roll-sides',
        start: d.start,
        end: sidesToken.end,
      });
      return this.#abort();
    }
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    // Result lines directly under the roll, one per line.
    const rows: TableRow[] = [];
    while (!this.#inTableRow && this.#startsTableRow()) {
      const row = this.#parseTableRow();
      if (!row) return this.#abort();
      rows.push(row);
    }
    return {
      kind: 'roll',
      span: { start: start.start, end: rows.length > 0 ? rows[rows.length - 1]!.span.end : end },
      count,
      sides,
      ...(rows.length > 0 ? { table: rows } : {}),
    };
  }

  /**
   * True at a new line that begins a result line: `<number> …:` or
   * `Otherwise:`. Cheap lookahead — a `:` before the first `.` — so a malformed
   * header still reports a table error rather than a generic one.
   */
  #startsTableRow(): boolean {
    const first = this.#peek();
    if (!first.atLineStart) return false;
    if (!(first.kind === 'number' || (first.kind === 'word' && first.lower === 'otherwise'))) return false;
    for (let offset = 0; offset < 6; offset += 1) {
      const token = this.#peekOffset(offset);
      if (!token || token.kind === 'eof') return false;
      if (token.kind === 'punct' && token.text === ':') return true;
      if (token.kind === 'punct' && token.text === '.') return false;
    }
    return false;
  }

  /** `2 to 5: Deal 5 damage to this character.` / `15 or more: …` / `Otherwise: …` */
  #parseTableRow(): TableRow | undefined {
    const first = this.#advance();
    let min = 0;
    let max: number | null = 0;
    let otherwise = false;
    let text = first.text;
    if (first.kind === 'word') {
      otherwise = true;
      text = 'Otherwise';
    } else {
      min = Number(first.text);
      max = min;
      const joiner = this.#peek();
      if (joiner.kind === 'word' && joiner.lower === 'to') {
        this.#advance();
        const upper = this.#peek();
        if (upper.kind !== 'number') {
          this.#fail(upper, `expected a number after "${first.text} to" — e.g. "${first.text} to ${Number(first.text) + 3}:"`, 'syntax');
          return undefined;
        }
        this.#advance();
        max = Number(upper.text);
        text = `${first.text} to ${upper.text}`;
        if (max < min) {
          this.#fail(upper, `"${text}" counts down — the larger number goes last`, 'count-range');
          return undefined;
        }
      } else if (joiner.kind === 'word' && joiner.lower === 'or') {
        this.#advance();
        const bound = this.#peek();
        if (bound.kind !== 'word' || (bound.lower !== 'more' && bound.lower !== 'less')) {
          this.#fail(bound, `expected "more" or "less" after "${first.text} or"`, 'syntax');
          return undefined;
        }
        this.#advance();
        text = `${first.text} or ${bound.lower}`;
        // Dice never roll below 1, so "or less" is open at the bottom.
        if (bound.lower === 'more') max = null;
        else {
          max = min;
          min = 0;
        }
      }
    }
    if (!this.#peekPunct(':')) {
      this.#failHere(`expected ":" after "${text}" — e.g. "${text}: Deal 5 damage to this character."`, 'syntax');
      return undefined;
    }
    this.#advance();
    // The line's sentences: everything up to the next line. A roll inside a
    // result line has no table of its own — its would-be lines are the outer
    // table's next lines.
    const sentences: Sentence[] = [];
    this.#inTableRow = true;
    try {
      while (this.#peek().kind !== 'eof' && !this.#peek().atLineStart) {
        const sentence = this.#parseSentence();
        if (!sentence) return undefined; // already reported
        sentences.push(sentence);
      }
    } finally {
      this.#inTableRow = false;
    }
    if (sentences.length === 0) {
      this.#fail(first, `"${text}:" needs something to happen — write the effect after the colon, on the same line`, 'syntax');
      return undefined;
    }
    return {
      span: { start: first.start, end: sentences[sentences.length - 1]!.span.end },
      text,
      min,
      max,
      otherwise,
      sentences,
    };
  }

  /* ---------------------------- choice rounds ---------------------------- */

  /**
   * The players of a choice sentence: `You`, `Each player`, `Each opponent`.
   * Leaves the cursor on the verb.
   */
  #parseChoosers(): { players: 'you' | 'each' | 'opponents'; span: Span } | undefined {
    const first = this.#advance(); // 'you' | 'each'
    if (first.lower === 'you') return { players: 'you', span: { start: first.start, end: first.end } };
    const noun = this.#peek();
    if (noun.kind === 'word' && (noun.lower === 'player' || noun.lower === 'opponent')) {
      this.#advance();
      return {
        players: noun.lower === 'player' ? 'each' : 'opponents',
        span: { start: first.start, end: noun.end },
      };
    }
    this.#fail(noun, '"Each" is followed by "player" or "opponent" — e.g. "Each player commits a card from their hand face down."', 'syntax');
    return undefined;
  }

  /** The `their` / `your` before a zone: whose zone it is. The word carries no extra meaning. */
  #matchPossessive(): boolean {
    return this.#matchWord('their') || this.#matchWord('your');
  }

  /**
   * `Each player commits a card from their hand face down.` (sealed) /
   * `Each player chooses a card from their hand.` (open) — and the same with
   * `a number from 1 to 6`.
   *
   * The verb decides the mode. `commit` is sealed and **must** say `face down`,
   * because the words are the instruction a table follows; `choose` is open and
   * must not claim to be hidden.
   */
  #parseChoose(): Sentence | undefined {
    const start = this.#peek();
    const chooser = this.#parseChoosers();
    if (!chooser) return this.#abort();
    const verb = this.#peek();
    const sealedVerb = verb.kind === 'word' && (verb.lower === 'commits' || verb.lower === 'commit');
    const openVerb = verb.kind === 'word' && (verb.lower === 'chooses' || verb.lower === 'choose');
    if (!sealedVerb && !openVerb) {
      this.#fail(
        verb,
        'expected "commits" (sealed) or "chooses" (open) — e.g. "Each player commits a card from their hand face down."',
        'syntax',
      );
      return this.#abort();
    }
    this.#advance();
    if (!this.#matchWord('a')) {
      this.#failHere('expected "a card from their <zone>" or "a number from <low> to <high>" after the verb', 'syntax');
      return this.#abort();
    }
    let pick: Extract<Sentence, { kind: 'choose' }>['pick'];
    if (this.#peek().kind === 'word' && this.#peek().lower === 'vote') {
      // `commits a vote for Attack or Retreat face down` — a sealed vote.
      if (openVerb) {
        this.#failHere(
          'an open vote says who goes first — write "Starting with you, each player votes for Attack or Retreat." (or "Ending with you", "Starting with a random player", "In reverse order"), or "Each player commits a vote for … face down."',
          'syntax',
        );
        return this.#abort();
      }
      if (chooser.players !== 'each') {
        this.#failHere('everyone votes — write "Each player commits a vote for Attack or Retreat face down."', 'syntax');
        return this.#abort();
      }
      this.#advance();
      const options = this.#parseVoteOptions();
      if (!options) return this.#abort();
      pick = { kind: 'label', options };
    } else if (this.#matchWord('card')) {
      // `from` is the written form; `in` reads the same and is accepted.
      if (!(this.#matchWord('from') || this.#matchWord('in'))) {
        this.#failHere('expected "from their <zone>" after "a card" — e.g. "a card from their hand"', 'syntax');
        return this.#abort();
      }
      if (!this.#matchPossessive()) {
        this.#failHere('expected "their" or "your" before the zone — e.g. "a card from their hand"', 'syntax');
        return this.#abort();
      }
      const zoneStart = this.#peek();
      const zone = this.#parseZoneName('expected the zone the card is taken from, e.g. "from their hand"');
      if (zone === null) return this.#abort();
      pick = { kind: 'card', zone, zoneSpan: { start: zoneStart.start, end: this.#previous().end } };
    } else if (this.#matchWord('number')) {
      if (!this.#matchWord('from')) {
        this.#failHere('expected "from <low> to <high>" after "a number" — e.g. "a number from 1 to 6"', 'syntax');
        return this.#abort();
      }
      const low = this.#expectNumber('after "from"', 'syntax');
      if (!low) return this.#abort();
      if (!this.#matchWord('to')) {
        this.#failHere('expected "to <high>" — e.g. "a number from 1 to 6"', 'syntax');
        return this.#abort();
      }
      const high = this.#expectNumber('after "to"', 'syntax');
      if (!high) return this.#abort();
      if (!Number.isInteger(low.value) || !Number.isInteger(high.value) || low.value > high.value) {
        this.#diagnostics.push({
          severity: 'error',
          message: `"from ${low.value} to ${high.value}" is not a range of whole numbers — write the lower number first, e.g. "from 1 to 6"`,
          code: 'choose-range',
          start: low.span.start,
          end: high.span.end,
        });
        return this.#abort();
      }
      pick = { kind: 'number', min: low.value, max: high.value };
    } else {
      this.#failHere('you can pick "a card from their <zone>" or "a number from <low> to <high>"', 'syntax');
      return this.#abort();
    }
    // The old spelling, named rather than reported as a stray word.
    if (this.#peek().kind === 'word' && this.#peek().lower === 'in' && this.#peek(1).lower === 'secret') {
      this.#failHere(
        'a choice made in secret is not yet a commitment — write "commits … face down", e.g. "Each player commits a card from their hand face down."',
        'syntax',
      );
      return this.#abort();
    }
    const faceDown = this.#peek().kind === 'word' && this.#peek().lower === 'face' && this.#peek(1).lower === 'down';
    if (faceDown) {
      this.#advance();
      this.#advance();
    }
    if (sealedVerb && !faceDown) {
      this.#failHere('a commitment is placed face down — add "face down", e.g. "Each player commits a card from their hand face down."', 'syntax');
      return this.#abort();
    }
    if (openVerb && faceDown) {
      this.#failHere('"chooses" is made in the open — to place it face down, write "commits … face down"', 'syntax');
      return this.#abort();
    }
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return {
      kind: 'choose',
      span: { start: start.start, end },
      players: chooser.players,
      playersSpan: chooser.span,
      pick,
      secret: sealedVerb,
    };
  }

  /**
   * `for Attack or Retreat` / `for Red, Green or Blue` — the names a vote is
   * between. A name is one word or a quoted string; there are at least two and
   * no two are the same (ignoring case).
   */
  #parseVoteOptions(): string[] | undefined {
    const shape = 'e.g. "votes for Attack or Retreat"';
    if (!this.#matchWord('for')) {
      this.#failHere(`expected "for" and the options after "vote" — ${shape}`, 'syntax');
      return undefined;
    }
    const read = (): string | undefined => {
      const token = this.#peek();
      if (token.kind !== 'word' && token.kind !== 'string') {
        this.#fail(token, `expected an option name (one word, or in quotes) — ${shape}`, 'syntax');
        return undefined;
      }
      this.#advance();
      return token.text;
    };
    const first = read();
    if (first === undefined) return undefined;
    const options = [first];
    for (;;) {
      if (this.#peekPunct(',')) {
        this.#advance();
        this.#matchWord('or');
        const next = read();
        if (next === undefined) return undefined;
        options.push(next);
        continue;
      }
      if (this.#matchWord('or')) {
        const last = read();
        if (last === undefined) return undefined;
        options.push(last);
      }
      break;
    }
    if (options.length < 2) {
      this.#failHere(`a vote needs at least two options to choose between — ${shape}`, 'vote-options');
      return undefined;
    }
    const seen = new Set<string>();
    for (const option of options) {
      if (seen.has(option.toLowerCase())) {
        this.#diagnostics.push({
          severity: 'error',
          message: `"${option}" is listed twice — each option appears once`,
          code: 'vote-options',
          start: this.#previous().start,
          end: this.#previous().end,
        });
        return undefined;
      }
      seen.add(option.toLowerCase());
    }
    return options;
  }

  /**
   * An open vote, with its order in the opening words:
   * `Starting with you,` / `Ending with you,` / `Starting with a random player,` /
   * `In reverse order,` then `each player votes for Attack or Retreat.`
   */
  #parseOpenVote(): Sentence | undefined {
    const first = this.#advance(); // starting | ending | in
    const shapes =
      '"Starting with you", "Ending with you", "Starting with a random player" or "In reverse order"';
    let order: 'caster-first' | 'caster-last' | 'random' | 'reverse' | undefined;
    if (first.lower === 'starting' && this.#matchWord('with')) {
      if (this.#matchWord('you')) order = 'caster-first';
      else if (this.#matchWord('a') && this.#matchWord('random') && this.#matchWord('player')) order = 'random';
    } else if (first.lower === 'ending' && this.#matchWord('with') && this.#matchWord('you')) {
      order = 'caster-last';
    } else if (first.lower === 'in' && this.#matchWord('reverse') && this.#matchWord('order')) {
      order = 'reverse';
    }
    if (!order) {
      this.#fail(first, `an open vote opens with who goes first: ${shapes}`, 'syntax');
      return this.#abort();
    }
    if (!this.#peekPunct(',')) {
      this.#failHere(`expected "," after the order — e.g. "${first.text} …, each player votes for Attack or Retreat."`, 'syntax');
      return this.#abort();
    }
    this.#advance();
    const who = this.#peek();
    if (!(this.#matchWord('each') && this.#matchWord('player') && this.#matchWord('votes'))) {
      this.#fail(who, 'everyone votes — write "each player votes for Attack or Retreat."', 'syntax');
      return this.#abort();
    }
    const options = this.#parseVoteOptions();
    if (!options) return this.#abort();
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return {
      kind: 'choose',
      span: { start: first.start, end },
      players: 'each',
      playersSpan: { start: who.start, end: who.end },
      pick: { kind: 'label', options },
      secret: false,
      order,
    };
  }

  /** True when the cursor is on `when (all players|they) (are|is) ready,`. */
  #startsReveal(): boolean {
    const word = (offset: number): string => {
      const token = this.#peekOffset(offset);
      return token && token.kind === 'word' ? token.lower : '';
    };
    const comma = (offset: number): boolean => {
      const token = this.#peekOffset(offset);
      return token?.kind === 'punct' && token.text === ',';
    };
    if (word(0) !== 'when') return false;
    if (word(1) === 'they') return (word(2) === 'are' || word(2) === 'is') && word(3) === 'ready' && comma(4);
    return (
      word(1) === 'all' && word(2) === 'players' && (word(3) === 'are' || word(3) === 'is') && word(4) === 'ready' && comma(5)
    );
  }

  /** `When they are ready, reveal.` (or `When all players are ready, reveal.`) */
  #parseReveal(): Sentence | undefined {
    const start = this.#peek();
    if (!this.#startsReveal()) return this.#unexpectedSentenceStart(start);
    this.#advance(); // when
    while (!(this.#peek().kind === 'punct' && this.#peek().text === ',')) this.#advance();
    this.#advance(); // ,
    if (!this.#matchWord('reveal')) {
      this.#failHere('expected "reveal" — e.g. "When they are ready, reveal."', 'syntax');
      return this.#abort();
    }
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return { kind: 'reveal', span: { start: start.start, end } };
  }

  /** `Each player puts the card they committed into their garbage.` (or `chose`, after an open choice) */
  #parseMoveChosen(): Sentence | undefined {
    const start = this.#peek();
    const mover = this.#parseChoosers();
    if (!mover) return this.#abort();
    const verb = this.#peek();
    if (verb.kind !== 'word' || (verb.lower !== 'puts' && verb.lower !== 'put')) {
      this.#fail(verb, 'expected "puts" — e.g. "Each player puts the card they committed into their garbage."', 'syntax');
      return this.#abort();
    }
    this.#advance();
    const phrase = ['the', 'card'];
    for (const word of phrase) {
      if (!this.#matchWord(word)) {
        this.#failHere('only "the card they committed" can be moved here — e.g. "puts the card they committed into their garbage"', 'syntax');
        return this.#abort();
      }
    }
    // `committed` after a commit, `chose` after an open choice; both name the
    // card each player picked earlier in this ability.
    let committed = false;
    if (!(this.#matchWord('they') || this.#matchWord('you'))) {
      this.#failHere('write "the card they committed" (or "chose") — it names the card each player picked earlier', 'syntax');
      return this.#abort();
    }
    if (this.#matchWord('committed')) committed = true;
    else if (!this.#matchWord('chose')) {
      this.#failHere('write "the card they committed" (or "chose") — it names the card each player picked earlier', 'syntax');
      return this.#abort();
    }
    if (!this.#matchWord('into')) {
      this.#failHere('expected "into their <zone>" — e.g. "into their garbage"', 'syntax');
      return this.#abort();
    }
    if (!this.#matchPossessive()) {
      this.#failHere('expected "their" or "your" before the zone — e.g. "into their garbage"', 'syntax');
      return this.#abort();
    }
    const zoneStart = this.#peek();
    const zone = this.#parseZoneName('expected the zone the card goes to, e.g. "into their garbage"');
    if (zone === null) return this.#abort();
    const zoneSpan = { start: zoneStart.start, end: this.#previous().end };
    const end = this.#expectSentenceEnd();
    if (!end) return this.#abort();
    return {
      kind: 'moveChosen',
      span: { start: start.start, end },
      players: mover.players,
      playersSpan: mover.span,
      committed,
      zone,
      zoneSpan,
    };
  }

  /* --------------------------- character phrase -------------------------- */

  #parseCharsPhrase(): CharsPhrase | undefined {
    const quantToken = this.#peek();
    // `the source` — an event-bound noun, with no noun word of its own.
    if (
      quantToken.kind === 'word' &&
      quantToken.lower === 'the' &&
      this.#peek(1).kind === 'word' &&
      this.#peek(1).lower === 'source'
    ) {
      this.#advance();
      const noun = this.#advance();
      // The kind is required: an event's cause may be a character or a
      // buff, and a card has to say which it answers.
      const kindToken = this.#peek();
      const kind =
        kindToken.kind === 'word' && (kindToken.lower === 'character' || kindToken.lower === 'buff')
          ? kindToken.lower
          : undefined;
      if (!kind) {
        if (kindToken.kind === 'word' && kindToken.lower === 'player') {
          this.#fail(
            kindToken,
            'a player cannot be an event\'s source yet — the engine\'s causes are characters and buffs',
            'future-feature',
          );
          return undefined;
        }
        this.#fail(
          kindToken,
          'say which kind of source — "the source character" or "the source buff" — since an event\'s cause may be either',
          'source-kind',
        );
        return undefined;
      }
      this.#advance();
      return {
        kind: 'chars',
        span: { start: quantToken.start, end: this.#previous().end },
        quantifier: 'source',
        sourceType: kind,
        other: false,
        who: undefined,
        owner: undefined,
        withClause: undefined,
      };
    }
    // `the <name>` — one of the ability's named picks. Checked for
    // existence by the compiler, which knows the bindings.
    if (
      quantToken.kind === 'word' &&
      quantToken.lower === 'the' &&
      this.#peek(1).kind === 'word' &&
      !GAME_WORDS.includes(this.#peek(1).lower as (typeof GAME_WORDS)[number])
    ) {
      this.#advance();
      const nameToken = this.#advance();
      return {
        kind: 'chars',
        span: { start: quantToken.start, end: nameToken.end },
        quantifier: 'bound',
        name: nameToken.text,
        other: false,
        who: undefined,
        owner: undefined,
        withClause: undefined,
      };
    }
    if (quantToken.kind !== 'word' || !QUANTIFIERS.includes(quantToken.lower as (typeof QUANTIFIERS)[number])) {
      this.#fail(
        quantToken,
        'expected "this", "target character", "all characters", or "the source" here',
        'syntax',
      );
      return undefined;
    }
    this.#advance();
    return this.#parseCharsBody(
      quantToken.lower as 'this' | 'target' | 'all',
      quantToken.start,
      quantToken.end,
    );
  }

  /**
   * Everything after a character phrase's quantifier: `other`, the
   * adjective, the noun, and the `owned by` / `with` clauses.
   *
   * Split out because a **trigger**'s subject has no quantifier — its count
   * phrase stands in that slot (`when 2 to 5 enemy characters … die`) — so
   * the trigger parser calls this directly with an implied `'all'`.
   */
  #parseCharsBody(
    quantifier: 'this' | 'target' | 'all',
    start: number,
    quantEnd: number,
  ): CharsPhrase | undefined {
    const quantToken = { start, end: quantEnd, text: quantifier };
    let other = false;
    let who: Who | undefined;
    let owner: Owner | undefined;
    let end = quantEnd;

    if (quantifier === 'all' && this.#matchWord('other')) {
      other = true;
      end = this.#previous().end;
    }
    const adjective = this.#peek();
    if (adjective.kind === 'word' && ADJECTIVES.includes(adjective.lower as (typeof ADJECTIVES)[number])) {
      if (quantifier === 'this') {
        this.#fail(adjective, '"this character" is the user themselves — drop the "' + adjective.text + '"', 'syntax');
        return undefined;
      }
      this.#advance();
      who = adjective.lower === 'enemy' ? 'enemy' : 'ally';
      end = adjective.end;
    } else if (quantifier === 'this' && adjective.kind === 'word' && adjective.lower === 'buff') {
      this.#fail(
        adjective,
        '"this buff" needs a buff-owned ability — that arrives with the events milestone.',
        'future-feature',
      );
      return undefined;
    }
    const charWord = this.#peek();
    const hasNoun =
      charWord.kind === 'word' && CHAR_WORDS.includes(charWord.lower as (typeof CHAR_WORDS)[number]);
    if (hasNoun) {
      this.#advance();
      end = charWord.end;
    } else if (quantifier !== 'this') {
      // A group needs its noun: "all" alone does not say all *what*.
      this.#fail(charWord, 'expected "character" or "characters" here', 'syntax');
      return undefined;
    }
    // Bare `this` — it names the ability's own owner whatever kind of thing
    // that is, so the noun adds nothing.
    const bare = !hasNoun;

    // Post-phrase clauses, in either order and at most once each:
    // "… owned by you with hp < 10" / "… with hp < 10 owned by you".
    let withClause: WithClause | undefined;
    while (true) {
      const next = this.#peek();
      if (next.kind === 'word' && next.lower === OWNED && owner === undefined) {
        if (quantifier === 'this') {
          this.#fail(next, '"this character" is the user themselves — an "owned by" clause does not apply', 'syntax');
          return undefined;
        }
        this.#advance(); // owned
        end = next.end;
        if (!this.#matchWord('by')) {
          this.#failHere('expected "by" after "owned", e.g. "characters owned by you"', 'syntax');
          return undefined;
        }
        end = this.#previous().end;
        const ownerToken = this.#peek();
        if (ownerToken.kind === 'word' && ownerToken.lower === 'you') {
          this.#advance();
          owner = 'you';
          end = ownerToken.end;
        } else if (ownerToken.kind === 'word' && ownerToken.lower === 'the' && this.#peek(1).kind === 'word' && this.#peek(1).lower === 'opponent') {
          this.#advance();
          this.#advance();
          owner = 'opponent';
          end = this.#previous().end;
        } else if (ownerToken.lower === 'the' && ['winners', 'losers'].includes(this.#peek(1).lower)) {
          if (!this.#contestPlayed) {
            this.#fail(ownerToken, `"the ${this.#peek(1).lower}" are the result of a contest — play one first, e.g. "Each player plays Rock Paper Scissors."`, 'syntax');
            return undefined;
          }
          owner = this.#peek(1).lower as 'winners' | 'losers';
          this.#advance();
          this.#advance();
          end = this.#previous().end;
        } else {
          if (ownerToken.kind === 'word' && OWNER_WORDS.includes(ownerToken.lower as (typeof OWNER_WORDS)[number])) {
            this.#fail(ownerToken, 'expected "the" before "' + ownerToken.text + '" — write "owned by ' + (ownerToken.lower === 'you' ? 'you' : 'the opponent') + '"', 'syntax');
          } else {
            this.#fail(ownerToken, 'expected "you" or "the opponent" after "owned by"', 'syntax');
          }
          return undefined;
        }
        continue;
      }
      if (next.kind === 'word' && next.lower === 'with' && withClause === undefined) {
        if (quantifier === 'this') {
          this.#fail(next, '"this character" is one character — a "with …" filter does not apply', 'syntax');
          return undefined;
        }
        const clause = this.#parseWithClause();
        if (!clause) return undefined;
        withClause = clause;
        end = clause.span.end;
        continue;
      }
      break;
    }
    return {
      kind: 'chars',
      span: { start, end },
      quantifier,
      ...(bare ? { bare: true } : {}),
      other,
      who,
      owner,
      withClause,
    };
  }

  /**
   * `with <condition> [and|or <condition> …]` — `and` binds tighter than
   * `or` (see the language docs); commas act as `and`.
   */
  #parseWithClause(): WithClause | undefined {
    const start = this.#advance(); // 'with'
    const conditions: WithCondition[] = [];
    const joiners: ConditionJoiner[] = [];
    const expression = this.#parseBooleanOr(conditions, joiners);
    if (!expression) return undefined;
    const last = this.#previous();
    joiners.splice(0, joiners.length, ...flattenJoiners(expression));
    return {
      kind: 'with',
      span: { start: start.start, end: last.end },
      conditions,
      joiners,
      expression,
    };
  }

  #parseBooleanOr(conditions: WithCondition[], joiners: ConditionJoiner[]): import('./ast.js').BooleanCondition | undefined {
    let left = this.#parseBooleanAnd(conditions, joiners);
    while (left && this.#peek().kind === 'word' && this.#peek().lower === 'or') {
      const op = this.#advance();
      const right = this.#parseBooleanAnd(conditions, joiners);
      if (!right) return undefined;
      left = { kind: 'or', left, right, span: { start: left.span.start, end: right.span.end } };
      void op;
    }
    return left;
  }

  #parseBooleanAnd(conditions: WithCondition[], joiners: ConditionJoiner[]): import('./ast.js').BooleanCondition | undefined {
    let left = this.#parseBooleanPrimary(conditions, joiners);
    while (left) {
      let isAnd = false;
      if (this.#peek().kind === 'word' && this.#peek().lower === 'and') {
        this.#advance();
        isAnd = true;
      } else if (!this.#commaEndsCondition && this.#peek().kind === 'punct' && this.#peek().text === ',') {
        this.#advance();
        isAnd = true;
        // Oxford comma: `a, b, and c`.
        if (this.#peek().kind === 'word' && (this.#peek().lower === 'and' || this.#peek().lower === 'or')) {
          if (this.#peek().lower === 'and') this.#advance();
          else isAnd = false;
        }
      }
      if (!isAnd) break;
      const right = this.#parseBooleanPrimary(conditions, joiners);
      if (!right) return undefined;
      left = { kind: 'and', left, right, span: { start: left.span.start, end: right.span.end } };
    }
    return left;
  }

  #parseBooleanPrimary(conditions: WithCondition[], joiners: ConditionJoiner[]): import('./ast.js').BooleanCondition | undefined {
    if (this.#peek().kind === 'word' && this.#peek().lower === 'not') {
      const start = this.#advance();
      const expression = this.#parseBooleanPrimary(conditions, joiners);
      if (!expression) return undefined;
      return { kind: 'not', expression, span: { start: start.start, end: expression.span.end } };
    }
    if (this.#peek().kind === 'punct' && this.#peek().text === '(') {
      this.#advance();
      const expression = this.#parseBooleanOr(conditions, joiners);
      if (!expression) return undefined;
      if (!(this.#peek().kind === 'punct' && this.#peek().text === ')')) {
        this.#fail(this.#peek(), 'expected ")" to close the condition group', 'syntax');
        return undefined;
      }
      this.#advance();
      return expression;
    }
    const condition = this.#parseWithCondition();
    if (!condition) return undefined;
    conditions.push(condition);
    return condition;
  }

  /** One `with` condition: a gauge comparison or a buff the character has. */
  #parseWithCondition(): WithCondition | undefined {
    const first = this.#peek();
    if (first.kind === 'word' && (first.lower === 'hp' || first.lower === 'mana')) {
      this.#advance();
      const gaugeSpan = { start: first.start, end: first.end };
      const op = this.#readOperator();
      if (!op) {
        this.#failHere(`expected a comparison ("<", "<=", ">", ">=" or "=") after "${first.text}"`, 'syntax');
        return undefined;
      }
      const number = this.#expectAmount('after the comparison', 'syntax');
      if (!number) return undefined;
      return {
        kind: 'gauge',
        span: { start: first.start, end: number.span.end },
        gauge: first.lower as 'hp' | 'mana',
        gaugeSpan,
        op: op.op,
        opSpan: op.span,
        value: number.value,
        valueSpan: number.span,
      };
    }
    // A buff the character has: its name runs until a separator or the
    // sentence tail (buff names containing "and"/"or"/"for"/"owned" are
    // out for now — see the language docs).
    const nameTokens: Token[] = [];
    while (true) {
      const word = this.#peek();
      if (word.kind !== 'word') break;
      if (word.lower === 'and' || word.lower === 'or' || word.lower === 'for' || word.lower === 'owned' || word.lower === 'with') break;
      nameTokens.push(this.#advance());
    }
    if (nameTokens.length === 0) {
      this.#fail(
        first,
        'expected a condition after "with" — a gauge comparison like "hp < 10", or a buff the character has, like "poison"',
        'syntax',
      );
      return undefined;
    }
    const buffFirst = nameTokens[0]!;
    const buffLast = nameTokens[nameTokens.length - 1]!;
    return {
      kind: 'buff',
      span: { start: buffFirst.start, end: buffLast.end },
      buffName: nameTokens.map((t) => t.text).join(' '),
      buffSpan: { start: buffFirst.start, end: buffLast.end },
    };
  }

  /** Reads one comparison operator, combining `<`/`>` with a following `=`. */
  #readOperator(): { op: WithOperator; span: Span } | undefined {
    const first = this.#peek();
    if (first.kind !== 'punct') return undefined;
    const text = first.text;
    if (text === '<' || text === '>') {
      const second = this.#peek(1);
      if (second.kind === 'punct' && second.text === '=') {
        this.#advance();
        this.#advance();
        return { op: (text + '=') as WithOperator, span: { start: first.start, end: second.end } };
      }
      this.#advance();
      return { op: text as WithOperator, span: { start: first.start, end: first.end } };
    }
    if (text === '=') {
      this.#advance();
      return { op: '=', span: { start: first.start, end: first.end } };
    }
    return undefined;
  }

  /* ------------------------------ utilities ----------------------------- */

  /** True when the token is a word that does not start its own line. */
  #isWordOnLine(token: Token): boolean {
    return token.kind === 'word' && !token.atLineStart;
  }

  #expectNumber(after: string, code: string): { value: number; span: { start: number; end: number } } | undefined {
    const token = this.#peek();
    if (token.kind !== 'number') {
      this.#fail(token, `expected a number ${after}`, code);
      return undefined;
    }
    this.#advance();
    return { value: Number(token.text), span: { start: token.start, end: token.end } };
  }

  /* --------------------------- math expressions -------------------------- */

  /**
   * A number **or a formula** wherever an amount is expected — `5`, or
   * `(this.hp / 2)`, or anything the math language supports
   * (docs/creator/01-ability-language.md, "Math expressions"). A bare
   * number is just the trivial case of the same grammar below, so there
   * is no separate mode to opt into.
   *
   * This mirrors `parseMathExpression` in `src/ir/math-expression.ts` —
   * same grammar, same `MathExpression` output — but runs over this
   * parser's own tokens instead of re-lexing a text span, so it stops
   * cleanly at whatever follows (`damage`, `.` to end the sentence, `%`)
   * without needing to know that boundary in advance.
   */
  #expectAmount(after: string, code: string): { value: MathExpression; span: Span } | undefined {
    const start = this.#peek();
    const expression = this.#parseMathExpr();
    if (!expression) {
      if (this.#peek() === start) this.#fail(start, `expected a number or a formula ${after}`, code);
      return undefined;
    }
    return { value: expression, span: { start: start.start, end: this.#previous().end } };
  }

  /** True when the next token is exactly this punctuation character. */
  #peekPunct(text: string): boolean {
    const token = this.#peek();
    return token.kind === 'punct' && token.text === text;
  }

  /** Two tokens with nothing — not even a space — between them. */
  #adjacent(a: Token, b: Token): boolean {
    return a.end === b.start;
  }

  #parseMathExpr(): MathExpression | undefined {
    return this.#parseMathAdditive();
  }

  #parseMathAdditive(): MathExpression | undefined {
    let left = this.#parseMathMultiplicative();
    if (!left) return undefined;
    while (this.#peekPunct('+') || this.#peekPunct('-')) {
      const op = this.#advance().text as '+' | '-';
      const right = this.#parseMathMultiplicative();
      if (!right) return undefined;
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  #parseMathMultiplicative(): MathExpression | undefined {
    let left = this.#parseMathPower();
    if (!left) return undefined;
    while (this.#peekPunct('*') || this.#peekPunct('/')) {
      const op = this.#advance().text as '*' | '/';
      const right = this.#parseMathPower();
      if (!right) return undefined;
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  /** Right-associative, like `parseMathExpression`'s. */
  #parseMathPower(): MathExpression | undefined {
    const left = this.#parseMathUnary();
    if (!left) return undefined;
    if (this.#peekPunct('^')) {
      this.#advance();
      const right = this.#parseMathPower();
      if (!right) return undefined;
      return { kind: 'binary', op: '^', left, right };
    }
    return left;
  }

  #parseMathUnary(): MathExpression | undefined {
    if (this.#peekPunct('+') || this.#peekPunct('-')) {
      const op = this.#advance().text as '+' | '-';
      const expression = this.#parseMathUnary();
      if (!expression) return undefined;
      return { kind: 'unary', op, expression };
    }
    return this.#parseMathPrimary();
  }

  #parseMathPrimary(): MathExpression | undefined {
    const token = this.#peek();
    if (token.kind === 'number') {
      this.#advance();
      return { kind: 'number', value: Number(token.text) };
    }
    if (this.#peekPunct('(')) {
      this.#advance();
      const expression = this.#parseMathExpr();
      if (!expression) return undefined;
      if (!this.#peekPunct(')')) {
        this.#failHere('expected ")" to close the formula', 'syntax');
        return undefined;
      }
      this.#advance();
      return expression;
    }
    if (token.kind === 'punct' && (token.text === 'Σ' || token.text === '∑')) {
      return this.#parseMathSum();
    }
    // `votes for Attack` — how many votes an option got in the latest vote.
    if (token.kind === 'word' && token.lower === 'votes' && this.#peek(1).lower === 'for') {
      const named = this.#peek(2);
      if (named.kind === 'word' || named.kind === 'string') {
        this.#advance();
        this.#advance();
        this.#advance();
        return { kind: 'path', parts: ['votes', named.text] };
      }
      this.#fail(named, 'expected the option after "votes for" — e.g. "votes for Attack"', 'syntax');
      return undefined;
    }
    // `the total` / `the result` / `the highest die` / `the lowest die` — the
    // outcome of the latest roll, as the path `roll.<stat>` the evaluator reads.
    if (token.kind === 'word' && (token.lower === 'that' || token.lower === 'the')) {
      const stat = rollStatOf(this.#peek(1).lower);
      if (stat && token.lower === 'the') {
        // There is deliberately no "the total": with more than one roll it would
        // not say which. Say so, rather than reading "the" as a variable name.
        this.#failHere(
          `write "that ${stat === 'total' ? 'total' : `${stat} die`}" — "that" is always the most recent roll. To use an earlier roll, store it: "Store that value as AttackerRoll." and write the name.`,
          'syntax',
        );
        return undefined;
      }
      if (stat) {
        this.#advance();
        this.#advance();
        if (stat !== 'total') this.#matchWord('die');
        return { kind: 'path', parts: ['roll', stat] };
      }
    }
    if (token.kind === 'word') {
      this.#advance();
      const parts: (string | number | { readonly kind: 'index'; readonly expression: MathExpression })[] = [
        token.text,
      ];
      while (true) {
        // `.property` — only when nothing, not even a space, separates the
        // dot from what's on either side of it. A sentence's own ending
        // period sits right after the last word too (`by self.hp.`), so
        // adjacency alone can't tell them apart from a lookahead of one;
        // what settles it is that a real property name is glued to its
        // dot on *both* sides, where a sentence boundary almost never is
        // (`self.hp. Next sentence` has a space after the period).
        const dot = this.#peek();
        if (dot.kind === 'punct' && dot.text === '.' && this.#adjacent(this.#previous(), dot)) {
          const word = this.#peek(1);
          if (word.kind === 'word' && this.#adjacent(dot, word)) {
            this.#advance();
            parts.push(this.#advance().text);
            continue;
          }
        }
        if (this.#peekPunct('[')) {
          this.#advance();
          const index = this.#parseMathExpr();
          if (!index) return undefined;
          if (!this.#peekPunct(']')) {
            this.#failHere('expected "]" to close the index', 'syntax');
            return undefined;
          }
          this.#advance();
          parts.push({ kind: 'index', expression: index });
          continue;
        }
        break;
      }
      return { kind: 'path', parts };
    }
    this.#fail(token, 'expected a number, a path, "Σ(…)", or a parenthesized formula', 'syntax');
    return undefined;
  }

  /** `Σ(i = <start> to <end>, <expr>)` or the shorthand `Σ(<array>)`. */
  #parseMathSum(): MathExpression | undefined {
    this.#advance(); // Σ / ∑
    if (!this.#peekPunct('(')) {
      this.#failHere('expected "(" after "Σ"', 'syntax');
      return undefined;
    }
    this.#advance();
    if (this.#peek().kind === 'word' && this.#peek(1).kind === 'punct' && this.#peek(1).text === '=') {
      const variable = this.#advance().text;
      this.#advance(); // '='
      const start = this.#parseMathExpr();
      if (!start) return undefined;
      if (!this.#matchWord('to')) {
        this.#failHere('expected "to" in "Σ(i = <start> to <end>, …)"', 'syntax');
        return undefined;
      }
      const end = this.#parseMathExpr();
      if (!end) return undefined;
      if (!this.#peekPunct(',')) {
        this.#failHere('expected "," before the summed expression', 'syntax');
        return undefined;
      }
      this.#advance();
      const expression = this.#parseMathExpr();
      if (!expression) return undefined;
      if (!this.#peekPunct(')')) {
        this.#failHere('expected ")" to close "Σ(…)"', 'syntax');
        return undefined;
      }
      this.#advance();
      return { kind: 'sum', variable, start, end, expression };
    }
    const expression = this.#parseMathExpr();
    if (!expression) return undefined;
    if (!this.#peekPunct(')')) {
      this.#failHere('expected ")" to close "Σ(…)"', 'syntax');
      return undefined;
    }
    this.#advance();
    return { kind: 'sumArray', expression };
  }

  #expectSentenceEnd(): number | undefined {
    const token = this.#peek();
    if (token.kind === 'punct' && token.text === '.') {
      this.#advance();
      return token.end;
    }
    if (token.kind === 'eof') {
      // Point the error at the end of the text so the marker is visible.
      const len = this.#text.length;
      this.#diagnostics.push({
        severity: 'error',
        message: 'expected "." to end the sentence',
        code: 'syntax',
        start: len > 0 ? len - 1 : 0,
        end: len,
      });
      return undefined;
    }
    this.#fail(token, 'expected "." to end the sentence', 'syntax');
    return undefined;
  }

  #matchWord(lower: string): boolean {
    const token = this.#peek();
    if (token.kind === 'word' && token.lower === lower) {
      this.#advance();
      return true;
    }
    return false;
  }

  #peek(offset = 0): Token {
    return this.#tokens[Math.min(this.#index + offset, this.#tokens.length - 1)]!;
  }

  #advance(): Token {
    const token = this.#tokens[this.#index]!;
    if (this.#index < this.#tokens.length - 1) this.#index += 1;
    return token;
  }

  #previous(): Token {
    return this.#tokens[Math.max(0, this.#index - 1)]!;
  }

  #fail(token: Token, message: string, code: string): void {
    const end = token.kind === 'eof' ? this.#text.length : Math.max(token.end, token.start + 1);
    this.#diagnostics.push({
      severity: 'error',
      message,
      code,
      start: token.start,
      end: Math.max(end, token.start),
    });
  }

  #failHere(message: string, code: string): void {
    this.#fail(this.#peek(), message, code);
  }

  /** Report nothing extra; recover to the next sentence boundary. */
  #abort(): undefined {
    this.#recover();
    return undefined;
  }

  /** Skip to the end of the current sentence (a `.` or a new heading). */
  #recover(): void {
    while (true) {
      const token = this.#peek();
      if (token.kind === 'eof') return;
      if (token.kind === 'punct' && token.text === '.') {
        this.#advance();
        return;
      }
      if (token.kind === 'word' && token.atLineStart && SECTION_WORDS.includes(token.lower as (typeof SECTION_WORDS)[number])) {
        return;
      }
      this.#advance();
    }
  }

  /** Skip to the next token that starts its own line (heading recovery). */
  #skipToNextLine(): void {
    while (true) {
      const token = this.#peek();
      if (token.kind === 'eof') return;
      if (token.kind === 'word' && token.atLineStart) return;
      this.#advance();
    }
  }
}

function flattenJoiners(expression: import('./ast.js').BooleanCondition): ConditionJoiner[] {
  const result: ConditionJoiner[] = [];
  const visit = (node: import('./ast.js').BooleanCondition): void => {
    if (node.kind === 'and' || node.kind === 'or') {
      visit(node.left);
      result.push(node.kind);
      visit(node.right);
    } else if (node.kind === 'not') {
      visit(node.expression);
    }
  };
  visit(expression);
  return result;
}
