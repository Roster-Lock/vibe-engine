/**
 * **Lowering**: the Ability Language's AST → the IR (`src/ir/ability.ts`).
 *
 * This is the step that used to not exist — `compile.ts` went straight from
 * AST to engine closures, which made a document unshareable and
 * uninspectable (docs/GOAL.md, "the language and the share format are the
 * same problem"). Now the pipeline is:
 *
 * ```
 *   text ──parse──► AST ──lower (here)──► DocumentIR ──bind──► engine content
 *         span-accurate,    plain JSON,        src/ir/bind
 *         editor-facing     shareable
 * ```
 *
 * Lowering is **pure and total**: it imports no engine and reports no
 * diagnostics. Anything that can fail — an unknown buff name, two
 * conflicting `target …` sentences — is the checker's job in `compile.ts`,
 * which runs first. A reference that did not resolve still lowers (to its
 * written name); the binder treats it as a no-op.
 */
import type {
  AbilitySection,
  BooleanCondition,
  BuffSection,
  CharsPhrase,
  CountPhrase,
  Doc,
  IfClause,
  ModifierSentence,
  Sentence,
  TargetBinding,
  TriggerSentence,
  ZoneSection,
} from './ast.js';
import {
  rollStatOfPath,
  variableNameOfPath,
  votesOptionOfPath,
  voteStatOfPath,
  availableSummary,
  effectSummary,
  modifierSummary,
  targetsSummary,
  triggerSummary,
} from './describe.js';
import { slug } from './dictionary.js';
import type {
  AbilityIR,
  BuffIR,
  DocumentIR,
  EffectIR,
  EntityQueryIR,
  MathExpression,
  ModifierIR,
  PredicateIR,
  StepIR,
  TargetBindingIR,
  TargetingIR,
  TriggerIR,
  ValueIR,
  ZoneSectionIR,
} from '../ir/index.js';
import { IR_VERSION } from '../ir/index.js';

/**
 * The gauge a bare `Deal … damage` / `Heal …` sentence moves: the
 * target's own declared life gauge, never a hard-coded `'hp'` — the same
 * selector a `damage`/`healing` modifier subject lowers to, so the word
 * means one thing throughout the language. See `ActionMatchIR.gauge`.
 */
const LIFE_GAUGE = { kind: 'life' } as const;

/**
 * The one name a choice round has in English: "the card they chose" always
 * means the most recent `choose`, so the text needs no names and the IR can use
 * a constant (a later `choose` simply replaces the round).
 */
const ROUND = 'choice';

/** A literal number lowers to a flat `const`; anything richer keeps its formula. */
function amount(value: MathExpression): ValueIR {
  if (value.kind === 'number') return { kind: 'const', value: value.value };
  // "the total" / "the highest die" is a roll's outcome, not a formula.
  const stat = rollStatOfPath(value);
  if (stat) return { kind: 'rolled', stat };
  // A bare word the language does not own is a value stored earlier.
  const votes = votesOptionOfPath(value);
  if (votes !== undefined) return { kind: 'votes', option: votes };
  const voteStat = voteStatOfPath(value);
  if (voteStat !== undefined) return { kind: 'voteStat', stat: voteStat };
  const variable = variableNameOfPath(value);
  return variable !== undefined ? { kind: 'variable', name: variable } : { kind: 'expr', expression: value };
}

/* ------------------------------- filters ------------------------------ */

function lowerCondition(condition: BooleanCondition): PredicateIR {
  switch (condition.kind) {
    case 'gauge':
      // `with hp < 10` is an ordinary comparison: the left side reads the
      // candidate's gauge (no `of` — the entity in scope), the right side
      // is the written number.
      return {
        kind: 'compare',
        op: condition.op,
        left: { kind: 'gauge', gauge: condition.gauge },
        right: amount(condition.value),
      };
    case 'buff':
      return { kind: 'hasBuff', buff: condition.buffName };
    case 'and':
    case 'or':
      return {
        kind: condition.kind,
        clauses: [lowerCondition(condition.left), lowerCondition(condition.right)],
      };
    case 'not':
      return { kind: 'not', expression: lowerCondition(condition.expression) };
  }
}

/**
 * A phrase's filter: its ownership clause and its `with …` expression,
 * combined with `and`.
 *
 * `owned by you` becomes a `relation` node rather than being folded into
 * the comparison vocabulary, because it is a fact about the entity's
 * relationship to the ability's owner, not a property of the entity.
 */
