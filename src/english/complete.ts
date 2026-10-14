/**
 * Position-aware completion for the Ability Language: given the text and a
 * cursor offset, figure out which phrase is being written and return the
 * words the grammar accepts there (plus supplied/document buff names after
 * `Add`/`Remove`). The Monaco provider maps these onto the cursor's word
 * range; the unit tests check the same logic headlessly.
 */
import {
  ADJECTIVES,
  CHAR_WORDS,
  EVENT_PHRASES,
  RESULT_VERBS,
  SENTENCE_STARTERS,
  WITH_OPERATORS,
  WORD_DOCS,
} from './vocabulary.js';
import type { Token } from './lexer.js';
import { lex } from './lexer.js';
import { BuffDictionary, emptyDictionary, type DictionaryEntry } from './dictionary.js';
import { emptyZoneDictionary, type ZoneDictionary } from './zone-dictionary.js';

export type SuggestionKind = 'keyword' | 'class' | 'operator';

export interface Suggestion {
  readonly label: string;
  readonly kind: SuggestionKind;
  /** One-line explanation shown next to the item. */
  readonly detail?: string;
  /** Markdown documentation shown for the focused item. */
  readonly doc?: string;
}

/** The suggestions offered right before the cursor. */
export function completeAt(
  text: string,
  offset: number,
  dictionary: BuffDictionary = emptyDictionary(),
  zones: ZoneDictionary = emptyZoneDictionary(),
): Suggestion[] {
  const prefixText = text.slice(0, offset);
  const lexed = lex(prefixText);
  const tokens = lexed[lexed.length - 1]?.kind === 'eof' ? lexed.slice(0, -1) : lexed;
  // The word being typed (text right up to the cursor) is its own prefix.
  let typedPrefix = '';
  let walk = tokens;
  if (/[A-Za-z0-9']$/.test(prefixText)) {
    const last = tokens[tokens.length - 1];
    if (last && last.kind === 'word' && last.end === prefixText.length) {
      typedPrefix = last.lower;
      walk = tokens.slice(0, -1);
    }
  }

  const cursorLine = (prefixText.match(/\n/g)?.length ?? 0) + 1;

  // Where does the current construct begin? A boundary is a "." or a
  // line-start Ability/Buff heading.
  let boundaryIndex = -1;
  let boundaryToken: Token | undefined;
  for (let i = 0; i < walk.length; i += 1) {
    const token = walk[i]!;
    if (token.kind === 'punct' && token.text === '.') {
      boundaryIndex = i;
      boundaryToken = token;
    } else if (
      token.kind === 'word' &&
      token.atLineStart &&
      (token.lower === 'ability' || token.lower === 'buff')
    ) {
      boundaryIndex = i;
      boundaryToken = token;
    }
  }

  // Typing inside a heading's name (still on the heading's line): names are
  // free text — offer nothing (buff options inside parens are the exception).
  if (boundaryToken && boundaryToken.kind === 'word' && boundaryToken.line === cursorLine) {
    if (boundaryToken.lower === 'buff' && insideParens(walk, boundaryIndex)) {
      return wordsToSuggestions(['stacks', 'weight'], typedPrefix);
    }
    return [];
  }

  const sentenceTokens =
    boundaryToken && boundaryToken.kind === 'word'
      ? walk.slice(boundaryIndex + 1).filter((t) => t.line > boundaryToken.line)
      : boundaryToken
        ? walk.slice(boundaryIndex + 1)
        : walk;
  // Buffs the document itself declares are offerable too ("Toxic Tentacles").
  const effectiveDictionary = withDeclaredBuffs(dictionary, buffDeclarationsIn(lex(text)));
  const expectations = expectationsFor(sentenceTokens, effectiveDictionary, zones);
  return suggestionsFor(expectations, typedPrefix, effectiveDictionary, zones);
}

/**
 * Buff names the document declares (`Buff Toxic Tentacles (stacks)`),
 * found by scanning the tokens up to the cursor.
 */
function buffDeclarationsIn(tokens: readonly Token[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind !== 'word' || !token.atLineStart || token.lower !== 'buff') continue;
    const parts: string[] = [];
    let j = i + 1;
    while (j < tokens.length && tokens[j]!.kind === 'word' && !tokens[j]!.atLineStart) {
      parts.push(tokens[j]!.text);
      j += 1;
    }
    if (parts.length > 0) names.push(parts.join(' '));
  }
  return names;
}

