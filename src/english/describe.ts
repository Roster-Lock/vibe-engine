/**
 * **Describing** parsed content back to the player: a sentence as English,
 * a filter as English or as LaTeX.
 *
 * Separate from `compile.ts` because these read the **AST**, not the IR or
 * the engine — they are what the editor's preview pane and an ability's
 * generated `description` are built from, and `lower.ts` needs them without
 * depending on the compiler.
 */
import { REVEAL_CARD_TEXT, REVEAL_TEXT, castCardText, chooseText, moveCardText, moveCardsText, ownerWords, removeCountersText, castCardsText, playText, createText, revealCardsText, splitText, choosePileText, zoneAbilityText, drawText, scryText, moveChosenText, rollPhrase, rollText, storeText, votesPhrase, type RollStat } from './rounds.js';
import { MATH_ROOTS } from '../ir/math-expression.js';
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
/** `the total` etc. when an amount is exactly a roll's outcome (the path `roll.<stat>`). */
export function rollStatOfPath(value: MathExpression): RollStat | undefined {
  if (value.kind !== 'path' || value.parts.length !== 2 || value.parts[0] !== 'roll') return undefined;
  const stat = value.parts[1];
  return stat === 'total' || stat === 'highest' || stat === 'lowest' ? stat : undefined;
}

/** The option when an amount is exactly `votes for <Option>` (the path `votes.<Option>`). */
export function votesOptionOfPath(value: MathExpression): string | undefined {
  if (value.kind !== 'path' || value.parts.length !== 2 || value.parts[0] !== 'votes') return undefined;
  const option = value.parts[1];
  return typeof option === 'string' ? option : undefined;
}

/** `highest` / `lowest` when an amount is exactly `the highest vote` / `the lowest vote` (the path `vote.<stat>`). */
export function voteStatOfPath(value: MathExpression): 'highest' | 'lowest' | undefined {
  if (value.kind !== 'path' || value.parts.length !== 2 || value.parts[0] !== 'vote') return undefined;
  const stat = value.parts[1];
  return stat === 'highest' || stat === 'lowest' ? stat : undefined;
}

/** The name when an amount is exactly a stored variable: a bare word the language does not own. */
export function variableNameOfPath(value: MathExpression): string | undefined {
  if (value.kind !== 'path' || value.parts.length !== 1) return undefined;
  const name = value.parts[0];
  return typeof name === 'string' && !MATH_ROOTS.includes(name) ? name : undefined;
}

function amountToString(value: MathExpression): string {
  if (value.kind === 'number') return String(value.value);
  const stat = rollStatOfPath(value);
  if (stat) return rollPhrase(stat);
  const votes = votesOptionOfPath(value);
  if (votes !== undefined) return votesPhrase(votes);
  const voteStat = voteStatOfPath(value);
  if (voteStat !== undefined) return `the ${voteStat} vote`;
  return variableNameOfPath(value) ?? `(${mathToSource(value)})`;
}

/** Renders a character phrase the way the player typed it. */
export function charsToString(chars: CharsPhrase): string {
  const parts: string[] = [];
  switch (chars.quantifier) {
    case 'source':
      return 'the source';
    case 'it':
      return 'it';
    case 'bound':
      return `the ${chars.name ?? '?'}`;
    case 'this':
      return chars.withClause ? `this with ${conditionToString(chars.withClause.expression)}` : 'this';
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
  if (chars.owner) parts.push('owned by', ownerWords(chars.owner));
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
  if (guard.kind === 'value') {
    return `If ${guard.comparisons.map((c) => `${amountToString(c.value)} ${c.op} ${amountToString(c.other)}`).join(' and ')}, `;
  }
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
    case 'increaseMax':
      return `Increase ${sentence.gauge} maximum of ${charsToString(sentence.chars)} by ${amountToString(sentence.amount)}.`;
    case 'set':
      return `Set ${sentence.gauge} of ${charsToString(sentence.chars)} to ${amountToString(sentence.amount)}.`;
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
    case 'roll':
      return [
        rollText(sentence.count, sentence.sides),
        ...(sentence.table ?? []).map(
          (row) => `${row.text}: ${row.sentences.map(effectSummary).join(' ')}`,
        ),
      ].join(' ');
    case 'zoneAbility':
      return zoneAbilityText(sentence.owners, sentence.zone, sentence.ability, sentence.users, sentence.remove === true);
    case 'revealCard':
      return REVEAL_CARD_TEXT;
    case 'castCard':
      return castCardText(sentence.otherwise?.zone);
    case 'moveCard':
      return moveCardText(sentence.zone, sentence.article, sentence.counters);
    case 'create':
      return createText(sentence.players, sentence.creature);
    case 'play':
      return playText(sentence.players, sentence.contest);
    case 'removeCounters':
      return removeCountersText(sentence.count, sentence.counterKind, sentence.select, sentence.from);
    case 'castCards':
      return castCardsText(sentence.select, sentence.from, sentence.free);
    case 'moveCards':
      return moveCardsText(sentence.select, sentence.from, sentence.to, sentence.order, sentence.rest);
    case 'revealCards':
      return revealCardsText(sentence.select, sentence.from);
    case 'split':
      return splitText(sentence.chooser, sentence.from, sentence.into);
    case 'choosePile':
      return choosePileText(sentence.options);
    case 'store':
      return storeText(amountToString(sentence.value), sentence.name);
    case 'draw':
      return drawText(amountToString(sentence.count), sentence.players);
    case 'scry':
      return scryText(amountToString(sentence.count), sentence.players, sentence.surveil === true);
    case 'choose':
      return chooseText(
        sentence.players,
        sentence.pick.kind === 'card' ? { kind: 'card', zone: sentence.pick.zone } : sentence.pick,
        sentence.secret,
        sentence.order,
      );
    case 'reveal':
      return REVEAL_TEXT;
    case 'moveChosen':
      return moveChosenText(sentence.players, sentence.zone, sentence.committed);
    case 'result':
      return `${sentence.players === 'you' ? 'You' : 'All players'} ${sentence.win ? 'win' : 'lose'} the game.`;
  }
}

/** A short description of how the ability picks its target (preview pane). */
export function targetingSummary(ability: ManualAbility): string {
  if (ability.targeting.who === 'self') {
    return 'No target to pick — the user fires, and its "all …" phrases resolve by themselves.';
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
  // active" / "leaves play". One form, whether for a batch or one event.
  if (trigger.zone) {
    const verb = trigger.zone.verb;
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
