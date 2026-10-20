/**
 * Compiles Ability Language documents into engine content
 * (docs/creator/01-ability-language.md).
 *
 * `compileDocument` runs four passes and returns everything at once, so the
 * editor shows grammar and semantic errors together:
 *
 * ```
 *   parse ──► check ──► lower ──► bind
 *   parser.ts  (here)   lower.ts  src/ir/bind
 *   → AST      → diags  → IR      → ManualAbility / BuffDef
 * ```
 *
 * The **lower** step is what makes a document shareable: the IR is plain
 * JSON with no engine references, so it is simultaneously the compilation
 * target, what an editor introspects, and the share format (docs/GOAL.md).
 * `CompileResult.ir` is that document.
 *
 * Compilation is tolerant: a reference that does not resolve is reported as
 * a diagnostic and binds to a no-op, so the rest of a half-written document
 * still produces working abilities.
 */
import type { BuffDef, ManualAbility, AnyTriggeredAbility } from '../engine/index.js';
import { bindDocument, type BindOptions, type DocumentIR, type ZoneBinding } from '../ir/index.js';
import {
  withNested,
  type BuffSection,
  type CharsPhrase,
  type Diagnostic,
  type Doc,
  type Sentence,
  type TriggerSentence,
} from './ast.js';
import { triggerSummary } from './describe.js';
import { BuffDictionary, slug, type DictionaryEntry } from './dictionary.js';
import { emptyZoneDictionary, type ZoneDictionary } from './zone-dictionary.js';
import { lowerDocument, lowerSteps } from './lower.js';
import { MATH_ROOTS, validateRounds, type ContestIR, type MathExpression } from '../ir/index.js';
import { rollStatOf } from './rounds.js';
import { parseDocument } from './parser.js';

export interface CompileOptions {
  /** Buffs available to `Add`/`Remove` beyond the document's own `Buff` lines. */
  readonly dictionary?: BuffDictionary;
  /**
   * The zone names a `when … enters/leaves <zone>` trigger may name. The
   * engine's own `play`/`garbage` are always known; a game adds its deck,
   * hand, stack, resolving `active` slot, and so on.
   */
  readonly zones?: ZoneDictionary;
  /** The gauge ids the game declares, for `with hp < 10` and `incoming mana loss`. Defaults to `hp` and `mana`. */
  readonly gauges?: readonly string[];
  /** Contests a sentence may play by name (`All players play Rock Paper Scissors.`). */
  readonly contests?: readonly import("../ir/index.js").ContestIR[];
  /** Creature definitions a sentence may create by name (`Create a Giant Golem.`). */
  readonly creatures?: readonly string[];
  /**
   * How the document's abstract zone roles and `Draw(…)` bind to the game
   * (`BindOptions.aliases` / `BindOptions.draw`): `{ aliases: { library: 'deck' } }`
   * maps the language's `library` to this game's deck, and `draw` is the game's
   * own `draw(player, count)` — fatigue, a hand limit — in place of the plain one.
   */
  readonly bind?: Pick<BindOptions, 'aliases' | 'draw'>;
  /** Resolves a module import to a buff definition. File access stays outside the compiler. */
  readonly resolveImport?: (path: string, importedName: string) => BuffDef | undefined;
}

export interface CompileResult {
  readonly diagnostics: Diagnostic[];
  readonly doc: Doc;
  /**
   * The document as **plain JSON** — the share format. Produced even when
   * diagnostics were reported, so a half-written document still round-trips.
   */
  readonly ir: DocumentIR;
  /** The document's own `Buff` sections compiled to engine defs. */
  readonly buffs: BuffDef[];
  /** One engine manual ability per `Ability` section, in document order. */
  readonly abilities: ManualAbility[];
  /** Game-scoped triggers — they belong to no character, so the host registers them. */
  readonly triggers: AnyTriggeredAbility[];
  /**
   * One binding per `Zone` section. The host calls `apply(engine)` once the game's
   * zones and players exist — "Cards in this zone have Open Present" is state set
   * while the game runs, not part of the zone's declaration.
   */
  readonly zones: ZoneBinding[];
  /** One contest per valid `Contest` section — a function of a list of players to who won, who lost, or a tie. */
  readonly contests: ContestIR[];
}

