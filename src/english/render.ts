/**
 * **Rendering**: the Ability Language's IR → English text — the inverse of
 * `lower.ts`, and the half of the language that did not exist until now.
 *
 * ```
 *   text ──parse──► AST ──lower──► DocumentIR ──render (here)──► text
 * ```
 *
 * Why this exists (docs/design/18-english-and-blocks.md): the IR is the
 * document's canonical, shareable form, so an editor that holds an IR — one
 * imported from another player, one built by the block surface, or one
 * hand-written — needs to show it as the language the player reads. The same
 * direction is what the block view falls back on: after a block edit, the
 * English pane *is* `renderDocument(ir).text`.
 *
 * Three properties it holds to, each one a test:
 *
 * 1. **Total.** Every `DocumentIR` produces text; nothing throws.
 * 2. **Always parseable.** The output is valid English — a construct the
 *    sentence grammar cannot spell is emitted as a `#` note on its own line
 *    rather than as malformed prose, so invariant 1 holds even with gaps.
 * 3. **Faithful where it can be.** For anything the language can say, the
 *    text re-parses and re-lowers to the same canonical IR — the round trip
 *    `canonical(lower(parse(render(ir)))) === canonical(ir)`.
 *
 * Rendering **normalizes** rather than quoting: the IR has one `{kind:'self'}`
 * node, so bare `this` and `this character` render the same way. What it never
 * does is *drop* content: `RenderResult.gaps` names every node English had no
 * sentence for, and each one is marked in the text, so a lossy view is a
 * visible one.
 */
import type {
  AbilityIR,
  ActionMatchIR,
  ActionRewriteIR,
  BuffIR,
  DocumentIR,
  EffectIR,
  EntityQueryIR,
  ModifierIR,
  PredicateIR,
  StepIR,
  TargetBindingIR,
  TriggerIR,
  ValueIR,
} from '../ir/index.js';
import { mathToSource } from '../ir/math-expression.js';
import { EVENT_PHRASES } from './vocabulary.js';

/**
 * The prefix every placeholder line carries. A renderer that cannot spell a
 * construct says so in the document, where the author will see it — the
 * alternative (silently omitting it) makes a lossy view look complete.
 */
export const GAP_MARKER = '✗ not expressible in English: ';

/** One IR node the English sentence grammar has no frame for. */
export interface RenderGap {
  /** Why, in the language's own terms — also what the text says. */
  readonly reason: string;
  /** The node that could not be rendered, for the UI and for debugging. */
  readonly node: unknown;
}

export interface RenderResult {
  readonly text: string;
  /**
   * Empty for every document the language can express. Non-empty means the
   * text is a **lossy** view: `lower(parse(text))` will not equal the input,
   * because these nodes are commented out rather than written wrongly.
   */
  readonly gaps: readonly RenderGap[];
}

/** Lowercase the first letter, as a nested clause needs (`Deal` → `deal`). */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Whether a subtree refers to `the picked target` anywhere. */
function mentionsPicked(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(mentionsPicked);
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record.kind === 'picked') return true;
    return Object.values(record).some(mentionsPicked);
  }
  return false;
}

/** True for `{ kind: 'life' }` — the gauge `Deal`/`Heal`/`damage` mean. */
function isLifeGauge(gauge: string | { readonly kind: 'life' } | undefined): boolean {
  return typeof gauge === 'object' && gauge.kind === 'life';
}

interface CountPhrase {
  readonly text: string;
  readonly query: EntityQueryIR;
}

/**
 * One renderer run. Stateful only in `gaps`; the class exists so a render has
 * no module-level mutable state — two documents can be rendered concurrently
 * (a test, a preview and an import) without their gaps bleeding together.
 */
class Renderer {
  readonly gaps: RenderGap[] = [];

  /* ----------------------------- plumbing ------------------------------ */