function lowerFilter(chars: CharsPhrase): PredicateIR | undefined {
  const clauses: PredicateIR[] = [];
  if (chars.owner) clauses.push({ kind: 'relation', to: chars.owner });
  const expression = chars.withClause?.expression;
  if (expression) clauses.push(lowerCondition(expression));
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0]!;
  return { kind: 'and', clauses };
}

/* ------------------------------- queries ------------------------------ */

function lowerChars(chars: CharsPhrase): EntityQueryIR {
  switch (chars.quantifier) {
    case 'this':
      return { kind: 'self' };
    case 'target':
      return { kind: 'picked' };
    case 'source':
      return {
        kind: 'event',
        role: 'source',
        // The language names only the character that caused the event.
        sourceType: 'character',
      };
    case 'it':
      return { kind: 'event', role: 'subject' };
    case 'bound':
      return { kind: 'bound', name: chars.name ?? '' };
    case 'all': {
      const filter = lowerFilter(chars);
      return {
        kind: 'all',
        who: chars.who ?? 'any',
        other: chars.other,
        ...(filter ? { filter } : {}),
      };
    }
  }
}

/* ----------------------------- modifiers ------------------------------ */

function lowerModifier(sentence: ModifierSentence, buff: string, index: number): ModifierIR {
  const targetFilter = sentence.target ? lowerTriggerFilter(sentence.target) : undefined;
  return {
    id: `${slug(buff)}-modifier-${index}`,
    name: `${buff} ${modifierSummary(sentence).replace(/\.$/, '')}`,
    match: {
      ...(sentence.direction ? { direction: sentence.direction } : {}),
      change: sentence.change,
      // A named gauge claims that gauge; bare `damage`/`healing` claim the
      // target's own life gauge, never a hard-coded `'hp'` — see
      // `ActionMatchIR.gauge`.
      gauge: sentence.gauge ?? { kind: 'life' },
      ...(targetFilter ? { target: targetFilter } : {}),
    },
    rewrite:
      sentence.rewrite.kind === 'prevent'
        ? { kind: 'prevent' }
        : sentence.rewrite.kind === 'redirect'
          ? { kind: 'redirect', gauge: sentence.rewrite.gauge }
          : sentence.rewrite.kind === 'cap'
            ? { kind: 'cap', at: amount(sentence.rewrite.at) }
            : { kind: 'amount', op: sentence.rewrite.op, by: amount(sentence.rewrite.by) },
    ...(sentence.chance !== undefined ? { chance: amount(sentence.chance) } : {}),
  };
}

/* ------------------------------- guards ------------------------------- */

/**
 * An `If …,` clause as the step's gate.
 *
 * `there are <count>` becomes a comparison on `count(query)`; `any`/`every`
 * become the predicate nodes of the same name, which re-enter with each
 * match in scope so the condition reads per entity. `this` is one thing, so
 * `any` over it *is* the condition on it.
 */
function lowerGuard(clause: IfClause): PredicateIR {
  if (clause.kind === 'value') return lowerValueGuard(clause);
  const query = lowerChars(clause.subject);
  if (clause.kind === 'count') {
    // An `if` has no "the batch already fired" floor, so even a bare
    // "1 or more" is a real check: at least one must exist.
    const size: ValueIR = { kind: 'count', query };
    return (
      countGate(clause.count, size) ?? {
        kind: 'compare',
        op: '>=',
        left: size,
        right: amount({ kind: 'number', value: 1 }),
      }
    );
  }
  return { kind: clause.kind, query, test: lowerCondition(clause.condition) };
}

/** A list of sentences as steps — what an ability's body lowers to. */
export function lowerSteps(sentences: readonly Sentence[]): StepIR[] {
  return sentences.map(lowerStep);
}

/**
 * `<value> <op> <value> [and …]` as a predicate: each comparison is a `compare`
 * with its operator as written, and several are an `and`.
 */
function lowerValueGuard(clause: Extract<IfClause, { kind: 'value' }>): PredicateIR {
  const clauses: PredicateIR[] = clause.comparisons.map((comparison) => ({
    kind: 'compare',
    op: comparison.op,
    left: amount(comparison.value),
    right: amount(comparison.other),
  }));
  return clauses.length === 1 ? clauses[0]! : { kind: 'and', clauses };
}

