/**
 * Loads the content: reads `abilities.rts`, compiles it, and hands back a
 * program plus its diagnostics.
 *
 * Reading the file happens *here*, not in the compiler — `compileDocument`
 * takes a string and never touches the filesystem, so the same compiler
 * runs unchanged in a browser editor, in a test, or against text pasted
 * from another player. The parent project draws the line in the same place
 * and for the same reason (`src/english/compile.ts`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileDocument, type CompileResult } from '../english/compile.js';
import { SUMMONABLE } from './units.js';

export const ABILITIES_PATH = fileURLToPath(new URL('./abilities.rts', import.meta.url));

/** The ability document as text. */
export function readAbilitySource(): string {
  return readFileSync(ABILITIES_PATH, 'utf8');
}

/** Compiles the shipped ability document. */
export function loadContent(source = readAbilitySource()): CompileResult {
  return compileDocument(source, { units: SUMMONABLE });
}

export * from './units.js';
