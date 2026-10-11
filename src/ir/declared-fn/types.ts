/**
 * The shared plumbing every DeclaredFn category (variable, boolean, math,
 * iteration, action) builds on: the context a node evaluates against, the
 * phantom-typed wrapper that keeps `Input`/`Output` visible at construction
 * sites, and the recursive-evaluator signature category files take as a
 * parameter instead of importing the dispatcher directly (so the category
 * files and `index.ts`'s dispatcher can reference each other's *types*
 * without a value-level import cycle).
 */
import type { Character } from '../../engine/character.js';
import type { GameEngine } from '../../engine/engine.js';
import type { Status } from '../../engine/status/index.js';
import type { DeclaredFn } from './index.js';

/** The context every DeclaredFn evaluates against. */
export interface DeclaredFnContext {
  /** The character that owns the ability this DeclaredFn belongs to. */
  readonly self: Character;
  readonly engine: GameEngine;
  /** The buff/skill that owns the ability — `'vars'` reads/writes live here. */
  readonly status: Status;
}

/** Phantom-typed so distinct `Input`/`Output` instantiations don't structurally collapse. */
export type Phantom<Input, Output> = { readonly __phantom?: (input: Input) => Output };

/**
 * Recurses back into the dispatcher (`index.ts`'s `evaluateNode`). Passed
 * into each category's `evaluate*Node` function as a parameter — category
 * files never import the dispatcher itself, only this signature.
 */
export type Evaluate = (fn: AnyDeclaredFn, input: unknown, ctx: DeclaredFnContext) => unknown;

/** A DeclaredFn with its `Input`/`Output` erased — what the evaluator actually operates on. */
export type AnyDeclaredFn = DeclaredFn<any, any>;
