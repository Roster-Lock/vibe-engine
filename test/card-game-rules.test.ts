/**
 * Game rules (`src/games/cards/rules.ts`).
 *
 * The start-of-turn steps are not a procedure in `collectUserDecisions` —
 * they are a **rule set**: data with a name, a timing, a scope and a list of
 * actions. These tests pin the two things that buys:
 *
 * 1. the rules are the upkeep (apply them and the turn happens), and
 * 2. they are **content** — a revealed card can add, replace or remove one,
 *    and the game changes without touching the loop.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import { WISP, type Card } from '../examples/card-game/cards.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { CARD_RULES, type CardRule, type CardRuleAction } from '../examples/card-game/rules.js';
import type { RuleTiming } from '../src/games/cards/rules.js';

class ScriptedCardPlayer extends CardPlayer {
  #script: ((game: CardGame) => Move)[] = [];

  script(...moves: ((game: CardGame) => Move)[]): this {
    this.#script = [...moves];
    return this;
  }

  override async chooseMove(game: CardGame): Promise<Move> {
    const next = this.#script.shift();
    return next ? next(game) : { kind: 'end' };
  }
}

const deckOf = (card: Card, n = 30): Card[] => Array.from({ length: n }, () => card);

function match(rules?: readonly CardRule[]) {
  const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(WISP));
  const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(WISP));
  const game = new CardGame([alice, bob], {
    log: () => {},
    openingHand: 3,
    ...(rules ? { rules } : {}),
  });
  return { game, alice, bob };
}

/** A rule, written the way a card would contribute one. */
function rule(overrides: Partial<CardRule> & { actions: readonly CardRuleAction[] }): CardRule {
  return {
    id: 'test',
    name: 'A test rule.',
    at: 'turn:start',
    affects: 'turn-owner',
    ...overrides,
  };
}

describe('the standing rules are data', () => {
  it('reads as the game in English, in the order they apply', () => {
    expect(CARD_RULES.map((r) => r.id)).toEqual(['crystal', 'refill', 'wake', 'summoning-sickness', 'draw']);
    expect(CARD_RULES[0]!.name).toContain('mana crystal');
    expect(CARD_RULES[4]!.name).toBe('At the start of a turn, the turn owner draws a card.');
    // Every rule names a timing and a scope, so a UI can lay them out.
    for (const entry of CARD_RULES) {
      expect(entry.at).toBe<RuleTiming>(entry.id === 'summoning-sickness' ? 'creature:enters' : 'turn:start');
      expect(entry.affects).toBe('turn-owner');
    }
  });

  it('is exposed on the game, listable and describable', () => {
    const { game } = match();
    expect(game.rules.all()).toHaveLength(5);
    expect(game.rules.describe()).toEqual(CARD_RULES.map((r) => r.name));
    expect(game.rules.at('turn:end')).toEqual([]);
  });
});

describe('applying the rules is the upkeep', () => {
  it('runs a crystal, a refill, a wake and a draw at the start of a turn', async () => {
    const { game, alice } = match();
    await game.setup();
    const side = game.sideOf(alice);
    expect(side.hand.size).toBe(3);
    expect(side.mana).toBe(0);

    await game.collectUserDecisions();

    expect(side.crystals).toBe(1);
    expect(side.mana).toBe(1);
    expect(side.hand.size).toBe(4); // the draw rule
  });

  it('runs turn:end rules when a turn ends then', async () => {
    const { game, alice } = match([
      ...CARD_RULES,
      rule({
        id: 'study',
        name: 'At the end of a turn, the turn owner draws a card.',
        at: 'turn:end',
        actions: [{ kind: 'draw', count: 1 }],
      }),
    ]);
    await game.setup();
    const side = game.sideOf(alice);

    await game.collectUserDecisions();
    expect(side.hand.size).toBe(4);
    await game.runGame(); // the pass ends the turn, applying turn:end first
    expect(side.hand.size).toBe(5);
  });

  it('refuses an action it does not know rather than skipping a rule', async () => {
    const unknown = { kind: 'teleport' } as unknown as CardRuleAction;
    const { game } = match([
      ...CARD_RULES,
      rule({ id: 'beyond', name: 'A rule from a newer version.', actions: [unknown] }),
    ]);
    await game.setup();
    await expect(game.collectUserDecisions()).rejects.toThrow(/rule "beyond" uses an unknown action "teleport"/);
  });
});

describe('a revealed card can change the rules', () => {
  it('replaces a rule by id — one draw rule, doubled', async () => {
    const { game, alice } = match();
    await game.setup();

    // "…draw two instead": the same id, so the base rule is replaced, not
    // stacked on top of.
    game.rules.add(
      rule({
        id: 'draw',
        name: 'When your turn starts then draw two cards.',
        actions: [{ kind: 'draw', count: 2 }],
      }),
    );

    expect(game.rules.at('turn:start').filter((r) => r.id === 'draw')).toHaveLength(1);
    await game.collectUserDecisions();
    expect(game.sideOf(alice).hand.size).toBe(5); // 3 + 2
  });

  it('adds a rule alongside the others', async () => {
    const { game, alice, bob } = match();
    await game.setup();

    game.rules.add(
      rule({
        id: 'inspiration',
        name: 'When your turn starts then draw an extra card.',
        actions: [{ kind: 'draw', count: 1 }],
      }),
    );

    await game.collectUserDecisions();
    // The base draw and the added one: 3 + 2.
    expect(game.sideOf(alice).hand.size).toBe(5);
    // Bob is untouched: the added rule is a `turn-owner` rule.
    expect(game.sideOf(bob).hand.size).toBe(4); // opening hand + the coin
  });

  it('affects every player when the rule says so', async () => {
    const { game, alice, bob } = match();
    await game.setup();
    const before = { alice: game.sideOf(alice).hand.size, bob: game.sideOf(bob).hand.size };

    game.rules.add(
      rule({
        id: 'gift',
        name: 'At the start of a turn, every player draws a card.',
        affects: 'every-player',
        actions: [{ kind: 'draw', count: 1 }],
      }),
    );

    await game.collectUserDecisions();
    expect(game.sideOf(alice).hand.size).toBe(before.alice + 2); // turn-owner draw + gift
    expect(game.sideOf(bob).hand.size).toBe(before.bob + 1); // gift only
  });

  it('removes a rule outright', async () => {
    const { game, alice } = match();
    await game.setup();
    expect(game.rules.remove('draw')).toBe(true);
    expect(game.rules.remove('draw')).toBe(false);

    await game.collectUserDecisions();
    expect(game.sideOf(alice).hand.size).toBe(3); // no draw
    // The rest of the upkeep still ran.
    expect(game.sideOf(alice).crystals).toBe(1);
  });

  it('can be given a whole rule set by the host', async () => {
    const { game, alice } = match([
      rule({ id: 'refill', name: 'When your turn starts then your mana refills.', actions: [{ kind: 'refill-mana' }] }),
    ]);
    await game.setup();
    await game.collectUserDecisions();
    // Only the rule we supplied: no crystal, no draw.
    expect(game.sideOf(alice).crystals).toBe(0);
    expect(game.sideOf(alice).hand.size).toBe(3);
  });
});
