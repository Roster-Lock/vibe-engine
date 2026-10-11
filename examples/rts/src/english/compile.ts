/**
 * Lowers a parsed document into the IR (`src/ir.ts`) — the pass that turns
 * *text that parsed* into *a program that means something*.
 *
 * Three jobs, in one traversal so the editor gets every complaint at once:
 *
 * 1. **Resolve names.** `Add Slowed to …` becomes the buff id `slowed`,
 *    looked up in the document's own `Buff` sections or in a host-supplied
 *    dictionary. Unresolved names are an error that names the alternatives.
 * 2. **Check context.** `the attacker` is only a unit inside a
 *    `whenever … takes damage` trigger; `the target` is only a unit when
 *    the ability's `Targeting:` says so. These are the cases a creator
 *    actually hits, and catching them here is the difference between a
 *    squiggle and a silent no-op mid-battle.
 * 3. **Lower.** Spans, spellings and surface word order are dropped; what
 *    comes out is plain JSON.
 *
 * Compilation is tolerant: a sentence that fails to resolve is skipped with
 * an error reported, and the rest of the document still produces a working
 * program. A half-written ability should still let you press play.
 */
import type {
  AbilityProgram,
  Anchor,
  StatName,
  BuffProgram,
  EffectNode,
  EventKind,
  EventRole,
  ModifierNode,
  PeriodicNode,
  Program,
  Restriction,
  TargetingMode,
  TriggerNode,
  UnitFilter,
  UnitQuery,
  ValueNode,
} from '../ir.js';
import { slug } from '../ir.js';
import type {
  AbilitySection,
  AnchorPhrase,
  BuffSection,
  Diagnostic,
  Doc,
  FilterExpr,
  Sentence,
  Span,
  UnitPhrase,
  ValueExpr,
} from './ast.js';
import { parseDocument } from './parser.js';

export interface CompileOptions {
  /**
   * Buffs available beyond the document's own `Buff` sections — a host
   * library. Keyed by id; the compiler never reads a file itself, exactly
   * as in the parent project's language, so sharing and sandboxing stay the
   * application's decision.
   */
  readonly buffs?: readonly BuffProgram[];
  /** Unit ids `Summon` may name. An empty list rejects every summon. */
  readonly units?: readonly string[];
}

export interface CompileResult {
  readonly diagnostics: Diagnostic[];
  readonly doc: Doc;
  readonly program: Program;
}

/** What the traversal knows about the position it is compiling in. */
interface Context {
  /** How the enclosing ability is aimed — decides whether `the target` exists. */
  readonly targeting: TargetingMode;
  /** The event whose nouns are bound here, if inside a `whenever …` body. */
  readonly event: EventKind | undefined;
  /** True inside a `Buff` section: `this unit` is the buff's carrier. */
  readonly inBuff: boolean;
  /** Where the enclosing section's diagnostics should point when a node has no better span. */
  readonly sectionName: string;
}

/** Which `the …` nouns each event binds. */
const ROLES_BY_EVENT: Readonly<Record<EventKind, readonly EventRole[]>> = {
  damaged: ['attacker', 'victim'],
  died: ['victim', 'killer'],
  attacks: ['attacker', 'victim'],
  kills: ['killer', 'victim'],
  casts: [],
};

export function compileDocument(text: string, options: CompileOptions = {}): CompileResult {
  const parsed = parseDocument(text);
  return new Compiler(parsed.doc, parsed.diagnostics, options).compile();
}

class Compiler {
  readonly #doc: Doc;
  readonly #diagnostics: Diagnostic[];
  readonly #options: CompileOptions;
  /** Buff id to display name, from the document and the host library. */
  readonly #buffNames = new Map<string, string>();
  /** Buff ids declared by *this* document, for the unused-buff warning. */
  readonly #declared = new Set<string>();
  readonly #used = new Set<string>();

  constructor(doc: Doc, diagnostics: Diagnostic[], options: CompileOptions) {
    this.#doc = doc;
    this.#diagnostics = [...diagnostics];
    this.#options = options;
    for (const buff of options.buffs ?? []) this.#buffNames.set(buff.id, buff.name);
  }

