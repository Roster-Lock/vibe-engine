/**
 * The action registry — how the engine learns to *execute* what `ActionMap`
 * declares.
 *
 * `ActionMap` (contracts.ts) makes the action vocabulary open at the type
 * level: a game merges in `summon` and the union widens, so `Action` narrows
 * on it, `apply` accepts it, and the restriction gates see it. Types alone
 * cannot run it, though. This registry is the runtime half — the map says what
 * an action *is*, the registry says what it *does*:
 *
 * ```ts
 * declare module 'vibe-engine/contracts' {
 *   interface ActionMap {
 *     summon: SummonAction;
 *   }
 * }
 *
 * engine.actions.register('summon', async (action, ctx) => {
 *   // `action` is narrowed to SummonAction here — no cast, no switch
 *   ctx.engine.registerCharacter(action.unit);
 * });
 * ```
 *
 * The engine's own nine actions are registered the same way, in its
 * constructor — they are shipped content, not a privileged category. That is
 * what replaces the closed `switch` in `GameEngine.#execute`, and it is
 * strictly better than a `switch` over an open union: a switch with no
 * `default` silently does nothing for an action it has never heard of, whereas
 * a missing registration is a loud error naming the tag.
 *
 * ## Why the storage is type-erased
 *
 * The map is heterogeneous — one handler per action tag, each with a different
 * narrowed parameter. `register` is the only entry point and its signature
 * ties each handler to its own action type, so the erasure is sound by
 * construction; the single cast below is where that guarantee is asserted. The
 * alternative (a mapped type of handler per tag, plus a generic lookup) buys
 * nothing here because dispatch is inherently dynamic — the tag comes from a
 * value at runtime.
 */
import type { Action } from './contracts.js';
import type { Character } from './character.js';
import type { GameEngine } from './engine.js';
import type { EventSource } from './events.js';

/**
 * What a handler is given besides the action itself.
 *
 * Deliberately not `ActionContext` from `actions.ts`: that one is the
 * *transformer* context and carries a `target` and the owning `status`, which
 * have no meaning at execution time. This is the smaller set an executor
 * actually has.
 */
export interface ActionExecutionContext {
  /** The engine running the action. */
  readonly engine: GameEngine;
  /**
   * Who is responsible: a character, or a buff doing its thing. Taken from the
   * action's own `source` when it set one, else from `apply`'s context.
   */
  readonly source: EventSource | undefined;
}

/** Executes one action of type `A`. May be async; the engine awaits it. */
export type ActionHandler<A extends Action = Action> = (
  action: A,
  ctx: ActionExecutionContext,
) => void | Promise<void>;

/** The type-erased handler shape the registry stores. */
type StoredHandler = (action: Action, ctx: ActionExecutionContext) => void | Promise<void>;

/** Resolves the character an action acts on, when it has one. */
export type SubjectResolver<A extends Action = Action> = (action: A) => Character | undefined;

/** What a registration may declare besides the handler. */
export interface ActionRegistration<A extends Action = Action> {
  /**
   * The character this action acts on, if any.
   *
   * This is what the restriction gates and the incoming transformer pass run
   * against, so an action that omits it is treated as having **no character
   * subject**: passives cannot modify it and restrictions cannot block it. That
   * is right for a board-wide or game-ending action, and wrong for an action
   * aimed at a character — so an action that targets one must say how to find
   * it.
   *
   * ```ts
   * engine.actions.register('burn', handler, { subject: (a) => a.victim });
   * ```
   */
  readonly subject?: SubjectResolver<A>;
}

export class ActionRegistry {
  readonly #handlers = new Map<string, StoredHandler>();
  readonly #subjects = new Map<string, SubjectResolver>();

  /**
   * Teaches the engine how to execute an action. The handler's parameter is
   * narrowed to the action declared under `type` in `ActionMap`, so its fields
   * are reachable without a cast.
   *
   * Registering the same tag twice throws. The engine registers its built-ins
   * first, so a second registration means two handlers disagreeing about one
   * action — almost always a copy-paste tag — and silently letting the later
   * one win would hide it.
   */
  register<T extends Action['type']>(
    type: T,
    handler: ActionHandler<Extract<Action, { type: T }>>,
    options: ActionRegistration<Extract<Action, { type: T }>> = {},
  ): this {
    if (this.#handlers.has(type)) {
      throw new Error(
        `ActionRegistry: a handler for "${type}" is already registered`,
      );
    }
    // Sound by construction: `handler` accepts the action that `type` names,
    // and the only way to reach it is `get(type)` with that same tag.
    this.#handlers.set(type, handler as StoredHandler);
    if (options.subject) {
      this.#subjects.set(type, options.subject as SubjectResolver);
    }
    return this;
  }

  /**
   * Declares an action's character subject **without** registering a handler.
   *
   * For an action the engine executes by another path: `gauge` is batched and
   * settled rather than dispatched, so it has no handler, but it still needs a
   * subject or the restriction gates and the incoming transformer pass would
   * stop seeing the character whose gauge is being written.
   */
  subject<T extends Action['type']>(
    type: T,
    resolve: SubjectResolver<Extract<Action, { type: T }>>,
  ): this {
    this.#subjects.set(type, resolve as SubjectResolver);
    return this;
  }

  /** The handler for an action tag, or undefined when none is registered. */
  get(type: string): StoredHandler | undefined {
    return this.#handlers.get(type);
  }

  /**
   * The character an action acts on, or undefined when it has no character
   * subject (a board-wide effect, a game-ending declaration, or an action
   * whose registration did not declare one).
   */
  subjectOf(action: Action): Character | undefined {
    return this.#subjects.get(action.type)?.(action);
  }

  /** Whether an action tag has a handler. */
  has(type: string): boolean {
    return this.#handlers.has(type);
  }

  /** Every registered action tag, in registration order. */
  get registered(): readonly string[] {
    return [...this.#handlers.keys()];
  }
}
