/**
 * Buff inspection for the editor: given a document and a cursor offset,
 * find the buff name the cursor is on (a reference after `Add`/`Remove`/
 * `with`, or a `Buff` declaration heading) and describe what that buff is.
 *
 * The Monaco layer turns `buffReferenceInfo` into hover tooltips and
 * Ctrl/Cmd+Click "go to declaration"; the unit tests check the same logic
 * headlessly.
 */
import type { BuffSection, Span } from './ast.js';
import type { BuffDef } from '../engine/index.js';
import { compileDocument, effectSummary } from './compile.js';

export interface BuffReferenceInfo {
  /** The buff's display name (as declared / as built in). */
  readonly name: string;
  /** The span of the buff name under the cursor. */
  readonly span: Span;
  /** True when a `Buff …` line in the same document defines it. */
  readonly declared: boolean;
  /** The declaring section, when declared in the document. */
  readonly section: BuffSection | undefined;
  /** The engine definition, when the name is built in. */
  readonly def: BuffDef | undefined;
}

const contains = (span: Span, offset: number): boolean => span.start <= offset && offset < span.end;

/** Finds the buff name at `offset`, if the cursor is on one. */
export function buffReferenceInfo(
  text: string,
  offset: number,
  options: import('./compile.js').CompileOptions = {},
): BuffReferenceInfo | undefined {
  const compiled = compileDocument(text, options);
  const doc = compiled.doc;

  // A `Buff` declaration heading.
  for (const section of doc.buffs) {
    if (contains(section.nameSpan, offset)) {
      return { name: section.name, span: section.nameSpan, declared: true, section, def: undefined };
    }
  }

  // Buff references inside sentences: `Add <buff> to …`, `Remove <buff>
  // from …`, and buff conditions in `with …` clauses.
  const allSentences = [
    ...doc.abilities.flatMap((a) => a.sentences),
    ...doc.buffs.flatMap((b) => b.sentences),
  ];
  for (const sentence of allSentences) {
    if (sentence.kind === 'addBuff' || sentence.kind === 'removeBuff') {
      if (contains(sentence.buffSpan, offset)) {
        return resolveReference(sentence.buffName, sentence.buffSpan, doc.buffs, options);
      }
    }
    const chars =
      sentence.kind === 'deal' || sentence.kind === 'heal' || sentence.kind === 'destroy' || sentence.kind === 'addBuff' || sentence.kind === 'removeBuff'
        ? sentence.chars
        : undefined;
    for (const condition of chars?.withClause?.conditions ?? []) {
      if (condition.kind === 'buff' && contains(condition.buffSpan, offset)) {
        return resolveReference(condition.buffName, condition.buffSpan, doc.buffs, options);
      }
    }
  }
  return undefined;
}

function resolveReference(
  name: string,
  span: Span,
  declared: readonly BuffSection[],
  options: import('./compile.js').CompileOptions,
): BuffReferenceInfo {
  const declaredSection = declared.find(
    (section) =>
      section.name.toLowerCase() === name.toLowerCase() || slugOf(section.name) === slugOf(name),
  );
  if (declaredSection) {
    return { name, span, declared: true, section: declaredSection, def: undefined };
  }
  const builtinDef = options.dictionary?.resolve(name);
  if (builtinDef) {
    return { name: builtinDef.name, span, declared: false, section: undefined, def: builtinDef };
  }
  return { name, span, declared: false, section: undefined, def: undefined };
}

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A short markdown description of the buff under the cursor: what it is,
 * and — when supplied by a host — the abilities that make it do something.
 */
export function describeBuffReference(info: BuffReferenceInfo): string {
  if (info.declared && info.section) {
    const section = info.section;
    const options = [
      `weight ${section.weight}`,
      ...(section.fading !== undefined ? [`Fading ${section.fading}`] : []),
    ].join(', ');
    const eventLabel = (ev: string): string =>
      ev === 'turn:start' ? 'when a turn starts' : ev === 'turn:end' ? 'when a turn ends' : ev;
    const effectDescs = section.sentences.map((s) => s.event ? `[${eventLabel(s.event)}] ${effectSummary(s)}` : effectSummary(s)).join('\n');
    return (
      `**${section.name}** — declared in this document\n\n` +
      `_${options}_\n\n` +
      (effectDescs ? `**Effects:**\n${effectDescs}` : '_Declared marker buff_')
    );
  }
  if (info.def) return describeEngineBuff(info.def);
  return `**${info.name}**`;
}

/** A readable summary of an engine buff's definition (built-in names). */
export function describeEngineBuff(def: BuffDef): string {
  const lines: string[] = [`**${def.name}** — built-in or host-supplied buff`];
  if (def.description) lines.push(`> ${def.description}`);
  const facts: string[] = [`weight ${def.weight}`];
  if (def.removable === false) facts.push('not removable');
  if (def.removedOnDefeat === false) facts.push('survives its wearer');
  lines.push(`_${facts.join(', ')}_`);
  const abilityLines: string[] = [];
  for (const ability of def.abilities ?? []) {
    switch (ability.kind) {
      case 'trigger':
        abilityLines.push(
          `- **${ability.name}** — triggers on \`${ability.event}\`${ability.description ? ` — ${ability.description}` : ''}`,
        );
        break;
      case 'stat':
        abilityLines.push(
          `- **${ability.name}** — while attached, derives ${ability.gauge ? `max ${ability.gauge}` : `the stat \`${ability.stat}\``}`,
        );
        break;
      case 'manual':
        abilityLines.push(`- **${ability.name}** — activated by its wearer's player`);
        break;
      case 'passive':
        abilityLines.push(`- **${ability.name}** — transforms actions flowing past its wearer`);
        break;
      case 'transformModifier':
        abilityLines.push(`- **${ability.name}** — ties the wearer's form while attached`);
        break;
      case 'restriction':
        abilityLines.push(`- **${ability.name}** — restricts what can happen to its wearer`);
        break;
    }
  }
  if (abilityLines.length > 0) lines.push(...abilityLines);
  else lines.push('_No abilities — a plain marker buff._');
  return lines.join('\n\n');
}
