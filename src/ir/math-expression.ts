/**
 * Safe numeric expressions — a JSON AST plus an evaluator and a LaTeX
 * renderer, so a formula stays data (introspectable, hoverable, storable)
 * instead of a compiled closure. Lives under `src/ir/` because
 * it's the numeric half of `DeclaredFn` (see `declared-fn/math.ts`) as much
 * as it is `src/english`'s content-authoring formula language — `src/english`
 * re-exports these same symbols rather than owning a copy.
 *
 * This parser never evaluates source code. Paths are resolved against the
 * caller-provided context, and the Greek capital sigma (Σ) only aggregates
 * numeric values.
 */
export type MathExpression =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'path'; readonly parts: readonly (string | number | { readonly kind: 'index'; readonly expression: MathExpression })[] }
  | { readonly kind: 'unary'; readonly op: '+' | '-'; readonly expression: MathExpression }
  | {
      readonly kind: 'binary';
      /**
       * No remainder operator: `%` is reserved for **percent**, which card
       * text needs far more often ("50% of this unit's attack"), and a `%`
       * that meant remainder would be misread as a percentage every time.
       * Parity — the only thing remainder was serving — is a `parity`
       * predicate instead (src/ir/ability.ts).
       */
      readonly op: '+' | '-' | '*' | '/' | '^';
      readonly left: MathExpression;
      readonly right: MathExpression;
    }
  | { readonly kind: 'sum'; readonly variable: string; readonly start: MathExpression; readonly end: MathExpression; readonly expression: MathExpression }
  | { readonly kind: 'sumArray'; readonly expression: MathExpression };

export type MathContext = Readonly<Record<string, unknown>>;

/**
 * A gauge as a formula reads it: written alone (`this.mana`) it is the **current** value, and its
 * other readings are named after it (`this.mana.max`, `this.mana.min`).
 */
export class GaugeReading {
  constructor(
    readonly current: number,
    readonly max: number,
    readonly min: number,
  ) {}
}

const asNumber = (value: unknown): unknown => (value instanceof GaugeReading ? value.current : value);

/**
 * The names a formula can start a path with because the *language* provides them
 * (`this.hp`, `count`, `roll.total`). Any other bare name in a formula is a
 * variable the author stored with "Store … as <Name>."
 */
export const MATH_ROOTS: readonly string[] = ['this', 'subject', 'subjects', 'sources', 'count', 'roll', 'votes', 'vote'];

type MathToken = { kind: 'number' | 'word' | 'operator' | 'eof'; text: string };

function tokenize(text: string): MathToken[] {
  const tokens: MathToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) { index += 1; continue; }
    if (/[0-9]/.test(char)) {
      const start = index;
      while (index < text.length && /[0-9.]/.test(text[index]!)) index += 1;
      tokens.push({ kind: 'number', text: text.slice(start, index) });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index]!)) index += 1;
      tokens.push({ kind: 'word', text: text.slice(start, index) });
      continue;
    }
    if ('+-*/^().[],=Σ∑'.includes(char)) {
      tokens.push({ kind: 'operator', text: char });
      index += 1;
      continue;
    }
    throw new Error(`unexpected character "${char}" in math expression`);
  }
  tokens.push({ kind: 'eof', text: '' });
  return tokens;
}

export function parseMathExpression(text: string): MathExpression {
  const parser = new MathParser(tokenize(text));
  const expression = parser.parseExpression();
  parser.expect('eof');
  return expression;
}

class MathParser {
  #index = 0;
  constructor(private readonly tokens: readonly MathToken[]) {}

  parseExpression(): MathExpression { return this.parseAdditive(); }

