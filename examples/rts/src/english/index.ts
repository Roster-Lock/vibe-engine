/**
 * The RTS Ability Language — English-shaped text that compiles into a
 * runnable program.
 *
 * ```ts
 * const { program, diagnostics } = compileDocument(`
 *   Ability Thunder Clap
 *   Cooldown 8 seconds
 *   Deal 100 damage to all enemy units within 300 range of this unit.
 * `);
 * ```
 *
 * From `program` you can either interpret (`new AbilityRuntime(program)`)
 * or print TypeScript (`generateModule(program, 'abilities.rts')`).
 */
export type { Diagnostic, Doc, Severity, Span } from './ast.js';
export type { Token, TokenKind } from './lexer.js';
export { lex, lineColAt } from './lexer.js';
export type { ParseResult } from './parser.js';
export { parseDocument } from './parser.js';
export type { CompileOptions, CompileResult } from './compile.js';
export { compileDocument } from './compile.js';
export { generateModule, identifier } from './codegen.js';
export type { CastApi, CastTarget, CompiledAbility, RuntimeOptions } from './runtime.js';
export { AbilityRuntime } from './runtime.js';
export { WORD_DOCS } from './vocabulary.js';
