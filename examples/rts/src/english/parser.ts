/**
 * Recursive-descent parser for the RTS Ability Language.
 *
 * Error-tolerant by construction: a sentence that fails to parse reports
 * exactly one diagnostic and then skips to the next sentence boundary (a
 * `.`, the next heading or header line, or end of input). A creator with
 * three typos sees three squiggles, not one message and a dead editor.
 *
 * Two places need backtracking, and both use `#attempt`, which restores the
 * token index *and* discards diagnostics produced by the failed branch:
 *
 * - `and` is both a filter joiner and an effect-chain joiner, so
 *   `… with poison and add Slowed to the target` has to try "another
 *   condition" and give the `and` back when that is not what follows;
 * - a stat word can begin a buff name (`Mana Shield`), so a filter tries
 *   the stat-comparison reading and falls back to the buff reading.
 */
import type {
  AbilitySection,
  AnchorPhrase,
  BuffSection,
  Diagnostic,
  Doc,
  FilterExpr,
  HeaderEntry,
  Selector,
  Sentence,
  Span,
  UnitPhrase,
  UnitRef,
  ValueExpr,
} from './ast.js';
import { spanning } from './ast.js';
import type { Allegiance, Anchor, CompareOp, EventKind, Restriction, StatName, TargetingMode } from '../ir.js';
import { lex, type Token } from './lexer.js';
import { EFFECT_VERBS, HEADER_WORDS, SECTION_WORDS, STAT_PHRASES } from './vocabulary.js';

export interface ParseResult {
  readonly doc: Doc;
  readonly diagnostics: Diagnostic[];
}

/** Sentences written before any heading collect into an ability with this name. */
const UNTITLED = 'Untitled';

/** Words that end a free-form name (a buff or unit reference inside a sentence). */
const NAME_STOP_WORDS = new Set(['to', 'from', 'near', 'and', 'or', 'for', 'with', 'within', 'back']);

export function parseDocument(text: string): ParseResult {
  return new Parser(text).parse();
}

class Parser {
  readonly #tokens: Token[];
  readonly #diagnostics: Diagnostic[] = [];
  #index = 0;

  constructor(text: string) {
    this.#tokens = lex(text);
  }

  parse(): ParseResult {
    return { doc: this.#parseDoc(), diagnostics: this.#diagnostics };
  }

  /* -------------------------------- document ------------------------------- */

  #parseDoc(): Doc {
    const abilities: AbilitySection[] = [];
    const buffs: BuffSection[] = [];
    let current: AbilitySection | BuffSection | undefined;

    while (!this.#atEnd()) {
      const token = this.#peek();

      if (token.atLineStart && token.kind === 'word' && token.lower === 'ability') {
        current = this.#parseAbilityHeading();
        abilities.push(current);
        continue;
      }
      if (token.atLineStart && token.kind === 'word' && token.lower === 'buff') {
        current = this.#parseBuffHeading();
        buffs.push(current);
        continue;
      }
      if (token.atLineStart && token.kind === 'word' && (HEADER_WORDS as readonly string[]).includes(token.lower)) {
        const entry = this.#parseHeaderLine();
        if (!entry) continue;
        if (!current) {
          this.#report(entry.span, `"${token.text}" must follow an Ability or Buff heading`, 'orphan-header');
          continue;
        }
        if (entry.kind === 'duration' && current.kind === 'ability') {
          this.#report(entry.span, 'Duration belongs on a Buff, not an Ability', 'misplaced-header');
          continue;
        }
        if (entry.kind !== 'duration' && current.kind === 'buff') {
          this.#report(entry.span, `${entry.kind} belongs on an Ability, not a Buff`, 'misplaced-header');
          continue;
        }
        current.header.push(entry);
        continue;
      }
      if (token.kind === 'punct' && token.text === '.') {
        this.#report(this.#span(token), 'unexpected "." — a sentence or heading belongs here', 'syntax');
        this.#advance();
        continue;
      }

      const sentences = this.#parseSentence();
      if (!sentences) continue;
      if (!current) {
        // Sentences before any heading form an implicit ability, so a
        // one-liner in a scratch buffer still compiles to something.
        current = {
          kind: 'ability',
          span: sentences[0]!.span,
          name: UNTITLED,
          nameSpan: sentences[0]!.span,
          header: [],
          sentences: [],
        };
        abilities.push(current);
      }
      for (const sentence of sentences) {
        current.sentences.push(sentence);
        current.span = spanning(current.span, sentence.span);
      }
    }

    return { abilities, buffs };
  }

  #parseAbilityHeading(): AbilitySection {
    const keyword = this.#advance();
    const { name, span } = this.#readLineName(keyword);
    if (!name) this.#report(span, 'an Ability needs a name', 'missing-name');
    return {
      kind: 'ability',
      span: spanning(this.#span(keyword), span),
      name: name || UNTITLED,
      nameSpan: span,
      header: [],
      sentences: [],
    };
  }