  compile(): CompileResult {
    // Two passes over buffs: collect every name first, so an ability may
    // reference a buff declared further down the document.
    for (const section of this.#doc.buffs) {
      const id = slug(section.name);
      if (this.#declared.has(id)) {
        this.#error(section.nameSpan, `buff "${section.name}" is declared twice`, 'duplicate-buff');
        continue;
      }
      if (this.#options.buffs?.some((buff) => buff.id === id)) {
        this.#error(section.nameSpan, `buff "${section.name}" is already provided by the host library`, 'shadowed-buff');
        continue;
      }
      this.#declared.add(id);
      this.#buffNames.set(id, section.name);
    }

    const buffs = this.#doc.buffs
      .filter((section) => this.#declared.has(slug(section.name)))
      .map((section) => this.#buff(section));
    const abilities = this.#doc.abilities.map((section) => this.#ability(section));

    for (const section of this.#doc.buffs) {
      const id = slug(section.name);
      if (this.#declared.has(id) && !this.#used.has(id)) {
        this.#warn(section.nameSpan, `buff "${section.name}" is never applied by this document`, 'unused-buff');
      }
    }

    return { diagnostics: this.#diagnostics, doc: this.#doc, program: { abilities, buffs } };
  }

  /* -------------------------------- sections ------------------------------- */

  #ability(section: AbilitySection): AbilityProgram {
    let targeting: TargetingMode = 'none';
    let cooldown = 0;
    let manaCost = 0;
    let castRange = 0;
    for (const entry of section.header) {
      switch (entry.kind) {
        case 'targeting':
          targeting = entry.mode;
          break;
        case 'cooldown':
          cooldown = entry.seconds;
          break;
        case 'cost':
          manaCost = entry.mana;
          break;
        case 'range':
          castRange = entry.range;
          break;
        case 'duration':
          break;
      }
    }

    const context: Context = { targeting, event: undefined, inBuff: false, sectionName: section.name };
    const effects: EffectNode[] = [];
    const triggers: TriggerNode[] = [];
    for (const sentence of section.sentences) {
      if (sentence.kind === 'whenever') {
        const trigger = this.#trigger(sentence, context);
        if (trigger) triggers.push(trigger);
        continue;
      }
      if (sentence.kind === 'modifier' || sentence.kind === 'restriction') {
        this.#error(sentence.span, 'this line describes a lasting status — put it on a Buff and apply the buff', 'modifier-on-ability');
        continue;
      }
      const effect = this.#effect(sentence, context);
      if (effect) effects.push(effect);
    }

    if (targeting !== 'none' && castRange === 0) {
      this.#warn(section.nameSpan, `"${section.name}" is targeted but has no Range — it will be castable from anywhere`, 'missing-range');
    }
    return { id: slug(section.name), name: section.name, targeting, cooldown, manaCost, castRange, effects, triggers };
  }

  #buff(section: BuffSection): BuffProgram {
    let duration = 0;
    for (const entry of section.header) {
      if (entry.kind === 'duration') duration = entry.seconds;
    }

    const context: Context = { targeting: 'none', event: undefined, inBuff: true, sectionName: section.name };
    const modifiers: ModifierNode[] = [];
    const restrictions: Restriction[] = [];
    const triggers: TriggerNode[] = [];
    const periodic: PeriodicNode[] = [];

    for (const sentence of section.sentences) {
      switch (sentence.kind) {
        case 'modifier':
          modifiers.push({ stat: sentence.stat, mode: sentence.mode, amount: sentence.amount });
          break;
        case 'restriction':
          restrictions.push(sentence.restriction);
          break;
        case 'whenever': {
          const trigger = this.#trigger(sentence, context);
          if (trigger) triggers.push(trigger);
          break;
        }
        case 'every': {
          if (sentence.duration !== undefined) {
            this.#error(sentence.span, 'a buff’s cadence runs for the buff’s Duration — drop the "for … seconds"', 'every-for-on-buff');
            break;
          }
          const body = this.#effects(sentence.body, context);
          if (body.length > 0) periodic.push({ interval: sentence.interval, effects: body });
          break;
        }
        default:
          this.#error(
            sentence.span,
            'a buff describes what is true while it lasts — use "Every …", "Whenever …", "Increase/Reduce …" or "Cannot …"',
            'effect-on-buff',
          );
      }
    }

    if (duration === 0 && periodic.length > 0) {
      this.#warn(section.nameSpan, `"${section.name}" ticks forever — it has no Duration`, 'endless-periodic');
    }
    return { id: slug(section.name), name: section.name, duration, stacks: section.stacks, modifiers, restrictions, triggers, periodic };
  }

