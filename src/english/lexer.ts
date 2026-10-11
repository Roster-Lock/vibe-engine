/**
 * Tokenizer for the Ability Language.
 *
 * Tokens are words (letters/apostrophes), numbers (`12`, `3.5`), and
 * punctuation (`.`, `(`, `)`, `,`). Newlines are not tokens, but every
 * token records its 1-based line/column and whether it starts its line —
 * the parser needs line starts to recognize `Ability`/`Buff` headings.
 * Lines whose first non-space character is `#` are comments and produce no
 * tokens.
 */
export type TokenKind = 'word' | 'number' | 'string' | 'punct' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** The original text of the token. */
  readonly text: string;
  /** Lowercased text for keywords; `text` for numbers/punct. */
  readonly lower: string;
  readonly start: number;
  readonly end: number;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column (in characters). */
  readonly col: number;
  /** True when no non-space characters precede this token on its line. */
  readonly atLineStart: boolean;
}

const PUNCT = new Set(['.', '(', ')', ',']);

export function lex(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let atLineStart = true;

  const push = (kind: TokenKind, start: number, raw: string): void => {
    const end = start + raw.length;
    tokens.push({
      kind,
      text: raw,
      lower: kind === 'word' ? raw.toLowerCase() : raw,
      start,
      end,
      line,
      col,
      atLineStart,
    });
    atLineStart = false;
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
      // Comment to end of line.
      while (i < text.length && text[i] !== '\n') {
        i += 1;
        col += 1;
      }
      continue;
    }
    const start = i;
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      col += 1;
      let raw = '';
      while (i < text.length && text[i] !== quote && text[i] !== '\n') {
        raw += text[i]!;
        i += 1;
        col += 1;
      }
      if (text[i] === quote) {
        i += 1;
        col += 1;
      }
      push('string', start, raw);
      continue;
    }
    if (/[0-9]/.test(c)) {
      let raw = '';
      while (i < text.length && /[0-9]/.test(text[i]!)) {
        raw += text[i];
        i += 1;
        col += 1;
      }
      // Fractional part (only when digits follow the dot — so a sentence
      // terminator "25." stays a number followed by '.').
      if (text[i] === '.' && i + 1 < text.length && /[0-9]/.test(text[i + 1]!)) {
        raw += '.';
        i += 1;
        col += 1;
        while (i < text.length && /[0-9]/.test(text[i]!)) {
          raw += text[i];
          i += 1;
          col += 1;
        }
      }
      push('number', start, raw);
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let raw = '';
      while (i < text.length && /[A-Za-z']/.test(text[i]!)) {
        raw += text[i];
        i += 1;
        col += 1;
      }
      push('word', start, raw);
      continue;
    }
    // Any other character is treated as punctuation so the parser can
    // report it cleanly ("unexpected '-'").
    i += 1;
    col += 1;
    push('punct', start, ch);
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

/** Converts an absolute offset to a 1-based { line, col } pair. */
export function lineColAt(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}