export function compileDocument(text: string, options: CompileOptions = {}): CompileResult {
  const parsed = parseDocument(text, {
    zones: options.zones ?? emptyZoneDictionary(),
    ...(options.gauges ? { gauges: options.gauges } : {}),
    ...(options.contests ? { contests: options.contests } : {}),
    ...(options.creatures ? { creatures: options.creatures } : {}),
  });
  const builtIns = options.dictionary ?? new BuffDictionary([]);
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];

  // Document-declared buffs — validated against the built-ins and each
  // other, then built into engine defs.
  const declared: DictionaryEntry[] = [];
  const imported: DictionaryEntry[] = [];
  for (const section of parsed.doc.imports) {
    const def = resolveImportedBuff(section.path, section.name, builtIns, options.resolveImport);
    if (!def) {
      diagnostics.push({
        severity: 'error',
        message: `cannot resolve imported buff "${section.name}" from "${section.path}"`,
        code: 'unknown-import',
        start: section.pathSpan.start,
        end: section.pathSpan.end,
      });
      continue;
    }
    imported.push({ name: section.name, def });
  }
  const buffSectionsList: BuffSection[] = [];
  for (const section of parsed.doc.buffs) {
    const key = slug(section.name);
    const clash =
      builtIns.hasName(section.name) ||
      declared.some((e) => slug(e.name) === key || e.name.toLowerCase() === section.name.toLowerCase());
    if (builtIns.hasName(section.name)) {
      diagnostics.push({
        severity: 'error',
        message: `"${section.name}" is already supplied by the host — use a different name`,
        code: 'buff-dup-builtin',
        start: section.nameSpan.start,
        end: section.nameSpan.end,
      });
    } else if (clash) {
      diagnostics.push({
        severity: 'error',
        message: `a buff named "${section.name}" is already declared in this document`,
        code: 'buff-dup',
        start: section.nameSpan.start,
        end: section.nameSpan.end,
      });
    } else {
      declared.push({ name: section.name, def: { name: section.name, weight: section.weight } });
      buffSectionsList.push(section);
    }
  }
  const merged = mergedDictionary([...imported, ...declared], builtIns);

  // Buff references (sentences + "with" filters) + target-picking checks.
  const usedBuffNames = new Set<string>();
  const reportUnknownBuff = (name: string, span: { start: number; end: number }): void => {
    const known = merged.names;
    const similar = known
      .filter((n) => n.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(n.toLowerCase()))
      .slice(0, 3);
    const hint =
      similar.length > 0
        ? ` Did you mean ${similar.map((s) => `"${s}"`).join(' or ')}?`
        : '';
    diagnostics.push({
      severity: 'error',
      message: `unknown buff "${name}" — declare it with a "Buff ${name}" line or import it from a content module.${hint}`,
      code: 'unknown-buff',
      start: span.start,
      end: span.end,
    });
  };
  const noteBuffUsed = (name: string): void => {
    usedBuffNames.add(name.toLowerCase());
    usedBuffNames.add(slug(name));
  };

  // Every sentence, including those inside a roll table's result lines.
  const allSentences = [
    ...parsed.doc.abilities.flatMap((a) => a.sentences),
    ...parsed.doc.buffs.flatMap((b) => b.sentences),
  ].flatMap(withNested);

  for (const ability of parsed.doc.abilities) {
    const pickKeys = new Set<string>();
    for (const sentence of ability.sentences) {
      const pick = pickDescriptor(sentence);
      if (pick) {
        if (pickKeys.size === 0) {
          pickKeys.add(pick.key);
        } else if (!pickKeys.has(pick.key)) {
          diagnostics.push({
            severity: 'error',
            message:
              'this ability asks for a different target than its other sentence — in this version an ability picks one character ("target …") and everything else resolves by itself',
            code: 'target-conflict',
            start: pick.span.start,
            end: pick.span.end,
          });
        }
      }
    }
  }

  // Named picks: duplicate names, and references to names nothing bound.
  for (const ability of parsed.doc.abilities) {
    const bound = new Set<string>();
    for (const binding of ability.targets ?? []) {
      const key = binding.name.toLowerCase();
      if (bound.has(key)) {
        diagnostics.push({
          severity: 'error',
          message: `"${ability.name}" already picks something called "${binding.name}" — give each binding its own name`,
          code: 'target-name-dup',
          start: binding.nameSpan.start,
          end: binding.nameSpan.end,
        });
      }
      bound.add(key);
    }
    for (const sentence of ability.sentences) {
      const chars = charsOf(sentence);
      if (!chars || chars.quantifier !== 'bound') continue;
      const name = chars.name ?? '';
      if (bound.has(name.toLowerCase())) continue;
      const known = [...bound];
      diagnostics.push({
        severity: 'error',
        message:
          `"${ability.name}" never picks anything called "${name}"` +
          (known.length > 0
            ? ` — it picks ${known.map((entry) => `"${entry}"`).join(' and ')}`
            : ' — name a pick first with "Target 1 character as ' + name + '."'),
        code: 'unknown-target-name',
        start: chars.span.start,
        end: chars.span.end,
      });
    }
  }

  for (const sentence of allSentences) {
    if (
      sentence.kind === 'addBuff' ||
      sentence.kind === 'removeBuff' ||
      sentence.kind === 'toggleBuff'
    ) {
      if (merged.resolve(sentence.buffName)) {
        noteBuffUsed(sentence.buffName);
      } else {
        reportUnknownBuff(sentence.buffName, sentence.buffSpan);
      }
    }
    const chars = charsOf(sentence);
    for (const condition of chars?.withClause?.conditions ?? []) {
      if (condition.kind !== 'buff') continue;
      if (merged.resolve(condition.buffName)) {
        noteBuffUsed(condition.buffName);
      } else {
        reportUnknownBuff(condition.buffName, condition.buffSpan);
      }
    }
  }

  // Warn about declared buffs nothing references.
  for (const section of parsed.doc.buffs) {
    if (usedBuffNames.has(section.name.toLowerCase()) || usedBuffNames.has(slug(section.name))) continue;
    diagnostics.push({
      severity: 'warning',
      message: `"${section.name}" is declared but no sentence adds or removes it`,
      code: 'unused-buff',
      start: section.nameSpan.start,
      end: section.nameSpan.end,
    });
  }

  // Choice rounds must be playable at a table: a secret choice is revealed, a
  // choice is used only after it is public. Each problem points at its sentence.
  const reportRounds = (sentences: readonly Sentence[]): void => {
    if (!sentences.some((s) => s.kind === 'choose' || s.kind === 'reveal' || s.kind === 'moveChosen')) return;
    for (const issue of validateRounds(lowerSteps(sentences))) {
      const at = sentences[issue.step]!;
      diagnostics.push({
        severity: issue.severity,
        message: issue.message,
        code: 'choice-round',
        start: at.span.start,
        end: at.span.end,
      });
    }
  };
  // A trigger that sets itself off again: "When this is damaged then deal damage to
  // this character." The engine would stop it (gas), but it is almost never what was
  // meant, so say so while it is still being written. Conservative on purpose — it
  // only recognises a trigger on "this" whose effect lands on "this" (or on everyone,
  // which includes it) in the same direction, never one that points at "the source".
  const reportSelfTriggers = (triggers: readonly TriggerSentence[]): void => {
    const hitsItself = (chars: CharsPhrase): boolean =>
      chars.quantifier === 'this' ||
      (chars.quantifier === 'all' && !chars.who && !chars.other && !chars.owner && !chars.withClause);
    for (const trigger of triggers) {
      const effect = trigger.effects[0];
      if (!effect || trigger.event !== 'gauge:changed' || trigger.subject.quantifier !== 'this') continue;
      const loops =
        (trigger.change === 'damage' && effect.kind === 'deal' && hitsItself(effect.chars)) ||
        (trigger.change === 'heal' && effect.kind === 'heal' && hitsItself(effect.chars));
      if (!loops) continue;
      diagnostics.push({
        severity: 'warning',
        message:
          `"${triggerSummary(trigger)}" sets itself off again every time it runs, so it never stops — the engine ` +
          `will end it when it runs out of gas. Aim it at "the source", or add a condition.`,
        code: 'trigger-loop',
        start: trigger.span.start,
        end: trigger.span.end,
      });
    }
  };
  reportSelfTriggers(parsed.doc.triggers);
  for (const buff of parsed.doc.buffs) reportSelfTriggers(buff.triggers);

  // "Cards in your boxed zone have Open Present" must name an ability of this
  // document. A typo is the likeliest mistake, so it gets the names that do exist.
  const reportZoneAbilities = (sentences: readonly Sentence[]): void => {
    const names = parsed.doc.abilities.map((ability) => ability.name);
    for (const sentence of sentences.flatMap(withNested)) {
      if (sentence.kind !== 'zoneAbility') continue;
      const wanted = slug(sentence.ability);
      if (names.some((name) => slug(name) === wanted)) continue;
      const close = names.filter((name) => slug(name).includes(wanted) || wanted.includes(slug(name)));
      diagnostics.push({
        severity: 'error',
        message:
          `there is no ability called "${sentence.ability}" in this document` +
          (close.length > 0
            ? ` — did you mean ${close.map((name) => `"${name}"`).join(' or ')}?`
            : ` — it has ${names.map((name) => `"${name}"`).join(', ')}`),
        code: 'unknown-ability',
        start: sentence.abilitySpan.start,
        end: sentence.abilitySpan.end,
      });
    }
  };
  for (const zone of parsed.doc.zones) reportZoneAbilities(zone.sentences);
  for (const ability of parsed.doc.abilities) reportZoneAbilities(ability.sentences);
  for (const trigger of parsed.doc.triggers) reportZoneAbilities(trigger.effects);
  for (const buff of parsed.doc.buffs) {
    for (const trigger of buff.triggers) reportZoneAbilities(trigger.effects);
    reportZoneAbilities(buff.sentences);
  }

  // A roll table's lines: every line must be a result the dice can make, no two
  // lines may claim the same result (first-match would hide a typo), `Otherwise`
  // is last and once, and a line cannot pick a target (the pick is made before
  // anything resolves, so it belongs above the roll). A result no line covers is
  // not an error: it simply does nothing.
  const reportTables = (sentences: readonly Sentence[]): void => {
    const error = (message: string, code: string, at: { start: number; end: number }): void => {
      diagnostics.push({ severity: 'error', message, code, start: at.start, end: at.end });
    };
    for (const sentence of sentences.flatMap(withNested)) {
      if (sentence.kind !== 'roll' || !sentence.table) continue;
      const lowest = sentence.count;
      const highest = sentence.count * sentence.sides;
      const die = sentence.count === 1 ? `a d${sentence.sides}` : `${sentence.count}d${sentence.sides}`;
      const taken: { text: string; from: number; to: number }[] = [];
      let seenOtherwise = false;
      for (const row of sentence.table) {
        if (seenOtherwise) {
          error(`"${row.text}:" comes after "Otherwise:" — Otherwise covers everything left, so it goes last`, 'table-order', row.span);
        }
        if (row.otherwise) {
          if (seenOtherwise) error('there is already an "Otherwise:" line — a table has one', 'table-otherwise', row.span);
          seenOtherwise = true;
        } else if (row.min > highest || (row.max !== null && row.max < lowest)) {
          error(
            `${die} never rolls ${row.text.replace(/ or (more|less)$/, '')} — it rolls ${lowest === highest ? lowest : `${lowest} to ${highest}`}`,
            'table-range',
            row.span,
          );
        } else {
          const from = Math.max(lowest, row.min);
          const to = Math.min(highest, row.max ?? highest);
          const clash = taken.find((earlier) => from <= earlier.to && earlier.from <= to);
          if (clash) {
            const shared = Math.max(from, clash.from);
            error(
              `"${row.text}" and "${clash.text}" both cover ${shared} — give each result one line`,
              'table-overlap',
              row.span,
            );
          }
          taken.push({ text: row.text, from, to });
        }
        for (const nested of row.sentences.flatMap(withNested)) {
          const chars = 'chars' in nested ? nested.chars : undefined;
          if (chars?.quantifier === 'target') {
            error(
              `a result line cannot pick a target — "target" is chosen before the ability resolves; use "all …" or "this", or pick above the roll with "Target 1 character as Victim."`,
              'table-target',
              nested.span,
            );
          }
        }
      }
    }
  };
  for (const ability of parsed.doc.abilities) reportTables(ability.sentences);
  for (const trigger of parsed.doc.triggers) reportTables(trigger.effects);
  for (const buff of parsed.doc.buffs) {
    for (const trigger of buff.triggers) reportTables(trigger.effects);
    reportTables(buff.sentences);
  }

  // A bare name in an amount is a value stored earlier ("Store that value as X.").
  // It must have been stored before it is read, under a name the language does
  // not already own, and only once.
  const reportVariables = (sentences: readonly Sentence[]): void => {
    const stored = new Set<string>();
    const report = (message: string, code: string, start: number, end: number): void => {
      diagnostics.push({ severity: 'error', message, code, start, end });
    };
    const check = (expression: MathExpression, at: { start: number; end: number }, scope: ReadonlySet<string>): void => {
      switch (expression.kind) {
        case 'path': {
          const root = expression.parts[0];
          if (expression.parts.length === 1 && typeof root === 'string' && !MATH_ROOTS.includes(root) && !scope.has(root) && !stored.has(root)) {
            report(
              `"${root}" has not been stored — write "Store that value as ${root}." before using it`,
              'unknown-variable',
              at.start,
              at.end,
            );
          }
          for (const part of expression.parts) {
            if (typeof part === 'object') check(part.expression, at, scope);
          }
          return;
        }
        case 'unary':
          return check(expression.expression, at, scope);
        case 'binary':
          check(expression.left, at, scope);
          return check(expression.right, at, scope);
        case 'sum':
          check(expression.start, at, scope);
          check(expression.end, at, scope);
          return check(expression.expression, at, new Set([...scope, expression.variable]));
        case 'sumArray':
          return check(expression.expression, at, scope);
        case 'number':
          return;
      }
    };
    for (const sentence of sentences.flatMap(withNested)) {
      // A condition may read a stored name too: `If AttackerRoll > DefenderRoll, …`.
      for (const clause of [sentence.guard, sentence.repeat?.condition]) {
        if (clause?.kind !== 'value') continue;
        for (const comparison of clause.comparisons) {
          check(comparison.value, comparison.span, new Set());
          check(comparison.other, comparison.span, new Set());
        }
      }
      if (sentence.kind === 'deal' || sentence.kind === 'heal' || sentence.kind === 'set' || sentence.kind === 'increaseMax') check(sentence.amount, sentence.amountSpan, new Set());
      if (sentence.kind === 'draw' || sentence.kind === 'scry') check(sentence.count, sentence.span, new Set());
      if (sentence.kind === 'store') {
        check(sentence.value, sentence.span, new Set());
        const { name, nameSpan } = sentence;
        if (MATH_ROOTS.includes(name) || rollStatOf(name.toLowerCase()) || name.toLowerCase() === 'that' || name.toLowerCase() === 'the') {
          report(`"${name}" is a word the language already uses — choose another name, e.g. "AttackerRoll"`, 'variable-name', nameSpan.start, nameSpan.end);
        } else if (stored.has(name)) {
          report(`"${name}" is already stored — a name is stored once; use a different name`, 'variable-twice', nameSpan.start, nameSpan.end);
        } else {
          stored.add(name);
        }
      }
    }
  };
  // A vote's tally (`votes for Attack`) must be asked of a vote that was held,
  // for an option that was on its ballot, and — for a sealed vote — only after
  // the reveal.
  const reportVotes = (sentences: readonly Sentence[]): void => {
    let latest: { options: readonly string[]; sealed: boolean } | undefined;
    const report = (message: string, at: { start: number; end: number }): void => {
      diagnostics.push({ severity: 'error', message, code: 'vote-tally', start: at.start, end: at.end });
    };
    /** Every tally an amount reads: an option's (`votes for Attack`), or a bare extreme (`the highest vote`). */
    const optionsRead = (expression: MathExpression): (string | undefined)[] => {
      switch (expression.kind) {
        case 'path':
          if (expression.parts[0] === 'votes' && expression.parts.length === 2 && typeof expression.parts[1] === 'string') {
            return [expression.parts[1]];
          }
          return expression.parts[0] === 'vote' && expression.parts.length === 2 ? [undefined] : [];
        case 'unary':
          return optionsRead(expression.expression);
        case 'binary':
          return [...optionsRead(expression.left), ...optionsRead(expression.right)];
        case 'sum':
          return [...optionsRead(expression.start), ...optionsRead(expression.end), ...optionsRead(expression.expression)];
        case 'sumArray':
          return optionsRead(expression.expression);
        case 'number':
          return [];
      }
    };
    const expressionsOf = (sentence: Sentence): MathExpression[] => {
      const out: MathExpression[] = [];
      for (const clause of [sentence.guard, sentence.repeat?.condition]) {
        if (clause?.kind !== 'value') continue;
        for (const comparison of clause.comparisons) out.push(comparison.value, comparison.other);
      }
      if (sentence.kind === 'deal' || sentence.kind === 'heal' || sentence.kind === 'set' || sentence.kind === 'increaseMax') out.push(sentence.amount);
      if (sentence.kind === 'store') out.push(sentence.value);
      if (sentence.kind === 'draw' || sentence.kind === 'scry') out.push(sentence.count);
      return out;
    };
    for (const sentence of sentences.flatMap(withNested)) {
      // A guard is read before the sentence it gates runs, so it is checked first.
      for (const expression of expressionsOf(sentence)) {
        for (const option of optionsRead(expression)) {
          const what = option === undefined ? 'the votes' : `"votes for ${option}"`;
          if (!latest) {
            report(`${what} are read before any vote — hold one first: "All players choose ${option ?? 'Attack'} or …"`, sentence.span);
          } else if (option !== undefined && !latest.options.some((candidate) => candidate.toLowerCase() === option.toLowerCase())) {
            report(
              `nobody can vote for "${option}" — the options are ${latest.options.map((o) => `"${o}"`).join(' and ')}`,
              sentence.span,
            );
          } else if (latest.sealed) {
            report(`${what} are read before the votes are revealed — add "When they are ready, reveal." first`, sentence.span);
          }
        }
      }
      if (sentence.kind === 'choose') {
        latest = sentence.pick.kind === 'label' ? { options: sentence.pick.options, sealed: sentence.secret } : latest;
      } else if (sentence.kind === 'reveal' && latest) {
        latest = { ...latest, sealed: false };
      }
    }
  };
  for (const ability of parsed.doc.abilities) reportVotes(ability.sentences);
  for (const trigger of parsed.doc.triggers) reportVotes(trigger.effects);
  for (const buff of parsed.doc.buffs) {
    for (const trigger of buff.triggers) reportVotes(trigger.effects);
    reportVotes(buff.sentences);
  }

  for (const ability of parsed.doc.abilities) reportVariables(ability.sentences);
  for (const trigger of parsed.doc.triggers) reportVariables(trigger.effects);
  for (const buff of parsed.doc.buffs) {
    for (const trigger of buff.triggers) reportVariables(trigger.effects);
    reportVariables(buff.sentences);
  }

  for (const ability of parsed.doc.abilities) reportRounds(ability.sentences);
  for (const trigger of parsed.doc.triggers) reportRounds(trigger.effects);
  for (const buff of parsed.doc.buffs) {
    for (const trigger of buff.triggers) reportRounds(trigger.effects);
    const byEvent = new Map<string, Sentence[]>();
    for (const sentence of buff.sentences) {
      const group = byEvent.get(sentence.event ?? '') ?? [];
      group.push(sentence);
      byEvent.set(sentence.event ?? '', group);
    }
    for (const group of byEvent.values()) reportRounds(group);
  }

  // Lower to IR, then bind. Buff references are canonicalized first, so a
  // reference shows the name it resolved to (the declaration / built-in
  // spelling — "Toxic Tentacles", not "toxic tentacles") everywhere it is
  // displayed, and the IR carries that spelling too.
  const doc = canonicalizeBuffNames(parsed.doc, merged);
  const keptNameSpans = new Set(buffSectionsList.map((section) => section.nameSpan.start));
  const ir = lowerDocument(doc, doc.buffs.filter((section) => keptNameSpans.has(section.nameSpan.start)));

  // Binding is late: `resolveBuff` reads whatever `resolver` holds *when an
  // effect runs*, not when it is bound. That is what lets a buff's trigger
  // add another of the document's buffs — the bound definitions below do not
  // exist yet at the moment they are referenced.
  let resolver = merged;
  // The rounds were checked above and reported with their spans, so binding
  // must not throw on them a second time.
  const bound = bindDocument(ir, {
    resolveBuff: (name) => resolver.resolve(name),
    allowUnsoundRounds: true,
    ...(options.bind ?? {}),
  });
  for (let i = 0; i < declared.length; i += 1) {
    const def = bound.buffs[i];
    if (def) declared[i] = { name: declared[i]!.name, def };
  }
  resolver = mergedDictionary([...imported, ...declared], builtIns);

  return {
    diagnostics,
    doc,
    ir,
    buffs: bound.buffs,
    abilities: bound.abilities,
    triggers: bound.triggers,
    zones: bound.zones,
    contests: doc.contests.flatMap((section) => (section.contest ? [section.contest] : [])),
  };
}

