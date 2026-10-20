/**
 * Game rules (`examples/card-game/rules.ts`).
 *
 * The start-of-turn steps are not a procedure in `collectUserDecisions` —
 * they are **rule cards** (`"type": "rule"`): English with no cost, no owner and
 * no controller, in force for the whole game. These tests pin the two things that buys:
 *
 * 1. the rules are the upkeep (apply them and the turn happens), and
 * 2. they are **content** — a card document can add, replace or remove one,
 *    and the game changes without touching the loop.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import { WISP, type Card } from '../examples/card-game/cards.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { playableCards } from '../examples/card-game/english.js';
import { CARD_RULES, RULE_BUFFS } from '../examples/card-game/rules.js';

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

function match(rules?: string) {
  const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(WISP));
  const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(WISP));
  const game = new CardGame([alice, bob], {
    log: () => {},
    openingHand: 3,
    ...(rules ? { rules } : {}),
  });
  return { game, alice, bob };
}

/** Rule cards, written the way a card document contributes them. */
const rulesOf = (document: string) => playableCards(document, RULE_BUFFS);

describe('the standing rules are cards', () => {
  it('reads as the game in English, in the order they apply', () => {
    const { game, alice } = match();
    const rules = game.rulesOf(alice);
    expect(rules.map((r) => r.name)).toEqual(['Mana', 'Summoning Sickness', 'Draw']);
    expect(rules[0]!.text).toContain('Increase mana maximum');
    expect(rules[2]!.text).toBe('When your turn starts then Draw(you, 1).');
  });

  it('compiles with no diagnostics', () => {
    expect(playableCards(CARD_RULES, RULE_BUFFS).diagnostics).toEqual([]);
  });

  it('are not cards for a deck', () => {
    expect(playableCards(CARD_RULES, RULE_BUFFS).cards).toEqual([]);
  });
});

describe('applying the rules is the upkeep', () => {
  it('runs a crystal, a refill and a draw at the start of a turn', async () => {
    const { game, alice } = match();
    await game.setup();
    const side = game.sideOf(alice);
    expect(side.hand.size).toBe(3);
    expect(side.mana).toBe(0);

    await game.collectUserDecisions();

    expect(side.hero.gauge('mana').max).toBe(1);
    expect(side.mana).toBe(1);
    expect(side.hand.size).toBe(4); // the draw rule
  });

  it('runs turn-end rules when a turn ends', async () => {
    const { game, alice } = match(`${CARD_RULES}
Card Study
{ "type": "rule" }
When your turn ends then Draw(you, 1).
`);
    await game.setup();
    const side = game.sideOf(alice);

    await game.collectUserDecisions();
    expect(side.hand.size).toBe(4);
    await game.runGame(); // the pass ends the turn, applying turn-end rules first
    expect(side.hand.size).toBe(5);
  });

  it('refuses a rule that does not compile rather than skipping it', () => {
    const { diagnostics } = rulesOf('Card Broken\n{ "type": "rule" }\nDraw(you, 1).');
    expect(diagnostics.map((d) => d.code)).toContain('card-rule-bare');
  });
});

describe('every player has their own rules', () => {
  it('has no cost, and refuses one', () => {
    const { diagnostics } = rulesOf('Card Taxed\n{ "cost": 2, "type": "rule" }\nWhen your turn starts then Draw(you, 1).');
    expect(diagnostics.map((d) => d.code)).toContain('card-header-field');
  });

  it('runs "your turn" rules for their owner only', async () => {
    const { game, alice, bob } = match();
    await game.setup();
    await game.collectUserDecisions(); // Alice's turn
    expect(game.sideOf(alice).hero.gauge('mana').max).toBe(1);
    expect(game.sideOf(bob).hero.gauge('mana').max).toBe(0);
  });

  it('can change one player’s rules and leave the other’s', async () => {
    const { game, alice, bob } = match();
    await game.setup();
    game.installRules(rulesOf('Card Draw\n{ "type": "rule" }\nWhen your turn starts then Draw(you, 3).'), { for: [bob] });

    expect(game.rulesOf(alice).find((r) => r.name === 'Draw')!.text).toContain('Draw(you, 1)');
    expect(game.rulesOf(bob).find((r) => r.name === 'Draw')!.text).toContain('Draw(you, 3)');
    await game.collectUserDecisions(); // Alice's turn: her draw is still one
    expect(game.sideOf(alice).hand.size).toBe(4);
  });

  it('puts a ceiling on the maximum inside the rule', async () => {
    const { game, alice } = match();
    await game.setup();
    for (let i = 0; i < 12; i++) await game.applyRules('turn:start', game.sideOf(alice));
    expect(game.sideOf(alice).hero.gauge('mana').max).toBe(10);
    expect(game.sideOf(alice).mana).toBe(10);
  });
});