/** One sentence as a step, with its `If …,` clause as the step's gate. */
function lowerStep(sentence: Sentence): StepIR {
  return {
    effects: lowerEffects(sentence),
    ...(sentence.guard ? { when: lowerGuard(sentence.guard) } : {}),
    ...(sentence.optional ? { optional: true } : {}),
    ...(sentence.repeat
      ? {
          repeat: {
            ...(sentence.repeat.condition ? { while: lowerGuard(sentence.repeat.condition) } : {}),
            ...(sentence.repeat.confirm ? { confirm: true } : {}),
            ...(sentence.repeat.min > 0 ? { min: sentence.repeat.min } : {}),
            ...(sentence.repeat.max !== undefined ? { max: sentence.repeat.max } : {}),
          },
        }
      : {}),
  };
}

/* ------------------------------ triggers ------------------------------ */

/**
 * A trigger's filter: which of the batch's events count.
 *
 * Unlike a group query's filter, the adjective (`enemy`/`ally`) has to be
 * part of it — a group turns `who` into an engine targeting pattern, but a
 * trigger has no pattern, so "enemy" becomes a `relation` predicate over
 * each triggering character.
 */
function lowerTriggerFilter(subject: CharsPhrase): PredicateIR | undefined {
  const clauses: PredicateIR[] = [];
  // "when this character dies" — the triggering character must *be* the
  // ability's owner.
  if (subject.quantifier === 'this') clauses.push({ kind: 'relation', to: 'self' });
  if (subject.who) clauses.push({ kind: 'relation', to: subject.who });
  const rest = lowerFilter(subject);
  if (rest) clauses.push(rest);
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0]!;
  return { kind: 'and', clauses };
}

/**
 * The count phrase as the trigger's gate.
 *
 * Omitted when it is the default "at least one": the binder already
 * refuses a trigger whose filtered set is empty, so `one or more` needs no
 * predicate. Anything else compares `count(the triggering set)`.
 */
function lowerCount(trigger: TriggerSentence): PredicateIR | undefined {
  const count = trigger.count;
  if (!count) return undefined;
  return countGate(count, { kind: 'count', query: { kind: 'event', role: 'subject' } });
}

/**
 * A count phrase as a predicate over some size.
 *
 * `1 or more` needs none: a batch event only fires when the batch held at
 * least one, and the binder already refuses an empty filtered set.
 */
function countGate(count: CountPhrase, size: ValueIR): PredicateIR | undefined {
  if (count.kind === 'parity') return { kind: 'parity', value: size, parity: count.parity };
  if (count.min <= 1 && count.max === null) return undefined;
  const clauses: PredicateIR[] = [];
  if (count.min > 1) {
    clauses.push({ kind: 'compare', op: '>=', left: size, right: amount({ kind: 'number', value: count.min }) });
  }
  if (count.max !== null) {
    clauses.push({ kind: 'compare', op: '<=', left: size, right: amount({ kind: 'number', value: count.max }) });
  }
  if (clauses.length === 1) return clauses[0]!;
  return { kind: 'and', clauses };
}

function lowerTrigger(trigger: TriggerSentence, scope: 'self' | 'game', index: number): TriggerIR {
  const name = triggerSummary(trigger);
  const gate = lowerCount(trigger);
  const filter = lowerTriggerFilter(trigger.subject);
  return {
    id: `${slug(trigger.event)}-${index}`,
    name,
    scope,
    event: trigger.event,
    mode: trigger.mode,
    ...(trigger.gauge !== undefined ? { gauge: trigger.gauge } : {}),
    ...(trigger.change !== undefined ? { change: trigger.change } : {}),
    ...(trigger.zone
      ? {
          zone: {
            verb: trigger.zone.verb,
            id: trigger.zone.id,
            ...(trigger.zone.opposite !== undefined ? { opposite: trigger.zone.opposite } : {}),
          },
        }
      : {}),
    ...(gate ? { when: gate } : {}),
    ...(filter ? { filter } : {}),
    steps: trigger.effects.map(lowerStep),
  };
}

/* ------------------------------- effects ------------------------------ */

/**
 * A sentence's effects. Almost always one; a **roll with result lines** is two in
 * the same step — the roll, then the table that reads it once — so the lines are
 * governed by the roll's own `If` / `You may`, and nothing runs between them.
 */