/** Replaces every buff reference's name with its resolved display name. */
function canonicalizeBuffNames(doc: Doc, dictionary: BuffDictionary): Doc {
  const canonical = (name: string): string => dictionary.entryOf(name)?.name ?? name;
  const mapExpression = (expression: import('./ast.js').BooleanCondition): import('./ast.js').BooleanCondition => {
    if (expression.kind === 'and' || expression.kind === 'or') {
      return { ...expression, left: mapExpression(expression.left), right: mapExpression(expression.right) };
    }
    if (expression.kind === 'not') return { ...expression, expression: mapExpression(expression.expression) };
    return expression.kind === 'buff' ? { ...expression, buffName: canonical(expression.buffName) } : expression;
  };
  const mapChars = (chars: CharsPhrase): CharsPhrase => {
    const clause = chars.withClause;
    if (!clause) return chars;
    return {
      ...chars,
      withClause: {
        ...clause,
        conditions: clause.conditions.map((condition) =>
          condition.kind === 'buff'
            ? { ...condition, buffName: canonical(condition.buffName) }
            : condition,
        ),
        expression: mapExpression(clause.expression),
      },
    };
  };
  const mapSentence = (sentence: Sentence): Sentence => {
    switch (sentence.kind) {
      case 'addBuff':
      case 'removeBuff':
      case 'toggleBuff':
        return { ...sentence, buffName: canonical(sentence.buffName), chars: mapChars(sentence.chars) };
      case 'deal':
      case 'heal':
      case 'set':
      case 'increaseMax':
      case 'destroy':
        return { ...sentence, chars: mapChars(sentence.chars) };
      case 'roll':
        // Result lines hold sentences of their own (`Add Poison to …`).
        return sentence.table
          ? {
              ...sentence,
              table: sentence.table.map((row) => ({ ...row, sentences: row.sentences.map(mapSentence) })),
            }
          : sentence;
      case 'store':
      case 'draw':
      case 'scry':
      case 'revealCard':
      case 'castCard':
      case 'moveCard':
      case 'moveCards':
      case 'revealCards':
      case 'split':
      case 'removeCounters':
      case 'play':
      case 'create':
      case 'castCards':
      case 'choosePile':
      case 'zoneAbility':
      case 'choose':
      case 'reveal':
      case 'moveChosen':
      case 'result':
        return sentence;
    }
  };
  return {
    abilities: doc.abilities.map((ability) => ({
      ...ability,
      sentences: ability.sentences.map(mapSentence),
    })),
    zones: doc.zones,
    buffs: doc.buffs.map((buff) => ({
      ...buff,
      sentences: buff.sentences.map(mapSentence),
    })),
    imports: doc.imports,
    triggers: doc.triggers,
    contests: doc.contests,
  };
}