/** The built-in dictionary plus every buff the document declares. */
function withDeclaredBuffs(dictionary: BuffDictionary, declared: string[]): BuffDictionary {
  if (declared.length === 0) return dictionary;
  const entries: DictionaryEntry[] = [
    ...declared.map((name) => ({ name, def: { name, weight: 1 } })),
    ...dictionary.entries,
  ];
  return new BuffDictionary(entries);
}

/* --------------------------- expectation model -------------------------- */

type Expectation =
  | { readonly kind: 'words'; readonly words: string[] }
  | { readonly kind: 'wordsAndBuffs'; readonly words: string[] }
  | { readonly kind: 'buffNames' }
  | { readonly kind: 'zones' }
  | { readonly kind: 'number' }
  | { readonly kind: 'none' };

const sentenceStartWords = (): string[] => [
  ...SENTENCE_STARTERS.map(capitalize),
  'Ability',
  'Buff',
];

/**
 * Walks the tokens of the sentence being written (all complete tokens —
 * the partial word is the prefix) and returns what the grammar accepts
 * next.
 */
function expectationsFor(tokens: Token[], _dictionary: BuffDictionary, zones: ZoneDictionary): Expectation {
  const first = tokens[0];
  if (!first) return { kind: 'words', words: sentenceStartWords() };
  if (first.kind !== 'word') return { kind: 'none' };

  const lower = first.lower;
  switch (lower) {
    case 'when':
      return walkTrigger(tokens, 1, zones);
    case 'deal':
      return walkDeal(tokens, 1);
    case 'heal':
      return walkHeal(tokens, 1);
    case 'destroy':
      return walkChars(tokens, 1, []);
    case 'add':
      return walkAddRemove(tokens, 1, true);
    case 'remove':
      return walkAddRemove(tokens, 1, false);
    case 'you':
    case 'all':
      return walkResult(tokens, 1);
    default:
      return { kind: 'words', words: sentenceStartWords() };
  }
}

/* ------------------------------ triggers ------------------------------- */

/** The zone verbs, which name a zone rather than an event. */
const ZONE_VERBS = ['enters', 'enter', 'leaves', 'leave'] as const;

/** The words that can end a trigger's subject and start its event verb. */
function isEventVerbWord(word: string | undefined): boolean {
  if (word === undefined) return false;
  return ZONE_VERBS.includes(word as (typeof ZONE_VERBS)[number]);
}

/** How many words the event verb at `i` spans, or 0 when there is none. */
function eventVerbLengthAt(tokens: Token[], i: number): number {
  let best = 0;
  for (const phrase of EVENT_PHRASES) {
    for (const words of phrase.verbs) {
      if (words.length <= best) continue;
      if (words.every((word, offset) => tokens[i + offset]?.lower === word)) best = words.length;
    }
  }
  if (best === 0 && isEventVerbWord(tokens[i]?.lower)) best = 1;
  return best;
}

/**
 * `when <count>? <subject> <event> [from|to <zone>] then <effect>.`
 *
 * The subject's own grammar is walked by the same phrase code the other
 * completions use, but a trigger only needs to know *where the verb starts*
 * — so this scans to the first event verb, then completes the verb, its
 * zone (if it names one), the optional other end, and finally the effect.
 */
function walkTrigger(tokens: Token[], start: number, zones: ZoneDictionary): Expectation {
  // Find the event verb. Everything before it is the subject/count phrase.
  let i = start;
  let length = 0;
  while (i < tokens.length) {
    length = eventVerbLengthAt(tokens, i);
    if (length > 0) break;
    i += 1;
  }
  if (length === 0) {
    // Still writing the subject (or a count phrase).
    return {
      kind: 'words',
      words: ['this', 'a', 'characters', '1', '2', '3', ...ZONE_VERBS, ...eventVerbs()],
    };
  }

  const verb = tokens[i]!.lower;
  i += length;
  if (isEventVerbWord(verb)) {
    // `enters <zone> [from <zone>]` / `leaves <zone> [to <zone>]`.
    const article = tokens[i]?.kind === 'word' && ['a', 'an', 'the'].includes(tokens[i]!.lower);
    if (article) i += 1;
    if (i >= tokens.length || tokens[i]!.kind !== 'word') return { kind: 'zones' };
    i += 1; // the zone name
    const preposition = verb.startsWith('enter') ? 'from' : 'to';
    const next = tokens[i];
    if (next === undefined) return { kind: 'words', words: [preposition, 'then'] };
    if (next.kind === 'word' && (next.lower === 'from' || next.lower === 'to')) {
      const other = tokens[i + 1];
      if (other === undefined) return { kind: 'zones' };
      i += 2;
      return tokens[i] === undefined ? { kind: 'words', words: ['then'] } : walkThen(tokens, i);
    }
    return { kind: 'words', words: [preposition, 'then'] };
  }

  return walkThen(tokens, i);
}

