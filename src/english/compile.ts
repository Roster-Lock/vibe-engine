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
import { bindDocument, type DocumentIR } from '../ir/index.js';
import type { BuffSection, CharsPhrase, Diagnostic, Doc, Sentence } from './ast.js';
import { BuffDictionary, slug, type DictionaryEntry } from './dictionary.js';
import { lowerDocument } from './lower.js';
import { parseDocument } from './parser.js';

export interface CompileOptions {
  /** Buffs available to `Add`/`Remove` beyond the document's own `Buff` lines. */
  readonly dictionary?: BuffDictionary;
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
}

export function compileDocument(text: string, options: CompileOptions = {}): CompileResult {
  const parsed = parseDocument(text);
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
      declared.push({ name: section.name, def: { name: section.name, weight: section.weight, ...(section.stacks ? { stacks: true } : {}) } });
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

  const allSentences = [
    ...parsed.doc.abilities.flatMap((a) => a.sentences),
    ...parsed.doc.buffs.flatMap((b) => b.sentences),
  ];

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
  const bound = bindDocument(ir, { resolveBuff: (name) => resolver.resolve(name) });
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
      case 'destroy':
        return { ...sentence, chars: mapChars(sentence.chars) };
      case 'result':
        return sentence;
    }
  };
  return {
    abilities: doc.abilities.map((ability) => ({
      ...ability,
      sentences: ability.sentences.map(mapSentence),
    })),
    buffs: doc.buffs.map((buff) => ({
      ...buff,
      sentences: buff.sentences.map(mapSentence),
    })),
    imports: doc.imports,
    triggers: doc.triggers,
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
    case 'destroy':
    case 'addBuff':
    case 'removeBuff':
    case 'toggleBuff':
      return sentence.chars;
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
