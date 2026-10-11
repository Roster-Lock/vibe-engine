/**
 * Tokenizer for the RTS Ability Language.
 *
 * Words, numbers, and punctuation, with three wrinkles the grammar needs:
 *
 * - **Comparison operators lex greedily** — `<=` is one token, not `<`
 *   followed by `=`, so the parser never has to peek across a token
 *   boundary to read an operator.
 * - **The possessive is its own token.** `this unit's attack damage` lexes
 *   as `this` `unit` `'s` `attack` `damage`, so the parser matches the
 *   ordinary noun `unit` and then sees the possessive marker. Folding `'s`
 *   into the word would mean every noun needed a second spelling.
 * - **Line starts are recorded.** `Ability`, `Buff` and the header words
 *   are only keywords at the beginning of a line; anywhere else they are
 *   ordinary words that can appear inside a name.
 *
 * Lines whose first non-space character is `#` are comments and produce no
 * tokens at all.
 */
export type TokenKind = 'word' | 'number' | 'punct' | 'possessive' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** The original text, with its original case. */
  readonly text: string;
  /** Lowercased for words; identical to `text` otherwise. */
  readonly lower: string;
  readonly start: number;
  readonly end: number;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column. */
  readonly col: number;
  /** True when only whitespace precedes this token on its line. */
  readonly atLineStart: boolean;
}

/** Multi-character operators, longest first so the greedy match is correct. */
const OPERATORS = ['<=', '>=', '!=', '<', '>', '='] as const;

export function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let atLineStart = true;

  const push = (kind: TokenKind, start: number, raw: string): void => {
    tokens.push({
      kind,
      text: raw,
      lower: kind === 'word' ? raw.toLowerCase() : raw,
      start,
      end: start + raw.length,
      line,
      col,
      atLineStart,
    });
    atLineStart = false;
    col += raw.length;
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') {
      line += 1;
      col = 1;
      atLineStart = true;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      col += 1;
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }

    const start = i;

    // The possessive marker, before the word rule so `'s` never starts a word.
    if (ch === "'" && (text[i + 1] === 's' || text[i + 1] === 'S')) {
      push('possessive', start, text.slice(i, i + 2));
      i += 2;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let raw = '';
      while (i < text.length && /[0-9]/.test(text[i]!)) {
        raw += text[i];
        i += 1;
      }
      // A fractional part only when digits follow the dot, so the sentence
      // terminator in "heal for 20." stays a separate token.
      if (text[i] === '.' && /[0-9]/.test(text[i + 1] ?? '')) {
        raw += '.';
        i += 1;
        while (i < text.length && /[0-9]/.test(text[i]!)) {
          raw += text[i];
          i += 1;
        }
      }
      push('number', start, raw);
      continue;
    }

    if (/[A-Za-z]/.test(ch)) {
      let raw = '';
      while (i < text.length && /[A-Za-z]/.test(text[i]!)) {
        raw += text[i];
        i += 1;
      }
      push('word', start, raw);
      continue;
    }

    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, i));
    if (operator) {
      push('punct', start, operator);
      i += operator.length;
      continue;
    }

    // Everything else is single-character punctuation, so an unexpected
    // character is reported cleanly instead of derailing the parse.
    push('punct', start, ch);
    i += 1;
  }

  tokens.push({
    kind: 'eof',
    text: '',
    lower: '',
    start: text.length,
    end: text.length,
    line,
    col,
    atLineStart: false,
  });
  return tokens;
}

/** Converts an absolute offset to a 1-based `{ line, col }` pair. */
export function lineColAt(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < Math.min(offset, text.length); i += 1) {
    if (text[i] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}
