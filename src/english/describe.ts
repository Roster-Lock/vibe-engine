/**
 * **Describing** parsed content back to the player: a sentence as English,
 * a filter as English or as LaTeX.
 *
 * Separate from `compile.ts` because these read the **AST**, not the IR or
 * the engine — they are what the editor's preview pane and an ability's
 * generated `description` are built from, and `lower.ts` needs them without
 * depending on the compiler.
 */
import { EVENT_PHRASES } from './vocabulary.js';
import type {
  CharsPhrase,
  BooleanCondition,
  IfClause,
  ModifierSentence,
  RepeatClause,
  Sentence,
  TargetBinding,
  TriggerSentence,
} from './ast.js';
import { mathToLatex, mathToSource, type MathExpression } from '../ir/index.js';
import type { ManualAbility } from '../engine/index.js';

/** A number, or the plain-text form of a formula (`(this.hp / 2)`). */
function amountToString(value: MathExpression): string {
  return value.kind === 'number' ? String(value.value) : `(${mathToSource(value)})`;
}

/** Renders a character phrase the way the player typed it. */
export function charsToString(chars: CharsPhrase): string {
  const parts: string[] = [];
  switch (chars.quantifier) {
    case 'source':
      return `the source ${chars.sourceType ?? 'character'}`;
    case 'bound':
      return `the ${chars.name ?? '?'}`;
    case 'this':
      // Read back the way it was written: bare `this`, or `this character`.
      return chars.withClause ? `this with ${conditionToString(chars.withClause.expression)}` : chars.bare ? 'this' : 'this character';
    case 'target':
      parts.push('target');
      break;
    case 'all':
      parts.push('all');
      if (chars.other) parts.push('other');
      break;
  }
  if (chars.who) parts.push(chars.who === 'ally' ? 'ally' : 'enemy');
  parts.push(chars.quantifier === 'all' ? 'characters' : 'character');
  if (chars.owner) parts.push('owned by', chars.owner === 'you' ? 'you' : 'the opponent');
  const expression = chars.withClause?.expression;
  if (expression) parts.push('with', conditionToString(expression));
  return parts.join(' ');
}

function conditionToString(expression: BooleanCondition, parentPrecedence = 0): string {
  const precedence = expression.kind === 'or' ? 1 : expression.kind === 'and' ? 2 : expression.kind === 'not' ? 3 : 4;
  let text: string;
  if (expression.kind === 'and' || expression.kind === 'or') {
    const operator = expression.kind;
    text = `${conditionToString(expression.left, precedence)} ${operator} ${conditionToString(expression.right, precedence)}`;
  } else if (expression.kind === 'not') {
    text = `not ${conditionToString(expression.expression, precedence)}`;
  } else if (expression.kind === 'gauge') {
    text = `${expression.gauge} ${expression.op} ${amountToString(expression.value)}`;
  } else if (expression.kind === 'buff') {
    text = expression.buffName;
  } else {
    text = '';
  }
  return precedence < parentPrecedence ? `(${text})` : text;
}

/** Converts a boolean filter into a compact LaTeX formula for the editor. */
export function conditionToLatex(expression: BooleanCondition, parentPrecedence = 0): string {
  const precedence = expression.kind === 'or' ? 1 : expression.kind === 'and' ? 2 : expression.kind === 'not' ? 3 : 4;
  let text: string;
  if (expression.kind === 'and' || expression.kind === 'or') {
    const operator = expression.kind === 'and' ? '\\land' : '\\lor';
    text = `${conditionToLatex(expression.left, precedence)} ${operator} ${conditionToLatex(expression.right, precedence)}`;
  } else if (expression.kind === 'not') {
    text = `\\lnot ${conditionToLatex(expression.expression, precedence)}`;
  } else if (expression.kind === 'gauge') {
    text = `\\mathrm{${expression.gauge}} ${expression.op} ${mathToLatex(expression.value)}`;
  } else if (expression.kind === 'buff') {
    text = `\\mathrm{has\\ ${expression.buffName.replace(/[^A-Za-z0-9 ]/g, '')}}`;
  } else {
    text = '';
  }
  return precedence < parentPrecedence ? `\\left(${text}\\right)` : text;
}