  private parseAdditive(): MathExpression {
    let left = this.parseMultiplicative();
    while (this.peek('+') || this.peek('-')) {
      const op = this.advance().text as '+' | '-';
      left = { kind: 'binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): MathExpression {
    let left = this.parsePower();
    while (this.peek('*') || this.peek('/')) {
      const op = this.advance().text as '*' | '/';
      left = { kind: 'binary', op, left, right: this.parsePower() };
    }
    return left;
  }

  private parsePower(): MathExpression {
    const left = this.parseUnary();
    if (this.peek('^')) return { kind: 'binary', op: '^', left, right: (this.advance(), this.parsePower()) };
    return left;
  }

  private parseUnary(): MathExpression {
    if (this.peek('+') || this.peek('-')) {
      const op = this.advance().text as '+' | '-';
      return { kind: 'unary', op, expression: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): MathExpression {
    const token = this.advance();
    if (token.kind === 'number') return { kind: 'number', value: Number(token.text) };
    if (token.kind === 'operator' && token.text === '(') {
      const expression = this.parseExpression();
      this.expect(')');
      return expression;
    }
    if (token.kind !== 'word' && !(token.kind === 'operator' && (token.text === 'Σ' || token.text === '∑'))) {
      throw new Error('expected a number, path, Σ(...), or parenthesized expression');
    }
    if ((token.text === 'Σ' || token.text === '∑') && this.peek('(')) {
      this.advance();
      const variable = this.advance();
      if (variable.kind === 'word' && this.peek('=')) {
        this.advance();
        const start = this.parseExpression();
        this.expectWord('to');
        const end = this.parseExpression();
        this.expect(',');
        const expression = this.parseExpression();
        this.expect(')');
        return { kind: 'sum', variable: variable.text, start, end, expression };
      }
      this.#rewind();
      const expression = this.parseExpression();
      this.expect(')');
      return { kind: 'sumArray', expression };
    }
    const parts: (string | number | { readonly kind: 'index'; readonly expression: MathExpression })[] = [token.text];
    while (this.peek('.') || this.peek('[')) {
      if (this.peek('.')) {
        this.advance();
        const property = this.advance();
        if (property.kind !== 'word') throw new Error('expected an object property after "."');
        parts.push(property.text);
      } else {
        this.advance();
        const index = this.parseExpression();
        parts.push({ kind: 'index', expression: index });
        this.expect(']');
      }
    }
    return { kind: 'path', parts };
  }

  private peek(text: string): boolean { return this.tokens[this.#index]!.text === text; }
  private advance(): MathToken { return this.tokens[this.#index++]!; }
  #rewind(): void { this.#index -= 1; }
  private expectWord(text: string): void {
    const token = this.advance();
    if (token.kind !== 'word' || token.text.toLowerCase() !== text) {
      throw new Error(`expected "${text}" but found "${token.text || 'end of expression'}"`);
    }
  }
  expect(text: string): void {
    const token = this.advance();
    if ((text === 'eof' && token.kind !== 'eof') || (text !== 'eof' && token.text !== text)) {
      throw new Error(`expected "${text}" but found "${token.text || 'end of expression'}"`);
    }
  }
}

function resolvePath(context: MathContext, parts: readonly (string | number | { readonly kind: 'index'; readonly expression: MathExpression })[], variables: MathContext = context): unknown {
  let value: unknown = context;
  for (const part of parts) {
    if (Array.isArray(value)) {
      if (part === 'length') {
        value = value.length;
        continue;
      }
      const index = typeof part === 'object' ? evaluateMathExpression(part.expression, variables) : part;
      value = typeof index === 'number' ? value[index] : value.map((item) => item && typeof item === 'object' ? (item as Record<string, unknown>)[String(index)] : undefined);
    } else if (value && typeof value === 'object') {
      value = (value as Record<string, unknown>)[String(part)];
    } else {
      return undefined;
    }
  }
  return value;
}

/**
 * Hooks into an evaluation. `step` is called once per node visited, which is how a
 * caller meters the work: a `Σ` over a billion terms visits a billion nodes.
 */
export interface EvaluateHooks {
  readonly step?: () => void;
}

export function evaluateMathExpression(
  expression: MathExpression,
  context: MathContext,
  hooks?: EvaluateHooks,
): number {
  hooks?.step?.();
  switch (expression.kind) {
    case 'number': return expression.value;
    case 'path': {
      const value = asNumber(resolvePath(context, expression.parts, context));
      if (typeof value !== 'number') throw new Error(`math path does not resolve to a number: ${expression.parts.join('.')}`);
      return value;
    }
    case 'unary': return expression.op === '-' ? -evaluateMathExpression(expression.expression, context, hooks) : evaluateMathExpression(expression.expression, context, hooks);
    case 'sumArray': {
      const value = expression.expression.kind === 'path' ? resolvePath(context, expression.expression.parts, context) : evaluateMathExpression(expression.expression, context, hooks);
      if (!Array.isArray(value)) throw new Error('Σ(...) expects an array or array property');
      return value.reduce((total: number, item) => total + (typeof asNumber(item) === 'number' ? (asNumber(item) as number) : 0), 0);
    }
    case 'sum': {
      const start = Math.ceil(evaluateMathExpression(expression.start, context, hooks));
      const end = Math.floor(evaluateMathExpression(expression.end, context, hooks));
      let total = 0;
      for (let index = start; index <= end; index += 1) {
        total += evaluateMathExpression(expression.expression, { ...context, [expression.variable]: index }, hooks);
      }
      return total;
    }
    case 'binary': {
      const left = evaluateMathExpression(expression.left, context, hooks);
      const right = evaluateMathExpression(expression.right, context, hooks);
      switch (expression.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '^': return left ** right;
      }
    }
  }
}

/**
 * A `MathExpression` as the plain Unicode text a creator would type —
 * `mathToLatex`'s counterpart for places that render into ordinary text
 * (a generated ability name, a diagnostic) rather than a math display.
 */
export function mathToSource(expression: MathExpression, parentPrecedence = 0): string {
  if (expression.kind === 'number') return String(expression.value);
  if (expression.kind === 'path') {
    return expression.parts
      .map((part, index) =>
        index === 0
          ? String(part)
          : typeof part === 'number'
            ? `[${part}]`
            : typeof part === 'object'
              ? `[${mathToSource(part.expression)}]`
              : `.${part}`,
      )
      .join('');
  }
  if (expression.kind === 'sumArray') return `Σ(${mathToSource(expression.expression)})`;
  if (expression.kind === 'sum') {
    return `Σ(${expression.variable} = ${mathToSource(expression.start)} to ${mathToSource(expression.end)}, ${mathToSource(expression.expression)})`;
  }
  if (expression.kind === 'unary') return `${expression.op}${mathToSource(expression.expression, 3)}`;
  const precedence =
    expression.op === '+' || expression.op === '-' ? 1 : expression.op === '*' || expression.op === '/' ? 2 : 3;
  const text = `${mathToSource(expression.left, precedence)} ${expression.op} ${mathToSource(expression.right, precedence)}`;
  return precedence < parentPrecedence ? `(${text})` : text;
}

export function mathToLatex(expression: MathExpression, parentPrecedence = 0): string {
  if (expression.kind === 'number') return String(expression.value);
  if (expression.kind === 'path') return expression.parts.map((part, index) => index === 0 ? String(part) : typeof part === 'number' ? `[${part}]` : typeof part === 'object' ? `[${mathToLatex(part.expression)}]` : `.${part}`).join('');
  if (expression.kind === 'sumArray') return `\\sum\\left(${mathToLatex(expression.expression)}\\right)`;
  if (expression.kind === 'sum') return `\\sum_{${expression.variable}=${mathToLatex(expression.start)}}^{${mathToLatex(expression.end)}} ${mathToLatex(expression.expression)}`;
  if (expression.kind === 'unary') return `${expression.op}${mathToLatex(expression.expression, 3)}`;
  const precedence =
    expression.op === '+' || expression.op === '-' ? 1 : expression.op === '*' || expression.op === '/' ? 2 : 3;
  const right = expression.op === '/' ? `\\frac{${mathToLatex(expression.left)}}{${mathToLatex(expression.right)}}` : `${mathToLatex(expression.left, precedence)} ${expression.op === '*' ? '\\cdot' : expression.op} ${mathToLatex(expression.right, precedence)}`;
  return precedence < parentPrecedence ? `\\left(${right}\\right)` : right;
}