  #trigger(sentence: Extract<Sentence, { kind: 'whenever' }>, context: Context): TriggerNode | undefined {
    const inner: Context = { ...context, event: sentence.event };
    const effects = this.#effects(sentence.body, inner);
    if (effects.length === 0) return undefined;
    return { event: sentence.event, effects };
  }

  /* -------------------------------- effects -------------------------------- */

  #effects(sentences: readonly Sentence[], context: Context): EffectNode[] {
    const effects: EffectNode[] = [];
    for (const sentence of sentences) {
      const effect = this.#effect(sentence, context);
      if (effect) effects.push(effect);
    }
    return effects;
  }

  #effect(sentence: Sentence, context: Context): EffectNode | undefined {
    switch (sentence.kind) {
      case 'damage': {
        const amount = this.#value(sentence.amount, context);
        const units = this.#units(sentence.units, context);
        return amount && units ? { kind: 'damage', amount, units } : undefined;
      }
      case 'heal': {
        const amount = this.#value(sentence.amount, context);
        const units = this.#units(sentence.units, context);
        return amount && units ? { kind: 'heal', amount, units } : undefined;
      }
      case 'addBuff': {
        const buff = this.#buffRef(sentence.buffName, sentence.buffSpan);
        const units = this.#units(sentence.units, context);
        return buff && units ? { kind: 'addBuff', buff, units } : undefined;
      }
      case 'removeBuff': {
        const buff = this.#buffRef(sentence.buffName, sentence.buffSpan);
        const units = this.#units(sentence.units, context);
        return buff && units ? { kind: 'removeBuff', buff, units } : undefined;
      }
      case 'kill': {
        const units = this.#units(sentence.units, context);
        return units ? { kind: 'kill', units } : undefined;
      }
      case 'summon': {
        const anchor = this.#anchor(sentence.anchor, context);
        if (!anchor) return undefined;
        const id = slug(sentence.unitName);
        const known = this.#options.units ?? [];
        if (!known.includes(id)) {
          this.#error(
            sentence.unitSpan,
            known.length === 0
              ? `no unit types are available to summon — the host supplied none`
              : `unknown unit "${sentence.unitName}" — known units: ${known.join(', ')}`,
            'unknown-unit',
          );
          return undefined;
        }
        return { kind: 'summon', unit: id, count: sentence.count, anchor };
      }
      case 'teleport': {
        const units = this.#units(sentence.units, context);
        const anchor = this.#anchor(sentence.anchor, context);
        return units && anchor ? { kind: 'teleport', units, anchor } : undefined;
      }
      case 'push': {
        const units = this.#units(sentence.units, context);
        const anchor = sentence.anchor ? this.#anchor(sentence.anchor, context) : ({ kind: 'self' } as Anchor);
        return units && anchor ? { kind: 'knockback', units, distance: sentence.distance, anchor } : undefined;
      }
      case 'after': {
        const body = this.#effects(sentence.body, context);
        return body.length > 0 ? { kind: 'after', delay: sentence.delay, body } : undefined;
      }
      case 'every': {
        if (sentence.duration === undefined) {
          this.#error(sentence.span, 'an ability’s cadence needs an end — write "Every 1 second for 12 seconds, …"', 'every-needs-duration');
          return undefined;
        }
        const body = this.#effects(sentence.body, context);
        return body.length > 0 ? { kind: 'every', interval: sentence.interval, duration: sentence.duration, body } : undefined;
      }
      case 'whenever':
        this.#error(sentence.span, 'a trigger cannot be nested inside another effect', 'nested-trigger');
        return undefined;
      case 'modifier':
      case 'restriction':
        this.#error(sentence.span, 'this line describes a lasting status — put it on a Buff', 'modifier-on-ability');
        return undefined;
    }
  }

  /* --------------------------------- nouns --------------------------------- */

  #value(expression: ValueExpr, context: Context): ValueNode | undefined {
    if (expression.kind === 'const') return { kind: 'const', value: expression.value };
    const of = this.#unitRefQuery(expression.of, expression.span, context);
    if (!of) return undefined;
    return { kind: 'stat', of, stat: expression.stat, percent: expression.percent };
  }

  #units(phrase: UnitPhrase, context: Context): UnitQuery | undefined {
    const base = this.#selector(phrase, context);
    if (!base) return undefined;
    if (!phrase.filter) return base;
    const filter = this.#filter(phrase.filter);
    return filter ? { kind: 'filtered', units: base, filter } : undefined;
  }

  #selector(phrase: UnitPhrase, context: Context): UnitQuery | undefined {
    const selector = phrase.selector;
    switch (selector.kind) {
      case 'self':
        return { kind: 'self' };
      case 'target':
        return this.#checkTarget(phrase.span, context) ? { kind: 'target' } : undefined;
      case 'eventUnit':
        return this.#checkRole(selector.role, phrase.span, context) ? { kind: 'eventUnit', role: selector.role } : undefined;
      case 'area': {
        const anchor = this.#anchor(selector.anchor, context);
        if (!anchor) return undefined;
        return { kind: 'area', who: selector.who, radius: selector.radius, anchor, other: selector.other };
      }
    }
  }

  /** The single-unit nouns, as a query — what a possessive is taken of. */
  #unitRefQuery(ref: { kind: 'self' | 'target' | 'eventUnit'; role?: EventRole }, span: Span, context: Context): UnitQuery | undefined {
    if (ref.kind === 'self') return { kind: 'self' };
    if (ref.kind === 'target') return this.#checkTarget(span, context) ? { kind: 'target' } : undefined;
    const role = ref.role!;
    return this.#checkRole(role, span, context) ? { kind: 'eventUnit', role } : undefined;
  }

  #anchor(phrase: AnchorPhrase, context: Context): Anchor | undefined {
    const anchor = phrase.anchor;
    switch (anchor.kind) {
      case 'self':
        return anchor;
      case 'target':
        return this.#checkTarget(phrase.span, context) ? anchor : undefined;
      case 'targetPoint':
        return this.#checkTargetPoint(phrase.span, context) ? anchor : undefined;
      case 'eventUnit':
        return this.#checkRole(anchor.role, phrase.span, context) ? anchor : undefined;
    }
  }

  #filter(expression: FilterExpr): UnitFilter | undefined {
    switch (expression.kind) {
      case 'stat':
        return expression.percentOfMax
          ? {
              kind: 'statShare',
              stat: expression.stat,
              op: expression.op,
              percent: expression.value,
              of: MAXIMUM_OF[expression.stat] ?? expression.stat,
            }
          : { kind: 'stat', stat: expression.stat, op: expression.op, value: { kind: 'const', value: expression.value } };
      case 'buff': {
        const buff = this.#buffRef(expression.buffName, expression.buffSpan);
        return buff ? { kind: 'buff', buff } : undefined;
      }
      case 'and':
      case 'or': {
        const left = this.#filter(expression.left);
        const right = this.#filter(expression.right);
        return left && right ? { kind: expression.kind, left, right } : undefined;
      }
      case 'not': {
        const inner = this.#filter(expression.expression);
        return inner ? { kind: 'not', expression: inner } : undefined;
      }
    }
  }

  /* -------------------------------- checking ------------------------------- */

  #buffRef(name: string, span: Span): string | undefined {
    const id = slug(name);
    if (!this.#buffNames.has(id)) {
      const known = [...this.#buffNames.values()];
      this.#error(
        span,
        known.length === 0
          ? `unknown buff "${name}" — declare it with a "Buff ${name}" section`
          : `unknown buff "${name}" — known buffs: ${known.join(', ')}`,
        'unknown-buff',
      );
      return undefined;
    }
    this.#used.add(id);
    return id;
  }

  #checkTarget(span: Span, context: Context): boolean {
    if (context.inBuff) {
      this.#error(span, 'a buff has no cast target — "this unit" is the unit carrying the buff', 'target-in-buff');
      return false;
    }
    if (context.targeting === 'none') {
      this.#error(span, `"${context.sectionName}" has no target — add a "Targeting:" line, or name units with "all … within … range of this unit"`, 'no-target');
      return false;
    }
    if (context.targeting === 'point') {
      this.#error(span, `"${context.sectionName}" targets a point, not a unit — say "the target point"`, 'point-not-unit');
      return false;
    }
    return true;
  }

  #checkTargetPoint(span: Span, context: Context): boolean {
    if (context.inBuff) {
      this.#error(span, 'a buff has no cast target', 'target-in-buff');
      return false;
    }
    if (context.targeting === 'none') {
      this.#error(span, `"${context.sectionName}" has no target — add "Targeting: target point"`, 'no-target');
      return false;
    }
    // A unit-targeted cast still has a point: wherever the target stands.
    return true;
  }

  #checkRole(role: EventRole, span: Span, context: Context): boolean {
    if (!context.event) {
      this.#error(span, `"the ${role}" only exists inside a "Whenever …" trigger`, 'role-outside-trigger');
      return false;
    }
    const allowed = ROLES_BY_EVENT[context.event];
    if (!allowed.includes(role)) {
      this.#error(
        span,
        allowed.length === 0
          ? `this event binds no units — "the ${role}" is not available here`
          : `this event does not bind "the ${role}" — it binds ${allowed.map((name) => `the ${name}`).join(' and ')}`,
        'role-not-bound',
      );
      return false;
    }
    return true;
  }

  #error(span: Span, message: string, code: string): void {
    this.#diagnostics.push({ severity: 'error', message, code, start: span.start, end: span.end });
  }

  #warn(span: Span, message: string, code: string): void {
    this.#diagnostics.push({ severity: 'warning', message, code, start: span.start, end: span.end });
  }
}

/** The maximum a `… below <n>%` comparison is taken against. */
const MAXIMUM_OF: Readonly<Record<string, StatName | undefined>> = {
  hp: 'maxHp',
  mana: 'maxMana',
};