  #parseBuffHeading(): BuffSection {
    const keyword = this.#advance();
    const { name, span } = this.#readLineName(keyword);
    if (!name) this.#report(span, 'a Buff needs a name', 'missing-name');
    let stacks = false;
    let end = span;
    if (this.#atPunct('(')) {
      const open = this.#advance();
      while (!this.#atEnd() && !this.#atPunct(')')) {
        const option = this.#advance();
        if (option.kind === 'word' && option.lower === 'stacks') stacks = true;
        else if (!(option.kind === 'punct' && option.text === ','))
          this.#report(this.#span(option), `unknown buff option "${option.text}" — did you mean "stacks"?`, 'buff-option');
      }
      end = this.#atPunct(')') ? this.#span(this.#advance()) : this.#span(open);
    }
    return {
      kind: 'buff',
      span: spanning(this.#span(keyword), end),
      name: name || UNTITLED,
      nameSpan: span,
      stacks,
      header: [],
      sentences: [],
    };
  }

  /** Reads the rest of `keyword`'s line as a name, stopping at `(`. */
  #readLineName(keyword: Token): { name: string; span: Span } {
    const parts: Token[] = [];
    while (!this.#atEnd() && this.#peek().line === keyword.line && !this.#atPunct('(')) {
      parts.push(this.#advance());
    }
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (!first || !last) return { name: '', span: this.#span(keyword) };
    return { name: parts.map((part) => part.text).join(' '), span: spanning(this.#span(first), this.#span(last)) };
  }

  /* ------------------------------ header lines ----------------------------- */

  #parseHeaderLine(): HeaderEntry | undefined {
    const keyword = this.#advance();
    if (this.#atPunct(':')) this.#advance();
    const finish = <T extends HeaderEntry>(entry: T): T => {
      if (this.#atPunct('.')) this.#advance();
      return entry;
    };

    switch (keyword.lower) {
      case 'targeting': {
        const mode = this.#parseTargetingMode();
        if (!mode) return undefined;
        return finish({ kind: 'targeting', span: spanning(this.#span(keyword), mode.span), mode: mode.mode, modeSpan: mode.span });
      }
      case 'cooldown': {
        const seconds = this.#parseDuration(keyword);
        if (seconds === undefined) return undefined;
        return finish({ kind: 'cooldown', span: spanning(this.#span(keyword), this.#lastSpan()), seconds });
      }
      case 'duration': {
        const seconds = this.#parseDuration(keyword);
        if (seconds === undefined) return undefined;
        return finish({ kind: 'duration', span: spanning(this.#span(keyword), this.#lastSpan()), seconds });
      }
      case 'cost': {
        const amount = this.#parseNumber('a mana cost');
        if (!amount) return undefined;
        if (this.#atWord('mana')) this.#advance();
        return finish({ kind: 'cost', span: spanning(this.#span(keyword), this.#lastSpan()), mana: amount.value });
      }
      case 'range': {
        const amount = this.#parseNumber('a cast range');
        if (!amount) return undefined;
        return finish({ kind: 'range', span: spanning(this.#span(keyword), this.#lastSpan()), range: amount.value });
      }
      default:
        this.#report(this.#span(keyword), `unknown header "${keyword.text}"`, 'unknown-header');
        this.#recover();
        return undefined;
    }
  }

  #parseTargetingMode(): { mode: TargetingMode; span: Span } | undefined {
    const start = this.#peek();
    if (this.#atWord('no')) {
      this.#advance();
      if (!this.#expectWord('target', 'no target')) return undefined;
      return { mode: 'none', span: spanning(this.#span(start), this.#lastSpan()) };
    }
    if (!this.#expectWord('target', 'a targeting mode')) return undefined;
    if (this.#atWord('point')) {
      this.#advance();
      return { mode: 'point', span: spanning(this.#span(start), this.#lastSpan()) };
    }
    let mode: TargetingMode = 'unit';
    if (this.#atWord('enemy')) {
      this.#advance();
      mode = 'enemyUnit';
    } else if (this.#atWord('ally') || this.#atWord('allied') || this.#atWord('friendly')) {
      this.#advance();
      mode = 'allyUnit';
    }
    if (!this.#expectUnitNoun()) return undefined;
    return { mode, span: spanning(this.#span(start), this.#lastSpan()) };
  }

  /** `8` / `8 seconds` — the trailing noun is optional but idiomatic. */
  #parseDuration(context: Token): number | undefined {
    const amount = this.#parseNumber(`a number of seconds after "${context.text}"`);
    if (!amount) return undefined;
    if (this.#atWord('second') || this.#atWord('seconds')) this.#advance();
    return amount.value;
  }

  /* -------------------------------- sentences ------------------------------ */

  /**
   * One or more clauses joined by `and`, terminated by `.`.
   *
   * Returns the clauses *unwrapped*: at the top level `Deal 50 damage to
   * the target and add Stunned to the target.` is two sentences that happen
   * to share a period, and running them as two ordinary steps is exactly
   * what the author means. (Inside `after …` / `every …` the chain stays
   * nested, because there the delay applies to the whole body.)
   */
  #parseSentence(): Sentence[] | undefined {
    const clauses = this.#parseClauseChain();
    if (!clauses) {
      this.#recover();
      return undefined;
    }
    if (this.#atPunct('.')) this.#advance();
    else this.#report(this.#span(this.#peek()), 'a sentence must end with "."', 'missing-period');
    return clauses;
  }

  #parseClauseChain(): Sentence[] | undefined {
    const first = this.#parseClause();
    if (!first) return undefined;
    const clauses = [first];
    while (this.#atWord('and')) {
      const next = this.#attempt(() => {
        this.#advance();
        return this.#parseClause();
      });
      if (!next) break;
      clauses.push(next);
    }
    return clauses;
  }

  #parseClause(): Sentence | undefined {
    const token = this.#peek();
    if (token.kind !== 'word') {
      this.#report(this.#span(token), `expected an effect, found "${token.text || 'end of input'}"`, 'syntax');
      return undefined;
    }
    switch (token.lower) {
      case 'deal':
        return this.#parseDamage();
      case 'heal':
        return this.#parseHeal();
      case 'add':
        return this.#parseAddBuff();
      case 'remove':
        return this.#parseRemoveBuff();
      case 'kill':
        return this.#parseKill();
      case 'summon':
        return this.#parseSummon();
      case 'teleport':
        return this.#parseTeleport();
      case 'push':
        return this.#parsePush();
      case 'after':
        return this.#parseAfter();
      case 'every':
        return this.#parseEvery();
      case 'whenever':
      case 'when':
        return this.#parseWhenever();
      case 'increase':
      case 'reduce':
        return this.#parseModifier();
      case 'cannot':
        return this.#parseRestriction();
      default:
        this.#report(this.#span(token), `unknown effect "${token.text}"`, 'unknown-verb');
        return undefined;
    }
  }

  /** `Deal 100 damage to …` or `Deal damage equal to 50% of … to …`. */
  #parseDamage(): Sentence | undefined {
    const keyword = this.#advance();
    let amount: ValueExpr | undefined;
    if (this.#atWord('damage')) {
      this.#advance();
      if (!this.#expectWord('equal', '"equal to" before a scaling amount')) return undefined;
      if (!this.#expectWord('to', '"to" after "equal"')) return undefined;
      amount = this.#parseValue();
    } else {
      amount = this.#parseValue();
      if (amount && !this.#expectWord('damage', '"damage" after the amount')) return undefined;
    }
    if (!amount) return undefined;
    if (!this.#expectWord('to', '"to" before the units')) return undefined;
    const units = this.#parseUnitPhrase();
    if (!units) return undefined;
    return { kind: 'damage', span: spanning(this.#span(keyword), units.span), amount, units };
  }

  /** `Heal <units> for <value>.` or the amount-first `Heal <value> to <units>.` */
  #parseHeal(): Sentence | undefined {
    const keyword = this.#advance();
    if (this.#peek().kind === 'number') {
      const amount = this.#parseValue();
      if (!amount) return undefined;
      if (!this.#expectWord('to', '"to" before the units')) return undefined;
      const units = this.#parseUnitPhrase();
      if (!units) return undefined;
      return { kind: 'heal', span: spanning(this.#span(keyword), units.span), amount, units };
    }
    const units = this.#parseUnitPhrase();
    if (!units) return undefined;
    if (!this.#expectWord('for', '"for" before the amount')) return undefined;
    const amount = this.#parseValue();
    if (!amount) return undefined;
    return { kind: 'heal', span: spanning(this.#span(keyword), amount.span), amount, units };
  }

  #parseAddBuff(): Sentence | undefined {
    const keyword = this.#advance();
    const name = this.#parseName('a buff name');
    if (!name) return undefined;
    if (!this.#expectWord('to', '"to" before the units')) return undefined;
    const units = this.#parseUnitPhrase();
    if (!units) return undefined;
    return {
      kind: 'addBuff',
      span: spanning(this.#span(keyword), units.span),
      buffName: name.text,
      buffSpan: name.span,
      units,
    };
  }

  #parseRemoveBuff(): Sentence | undefined {
    const keyword = this.#advance();
    const name = this.#parseName('a buff name');
    if (!name) return undefined;
    if (!this.#expectWord('from', '"from" before the units')) return undefined;
    const units = this.#parseUnitPhrase();
    if (!units) return undefined;
    return {
      kind: 'removeBuff',
      span: spanning(this.#span(keyword), units.span),
      buffName: name.text,
      buffSpan: name.span,
      units,
    };
  }

  #parseKill(): Sentence | undefined {
    const keyword = this.#advance();
    const units = this.#parseUnitPhrase();
    if (!units) return undefined;
    return { kind: 'kill', span: spanning(this.#span(keyword), units.span), units };
  }

  #parseSummon(): Sentence | undefined {
    const keyword = this.#advance();
    const count = this.#parseNumber('how many units to summon');
    if (!count) return undefined;
    const name = this.#parseName('a unit name');
    if (!name) return undefined;
    if (!this.#expectWord('near', '"near" before the anchor')) return undefined;
    const anchor = this.#parseAnchor();
    if (!anchor) return undefined;
    return {
      kind: 'summon',
      span: spanning(this.#span(keyword), anchor.span),
      count: count.value,
      countSpan: count.span,
      unitName: name.text,
      unitSpan: name.span,
      anchor,
    };
  }

  #parseTeleport(): Sentence | undefined {
    const keyword = this.#advance();
    const units = this.#parseUnitPhrase();
    if (!units) return undefined;
    if (!this.#expectWord('to', '"to" before the destination')) return undefined;
    const anchor = this.#parseAnchor();
    if (!anchor) return undefined;
    return { kind: 'teleport', span: spanning(this.#span(keyword), anchor.span), units, anchor };
  }

  /** `Push <units> back <n> units [from <anchor>].` */
  #parsePush(): Sentence | undefined {
    const keyword = this.#advance();
    const units = this.#parseUnitPhrase();
    if (!units) return undefined;
    if (!this.#expectWord('back', '"back" after the units')) return undefined;
    const amount = this.#parseNumber('a push distance');
    if (!amount) return undefined;
    if (this.#atWord('unit') || this.#atWord('units')) this.#advance();
    let anchor: AnchorPhrase | undefined;
    if (this.#atWord('from')) {
      this.#advance();
      anchor = this.#parseAnchor();
      if (!anchor) return undefined;
    }
    return {
      kind: 'push',
      span: spanning(this.#span(keyword), anchor?.span ?? this.#lastSpan()),
      units,
      distance: amount.value,
      anchor,
    };
  }

  #parseAfter(): Sentence | undefined {
    const keyword = this.#advance();
    const delay = this.#parseDuration(keyword);
    if (delay === undefined) return undefined;
    const body = this.#parseBody(keyword);
    if (!body) return undefined;
    return { kind: 'after', span: spanning(this.#span(keyword), body.span), delay, body: body.clauses };
  }

  #parseEvery(): Sentence | undefined {
    const keyword = this.#advance();
    const interval = this.#parseDuration(keyword);
    if (interval === undefined) return undefined;
    let duration: number | undefined;
    if (this.#atWord('for')) {
      this.#advance();
      duration = this.#parseDuration(keyword);
      if (duration === undefined) return undefined;
    }
    const body = this.#parseBody(keyword);
    if (!body) return undefined;
    return { kind: 'every', span: spanning(this.#span(keyword), body.span), interval, duration, body: body.clauses };
  }

  #parseWhenever(): Sentence | undefined {
    const keyword = this.#advance();
    const event = this.#parseEvent();
    if (!event) return undefined;
    const body = this.#parseBody(keyword);
    if (!body) return undefined;
    return {
      kind: 'whenever',
      span: spanning(this.#span(keyword), body.span),
      event: event.event,
      eventSpan: event.span,
      body: body.clauses,
    };
  }

  /** The `, <clause> [and <clause>]*` tail shared by after / every / whenever. */
  #parseBody(keyword: Token): { clauses: Sentence[]; span: Span } | undefined {
    if (!this.#atPunct(',')) {
      this.#report(this.#span(this.#peek()), `"${keyword.text} …" needs a comma before its effect`, 'missing-comma');
      return undefined;
    }
    this.#advance();
    const clauses = this.#parseClauseChain();
    if (!clauses || clauses.length === 0) return undefined;
    return { clauses, span: clauses[clauses.length - 1]!.span };
  }

  #parseEvent(): { event: EventKind; span: Span } | undefined {
    const start = this.#peek();
    if (this.#atWord('this')) {
      this.#advance();
      if (!this.#expectUnitNoun()) return undefined;
    } else if (this.#atWord('a')) {
      // "whenever a unit dies" reads naturally but means something else
      // (any unit on the map), which this version does not have.
      this.#report(this.#span(start), 'only "whenever this unit …" is supported — a map-wide listener is not in this version', 'unsupported-event-subject');
      return undefined;
    }
    const verb = this.#peek();
    if (verb.kind !== 'word') {
      this.#report(this.#span(verb), 'expected an event verb (takes damage, dies, attacks, kills, casts)', 'unknown-event');
      return undefined;
    }
    switch (verb.lower) {
      case 'takes':
        this.#advance();
        if (!this.#expectWord('damage', '"damage" after "takes"')) return undefined;
        return { event: 'damaged', span: spanning(this.#span(start), this.#lastSpan()) };
      case 'dies':
        this.#advance();
        return { event: 'died', span: spanning(this.#span(start), this.#lastSpan()) };
      case 'attacks':
        this.#advance();
        return { event: 'attacks', span: spanning(this.#span(start), this.#lastSpan()) };
      case 'kills':
        this.#advance();
        if (this.#atWord('a')) this.#advance();
        if (this.#atWord('unit')) this.#advance();
        return { event: 'kills', span: spanning(this.#span(start), this.#lastSpan()) };
      case 'casts':
        this.#advance();
        if (this.#atWord('an')) this.#advance();
        if (this.#atWord('ability')) this.#advance();
        return { event: 'casts', span: spanning(this.#span(start), this.#lastSpan()) };
      default:
        this.#report(this.#span(verb), `unknown event "${verb.text}" — try takes damage, dies, attacks, kills, casts`, 'unknown-event');
        return undefined;
    }
  }

  /** `Increase attack damage by 10.` / `Reduce movement speed by 50%.` */
  #parseModifier(): Sentence | undefined {
    const keyword = this.#advance();
    const sign = keyword.lower === 'reduce' ? -1 : 1;
    const stat = this.#parseStat();
    if (!stat) return undefined;
    const target = MODIFIABLE_STATS[stat.text];
    if (!target) {
      this.#report(stat.span, `"${stat.text}" cannot be modified by a buff — try movement speed, attack damage, attack speed or armor`, 'unmodifiable-stat');
      return undefined;
    }
    if (!this.#expectWord('by', '"by" before the amount')) return undefined;
    const amount = this.#parseNumber('an amount');
    if (!amount) return undefined;
    let mode: 'flat' | 'percent' = 'flat';
    if (this.#atPunct('%')) {
      this.#advance();
      mode = 'percent';
    }
    return {
      kind: 'modifier',
      span: spanning(this.#span(keyword), this.#lastSpan()),
      stat: target,
      mode,
      amount: sign * amount.value,
    };
  }

  #parseRestriction(): Sentence | undefined {
    const keyword = this.#advance();
    const word = this.#peek();
    const restriction = word.kind === 'word' ? (RESTRICTIONS[word.lower] as Restriction | undefined) : undefined;
    if (!restriction) {
      this.#report(this.#span(word), 'expected "move", "attack" or "cast" after "cannot"', 'unknown-restriction');
      return undefined;
    }
    this.#advance();
    return { kind: 'restriction', span: spanning(this.#span(keyword), this.#lastSpan()), restriction };
  }

  /* ---------------------------------- nouns -------------------------------- */

  #parseUnitPhrase(): UnitPhrase | undefined {
    const start = this.#peek();
    const selector = this.#parseSelector();
    if (!selector) return undefined;
    let filter: FilterExpr | undefined;
    if (this.#atWord('with')) {
      this.#advance();
      filter = this.#parseFilter();
      if (!filter) return undefined;
    }
    return { span: spanning(this.#span(start), this.#lastSpan()), selector, filter };
  }

  #parseSelector(): Selector | undefined {
    const token = this.#peek();
    if (this.#atWord('this')) {
      this.#advance();
      if (!this.#expectUnitNoun()) return undefined;
      return { kind: 'self' };
    }
    if (this.#atWord('the')) {
      const ref = this.#parseTheNoun();
      if (!ref) return undefined;
      if (ref.kind === 'targetPoint') {
        this.#report(ref.span, '"the target point" is a place, not a unit — name units to affect', 'point-as-unit');
        return undefined;
      }
      return ref.selector;
    }
    if (this.#atWord('all')) {
      return this.#parseAreaSelector();
    }
    this.#report(this.#span(token), `expected units, found "${token.text || 'end of input'}"`, 'expected-units');
    return undefined;
  }

  /** `all [other] [enemy|ally] units within <n> [range] of <anchor>` */
  #parseAreaSelector(): Selector | undefined {
    this.#advance(); // all
    let other = false;
    if (this.#atWord('other')) {
      this.#advance();
      other = true;
    }
    let who: Allegiance = 'any';
    if (this.#atWord('enemy')) {
      this.#advance();
      who = 'enemy';
    } else if (this.#atWord('ally') || this.#atWord('allied') || this.#atWord('friendly')) {
      this.#advance();
      who = 'ally';
    }
    if (!this.#expectUnitNoun()) return undefined;
    if (!this.#expectWord('within', 'a radius — "within 300 range of this unit"')) return undefined;
    const radius = this.#parseNumber('a radius');
    if (!radius) return undefined;
    if (this.#atWord('range')) this.#advance();
    if (!this.#expectWord('of', '"of" before the anchor')) return undefined;
    const anchor = this.#parseAnchor();
    if (!anchor) return undefined;
    return { kind: 'area', who, other, radius: radius.value, radiusSpan: radius.span, anchor };
  }

  #parseAnchor(): AnchorPhrase | undefined {
    const start = this.#peek();
    if (this.#atWord('this')) {
      this.#advance();
      if (!this.#expectUnitNoun()) return undefined;
      return { span: spanning(this.#span(start), this.#lastSpan()), anchor: { kind: 'self' } };
    }
    if (this.#atWord('the')) {
      const ref = this.#parseTheNoun();
      if (!ref) return undefined;
      return { span: ref.span, anchor: ref.anchor };
    }
    this.#report(this.#span(start), `expected an anchor ("this unit", "the target", "the target point"), found "${start.text || 'end of input'}"`, 'expected-anchor');
    return undefined;
  }

  /**
   * The `the …` nouns, parsed once for both the unit-phrase and anchor
   * positions: `the target`, `the target point`, `the attacker`, `the
   * victim`, `the killer`.
   */
  #parseTheNoun():
    | { kind: 'target' | 'targetPoint' | 'eventUnit'; span: Span; anchor: Anchor; selector: Selector }
    | undefined {
    const start = this.#advance(); // the
    const noun = this.#peek();
    if (noun.kind !== 'word') {
      this.#report(this.#span(noun), 'expected a noun after "the"', 'expected-noun');
      return undefined;
    }
    if (noun.lower === 'target') {
      this.#advance();
      if (this.#atWord('point')) {
        this.#advance();
        const span = spanning(this.#span(start), this.#lastSpan());
        return { kind: 'targetPoint', span, anchor: { kind: 'targetPoint' }, selector: { kind: 'target' } };
      }
      const span = spanning(this.#span(start), this.#lastSpan());
      return { kind: 'target', span, anchor: { kind: 'target' }, selector: { kind: 'target' } };
    }
    if (noun.lower === 'attacker' || noun.lower === 'victim' || noun.lower === 'killer') {
      this.#advance();
      const role = noun.lower;
      const span = spanning(this.#span(start), this.#lastSpan());
      return { kind: 'eventUnit', span, anchor: { kind: 'eventUnit', role }, selector: { kind: 'eventUnit', role } };
    }
    this.#report(this.#span(noun), `unknown noun "the ${noun.text}" — try the target, the target point, the attacker, the victim or the killer`, 'unknown-noun');
    return undefined;
  }

  /** A number, or `<n>% of <unit>'s <stat>`. */
  #parseValue(): ValueExpr | undefined {
    const amount = this.#parseNumber('an amount');
    if (!amount) return undefined;
    if (!this.#atPunct('%')) return { kind: 'const', span: amount.span, value: amount.value };
    this.#advance(); // %
    if (!this.#expectWord('of', '"of" after a percentage')) return undefined;
    const of = this.#parseUnitRef();
    if (!of) return undefined;
    if (this.#peek().kind !== 'possessive') {
      this.#report(this.#span(this.#peek()), 'expected "\'s" before the stat — "50% of this unit\'s attack damage"', 'expected-possessive');
      return undefined;
    }
    this.#advance();
    const stat = this.#parseValueStat();
    if (!stat) return undefined;
    return {
      kind: 'statPercent',
      span: spanning(amount.span, stat.span),
      percent: amount.value,
      of,
      stat: stat.stat,
      statSpan: stat.span,
    };
  }

  /** The single-unit nouns that may own a possessive. */
  #parseUnitRef(): UnitRef | undefined {
    if (this.#atWord('this')) {
      this.#advance();
      if (!this.#expectUnitNoun()) return undefined;
      return { kind: 'self' };
    }
    if (this.#atWord('the')) {
      const ref = this.#parseTheNoun();
      if (!ref) return undefined;
      if (ref.kind === 'targetPoint') {
        this.#report(ref.span, '"the target point" has no stats', 'point-has-no-stats');
        return undefined;
      }
      return ref.selector as UnitRef;
    }
    this.#report(this.#span(this.#peek()), 'expected "this unit" or "the target"', 'expected-unit-ref');
    return undefined;
  }

  /**
   * A stat in a position that reads its *value* (a filter, a percentage).
   * `attack speed` is rejected here: it exists only as a buff modifier, and
   * saying so beats silently comparing against something else.
   */
  #parseValueStat(): { stat: StatName; span: Span; text: string } | undefined {
    const matched = this.#parseStat();
    if (!matched) return undefined;
    const stat = STAT_NAMES[matched.text];
    if (!stat) {
      this.#report(matched.span, `"${matched.text}" is not a stat you can read — it only exists as a buff modifier`, 'unreadable-stat');
      return undefined;
    }
    return { stat, span: matched.span, text: matched.text };
  }

  /** Matches the longest stat phrase at the cursor (`attack damage` beats `attack`). */
  #parseStat(): { span: Span; text: string } | undefined {
    for (const phrase of STAT_PHRASES) {
      const matches = phrase.every((word, offset) => {
        const token = this.#tokens[this.#index + offset];
        return token !== undefined && token.kind === 'word' && token.lower === word;
      });
      if (!matches) continue;
      const first = this.#peek();
      for (let i = 0; i < phrase.length; i += 1) this.#advance();
      return { span: spanning(this.#span(first), this.#lastSpan()), text: phrase.join(' ') };
    }
    const token = this.#peek();
    this.#report(this.#span(token), `unknown stat "${token.text || 'end of input'}"`, 'unknown-stat');
    return undefined;
  }

  /* --------------------------------- filters -------------------------------- */

  /** `or` has the loosest binding, then `and`/`,`, then `not`/parentheses. */
  #parseFilter(): FilterExpr | undefined {
    let left = this.#parseFilterAnd();
    if (!left) return undefined;
    while (this.#atWord('or')) {
      const next = this.#attempt(() => {
        this.#advance();
        return this.#parseFilterAnd();
      });
      if (!next) break;
      left = { kind: 'or', span: spanning(left.span, next.span), left, right: next };
    }
    return left;
  }

  #parseFilterAnd(): FilterExpr | undefined {
    let left = this.#parseFilterUnary();
    if (!left) return undefined;
    while (this.#atWord('and') || this.#atPunct(',')) {
      const next = this.#attempt(() => {
        this.#advance();
        // An Oxford comma — "poison, thorns, and hp < 10" — puts `and`
        // right after the comma; both are the same joiner, so skip it.
        if (this.#atWord('and')) this.#advance();
        return this.#parseFilterUnary();
      });
      if (!next) break;
      left = { kind: 'and', span: spanning(left.span, next.span), left, right: next };
    }
    return left;
  }

  #parseFilterUnary(): FilterExpr | undefined {
    if (this.#atWord('not')) {
      const keyword = this.#advance();
      const expression = this.#parseFilterUnary();
      if (!expression) return undefined;
      return { kind: 'not', span: spanning(this.#span(keyword), expression.span), expression };
    }
    if (this.#atPunct('(')) {
      const open = this.#advance();
      const inner = this.#parseFilter();
      if (!inner) return undefined;
      if (!this.#atPunct(')')) {
        this.#report(this.#span(this.#peek()), 'expected ")" to close the condition group', 'unclosed-group');
        return undefined;
      }
      this.#advance();
      return { ...inner, span: spanning(this.#span(open), this.#lastSpan()) };
    }
    return this.#parseCondition();
  }

  /**
   * A stat comparison, or a bare buff name. The stat reading is tried first
   * but only *committed* when an operator follows, so a buff called
   * `Mana Shield` still parses as a buff.
   */
  #parseCondition(): FilterExpr | undefined {
    const comparison = this.#attempt(() => {
      const stat = this.#parseValueStat();
      if (!stat) return undefined;
      if (this.#atWord('below') || this.#atWord('above')) {
        const direction = this.#advance();
        const value = this.#parseNumber('a percentage');
        if (!value) return undefined;
        if (!this.#atPunct('%')) {
          this.#report(this.#span(this.#peek()), `expected "%" after "${direction.text} ${value.value}"`, 'expected-percent');
          return undefined;
        }
        this.#advance();
        return {
          kind: 'stat' as const,
          span: spanning(stat.span, this.#lastSpan()),
          stat: stat.stat,
          statSpan: stat.span,
          op: (direction.lower === 'below' ? '<' : '>') as CompareOp,
          value: value.value,
          percentOfMax: true,
        };
      }
      const operator = this.#peek();
      if (operator.kind !== 'punct' || !(COMPARE_SET as Set<string>).has(operator.text)) return undefined;
      this.#advance();
      const value = this.#parseNumber('a number to compare against');
      if (!value) return undefined;
      return {
        kind: 'stat' as const,
        span: spanning(stat.span, value.span),
        stat: stat.stat,
        statSpan: stat.span,
        op: operator.text as CompareOp,
        value: value.value,
        percentOfMax: false,
      };
    });
    if (comparison) return comparison;

    // A buff name may not begin with an effect verb. Without this, the
    // `and` in "… with poisoned and add Slowed to this unit." reads as a
    // condition joiner and swallows "add Slowed" as a buff name, instead of
    // ending the filter and starting the next clause.
    const next = this.#peek();
    if (next.kind === 'word' && (EFFECT_VERBS as readonly string[]).includes(next.lower)) {
      this.#report(this.#span(next), `expected a condition, found the effect "${next.text}"`, 'verb-in-filter');
      return undefined;
    }

    const name = this.#parseName('a condition — a stat comparison or a buff name');
    if (!name) return undefined;
    return { kind: 'buff', span: name.span, buffName: name.text, buffSpan: name.span };
  }

  /* --------------------------------- helpers -------------------------------- */

  /**
   * A multi-word free-form name (a buff or unit type), reading words until a
   * structural word or punctuation. Names cannot contain `to`, `from`,
   * `and`, … — those end the name, which is why a buff may not be called
   * "Hand of Protection" but may be called "Divine Protection".
   */
  #parseName(what: string): { text: string; span: Span } | undefined {
    const parts: Token[] = [];
    while (this.#peek().kind === 'word' && !NAME_STOP_WORDS.has(this.#peek().lower)) {
      parts.push(this.#advance());
    }
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (!first || !last) {
      this.#report(this.#span(this.#peek()), `expected ${what}`, 'expected-name');
      return undefined;
    }
    return {
      text: parts.map((part) => part.text).join(' '),
      span: spanning(this.#span(first), this.#span(last)),
    };
  }

  #parseNumber(what: string): { value: number; span: Span } | undefined {
    const token = this.#peek();
    if (token.kind !== 'number') {
      this.#report(this.#span(token), `expected ${what}, found "${token.text || 'end of input'}"`, 'expected-number');
      return undefined;
    }
    this.#advance();
    return { value: Number(token.text), span: this.#span(token) };
  }

  #expectWord(word: string, what: string): boolean {
    if (this.#atWord(word)) {
      this.#advance();
      return true;
    }
    const token = this.#peek();
    this.#report(this.#span(token), `expected ${what}, found "${token.text || 'end of input'}"`, 'expected-word');
    return false;
  }

  /** `unit` or `units` — accepted interchangeably everywhere. */
  #expectUnitNoun(): boolean {
    if (this.#atWord('unit') || this.#atWord('units')) {
      this.#advance();
      return true;
    }
    const token = this.#peek();
    this.#report(this.#span(token), `expected "unit", found "${token.text || 'end of input'}"`, 'expected-word');
    return false;
  }

  /**
   * Runs `body`; on failure restores both the cursor and the diagnostics
   * list, so a speculative branch leaves no trace.
   */
  #attempt<T>(body: () => T | undefined): T | undefined {
    const index = this.#index;
    const errors = this.#diagnostics.length;
    const result = body();
    if (result === undefined) {
      this.#index = index;
      this.#diagnostics.length = errors;
    }
    return result;
  }

  /** Skips to the next sentence boundary after an error. */
  #recover(): void {
    while (!this.#atEnd()) {
      const token = this.#peek();
      if (token.kind === 'punct' && token.text === '.') {
        this.#advance();
        return;
      }
      if (
        token.atLineStart &&
        token.kind === 'word' &&
        ((SECTION_WORDS as readonly string[]).includes(token.lower) || (HEADER_WORDS as readonly string[]).includes(token.lower))
      ) {
        return;
      }
      this.#advance();
    }
  }

  #peek(offset = 0): Token {
    return this.#tokens[Math.min(this.#index + offset, this.#tokens.length - 1)]!;
  }

  #advance(): Token {
    const token = this.#peek();
    if (this.#index < this.#tokens.length - 1) this.#index += 1;
    return token;
  }

  #atEnd(): boolean {
    return this.#peek().kind === 'eof';
  }

  #atWord(word: string): boolean {
    const token = this.#peek();
    return token.kind === 'word' && token.lower === word;
  }

  #atPunct(text: string): boolean {
    const token = this.#peek();
    return token.kind === 'punct' && token.text === text;
  }

  #span(token: Token): Span {
    return { start: token.start, end: token.end };
  }

  /** The span of the token just consumed — the end of whatever was matched. */
  #lastSpan(): Span {
    const token = this.#tokens[Math.max(0, this.#index - 1)]!;
    return { start: token.start, end: token.end };
  }

  #report(span: Span, message: string, code: string): void {
    this.#diagnostics.push({ severity: 'error', message, code, start: span.start, end: span.end });
  }
}

const COMPARE_SET = new Set<string>(['<', '<=', '>', '>=', '=', '!=']);

const RESTRICTIONS: Readonly<Record<string, Restriction>> = { move: 'move', attack: 'attack', cast: 'cast' };

/**
 * Stat phrase to the IR stat it reads. `attack speed` is deliberately
 * absent: nothing can read it as a number (it is expressed as a change to
 * the attack cooldown), so it appears only in `MODIFIABLE_STATS`.
 */
const STAT_NAMES: Readonly<Record<string, StatName | undefined>> = {
  'movement speed': 'moveSpeed',
  'attack damage': 'attackDamage',
  'max hp': 'maxHp',
  'max mana': 'maxMana',
  hp: 'hp',
  mana: 'mana',
  armor: 'armor',
};

/** Stat phrase to the modifier a buff contributes, for `Increase`/`Reduce`. */
const MODIFIABLE_STATS: Readonly<Record<string, 'moveSpeed' | 'attackDamage' | 'armor' | 'attackSpeed' | undefined>> = {
  'movement speed': 'moveSpeed',
  'attack damage': 'attackDamage',
  'attack speed': 'attackSpeed',
  armor: 'armor',
};