/** After a trigger's `then`, the effect is an ordinary sentence. */
function walkThen(tokens: Token[], i: number): Expectation {
  const next = tokens[i];
  if (next === undefined) return { kind: 'words', words: ['then'] };
  if (next.kind !== 'word' || next.lower !== 'then') return { kind: 'words', words: ['then'] };
  return { kind: 'words', words: effectStartWords() };
}

/** The verbs a sentence may start with (the effect half of a trigger). */
function effectStartWords(): string[] {
  return SENTENCE_STARTERS.map(capitalize).filter((word) => word !== 'When');
}

/** Every event verb, as written, for offering at the verb position. */
function eventVerbs(): string[] {
  return EVENT_PHRASES.flatMap((phrase) => phrase.verbs.map((words) => words.join(' ')));
}

/** `Deal <n> damage to <chars>.` */
function walkDeal(tokens: Token[], i: number): Expectation {
  if (i >= tokens.length || tokens[i]!.kind !== 'number') return { kind: 'number' };
  i += 1;
  if (i >= tokens.length || tokens[i]!.kind !== 'word' || tokens[i]!.lower !== 'damage') {
    return { kind: 'words', words: ['damage'] };
  }
  i += 1;
  if (i >= tokens.length || tokens[i]!.kind !== 'word' || tokens[i]!.lower !== 'to') {
    return { kind: 'words', words: ['to'] };
  }
  return walkChars(tokens, i + 1, []);
}

/** `Heal <chars> for <n>.` / `Heal <n> to <chars>.` */
function walkHeal(tokens: Token[], i: number): Expectation {
  if (i >= tokens.length) {
    return { kind: 'words', words: [...charQuantWords(), 'enemy', 'ally'] };
  }
  if (tokens[i]!.kind === 'number') {
    i += 1;
    if (i >= tokens.length || tokens[i]!.kind !== 'word' || tokens[i]!.lower !== 'to') {
      return { kind: 'words', words: ['to'] };
    }
    return walkChars(tokens, i + 1, []);
  }
  const afterChars = walkChars(tokens, i, ['for']);
  return afterChars;
}

function walkAddRemove(tokens: Token[], i: number, add: boolean): Expectation {
  // Buff name words run until the separator.
  let j = i;
  while (j < tokens.length && tokens[j]!.kind === 'word') {
    const lower = tokens[j]!.lower;
    if (lower === 'to' || lower === 'from') break;
    j += 1;
  }
  const separator = add ? 'to' : 'from';
  if (j === i) return { kind: 'buffNames' };
  if (j >= tokens.length) {
    // Mid-name: the name can keep going, or the separator can follow.
    return { kind: 'wordsAndBuffs', words: [separator] };
  }
  if (tokens[j]!.kind !== 'word' || tokens[j]!.lower !== separator) {
    return { kind: 'words', words: [separator] };
  }
  return walkChars(tokens, j + 1, []);
}

/** `You win the game.` / `All players win the game.` */
function walkResult(tokens: Token[], i: number): Expectation {
  if (tokens[0]!.lower === 'all') {
    if (i >= tokens.length || tokens[i]!.kind !== 'word' || tokens[i]!.lower !== 'players') {
      return { kind: 'words', words: ['players'] };
    }
    i += 1;
  }
  if (i >= tokens.length) return { kind: 'words', words: [...RESULT_VERBS] };
  const verb = tokens[i]!;
  if (verb.kind !== 'word' || !RESULT_VERBS.includes(verb.lower as (typeof RESULT_VERBS)[number])) {
    return { kind: 'words', words: [...RESULT_VERBS] };
  }
  i += 1;
  if (i >= tokens.length || tokens[i]!.kind !== 'word' || tokens[i]!.lower !== 'the') {
    return { kind: 'words', words: ['the'] };
  }
  i += 1;
  if (i >= tokens.length || tokens[i]!.kind !== 'word' || tokens[i]!.lower !== 'game') {
    return { kind: 'words', words: ['game'] };
  }
  return { kind: 'none' };
}

/**
 * Walks a character phrase starting at `i`. `continuations` are words that
 * may legally follow the phrase (e.g. "for" in "Heal X for 5") — they are
 * offered alongside "owned by …" once the phrase itself is complete.
 */