describe('a card document can change the rules', () => {
  it('replaces a rule by name — one draw rule, doubled', async () => {
    const { game, alice } = match();
    await game.setup();

    // "…draw two instead": the same name, so the base rule is replaced, not stacked on top of.
    game.installRules(rulesOf('Card Draw\n{ "type": "rule" }\nWhen your turn starts then Draw(you, 2).'));

    expect(game.rulesOf(alice).filter((r) => r.name === 'Draw')).toHaveLength(1);
    await game.collectUserDecisions();
    expect(game.sideOf(alice).hand.size).toBe(5); // 3 + 2
  });

  it('adds a rule alongside the others', async () => {
    const { game, alice, bob } = match();
    await game.setup();

    game.installRules(rulesOf('Card Inspiration\n{ "type": "rule" }\nWhen your turn starts then Draw(you, 1).'));

    await game.collectUserDecisions();
    // The base draw and the added one: 3 + 2.
    expect(game.sideOf(alice).hand.size).toBe(5);
    // Bob is untouched: "your turn" is the owner's turn.
    expect(game.sideOf(bob).hand.size).toBe(4); // opening hand + the coin
  });

  it('removes a rule outright', async () => {
    const { game, alice } = match();
    await game.setup();
    expect(game.removeRule('Draw')).toBe(true);
    expect(game.removeRule('Draw')).toBe(false);

    await game.collectUserDecisions();
    expect(game.sideOf(alice).hand.size).toBe(3); // no draw
    // The rest of the upkeep still ran.
    expect(game.sideOf(alice).hero.gauge('mana').max).toBe(1);
  });

  it('can be given a whole rule set by the host', async () => {
    const { game, alice } = match('Card Mana\n{ "type": "rule" }\nWhen your turn starts then Increase mana maximum of this by 1.');
    await game.setup();
    await game.collectUserDecisions();
    // Only the rule we supplied: a crystal, but no refill and no draw.
    expect(game.sideOf(alice).hero.gauge('mana').max).toBe(1);
    expect(game.sideOf(alice).hand.size).toBe(3);
  });
});

describe('the language a rule is written in', () => {
  it('`Set <gauge> of <characters> to <amount>` writes a gauge’s current value', async () => {
    const { game, alice } = match(`Card Mana
{ "type": "rule" }
When your turn starts then Increase mana maximum of this by 1.
When your turn starts then Set mana of this to 0.`);
    await game.setup();
    await game.collectUserDecisions();
    // The crystal raised the derived maximum; the write moved only the current value.
    expect(game.sideOf(alice).hero.gauge('mana').max).toBe(1);
    expect(game.sideOf(alice).hero.gauge('mana').current).toBe(0);
  });

  it('`it` is the character that entered play', async () => {
    const [tank] = playableCards(
      'Card Tank\n{ "cost": 0, "type": "creature", "creatureConfig": { "power": 1, "health": 3 } }\nTaunt.',
      RULE_BUFFS,
    ).cards;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(tank!));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(WISP));
    const game = new CardGame([alice, bob], {
      log: () => {},
      openingHand: 3,
      rules: `${CARD_RULES}
Card Welcome
{ "type": "rule" }
When a character owned by you enters play then Deal 1 damage to it.`,
    });
    await game.setup();
    alice.script((g) => ({ kind: 'play', card: g.activeSide.hand.cards[0]!, targets: [] }));
    await game.collectUserDecisions();
    await game.runGame();
    const board = game.sideOf(alice).board;
    expect(board).toHaveLength(1);
    expect(board[0]!.gauge('hp').current).toBe(2);
  });

  it('`it` is only meaningful in a rule', () => {
    const { diagnostics } = playableCards(
      'Card Lonely\n{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 1 } }\nWhen this enters play then Deal 1 damage to it.',
      RULE_BUFFS,
    );
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('braces group the steps of one rule, and `If { … }` guards everything inside it once', async () => {
    const doc = `Card Mana
{ "type": "rule" }
When your turn starts then {
  If this.mana.max < 2 {
    Increase mana maximum of this by 1.
    Increase mana maximum of this by 1.
  }
  Set mana of this to this.mana.max.
}`;
    expect(rulesOf(doc).diagnostics).toEqual([]);
    const { game, alice } = match(doc);
    await game.setup();
    await game.collectUserDecisions();
    // Checked once, before either increase: both ran, so the maximum went 0 → 2 (not 0 → 1 → stop).
    expect(game.sideOf(alice).hero.gauge('mana').max).toBe(2);
    expect(game.sideOf(alice).mana).toBe(2);
  });

  it('a block whose condition fails skips everything inside it, and the steps after it still run', async () => {
    const { game, alice } = match(`Card Mana
{ "type": "rule" }
When your turn starts then {
  If this.mana.max > 5 {
    Increase mana maximum of this by 1.
  }
  Draw(you, 1).
}`);
    await game.setup();
    await game.collectUserDecisions();
    expect(game.sideOf(alice).hero.gauge('mana').max).toBe(0);
    expect(game.sideOf(alice).hand.size).toBe(4);
  });

  it('refuses the retired `, then` chain, a bare second sentence, and a brace left open', () => {
    const codes = (doc: string): string[] => rulesOf(`Card R\n{ "type": "rule" }\n${doc}`).diagnostics.map((d) => d.code);
    expect(codes('When your turn starts then Draw(you, 1), then draw(you, 1).').length).toBeGreaterThan(0);
    expect(codes('When your turn starts then Draw(you, 1).\nDraw(you, 1).').length).toBeGreaterThan(0);
    expect(codes('When your turn starts then {\n  Draw(you, 1).').length).toBeGreaterThan(0);
    expect(codes('When your turn starts then {\n  When your turn ends then Draw(you, 1).\n}')).toContain('rule-nested-when');
  });

  it('a rule must say when it applies', () => {
    const { diagnostics } = rulesOf('Card Bare\n{ "type": "rule" }\nDraw(you, 1).');
    expect(diagnostics.map((d) => d.code)).toContain('card-rule-bare');
  });
});