  /**
   * Record that a node could not be rendered. Compositional helpers return
   * `undefined` after calling this, because a marker inside a formula would
   * be nonsense; the line-level assembler turns the failure into a `#` note.
   */
  #fail(reason: string, node: unknown): undefined {
    this.gaps.push({ reason, node });
    return undefined;
  }

  /** A failed line as a comment — the text stays parseable. */
  #note(reason: string): string {
    return `# ${GAP_MARKER}${reason}`;
  }

  /** Replace a `undefined` (already-recorded) line with its note. */
  #orNote(text: string | undefined): string {
    if (text !== undefined) return text;
    const last = this.gaps[this.gaps.length - 1];
    return this.#note(last ? last.reason : 'an unsupported construct');
  }

  /* ------------------------------- values ------------------------------ */

  /** A number, or the written formula in parentheses. */
  #value(value: ValueIR): string | undefined {
    if (value.kind === 'const') return String(value.value);
    if (value.kind === 'expr') return `(${mathToSource(value.expression)})`;
    if (value.kind === 'count') return this.#fail('an amount that counts characters (a block-view amount)', value);
    return this.#fail('an amount read from a gauge (a block-view amount)', value);
  }

  /* ----------------------------- predicates ---------------------------- */

  /** `hp < 10`, `poison and not thorns` — a `with …` condition. */
  #condition(predicate: PredicateIR, parentPrecedence = 0): string | undefined {
    const precedence = predicate.kind === 'or' ? 1 : predicate.kind === 'and' ? 2 : predicate.kind === 'not' ? 3 : 4;
    let text: string | undefined;
    switch (predicate.kind) {
      case 'compare': {
        // `with hp < 10` compares the entity in scope against a value.
        if (predicate.left.kind !== 'gauge' || predicate.left.of) {
          return this.#fail('a comparison between two computed values', predicate);
        }
        const right = this.#value(predicate.right);
        if (right === undefined) return undefined;
        text = `${predicate.left.gauge} ${predicate.op} ${right}`;
        break;
      }
      case 'hasBuff':
        text = predicate.buff;
        break;
      case 'and':
      case 'or': {
        const parts = predicate.clauses.map((clause) => this.#condition(clause, precedence));
        if (parts.some((part) => part === undefined)) return undefined;
        text = parts.join(` ${predicate.kind} `);
        break;
      }
      case 'not': {
        const inner = this.#condition(predicate.expression, precedence);
        if (inner === undefined) return undefined;
        text = `not ${inner}`;
        break;
      }
      default:
        return this.#fail(`a condition the sentence grammar has no phrase for (${predicate.kind})`, predicate);
    }
    return precedence < parentPrecedence ? `(${text})` : text;
  }

  /** The top-level conjuncts of a predicate — how a phrase's clauses split. */
  #conjuncts(predicate: PredicateIR | undefined): PredicateIR[] {
    if (!predicate) return [];
    if (predicate.kind === 'and') return predicate.clauses.flatMap((clause) => this.#conjuncts(clause));
    return [predicate];
  }

  #conjunction(clauses: readonly PredicateIR[]): PredicateIR | undefined {
    if (clauses.length === 0) return undefined;
    if (clauses.length === 1) return clauses[0];
    return { kind: 'and', clauses };
  }

  /** The leftover of a filter as a `with …` clause, when it can be one. */
  #withClause(rest: PredicateIR | undefined): string | undefined {
    if (!rest) return undefined;
    return this.#condition(rest);
  }

  /* ------------------------------- queries ----------------------------- */

  /** `all [other] [who] characters [owned by …] [with …]`. */
  #all(query: Extract<EntityQueryIR, { kind: 'all' }>, options: { singular?: boolean } = {}): string | undefined {
    const parts = ['all'];
    if (query.other) parts.push('other');
    if (query.who !== 'any') parts.push(query.who);
    parts.push(options.singular ? 'character' : 'characters');
    const rest: PredicateIR[] = [];
    for (const clause of this.#conjuncts(query.filter)) {
      if (clause.kind === 'relation' && (clause.to === 'you' || clause.to === 'opponent')) {
        parts.push('owned by', clause.to === 'you' ? 'you' : 'the opponent');
      } else if (clause.kind === 'relation' && (clause.to === 'ally' || clause.to === 'enemy')) {
        // `enemy` is already the phrase's adjective; a second spelling of it
        // would render as "all enemy characters enemy", so require agreement.
        if (query.who !== clause.to) return this.#fail('a group whose adjective and filter disagree', clause);
      } else if (clause.kind === 'relation') {
        return this.#fail('a group filtered on being the ability\'s own owner', clause);
      } else {
        rest.push(clause);
      }
    }
    const leftover = this.#conjunction(rest);
    const withText = this.#withClause(leftover);
    if (leftover && withText === undefined) return undefined;
    if (withText) parts.push('with', withText);
    return parts.join(' ');
  }

  /**
   * A noun phrase as English.
   *
   * `target …` is the one context-sensitive case: the pick's adjective and
   * filter live on the **ability's** targeting pattern, not on the query, so
   * the ability has to be in hand — the inverse of `lower.ts`'s
   * `lowerTargeting`, which is why the whole renderer threads it through.
   */
  #query(query: EntityQueryIR, ability: AbilityIR | undefined): string | undefined {
    switch (query.kind) {
      case 'self':
        // One spelling per frame: `this character` reads back as the same
        // node, and it is what keeps an ability's generated `description`
        // stable when a document is rendered.
        return 'this character';
      case 'picked': {
        if (!ability) return 'target character';
        const parts = ['target'];
        if (ability.targeting.who !== 'self' && ability.targeting.who !== 'any') parts.push(ability.targeting.who);
        parts.push('character');
        if (ability.targeting.filter) {
          const filter = this.#condition(ability.targeting.filter);
          if (filter === undefined) return undefined;
          parts.push('with', filter);
        }
        return parts.join(' ');
      }
      case 'bound':
        return `the ${query.name}`;
      case 'event':
        if (query.role === 'source') return `the source ${query.sourceType ?? 'character'}`;
        return this.#fail('an effect aimed at the triggering character itself', query);
      case 'all':
        return this.#all(query);
    }
  }

  /* ----------------------------- count gates --------------------------- */

  /** The query a count reads: the triggering set for a trigger, any query for an `if`. */
  #countQuery(value: ValueIR, subject: 'trigger' | 'if'): EntityQueryIR | undefined {
    if (value.kind !== 'count') return undefined;
    if (subject === 'trigger') {
      return value.query.kind === 'event' && value.query.role === 'subject' ? value.query : undefined;
    }
    return value.query;
  }

  /** One count clause — `2 or more`, `5 or less`, `an even number of`. */
  #countClause(predicate: PredicateIR, subject: 'trigger' | 'if'): CountPhrase | undefined {
    if (predicate.kind === 'parity') {
      const query = this.#countQuery(predicate.value, subject);
      if (!query) return undefined;
      return { text: `${predicate.parity === 'even' ? 'an even' : 'an odd'} number of`, query };
    }
    if (predicate.kind !== 'compare') return undefined;
    const query = this.#countQuery(predicate.left, subject);
    if (!query) return undefined;
    if (predicate.right.kind !== 'const') return undefined;
    const n = predicate.right.value;
    if (predicate.op === '>=') {
      // A trigger's "one or more" is the default, so `lower` omitted the gate
      // entirely; rendering it back would be a phrase the author never wrote.
      if (n <= 1 && subject === 'trigger') return undefined;
      return { text: `${n} or more`, query };
    }
    if (predicate.op === '<=') return { text: `${n} or less`, query };
    return undefined;
  }

  /** A gate's whole count phrase, joining a range's two halves into `2 to 5`. */
  #countPhrase(predicate: PredicateIR | undefined, subject: 'trigger' | 'if'): CountPhrase | undefined {
    if (!predicate) return undefined;
    if (predicate.kind !== 'and') return this.#countClause(predicate, subject);
    const parts = predicate.clauses.map((clause) => this.#countClause(clause, subject));
    if (parts.some((part) => part === undefined)) return undefined;
    const found = parts as CountPhrase[];
    const query = found[0]!.query;
    if (found.some((part) => JSON.stringify(part.query) !== JSON.stringify(query))) return undefined;
    const atLeast = found.find((part) => part.text.includes('or more'));
    const atMost = found.find((part) => part.text.includes('or less'));
    if (atLeast && atMost) {
      return {
        text: `${atLeast.text.replace(' or more', '')} to ${atMost.text.replace(' or less', '')}`,
        query,
      };
    }
    return found.length === 1 ? found[0] : undefined;
  }

  /** `If there are <count> <subject>, ` / `If any … has …, ` / `If this has …, `. */
  #guard(predicate: PredicateIR): string | undefined {
    const count = this.#countPhrase(predicate, 'if');
    if (count !== undefined) {
      const subject = this.#query(count.query, undefined);
      if (subject === undefined) return undefined;
      return `If there are ${count.text} ${subject.replace(/^all (other )?/, '$1')}, `;
    }
    if (predicate.kind === 'any' || predicate.kind === 'every') {
      const test = this.#condition(predicate.test);
      if (test === undefined) return undefined;
      if (predicate.query.kind === 'self') return `If this has ${test}, `;
      if (predicate.query.kind !== 'all') {
        return this.#fail('a guard whose subject is not a group', predicate.query);
      }
      const subject = this.#all(predicate.query, { singular: true });
      if (subject === undefined) return undefined;
      return `If ${predicate.kind} ${subject.replace(/^all (other )?/, '$1')} has ${test}, `;
    }
    return this.#fail('a condition the `if` frame cannot express', predicate);
  }

  /* ------------------------------ modifiers ---------------------------- */

  /** The far side of a modifier's match as a noun phrase (`from …`). */
  #modifierTarget(predicate: PredicateIR | undefined): string | undefined {
    if (!predicate) return undefined;
    const parts: string[] = [];
    const rest: PredicateIR[] = [];
    let who: string | undefined;
    let owner: string | undefined;
    for (const clause of this.#conjuncts(predicate)) {
      if (clause.kind === 'relation' && (clause.to === 'ally' || clause.to === 'enemy')) who = clause.to;
      else if (clause.kind === 'relation' && (clause.to === 'you' || clause.to === 'opponent')) owner = clause.to;
      else if (clause.kind === 'relation') return this.#fail('a modifier restricted to the owner', clause);
      else rest.push(clause);
    }
    if (who) parts.push(who);
    parts.push('characters');
    if (owner) parts.push('owned by', owner === 'you' ? 'you' : 'the opponent');
    const leftover = this.#conjunction(rest);
    const withText = this.#withClause(leftover);
    if (leftover && withText === undefined) return undefined;
    if (withText) parts.push('with', withText);
    return parts.join(' ');
  }

  #rewrite(rewrite: ActionRewriteIR): string | undefined {
    switch (rewrite.kind) {
      case 'prevent':
        return 'prevented';
      case 'redirect':
        return `redirected to ${rewrite.gauge}`;
      case 'cap': {
        const at = this.#value(rewrite.at);
        return at === undefined ? undefined : `capped at ${at}`;
      }
      case 'amount': {
        const by = this.#value(rewrite.by);
        if (by === undefined) return undefined;
        if (rewrite.op === 'multiply') {
          if (rewrite.by.kind === 'const' && rewrite.by.value === 2) return 'doubled';
          if (rewrite.by.kind === 'const' && rewrite.by.value === 0.5) return 'halved';
          return `multiplied by ${by}`;
        }
        return `${rewrite.op === 'add' ? 'increased' : 'reduced'} by ${by}`;
      }
    }
  }

  /** `Outgoing damage is increased by 5.` */
  #modifier(modifier: ModifierIR): string | undefined {
    const match: ActionMatchIR = modifier.match;
    if (!match.change) return this.#fail('a modifier that matches any gauge change', match);
    const changeWord =
      match.gauge === undefined || isLifeGauge(match.gauge)
        ? match.change === 'damage'
          ? 'damage'
          : 'healing'
        : `${match.gauge} ${match.change === 'damage' ? 'loss' : 'gain'}`;
    const subject = `${match.direction ? `${match.direction} ` : ''}${changeWord}`;
    const targetText = this.#modifierTarget(match.target);
    if (match.target && targetText === undefined) return undefined;
    const targetPhrase = targetText ? ` from ${targetText.replace(/^all (other )?/, '$1')}` : '';
    const rewrite = this.#rewrite(modifier.rewrite);
    if (rewrite === undefined) return undefined;
    let frame = 'is';
    if (modifier.chance) {
      const chance = this.#value(modifier.chance);
      if (chance === undefined) return undefined;
      frame = `has a ${chance}% chance to be`;
    }
    const sentence = `${subject.charAt(0).toUpperCase()}${subject.slice(1)}${targetPhrase} ${frame} ${rewrite}.`;
    return sentence;
  }

  /* ------------------------------- effects ----------------------------- */

  /** The verb of a sentence plus the noun it acts on. */
  #effect(effect: EffectIR, ability: AbilityIR | undefined): string | undefined {
    switch (effect.kind) {
      case 'gauge': {
        const chars = this.#query(effect.query, ability);
        if (chars === undefined) return undefined;
        const amount = this.#value(effect.amount);
        if (amount === undefined) return undefined;
        if (!isLifeGauge(effect.gauge)) {
          return this.#fail('damage moved on a named gauge (a block-view effect)', effect);
        }
        if (effect.op === 'subtract') return `Deal ${amount} damage to ${chars}.`;
        if (effect.op === 'add') return `Heal ${chars} for ${amount}.`;
        return this.#fail('a gauge set to a value (a block-view effect)', effect);
      }
      case 'destroy': {
        const chars = this.#query(effect.query, ability);
        return chars === undefined ? undefined : `Destroy ${chars}.`;
      }
      case 'addBuff': {
        const chars = this.#query(effect.query, ability);
        return chars === undefined ? undefined : `Add ${effect.buff} to ${chars}.`;
      }
      case 'removeBuff': {
        const chars = this.#query(effect.query, ability);
        return chars === undefined ? undefined : `Remove ${effect.buff} from ${chars}.`;
      }
      case 'toggleBuff': {
        // The bare `Toggle X.` form is the one the language writes when no
        // noun was given, and it reads back to the same `self` query.
        if (effect.query.kind === 'self') return `Toggle ${effect.buff}.`;
        const chars = this.#query(effect.query, ability);
        return chars === undefined ? undefined : `Toggle ${effect.buff} on ${chars}.`;
      }
      case 'result':
        return `${effect.players === 'you' ? 'You' : 'All players'} ${effect.win ? 'win' : 'lose'} the game.`;
    }
  }

  /* -------------------------------- steps ------------------------------ */

  /** `Repeat up to 3 times while … if you choose: ` — the clause as written. */
  #repeatPrefix(step: StepIR): string | undefined {
    const repeat = step.repeat;
    if (!repeat) return undefined;
    const parts = ['Repeat'];
    const min = repeat.min ?? 0;
    const max = repeat.max;
    let countText: string | undefined;
    if (max === undefined) countText = min > 0 ? `${min} or more` : undefined;
    else if (min === 0) countText = `up to ${max}`;
    else if (min === max) countText = String(min);
    else countText = `${min} to ${max}`;
    if (countText !== undefined) parts.push(`${countText} time${countText === '1' ? '' : 's'}`);
    if (repeat.while) {
      const condition = this.#guard(repeat.while);
      if (condition === undefined) return undefined;
      parts.push(condition.replace(/^If /, 'while ').replace(/, $/, ''));
    }
    if (repeat.confirm) parts.push('if you choose');
    return `${parts.join(' ')}: `;
  }

  /**
   * One step as one English sentence.
   *
   * Clause order is `describe.ts`'s, and it is the order the parser accepts:
   * `Repeat …, If …, you may <effect>.`
   */
  #sentence(step: StepIR, effect: EffectIR, ability: AbilityIR | undefined): string | undefined {
    let body = this.#effect(effect, ability);
    if (body === undefined) return undefined;
    if (step.optional) body = `You may ${lowerFirst(body)}`;
    if (step.when) {
      const guard = this.#guard(step.when);
      if (guard === undefined) return undefined;
      body = `${guard}${lowerFirst(body)}`;
    }
    const repeat = this.#repeatPrefix(step);
    if (step.repeat) {
      if (repeat === undefined) return undefined;
      body = `${repeat}${lowerFirst(body)}`;
    }
    return body;
  }

  /**
   * A step's sentences.
   *
   * The asymmetry is the IR's, not a shortcut: **an ability's step is one
   * sentence** (steps resolve one at a time with effects landing between
   * them, so splitting one would change what happens), while **a buff body
   * groups its sentences** into one per event and resolves them together, so
   * that grouping is re-derived rather than written.
   */
  #stepLines(step: StepIR, ability: AbilityIR | undefined, allowMultiple: boolean): string[] {
    const gated = step.optional === true || step.when !== undefined || step.repeat !== undefined;
    if (step.effects.length > 1 && (!allowMultiple || gated)) {
      return [this.#note(this.#gapReason('a step holding several effects at once', step))];
    }
    const lines: string[] = [];
    for (const effect of step.effects) {
      lines.push(this.#orNote(this.#sentence(step, effect, ability)));
    }
    return lines;
  }

  #gapReason(reason: string, node: unknown): string {
    this.gaps.push({ reason, node });
    return reason;
  }

  /* ------------------------------- triggers ---------------------------- */

  /** The verb phrase as written, out of the same table the parser matched. */
  #verb(trigger: TriggerIR): string | undefined {
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
    const words = phrase?.verbs[trigger.mode === 'single' ? 1 : 0];
    if (!words) {
      return this.#fail(
        `an event the sentence grammar has no verb for (${trigger.event})`,
        { event: trigger.event, gauge: trigger.gauge, change: trigger.change },
      );
    }
    return words.join(' ');
  }

  /** `this`, `enemy characters`, `a character`, `2 or more enemy characters`. */
  #triggerSubject(trigger: TriggerIR, countText: string | undefined): string | undefined {
    let self = false;
    let who: string | undefined;
    let owner: string | undefined;
    const rest: PredicateIR[] = [];
    for (const clause of this.#conjuncts(trigger.filter)) {
      if (clause.kind === 'relation' && clause.to === 'self') self = true;
      else if (clause.kind === 'relation' && (clause.to === 'ally' || clause.to === 'enemy')) who = clause.to;
      else if (clause.kind === 'relation' && (clause.to === 'you' || clause.to === 'opponent')) owner = clause.to;
      else if (clause.kind === 'relation') return this.#fail('a trigger filter with no phrase', clause);
      else rest.push(clause);
    }
    if (self) {
      if (countText || who || owner || rest.length > 0) {
        return this.#fail('a count or filter on "this" as a trigger subject', trigger.filter);
      }
      return 'this';
    }
    const parts: string[] = [];
    if (countText) parts.push(countText);
    const adjective = who ? `${who} ` : '';
    if (trigger.mode === 'single') {
      parts.push(`${/^[aeiou]/.test(adjective) ? 'an' : 'a'} ${adjective}character`);
    } else {
      if (who) parts.push(who);
      parts.push('characters');
    }
    if (owner) parts.push('owned by', owner === 'you' ? 'you' : 'the opponent');
    const leftover = this.#conjunction(rest);
    const withText = this.#withClause(leftover);
    if (leftover && withText === undefined) return undefined;
    if (withText) parts.push('with', withText);
    return parts.join(' ');
  }

  /** `when <count>? <subject> <verb> then <effect>.` */
  #trigger(trigger: TriggerIR, ability: AbilityIR | undefined): string | undefined {
    const verb = this.#verb(trigger);
    if (verb === undefined) return undefined;
    const count = this.#countPhrase(trigger.when, 'trigger');
    if (trigger.when && count === undefined) {
      return this.#fail('a trigger gate that is not a count phrase', trigger.when);
    }
    const subject = this.#triggerSubject(trigger, count?.text);
    if (subject === undefined) return undefined;
    const bodies: string[] = [];
    for (const step of trigger.steps) {
      bodies.push(...this.#stepLines(step, ability, false));
    }
    if (bodies.length !== 1) {
      return this.#fail('a trigger whose body is not one sentence', trigger);
    }
    return `when ${subject} ${verb} then ${lowerFirst(bodies[0]!)}`;
  }

  /* ------------------------------- sections ---------------------------- */

  #binding(binding: TargetBindingIR): string | undefined {
    const parts = [`${binding.count}${binding.distinct ? ' different' : ''}`];
    const adjective = binding.who !== 'self' && binding.who !== 'any' ? `${binding.who} ` : '';
    parts.push(`${adjective}character${binding.count === 1 ? '' : 's'}`);
    if (binding.filter) {
      const filter = this.#condition(binding.filter);
      if (filter === undefined) return undefined;
      parts.push('with', filter);
    }
    parts.push('as', binding.name);
    return parts.join(' ');
  }

  #abilityLines(ability: AbilityIR): string[] {
    const lines = [`Ability ${ability.name}`];
    if (ability.targets && ability.targets.length > 0) {
      const bindings = ability.targets.map((binding) => this.#binding(binding));
      lines.push(this.#orNote(bindings.every((text) => text !== undefined) ? `Target ${bindings.join(' and ')}.` : undefined));
    }
    if (ability.available) {
      const guard = this.#guard(ability.available);
      lines.push(this.#orNote(guard === undefined ? undefined : guard.replace(/^If /, 'Available while ').replace(/, $/, '.')));
    }
    // A targeting pattern is only ever *implied* by a `target …` phrase inside
    // a sentence, and only ever with a count of one pick. A pattern with no
    // sentence to carry it — or a range — has no English form, so it is a gap
    // rather than a silent loss (the sentence surface would re-lower to
    // `{ who: 'self', count: 1 }`).
    const count = ability.targeting.count;
    const single = Array.isArray(count) ? count[0] === 1 && count[1] === 1 : count === 1;
    if (!single) {
      lines.push(this.#note(this.#gapReason('an ability that picks a range of targets (a block-view targeting pattern)', ability.targeting)));
    } else if ((ability.targeting.who !== 'self' || ability.targeting.filter) && !mentionsPicked(ability.steps)) {
      lines.push(this.#note(this.#gapReason('a targeting pattern no sentence refers to (a block-view targeting pattern)', ability.targeting)));
    }
    for (const step of ability.steps) {
      lines.push(...this.#stepLines(step, ability, false));
    }
    return lines;
  }

  #buffLines(buff: BuffIR): string[] {
    const options: string[] = [];
    if (buff.stacks) options.push('stacks');
    if (buff.weight !== 1) options.push(`weight ${buff.weight}`);
    if (buff.duration) {
      options.push(buff.duration.kind === 'endOfTurn' ? 'until end of turn' : `for ${buff.duration.count} turns`);
    }
    const lines = [`Buff ${buff.name}${options.length > 0 ? ` (${options.join(', ')})` : ''}`];
    for (const trigger of buff.triggers) {
      // A payload sentence is a buff trigger on the default event with no
      // gate — the inverse of `lower.ts`'s `DEFAULT_BUFF_EVENT`.
      const payload =
        trigger.event === 'turn:start' &&
        trigger.mode === 'single' &&
        trigger.when === undefined &&
        trigger.filter === undefined;
      if (payload) {
        for (const step of trigger.steps) lines.push(...this.#stepLines(step, undefined, true));
        continue;
      }
      lines.push(this.#orNote(this.#trigger(trigger, undefined)));
    }
    for (const modifier of buff.modifiers ?? []) {
      lines.push(this.#orNote(this.#modifier(modifier)));
    }
    return lines;
  }

  /* ------------------------------ documents ---------------------------- */

  document(ir: DocumentIR): RenderResult {
    const blocks: string[][] = [];
    if (ir.imports.length > 0) {
      blocks.push(ir.imports.map((entry) => `import ${entry.name} from "${entry.path}"`));
    }
    for (const ability of ir.abilities) blocks.push(this.#abilityLines(ability));
    for (const buff of ir.buffs) blocks.push(this.#buffLines(buff));
    if (ir.triggers.length > 0) {
      blocks.push(ir.triggers.map((trigger) => this.#orNote(this.#trigger(trigger, undefined))));
    }
    const text = blocks.map((lines) => `${lines.join('\n')}\n`).join('\n');
    return { text, gaps: this.gaps };
  }
}

/**
 * Renders a document IR back to Ability Language text.
 *
 * Total and always parseable: check `gaps` to learn whether the text is a
 * faithful view (empty) or a lossy one (each gap is marked in the text).
 */
export function renderDocument(ir: DocumentIR): RenderResult {
  return new Renderer().document(ir);
}