function lowerEffects(sentence: Sentence): EffectIR[] {
  const effect = lowerSentence(sentence);
  if (sentence.kind !== 'roll' || !sentence.table) return [effect];
  return [
    effect,
    {
      kind: 'table',
      // The total of the dice just rolled — for a single die, the die.
      on: { kind: 'rolled', stat: 'total' },
      rows: sentence.table.map((row) => ({
        min: row.min,
        max: row.max,
        ...(row.otherwise ? { otherwise: true } : {}),
        steps: row.sentences.map(lowerStep),
      })),
    },
  ];
}

function lowerSentence(sentence: Sentence): EffectIR {
  switch (sentence.kind) {
    case 'deal':
      return {
        kind: 'gauge',
        query: lowerChars(sentence.chars),
        gauge: LIFE_GAUGE,
        op: 'subtract',
        amount: amount(sentence.amount),
      };
    case 'heal':
      return {
        kind: 'gauge',
        query: lowerChars(sentence.chars),
        gauge: LIFE_GAUGE,
        op: 'add',
        amount: amount(sentence.amount),
      };
    case 'increaseMax':
      return {
        kind: 'gaugeMax',
        query: lowerChars(sentence.chars),
        gauge: sentence.gauge,
        amount: amount(sentence.amount),
      };
    case 'set':
      return {
        kind: 'gauge',
        query: lowerChars(sentence.chars),
        gauge: sentence.gauge,
        op: 'set',
        amount: amount(sentence.amount),
      };
    case 'destroy':
      return { kind: 'destroy', query: lowerChars(sentence.chars) };
    case 'addBuff':
      return { kind: 'addBuff', query: lowerChars(sentence.chars), buff: sentence.buffName };
    case 'removeBuff':
      return { kind: 'removeBuff', query: lowerChars(sentence.chars), buff: sentence.buffName };
    case 'toggleBuff':
      return { kind: 'toggleBuff', query: lowerChars(sentence.chars), buff: sentence.buffName };
    case 'roll':
      return { kind: 'roll', count: amount({ kind: 'number', value: sentence.count }), sides: amount({ kind: 'number', value: sentence.sides }) };
    case 'zoneAbility':
      return {
        kind: 'zoneAbility',
        zone: sentence.zone,
        owners: sentence.owners,
        // The ability's id: the same slug an ability section's id is made from.
        ability: slug(sentence.ability) || 'ability',
        users: sentence.users,
        ...(sentence.remove ? { remove: true as const } : {}),
      };
    case 'revealCard':
      return { kind: 'revealCard' };
    case 'castCard':
      return { kind: 'castCard', ...(sentence.otherwise ? { otherwise: sentence.otherwise.zone } : {}) };
    case 'moveCard':
      return {
        kind: 'moveCard',
        to: sentence.zone,
        ...(sentence.article ? { article: sentence.article } : {}),
        ...(sentence.counters ? { counters: sentence.counters } : {}),
      };
    case 'create':
      return { kind: 'create', players: sentence.players, creature: sentence.creature };
    case 'play':
      return { kind: 'play', players: sentence.players, contest: sentence.contest };
    case 'removeCounters':
      return {
        kind: 'removeCounters',
        count: sentence.count,
        ...(sentence.counterKind ? { counterKind: sentence.counterKind } : {}),
        select: sentence.select,
        from: sentence.from,
      };
    case 'castCards':
      return { kind: 'castCards', select: sentence.select, from: sentence.from, ...(sentence.free ? { free: true as const } : {}) };
    case 'moveCards':
      return {
        kind: 'moveCards',
        select: sentence.select,
        from: sentence.from,
        to: sentence.to,
        ...(sentence.order ? { order: sentence.order } : {}),
        ...(sentence.rest ? { rest: sentence.rest } : {}),
      };
    case 'revealCards':
      return { kind: 'revealCards', select: sentence.select, from: sentence.from };
    case 'split':
      return { kind: 'split', chooser: sentence.chooser, from: sentence.from, into: sentence.into };
    case 'choosePile':
      return { kind: 'choosePile', options: sentence.options };
    case 'store':
      return { kind: 'store', name: sentence.name, value: amount(sentence.value) };
    case 'draw':
      return { kind: 'draw', count: amount(sentence.count), players: sentence.players };
    case 'scry':
      return { kind: 'scry', count: amount(sentence.count), players: sentence.players, ...(sentence.surveil ? { surveil: true as const } : {}) };
    case 'choose':
      return {
        kind: 'choose',
        round: ROUND,
        players: sentence.players,
        secret: sentence.secret,
        pick:
          sentence.pick.kind === 'card'
            ? { kind: 'card', from: sentence.pick.zone }
            : sentence.pick.kind === 'label'
              ? { kind: 'label', options: sentence.pick.options }
              : { kind: 'number', min: amount({ kind: 'number', value: sentence.pick.min }), max: amount({ kind: 'number', value: sentence.pick.max }) },
        // An open choice says who goes first; the default (the caster) is left out so the
        // IR has one spelling for it.
        ...(sentence.order && sentence.order !== 'caster-first' ? { order: sentence.order } : {}),
      };
    case 'reveal':
      return { kind: 'reveal', round: ROUND };
    case 'moveChosen':
      return { kind: 'moveChosen', round: ROUND, to: sentence.zone };
    case 'result':
      return {
        kind: 'result',
        players: sentence.players === 'you' ? 'you' : 'all',
        win: sentence.win,
      };
  }
}

