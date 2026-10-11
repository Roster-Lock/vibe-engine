/**
 * Cross-file definition index used by the content compiler and editor.
 * Equivalent definitions share one candidate and retain every source location.
 */
import type { BuffDef, CharacterDef, SkillDef } from '../engine/index.js';
import { slug } from './dictionary.js';
import { parseDocument } from './parser.js';

export type DefinitionKind = 'character' | 'buff' | 'skill';

export interface DefinitionLocation {
  readonly filePath: string;
  readonly line: number;
  readonly start?: number;
  readonly end?: number;
}

export interface DefinitionCandidate<T> {
  readonly value: T;
  locations: readonly DefinitionLocation[];
}

export type DefinitionMap<T> = ReadonlyMap<string, readonly DefinitionCandidate<T>[]>;

export interface DefinitionSource {
  readonly filePath: string;
  readonly text: string;
}

/** The definitions visible across a compilation unit. */
export class DefinitionIndex {
  readonly #characters = new Map<string, DefinitionCandidate<CharacterDef>[]>();
  readonly #buffs = new Map<string, DefinitionCandidate<BuffDef>[]>();
  readonly #skills = new Map<string, DefinitionCandidate<SkillDef>[]>();

  get characters(): DefinitionMap<CharacterDef> {
    return this.#characters;
  }

  get buffs(): DefinitionMap<BuffDef> {
    return this.#buffs;
  }

  get skills(): DefinitionMap<SkillDef> {
    return this.#skills;
  }

  /** Adds a definition, merging it with an equivalent candidate if present. */
  add<T extends CharacterDef | BuffDef | SkillDef>(
    kind: DefinitionKind,
    title: string,
    value: T,
    location: DefinitionLocation,
  ): DefinitionCandidate<T> {
    const entries = this.mapFor<T>(kind);
    const key = slug(title);
    const candidates = entries.get(key) ?? [];
    const equivalent = candidates.find((candidate) => equivalentValue(candidate.value, value));
    if (equivalent) {
      equivalent.locations = [...equivalent.locations, location];
      return equivalent;
    }
    const candidate: DefinitionCandidate<T> = { value, locations: [location] };
    candidates.push(candidate);
    entries.set(key, candidates);
    return candidate;
  }

  /** Creates an unresolved title entry without inventing a definition. */
  ensure(kind: DefinitionKind, title: string): void {
    const entries = this.mapFor(kind);
    const key = slug(title);
    if (!entries.has(key)) entries.set(key, []);
  }

  /** Returns the candidates for a title, including an empty unresolved entry. */
  candidates<T extends CharacterDef | BuffDef | SkillDef>(
    kind: DefinitionKind,
    title: string,
  ): readonly DefinitionCandidate<T>[] | undefined {
    return this.mapFor<T>(kind).get(slug(title));
  }

  /** Resolves only an unambiguous title. */
  resolve<T extends CharacterDef | BuffDef | SkillDef>(kind: DefinitionKind, title: string): T | undefined {
    const candidates = this.candidates<T>(kind, title);
    return candidates?.length === 1 ? candidates[0]!.value : undefined;
  }

  private mapFor<T extends CharacterDef | BuffDef | SkillDef>(kind: DefinitionKind): Map<string, DefinitionCandidate<T>[]> {
    switch (kind) {
      case 'character':
        return this.#characters as Map<string, DefinitionCandidate<T>[]>;
      case 'buff':
        return this.#buffs as Map<string, DefinitionCandidate<T>[]>;
      case 'skill':
        return this.#skills as Map<string, DefinitionCandidate<T>[]>;
    }
  }
}

/** Indexes every currently supported definition and reference in a file set. */
export function indexDocuments(sources: readonly DefinitionSource[]): {
  readonly index: DefinitionIndex;
  readonly parsed: readonly ReturnType<typeof parseDocument>[];
} {
  const index = new DefinitionIndex();
  const parsed = sources.map((source) => ({ source, result: parseDocument(source.text) }));

  for (const { source, result } of parsed) {
    for (const section of result.doc.buffs) {
      index.add('buff', section.name, buffDefinitionOf(section), {
        filePath: source.filePath,
        line: lineAt(source.text, section.nameSpan.start),
        start: section.nameSpan.start,
        end: section.nameSpan.end,
      });
    }
    for (const ability of result.doc.abilities) {
      for (const sentence of ability.sentences) {
        if (sentence.kind === 'addBuff' || sentence.kind === 'removeBuff') {
          index.ensure('buff', sentence.buffName);
        }
        const chars = sentence.kind === 'deal' || sentence.kind === 'heal' || sentence.kind === 'destroy' || sentence.kind === 'addBuff' || sentence.kind === 'removeBuff'
          ? sentence.chars
          : undefined;
        for (const condition of chars?.withClause?.conditions ?? []) {
          if (condition.kind === 'buff') index.ensure('buff', condition.buffName);
        }
      }
    }
  }

  return { index, parsed: parsed.map(({ result }) => result) };
}

function buffDefinitionOf(section: { name: string; weight: number; stacks: boolean }): BuffDef {
  return section.stacks
    ? { name: section.name, weight: section.weight, stacks: true }
    : { name: section.name, weight: section.weight };
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') line += 1;
  }
  return line;
}

function equivalentValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => equivalentValue(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => equivalentValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