function walkChars(tokens: Token[], i: number, continuations: string[]): Expectation {
  const quant = i < tokens.length ? tokens[i]!.lower : undefined;
  if (quant !== 'this' && quant !== 'target' && quant !== 'all') {
    return { kind: 'words', words: [...charQuantWords(), ...charAdjectiveWords()] };
  }
  i += 1;

  if (quant === 'all' && i < tokens.length && tokens[i]!.kind === 'word' && tokens[i]!.lower === 'other') {
    i += 1;
  }
  let sawAdjective = false;
  if (i < tokens.length && tokens[i]!.kind === 'word') {
    const lower = tokens[i]!.lower;
    if (ADJECTIVES.includes(lower as (typeof ADJECTIVES)[number])) {
      sawAdjective = true;
      i += 1;
    }
  }
  if (i >= tokens.length) {
    if (quant === 'this') return { kind: 'words', words: ['character'] };
    if (sawAdjective || quant === 'target') {
      return { kind: 'words', words: ['character', 'characters'] };
    }
    return { kind: 'words', words: ['other', 'enemy', 'ally', 'character', 'characters'] };
  }
  const charWord = tokens[i]!;
  if (charWord.kind !== 'word' || !CHAR_WORDS.includes(charWord.lower as (typeof CHAR_WORDS)[number])) {
    return { kind: 'words', words: ['character', 'characters'] };
  }
  i += 1;
  return walkPostCharword(tokens, i, continuations, quant);
}

/**
 * Walks everything after the phrase's noun: the optional `owned by …` and
 * `with …` clauses (in either order) and then the sentence tail.
 */
function walkPostCharword(tokens: Token[], i: number, continuations: string[], quant: string): Expectation {
  const isWordAt = (idx: number, lower: string): boolean => {
    const t = tokens[idx];
    return t !== undefined && t.kind === 'word' && t.lower === lower;
  };
  const clausesAllowed = quant !== 'this';
  let sawOwned = false;
  let sawWith = false;
  // Phases: 'phrase' (clauses or tail), 'by', 'owner', 'the', 'condition'
  // (start of a with-condition), 'gaugeOp', 'number', 'andOrTail'.
  let phase: 'phrase' | 'by' | 'owner' | 'the' | 'condition' | 'gaugeOp' | 'number' | 'andOrTail' = 'phrase';

  const tailWords = (): string[] => {
    const tail = [...continuations];
    if (clausesAllowed && !sawOwned) tail.push('owned');
    if (clausesAllowed && !sawWith) tail.push('with');
    if (sawWith) {
      tail.push('and');
      tail.push('or');
    }
    return [...new Set(tail)];
  };

  /** What the grammar accepts when the typed text runs out right now. */
  const endExpectation = (): Expectation => {
    switch (phase) {
      case 'phrase':
        return { kind: 'words', words: tailWords() };
      case 'by':
        return { kind: 'words', words: ['by'] };
      case 'owner':
        return { kind: 'words', words: ['you', 'the'] };
      case 'the':
        return { kind: 'words', words: ['opponent'] };
      case 'condition':
        return { kind: 'wordsAndBuffs', words: ['hp', 'mana'] };
      case 'gaugeOp':
        return { kind: 'words', words: [...WITH_OPERATORS] };
      case 'number':
        return { kind: 'number' };
      case 'andOrTail':
        return { kind: 'words', words: tailWords() };
    }
  };

  while (true) {
    const t = tokens[i];
    if (t === undefined) return endExpectation();
    switch (phase) {
      case 'phrase':
        if (isWordAt(i, 'owned') && !sawOwned) {
          sawOwned = true;
          i += 1;
          phase = 'by';
          break;
        }
        if (isWordAt(i, 'with') && !sawWith) {
          sawWith = true;
          i += 1;
          phase = 'condition';
          break;
        }
        // The phrase is complete — a tail word ("for", …) follows.
        return { kind: 'none' };
      case 'by':
        if (isWordAt(i, 'by')) {
          i += 1;
          phase = 'owner';
          break;
        }
        return { kind: 'words', words: ['by'] };
      case 'owner':
        if (isWordAt(i, 'you')) {
          i += 1;
          phase = 'phrase';
          break;
        }
        if (isWordAt(i, 'the')) {
          i += 1;
          phase = 'the';
          break;
        }
        return { kind: 'words', words: ['you', 'the'] };
      case 'the':
        if (isWordAt(i, 'opponent')) {
          i += 1;
          phase = 'phrase';
          break;
        }
        return { kind: 'words', words: ['opponent'] };
      case 'condition': {
        const lower = t.kind === 'word' ? t.lower : '';
        if (lower === 'hp' || lower === 'mana') {
          i += 1;
          phase = 'gaugeOp';
          break;
        }
        if (t.kind === 'word' && !['and', 'or', 'owned', 'with', ...continuations].includes(lower)) {
          // A buff name — consume its words.
          i += 1;
          while (true) {
            const w = tokens[i];
            if (w === undefined || w.kind !== 'word' || ['and', 'or', 'owned', 'with', ...continuations].includes(w.lower)) break;
            i += 1;
          }
          phase = 'andOrTail';
          break;
        }
        return { kind: 'wordsAndBuffs', words: ['hp', 'mana'] };
      }
      case 'gaugeOp':
        if (t.kind === 'punct' && (t.text === '<' || t.text === '>' || t.text === '=')) {
          i += 1;
          if (t.text !== '=' && tokens[i]?.kind === 'punct' && tokens[i]!.text === '=') i += 1;
          phase = 'number';
          break;
        }
        return { kind: 'words', words: [...WITH_OPERATORS] };
      case 'number':
        if (t.kind === 'number') {
          i += 1;
          phase = 'andOrTail';
          break;
        }
        return { kind: 'number' };
      case 'andOrTail':
        if (t.kind === 'word' && (t.lower === 'and' || t.lower === 'or')) {
          i += 1;
          phase = 'condition';
          break;
        }
        if (t.kind === 'punct' && t.text === ',') {
          i += 1;
          // The Oxford comma: "poison, thorns, and/or hp <= 40".
          if (isWordAt(i, 'and') || isWordAt(i, 'or')) i += 1;
          phase = 'condition';
          break;
        }
        return { kind: 'none' };
    }
  }
}