/** A `Target …` sentence as English. */
export function targetsSummary(bindings: readonly TargetBinding[]): string {
  const parts = bindings.map((binding) => {
    const noun = charsToString({ ...binding.chars, quantifier: 'all' })
      .replace(/^all (other )?/, '$1')
      .replace(/\bcharacters\b/, binding.count === 1 ? 'character' : 'characters');
    return `${binding.count}${binding.distinct ? ' different' : ''} ${noun} as ${binding.name}`;
  });
  return `Target ${parts.join(' and ')}.`;
}

/** A modifier sentence as English. */
export function modifierSummary(modifier: ModifierSentence): string {
  const changeWord = modifier.gauge
    ? `${modifier.gauge} ${modifier.change === 'damage' ? 'loss' : 'gain'}`
    : modifier.change === 'damage'
      ? 'damage'
      : 'healing';
  const subject = `${modifier.direction ? `${modifier.direction} ` : ''}${changeWord}`;
  const targetPhrase = modifier.target
    ? ` from ${charsToString(modifier.target).replace(/^all (other )?/, '$1')}`
    : '';
  const frame =
    modifier.chance !== undefined ? `has a ${amountToString(modifier.chance)}% chance to be` : 'is';
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)}${targetPhrase} ${frame} ${rewriteWords(modifier.rewrite)}.`;
}

function rewriteWords(rewrite: ModifierSentence['rewrite']): string {
  switch (rewrite.kind) {
    case 'prevent':
      return 'prevented';
    case 'redirect':
      return `redirected to ${rewrite.gauge}`;
    case 'cap':
      return `capped at ${amountToString(rewrite.at)}`;
    case 'amount':
      if (rewrite.op === 'multiply') {
        if (rewrite.by.kind === 'number' && rewrite.by.value === 2) return 'doubled';
        if (rewrite.by.kind === 'number' && rewrite.by.value === 0.5) return 'halved';
        return `multiplied by ${amountToString(rewrite.by)}`;
      }
      return `${rewrite.op === 'add' ? 'increased' : 'reduced'} by ${amountToString(rewrite.by)}`;
  }
}

/** An `Available while …` clause as English. */
export function availableSummary(clause: IfClause): string {
  return guardSummary(clause).replace(/^If /, 'Available while ').replace(/, $/, '.');
}

/** An `If …,` clause as English. */
export function guardSummary(guard: IfClause): string {
  if (guard.kind === 'count') {
    return `If there are ${guard.count.text} ${charsToString({ ...guard.subject, quantifier: 'all' }).replace(/^all (other )?/, '$1')}, `;
  }
  const subject = charsToString(guard.subject);
  // `any`/`every` take a singular verb — "every enemy character has", not
  // "every enemy characters has".
  const who =
    guard.subject.quantifier === 'this'
      ? subject
      : `${guard.kind} ${subject.replace(/^all (other )?/, '$1').replace(/\bcharacters\b/, 'character')}`;
  return `If ${who} has ${conditionToString(guard.condition)}, `;
}

/** A one-line English summary of an effect sentence (preview pane). */
export function effectSummary(sentence: Sentence): string {
  let body = bareEffectSummary(sentence);
  if (sentence.optional) {
    body = `You may ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
  }
  if (sentence.guard) {
    body = `${guardSummary(sentence.guard)}${body.charAt(0).toLowerCase()}${body.slice(1)}`;
  }
  if (sentence.repeat) {
    body = `${repeatSummary(sentence.repeat)}${body.charAt(0).toLowerCase()}${body.slice(1)}`;
  }
  return body;
}

/** A `Repeat …:` clause as English. */
export function repeatSummary(repeat: RepeatClause): string {
  const parts = ['Repeat'];
  if (repeat.countText !== undefined) {
    parts.push(`${repeat.countText} time${repeat.countText === '1' ? '' : 's'}`);
  }
  if (repeat.condition) parts.push(guardSummary(repeat.condition).replace(/^If /, 'while ').replace(/, $/, ''));
  if (repeat.confirm) parts.push('if you choose');
  return `${parts.join(' ')}: `;
}