/* ----------------------------- targeting ------------------------------ */

/**
 * An ability's targeting pattern: the first `target …` phrase decides.
 * Without one the ability picks nothing and resolves its own groups — the
 * engine spells that as `who: 'self'`.
 */
function lowerTargeting(section: AbilitySection): TargetingIR {
  const pick = section.sentences
    .map((sentence) => ('chars' in sentence ? sentence.chars : undefined))
    .find((chars) => chars !== undefined && chars.quantifier === 'target');
  if (!pick) return { who: 'self', count: 1 };
  const filter = lowerFilter(pick);
  return { who: pick.who ?? 'any', count: 1, ...(filter ? { filter } : {}) };
}

/** One named pick of a `Target …` sentence. */
function lowerBinding(binding: TargetBinding): TargetBindingIR {
  const filter = lowerFilter(binding.chars);
  return {
    name: binding.name,
    who: binding.chars.who ?? 'any',
    count: binding.count,
    ...(filter ? { filter } : {}),
    ...(binding.distinct ? { distinct: true } : {}),
  };
}

/* ----------------------------- abilities ------------------------------ */

/** Each sentence is its own **step** — see `StepIR` for why that matters. */
function lowerAbility(section: AbilitySection): AbilityIR {
  const steps: StepIR[] = section.sentences.map(lowerStep);
  const description = [
    ...(section.targets && section.targets.length > 0 ? [targetsSummary(section.targets)] : []),
    ...(section.available ? [availableSummary(section.available)] : []),
    ...section.sentences.map(effectSummary),
  ].join(' ');
  return {
    id: slug(section.name) || 'ability',
    name: section.name,
    targeting: lowerTargeting(section),
    ...(description ? { description } : {}),
    ...(section.targets && section.targets.length > 0
      ? { targets: section.targets.map(lowerBinding) }
      : {}),
    ...(section.available ? { available: lowerGuard(section.available) } : {}),
    steps,
  };
}

/* -------------------------------- buffs ------------------------------- */

/**
 * A buff's sentences become one trigger per event they fire on. All the
 * sentences of one event share a **single** step: a buff trigger applies
 * its whole body at once, which is the behavior hand-written buff content
 * has (unlike a multi-sentence activated ability, which steps).
 */
function lowerBuff(section: BuffSection): BuffIR {
  const byEvent = new Map<string, Sentence[]>();
  for (const sentence of section.sentences) {
    if (sentence.event === undefined) continue; // the parser already reported it
    const event = sentence.event.replace(/:yours$/, '');
    const sentences = byEvent.get(event) ?? [];
    sentences.push(sentence);
    byEvent.set(event, sentences);
  }
  const triggers: TriggerIR[] = [...byEvent].map(([event, sentences]) => ({
    id: `${slug(section.name)}-${slug(event)}`,
    name: `${section.name} ${event}`,
    scope: 'self',
    event,
    mode: 'single',
    // A step's gate covers the whole step, so a guarded sentence needs its
    // own; without guards the group keeps its single apply.
    steps: sentences.some((sentence) => sentence.guard || sentence.optional)
      ? sentences.map(lowerStep)
      : [{ effects: sentences.flatMap(lowerEffects) }],
  }));
  // A buff's `when … then …` sentences become triggers it grants while
  // attached — scope `self`, since the buff's wearer carries them.
  triggers.push(
    ...section.triggers.map((trigger, index) =>
      lowerTrigger(trigger, 'self', triggers.length + index),
    ),
  );
  return {
    id: slug(section.name),
    name: section.name,
    weight: section.weight,
    ...(section.fading !== undefined ? { fading: section.fading } : {}),
    triggers,
    ...(section.modifiers.length > 0
      ? {
          modifiers: section.modifiers.map((modifier, index) =>
            lowerModifier(modifier, section.name, index),
          ),
        }
      : {}),
  };
}

