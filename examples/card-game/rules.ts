/**
 * The card game's **standing rules**, as data.
 *
 * These used to be four hard-coded steps at the top of
 * `CardGame.collectUserDecisions` — a crystal, a mana refill, waking the
 * board, a draw. They are now a *rule set* (`src/games/cards/rules.ts`), so
 * they can be read, logged, listed in the UI, and **changed by content**.
 *
 * The action vocabulary is deliberately small and declarative: a rule says
 * *what* happens (`gain-crystal`), never *how*. That is what lets a future
 * revealed card add a rule without reaching into the game loop:
 *
 * ```ts
 * // "At the start of your turn, draw an extra card."
 * game.rules.add({
 *   id: 'inspiration',
 *   name: 'At the start of your turn, draw an extra card.',
 *   at: 'turn:start',
 *   affects: 'turn-owner',
 *   actions: [{ kind: 'draw', count: 1 }],
 * });
 *
 * // "…draw two instead": same id, so it *replaces* the base rule.
 * game.rules.add({ id: 'draw', …, actions: [{ kind: 'draw', count: 2 }] });
 * ```
 */
import type { GameRule } from '../../src/games/cards/rules.js';

/** What one card-game rule can do. Data, not a closure. */
export type CardRuleAction =
  /** One mana crystal, up to the ceiling. The hero's mana max is derived. */
  | { readonly kind: 'gain-crystal' }
  /** The hero's mana back to its maximum. */
  | { readonly kind: 'refill-mana' }
  /** The side's creatures may attack again this turn. */
  | { readonly kind: 'wake-creatures' }
  /** Draws cards (fatigue applies when the deck runs out). */
  | { readonly kind: 'draw'; readonly count: number }
  /**
   * The creature that just entered play cannot act — use an ability, attack — until its
   * controller's next turn, except as its card says (`This can attack the turn it enters
   * play.`, Charge). Only meaningful at `creature:enters`.
   */
  | { readonly kind: 'summoning-sickness' };

export type CardRule = GameRule<CardRuleAction>;

/**
 * The rules every match starts with — read top to bottom, this *is* the
 * upkeep. Order matters: the crystal lands before the refill, so the refill
 * includes it, and the draw comes last.
 */
export const CARD_RULES: readonly CardRule[] = [
  {
    id: 'crystal',
    name: 'At the start of your turn, you gain a mana crystal (up to ten).',
    at: 'turn:start',
    affects: 'turn-owner',
    actions: [{ kind: 'gain-crystal' }],
  },
  {
    id: 'refill',
    name: 'At the start of your turn, your mana refills.',
    at: 'turn:start',
    affects: 'turn-owner',
    actions: [{ kind: 'refill-mana' }],
  },
  {
    id: 'wake',
    name: 'At the start of your turn, your creatures wake up.',
    at: 'turn:start',
    affects: 'turn-owner',
    actions: [{ kind: 'wake-creatures' }],
  },
  {
    id: 'summoning-sickness',
    name: 'A creature cannot act the turn it enters play.',
    at: 'creature:enters',
    // The side the creature enters on, not whoever's turn it is.
    affects: 'turn-owner',
    actions: [{ kind: 'summoning-sickness' }],
  },
  {
    id: 'draw',
    name: 'At the start of a turn, the turn owner draws a card.',
    at: 'turn:start',
    affects: 'turn-owner',
    actions: [{ kind: 'draw', count: 1 }],
  },
];