/* ---------------------------- suggestion bits --------------------------- */

function charQuantWords(): string[] {
  return ['target', 'this', 'all'];
}

function charAdjectiveWords(): string[] {
  return ['enemy', 'ally'];
}

function suggestionsFor(
  expectation: Expectation,
  prefix: string,
  dictionary: BuffDictionary,
  zones: ZoneDictionary,
): Suggestion[] {
  switch (expectation.kind) {
    case 'words':
      return wordsToSuggestions(expectation.words, prefix);
    case 'wordsAndBuffs':
      return [
        ...wordsToSuggestions(expectation.words, prefix),
        ...namesToSuggestions(dictionary, prefix),
      ];
    case 'buffNames':
      return namesToSuggestions(dictionary, prefix);
    case 'zones':
      return zoneToSuggestions(zones, prefix);
    case 'number':
    case 'none':
      return [];
  }
}

/** The zone names a game declared, as completion items. */
function zoneToSuggestions(zones: ZoneDictionary, prefix: string): Suggestion[] {
  const names = prefix
    ? zones.names.filter((name) => name.toLowerCase().startsWith(prefix))
    : zones.names;
  return names.map((name) => ({
    label: name,
    kind: 'class',
    detail: 'zone',
    doc: `\`${name}\` — a zone this game declares. A trigger can name it with "enters ${name}" / "leaves ${name}".`,
  }));
}

function wordsToSuggestions(words: string[], prefix: string): Suggestion[] {
  const filtered = prefix
    ? words.filter((w) => w.toLowerCase().startsWith(prefix))
    : words;
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const label of filtered) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label,
      kind: /^[<>=]+$/.test(label) ? 'operator' : 'keyword',
      detail: docLine(label),
    });
  }
  return out;
}

function namesToSuggestions(dictionary: BuffDictionary, prefix: string): Suggestion[] {
  const names = prefix
    ? dictionary.names.filter((n) => {
        const lower = n.toLowerCase();
        // Multi-word names match from any word boundary: "tentacl" finds
        // "Toxic Tentacles".
        return lower.startsWith(prefix) || lower.includes(` ${prefix}`);
      })
    : dictionary.names;
  return names.map((name) => ({
    label: name,
    kind: 'class',
    detail: 'buff',
    doc: 'A buff this ability can add or remove — declared in the document or built in.',
  }));
}

/** The hover/description line for a word (from the shared vocabulary). */
export function wordDoc(word: string): string | undefined {
  return WORD_DOCS[word.toLowerCase()];
}

function docLine(word: string): string | undefined {
  const doc = WORD_DOCS[word.toLowerCase()];
  return doc ? doc.split('\n')[0] : undefined;
}

function capitalize(word: string): string {
  return word[0]!.toUpperCase() + word.slice(1);
}

/** True when the cursor sits inside an unbalanced "(" … ")" after `index`. */
function insideParens(tokens: Token[], index: number): boolean {
  let depth = 0;
  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === 'punct' && token.text === '(') depth += 1;
    else if (token.kind === 'punct' && token.text === ')') depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}