/* -------------------------------- zones -------------------------------- */

/**
 * A `Zone` section's statements, each filled in with the section's own zone — the
 * "this zone" of `Cards in this zone have …` is the zone the heading names.
 */
function lowerZone(section: ZoneSection): ZoneSectionIR {
  if (section.rule !== undefined) return lowerRule(section);
  const plain = section.sentences.filter((sentence) => sentence.event === undefined);
  const rules = section.sentences.filter((sentence) => sentence.event !== undefined);
  return {
    zone: section.zone,
    ...(section.rule !== undefined ? { rule: section.rule } : {}),
    steps: plain.map((sentence) =>
      lowerStep(sentence.kind === 'zoneAbility' ? { ...sentence, zone: section.zone } : sentence),
    ),
    ...(rules.length > 0
      ? {
          triggers: rules.map((sentence) => ({
            event: sentence.event!.replace(/:yours$/, ''),
            yours: sentence.event!.endsWith(':yours'),
            steps: [lowerStep({ ...sentence, event: undefined } as Sentence)],
          })),
        }
      : {}),
  };
}

/**
 * A `Rule` section: each sentence that says "When …" starts a rule; the steps braces gather under it
 * (`When … then { … }`) follow as steps of the same ability, and an `If … { … }` block is **one** step
 * whose condition is checked once, before any of its effects.
 */
function lowerRule(section: ZoneSection): ZoneSectionIR {
  const triggers: { event: string; yours: boolean; steps: StepIR[] }[] = [];
  let block = 0;
  let open: StepIR | undefined;
  section.sentences.forEach((sentence, at) => {
    const id = section.blocks?.[at] ?? 0;
    const step = lowerStep({ ...sentence, event: undefined } as Sentence);
    if (sentence.event !== undefined) {
      triggers.push({
        event: sentence.event.replace(/:yours$/, ''),
        yours: sentence.event.endsWith(':yours'),
        steps: [],
      });
      block = 0;
    }
    const steps = triggers[triggers.length - 1]?.steps;
    if (!steps) return;
    if (id !== 0 && id === block && open) {
      // More of the same `If { … }` block: its effects join the step that already holds the gate.
      steps[steps.length - 1] = { ...open, effects: [...open.effects, ...step.effects] };
      open = steps[steps.length - 1];
      return;
    }
    steps.push(step);
    block = id;
    open = id === 0 ? undefined : step;
  });
  return { zone: section.zone, rule: section.rule!, steps: [], ...(triggers.length > 0 ? { triggers } : {}) };
}

/* ------------------------------ documents ----------------------------- */

/**
 * Lowers a parsed document. `buffSections` names the buff declarations that
 * survived checking (a duplicate name is dropped by the checker and must
 * not reach the IR); when omitted, every parsed buff is lowered.
 */
export function lowerDocument(doc: Doc, buffSections: readonly BuffSection[] = doc.buffs): DocumentIR {
  return {
    version: IR_VERSION,
    imports: doc.imports.map((section) => ({ name: section.name, path: section.path })),
    abilities: doc.abilities.map(lowerAbility),
    buffs: buffSections.map(lowerBuff),
    ...(doc.zones.length > 0 ? { zones: doc.zones.map(lowerZone) } : {}),
    ...(doc.contests.some((section) => section.contest)
      ? { contests: doc.contests.flatMap((section) => (section.contest ? [section.contest] : [])) }
      : {}),
    // Written outside any Buff: they belong to no status, so the host
    // decides which character carries them (`CompileResult.triggers`).
    triggers: doc.triggers.map((trigger, index) => lowerTrigger(trigger, 'game', index)),
  };
}