/** Builds the `BuffDef` for a document declaration. */
function resolveImportedBuff(
  path: string,
  importedName: string,
  builtIns: BuffDictionary,
  resolver: CompileOptions['resolveImport'],
): BuffDef | undefined {
  return resolver?.(path, importedName);
}

interface PickDescriptor {
  readonly key: string;
  readonly span: { readonly start: number; readonly end: number };
}

/** When a sentence picks the ability's target, its normalized descriptor. */
function pickDescriptor(sentence: Sentence): PickDescriptor | undefined {
  const chars = charsOf(sentence);
  if (!chars || chars.quantifier !== 'target') return undefined;
  const conditions = chars.withClause?.conditions ?? [];
  const joiners = chars.withClause?.joiners ?? [];
  const text = conditions
    .map((c, i) => {
      const part =
        c.kind === 'gauge'
          ? `g:${c.gauge}${c.op}${c.value}`
          : `b:${c.buffName.toLowerCase()}`;
      return i === 0 ? part : `${joiners[i - 1] ?? 'and'}:${part}`;
    })
    .join(' ');
  const key = `${chars.who ?? 'any'}|${chars.owner ?? ''}|${text}`;
  return { key, span: chars.span };
}

function charsOf(sentence: Sentence): CharsPhrase | undefined {
  switch (sentence.kind) {
    case 'deal':
    case 'heal':
    case 'set':
    case 'increaseMax':
    case 'destroy':
    case 'addBuff':
    case 'removeBuff':
    case 'toggleBuff':
      return sentence.chars;
    case 'roll':
    case 'store':
    case 'draw':
    case 'scry':
    case 'revealCard':
    case 'castCard':
    case 'moveCard':
    case 'moveCards':
    case 'revealCards':
    case 'split':
    case 'removeCounters':
    case 'play':
    case 'create':
    case 'castCards':
    case 'choosePile':
    case 'zoneAbility':
    case 'choose':
    case 'reveal':
    case 'moveChosen':
    case 'result':
      return undefined;
  }
}

/** True when two players are on opposite sides (engine team semantics). */
/**
 * The merged dictionary an `Add`/`Remove` name resolves against: the
 * document's declarations win over the built-ins.
 */
function mergedDictionary(declared: readonly DictionaryEntry[], builtIns: BuffDictionary): BuffDictionary {
  const entries: DictionaryEntry[] = [...declared];
  for (const entry of builtIns.entries) {
    const taken = entries.some(
      (e) => slug(e.name) === slug(entry.name) || e.name.toLowerCase() === entry.name.toLowerCase(),
    );
    if (!taken) entries.push(entry);
  }
  return new BuffDictionary(entries);
}

/* --------------------------- preview helpers --------------------------- */
// Kept exported here for API compatibility — they read the AST and live in
// `describe.ts` (which `lower.ts` also uses, so it must not import this file).
export { charsToString, conditionToLatex, effectSummary, targetingSummary } from './describe.js';
