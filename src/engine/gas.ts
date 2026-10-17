/**
 * Gas — a budget of work, so a loop that never ends ends anyway.
 *
 * A card game lets players write rules that trigger other rules. Most of them stop;
 * some do not (a trigger that deals damage to the thing it triggers on, a formula
 * that sums a billion terms, a pair of triggers that each start the other). The
 * engine already caps *depth* — a chain of applies nested a hundred deep — but a loop
 * does not have to go deep: two triggers per trigger is wide, not deep, and a
 * `Σ` is one node. What they share is that they **do a lot of work**, so that is what
 * is counted.
 *
 * Every unit of work spends gas: running an action, firing a trigger, running an
 * effect, going round a loop, asking a player something, evaluating a node of a
 * formula. A *scope* — one move, one ability, one top-level `apply` — has a budget;
 * when it runs out, the work stops with an `OutOfGasError` that says where and what
 * it was doing. The next scope starts with a full budget, so a long game is never
 * starved by the work of an earlier turn.
 *
 * A game that gets stuck in a **mandatory** loop (one that nobody can choose to stop)
 * is a draw, as in Magic's rules; `Game.runLoop` ends it that way.
 *
 * Nested scopes share the outermost one's budget: a trigger that fires during a move
 * is part of that move's work.
 */

/** What a unit of work costs, by kind. */
export interface GasCosts {
  /** Running one action through the pipeline. */
  readonly action: number;
  /** Firing one triggered ability. */
  readonly trigger: number;
  /** Running one effect of an ability. */
  readonly effect: number;
  /** Going round a loop once (a `Repeat`, a state-based rule pass). */
  readonly loop: number;
  /** Asking a player to choose. */
  readonly ask: number;
  /** Evaluating one node of a formula. */
  readonly math: number;
}

export const DEFAULT_GAS_COSTS: GasCosts = {
  action: 1,
  trigger: 2,
  effect: 1,
  loop: 1,
  ask: 1,
  math: 1,
};

/**
 * Default budget per scope. Measured over full games, the busiest single move used
 * a few dozen units, and a board wipe with death triggers a few hundred; this is
 * well over an order of magnitude above even that, and low enough that a runaway
 * loop is stopped in milliseconds rather than after a long wait.
 */
export const DEFAULT_GAS_LIMIT = 10_000;

export interface GasOptions {
  /** The budget of one scope. `Infinity` turns metering off. */
  readonly limit?: number;
  readonly costs?: Partial<GasCosts>;
}

/** One step of the trail an `OutOfGasError` carries: what ran, and how many times in a row. */
export interface GasTrailEntry {
  readonly what: string;
  readonly times: number;
}

/** Thrown when a scope spends more than its budget. */
export class OutOfGasError extends Error {
  /** Set by the engine once it has announced `gas:exhausted`, so it is announced once. */
  announced = false;

  constructor(
    readonly label: string,
    readonly used: number,
    readonly limit: number,
    readonly trail: readonly GasTrailEntry[],
  ) {
    super(
      `Out of gas in "${label}": used ${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} — ` +
        `this looks like an infinite loop. Most recent work: ` +
        `${trail.map((entry) => (entry.times > 1 ? `${entry.what} ×${entry.times}` : entry.what)).join(', ')}. ` +
        `If this work is legitimate, raise the engine's gas limit.`,
    );
    this.name = 'OutOfGasError';
  }
}

/** How many distinct recent steps an `OutOfGasError` remembers. */
const TRAIL_LENGTH = 8;

export class GasMeter {
  readonly #limit: number;
  readonly #costs: GasCosts;
  #used = 0;
  #depth = 0;
  #label = '';
  #peak = 0;
  #trail: { what: string; times: number }[] = [];

  constructor(options: GasOptions = {}) {
    this.#limit = options.limit ?? DEFAULT_GAS_LIMIT;
    this.#costs = { ...DEFAULT_GAS_COSTS, ...options.costs };
  }

  /** The budget of one scope. */
  get limit(): number {
    return this.#limit;
  }

  /** What the current scope has spent; 0 outside one. */
  get used(): number {
    return this.#used;
  }

  get remaining(): number {
    return Math.max(0, this.#limit - this.#used);
  }

  /** The most any scope has spent so far — for tuning the limit against real games. */
  get peak(): number {
    return this.#peak;
  }

  /** True inside a scope. */
  get active(): boolean {
    return this.#depth > 0;
  }

  /**
   * Spends gas for `times` units of `kind` of work. Outside a scope it is free: the
   * engine's entry points all open one, so nothing it does can run unmetered, and
   * work done by a caller on its own account is the caller's to bound.
   *
   * @throws OutOfGasError when the scope's budget is exceeded.
   */
  spend(kind: keyof GasCosts, what?: string, times = 1): void {
    if (this.#depth === 0) return;
    this.#used += this.#costs[kind] * times;
    this.#record(what ? `${kind}:${what}` : kind);
    if (this.#used > this.#limit) {
      throw new OutOfGasError(this.#label, this.#used, this.#limit, this.#trail.slice());
    }
  }

  /**
   * Runs `fn` as a scope. Called inside a scope it joins it and shares its budget;
   * called outside one it starts a fresh budget and ends it afterwards.
   */
  async scope<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    if (this.#depth > 0) {
      this.#depth += 1;
      try {
        return await fn();
      } finally {
        this.#depth -= 1;
      }
    }
    this.#used = 0;
    this.#label = label;
    this.#trail = [];
    this.#depth = 1;
    try {
      return await fn();
    } finally {
      this.#peak = Math.max(this.#peak, this.#used);
      this.#depth = 0;
    }
  }

  #record(what: string): void {
    const last = this.#trail[this.#trail.length - 1];
    if (last && last.what === what) {
      last.times += 1;
      return;
    }
    this.#trail.push({ what, times: 1 });
    if (this.#trail.length > TRAIL_LENGTH) this.#trail.shift();
  }
}
