/**
 * **Game rules** — the standing rules of a card game, as data.
 *
 * A turn is not a procedure with an untap step, an upkeep step and a draw
 * step baked into the game loop. It is a **rule set**: "at the start of your
 * turn, you gain a mana crystal", "at the start of your turn, the turn owner
 * draws a card". The loop asks the rules what happens and applies them.
 *
 * That reframing is what makes the rules *content*:
 *
 * - they are **inspectable** — a UI can list them, so a player can read the
 *   game they are playing instead of inferring it from behaviour;
 * - they are **replaceable by id** — a revealed card that says "draw two
 *   instead" adds a rule with the same id and the old one is gone, rather
 *   than two draw rules quietly stacking;
 * - they are **data**, so they can travel: the same reason the ability
 *   language compiles to IR rather than to closures (docs/GOAL.md).
 *
 * The action vocabulary belongs to the *game*, not to this module — a
 * Hearthstone-alike has mana crystals, a Magic-alike has a land drop. This
 * file owns only the shape: an id, a human name, a timing, who it affects,
 * and a list of actions for the host to interpret.
 */

/** When a standing rule applies. */
export type RuleTiming =
  /** The turn belongs to someone new: crystals, refill, wake, draw. */
  | 'turn:start'
  /** The turn is ending, before the engine's `turn:end` event. */
  | 'turn:end'
  /** A creature has just entered play (a rule that is about *that* creature, not the turn). */
  | 'creature:enters';

/** Whose side of the table a rule acts on. */
export type RuleScope =
  /** Only the player whose turn it is. */
  | 'turn-owner'
  /** Every player, every turn (a global rule). */
  | 'every-player';

/** One standing rule. `A` is the game's own action vocabulary. */
export interface GameRule<A = unknown> {
  /** Stable key. Adding a rule with an existing id **replaces** it. */
  readonly id: string;
  /** The rule in English, for a UI and for logs. */
  readonly name: string;
  readonly at: RuleTiming;
  readonly affects: RuleScope;
  /** What it does, in order. Interpreted by the host. */
  readonly actions: readonly A[];
}

/**
 * An ordered rule set.
 *
 * Order is declaration order and is meaningful: "gain a crystal" before
 * "refill mana" is what makes the refill include the new crystal, and a
 * game that reverses them gets a different game.
 */
export class GameRules<A = unknown> {
  readonly #rules: GameRule<A>[];

  constructor(rules: readonly GameRule<A>[] = []) {
    this.#rules = [...rules];
  }

  /** Every rule, in order — what a "the rules of this game" panel shows. */
  all(): readonly GameRule<A>[] {
    return this.#rules;
  }

  /** The rules that apply at one timing, in order. */
  at(timing: RuleTiming): readonly GameRule<A>[] {
    return this.#rules.filter((rule) => rule.at === timing);
  }

  get(id: string): GameRule<A> | undefined {
    return this.#rules.find((rule) => rule.id === id);
  }

  /**
   * Adds a rule, or **replaces the one with the same id**.
   *
   * Replace-by-id is the whole affordance for a revealed card that changes
   * the rules: "at the start of your turn, draw two instead" replaces
   * `draw`, and there is exactly one draw rule afterwards. Appending instead
   * would make the card's text silently additive and the rule list a lie.
   */
  add(rule: GameRule<A>): void {
    const existing = this.#rules.findIndex((candidate) => candidate.id === rule.id);
    if (existing === -1) this.#rules.push(rule);
    else this.#rules[existing] = rule;
  }

  /** Removes a rule by id. Returns whether one was there. */
  remove(id: string): boolean {
    const index = this.#rules.findIndex((rule) => rule.id === id);
    if (index === -1) return false;
    this.#rules.splice(index, 1);
    return true;
  }

  /** The rules as English lines — for a log or a panel. */
  describe(): string[] {
    return this.#rules.map((rule) => rule.name);
  }
}