function bareEffectSummary(sentence: Sentence): string {
  switch (sentence.kind) {
    case 'deal':
      return `Deal ${amountToString(sentence.amount)} damage to ${charsToString(sentence.chars)}.`;
    case 'heal':
      return `Heal ${charsToString(sentence.chars)} for ${amountToString(sentence.amount)}.`;
    case 'destroy':
      return `Destroy ${charsToString(sentence.chars)}.`;
    case 'addBuff':
      return `Add ${sentence.buffName} to ${charsToString(sentence.chars)}.`;
    case 'removeBuff':
      return `Remove ${sentence.buffName} from ${charsToString(sentence.chars)}.`;
    case 'toggleBuff':
      return sentence.chars.quantifier === 'this' && sentence.chars.bare
        ? `Toggle ${sentence.buffName}.`
        : `Toggle ${sentence.buffName} on ${charsToString(sentence.chars)}.`;
    case 'result':
      return `${sentence.players === 'you' ? 'You' : 'All players'} ${sentence.win ? 'win' : 'lose'} the game.`;
  }
}

/** A short description of how the ability picks its target (preview pane). */
export function targetingSummary(ability: ManualAbility): string {
  if (ability.targeting.who === 'self') {
    return 'No target to pick — this character fires, and its "all …" phrases resolve by themselves.';
  }
  const side = ability.targeting.who === 'enemy' ? 'enemy' : ability.targeting.who === 'ally' ? 'ally' : 'character';
  return `The player picks 1 ${side} when the ability is used.`;
}

/**
 * A trigger as one English line — used for the ability's name, the editor
 * preview, and the log. Reads back what the author wrote rather than the
 * engine event it compiled to.
 */
export function triggerSummary(trigger: TriggerSentence): string {
  const isSelf = trigger.subject.quantifier === 'this';
  if (isSelf) {
    const effects = trigger.effects.map(effectSummary).join(' ');
    const body = effects.charAt(0).toLowerCase() + effects.slice(1);
    return `When ${charsToString(trigger.subject)} ${verbOf(trigger)}, ${body}`;
  }
  const count = trigger.count ? `${trigger.count.text} ` : trigger.mode === 'single' ? 'a ' : '';
  const subject = charsToString({ ...trigger.subject, quantifier: 'all' })
    .replace(/^all (other )?/, '$1')
    .replace(/\bcharacters\b/, trigger.mode === 'single' ? 'character' : 'characters');
  const effects = trigger.effects.map(effectSummary).join(' ');
  const body = effects.charAt(0).toLowerCase() + effects.slice(1);
  return `When ${count}${subject} ${verbOf(trigger)}, ${body}`;
}

/**
 * The event verb as written — plural for a batch, singular for one event.
 *
 * Read back out of the same table the parser matched against
 * (`EVENT_PHRASES`), so a new verb needs no second entry here.
 */
function verbOf(trigger: TriggerSentence): string {
  // A zone movement names its zone, not a table verb: "enters play from
  // active" / "leaves play". Plural for a batch, singular for one event.
  if (trigger.zone) {
    const verb = trigger.zone.verb === 'enters' ? (trigger.mode === 'single' ? 'enters' : 'enter') : trigger.mode === 'single' ? 'leaves' : 'leave';
    const preposition = trigger.zone.verb === 'enters' ? 'from' : 'to';
    return `${verb} ${trigger.zone.id}${trigger.zone.opposite !== undefined ? ` ${preposition} ${trigger.zone.opposite}` : ''}`;
  }
  // Compared by value, not identity: a gauge selector may be the object
  // `{ kind: 'life' }`, where `===` would only hold for the very same
  // instance the parser happened to copy.
  const sameGauge = (
    a: string | { readonly kind: 'life' } | undefined,
    b: string | { readonly kind: 'life' } | undefined,
  ): boolean => (typeof a === 'object' || typeof b === 'object' ? typeof a === typeof b : a === b);
  const phrase = EVENT_PHRASES.find(
    (candidate) =>
      (candidate.event === trigger.event || candidate.batchEvent === trigger.event) &&
      sameGauge(candidate.gauge, trigger.gauge) &&
      candidate.change === trigger.change,
  );
  // Each phrase lists its plural form first, its singular second.
  const words = phrase?.verbs[trigger.mode === 'single' ? 1 : 0] ?? phrase?.verbs[0];
  return words ? words.join(' ') : trigger.event;
}
