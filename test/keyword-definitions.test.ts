/**
 * **Keywords a document defines** — `Keyword Drain` + a JSON header + the lines of the language it stands
 * for. The point: a player extends the vocabulary in the language itself, and the new word behaves like a
 * built-in one — it is explained, it takes arguments, it is checked once where it is defined, and what it
 * means is compiled and played like any other card text.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import type { Card } from '../examples/card-game/cards.js';
import { playableCards } from '../examples/card-game/english.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import { compileCardDocument, completeCardAt } from '../src/english/card.js';
import type { Character } from '../src/engine/index.js';

const DRAIN = `Keyword Drain
{ "parameters": ["amount"], "cardKinds": ["spell"] }
Deal amount damage to target enemy character.
Heal this for amount.`;

const SIPHON = `${DRAIN}

Card Siphon
{ "cost": 1, "type": "spell" }
Drain(6).`;

const errors = (text: string) => compileCardDocument(text).diagnostics.filter((d) => d.severity === 'error');
const codes = (text: string) => errors(text).map((d) => d.code);

class Scripted extends CardPlayer {
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

const deckOf = (card: Card): Card[] => Array.from({ length: 30 }, () => card);

describe('a keyword defined in the document', () => {
  it('compiles, and a card can use it like Taunt', () => {
    const result = compileCardDocument(SIPHON);
    expect(errors(SIPHON)).toEqual([]);
    expect(result.cards.map((card) => card.name)).toEqual(['Siphon']);
    // The card prints the keyword, not what it means.
    expect(result.cards[0]!.rulesText).toBe('Drain(6).');
  });

  it('means its lines: the card does what the keyword says, through the real game', async () => {
    const { cards, diagnostics } = playableCards(SIPHON);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const siphon = cards[0]!;
    const alice = new Scripted('Alice', 'a', deckOf(siphon));
    const bob = new Scripted('Bob', 'b', deckOf(siphon));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();
    const aliceHero = game.sideOf(alice).hero;
    const bobHero = game.sideOf(bob).hero;
    await game.engine.damage(aliceHero.gauge('hp'), 10, bobHero);
    const before = aliceHero.gauge('hp').current;
    alice.script((g): Move => ({
      kind: 'play',
      card: g.activeSide.hand.cards.find((c) => c.printedId === siphon.id)!,
      targets: [bobHero] as Character[],
    }));
    await game.collectUserDecisions();
    await game.runGame();
    expect(bobHero.gauge('hp').current).toBe(30 - 6);
    expect(aliceHero.gauge('hp').current).toBeGreaterThan(before);
  });

  it('is offered and explained by its own lines — there is no summary to write', () => {
    const source = `${DRAIN}\n\nCard Siphon\n{ "cost": 1, "type": "spell" }\n`;
    const labels = completeCardAt(source, source.length).map((s) => s.label);
    expect(labels).toContain('Drain(…)');
    const doc = completeCardAt(source, source.length).find((s) => s.label === 'Drain(…)')?.doc ?? '';
    expect(doc).toContain('Deal amount damage to target enemy character.');
    expect(doc).toContain('Heal this for amount.');
  });

  it('checks the argument count where it is used', () => {
    const use = (line: string) => codes(`${DRAIN}\n\nCard Siphon\n{ "cost": 1, "type": "spell" }\n${line}`);
    expect(use('Drain.')).toContain('card-keyword-arity');
    expect(use('Drain(1, 2).')).toContain('card-keyword-arity');
    expect(use('Drain 3.')).toContain('card-keyword-trailing');
  });

  it('without parameters it is a bare word', () => {
    const source = `Keyword Scorch
{ "cardKinds": ["spell"] }
Deal 2 damage to all enemy characters.

Card Fire
{ "cost": 1, "type": "spell" }
Scorch.`;
    expect(errors(source)).toEqual([]);
  });

  it('can be nothing but its lines, with no header at all', () => {
    const source = `Keyword Scorch
Deal 2 damage to all enemy characters.

Card Fire
{ "cost": 1, "type": "spell" }
Scorch.`;
    expect(errors(source)).toEqual([]);
    expect(compileCardDocument(source).cards[0]!.rulesText).toBe('Scorch.');
  });

  it('a creature keyword is a trigger, and goes onto creatures', () => {
    const source = `Keyword Bomber
{ "parameters": ["amount"], "cardKinds": ["creature"] }
When this is destroyed then deal amount damage to all enemy characters.

Card Bomb Imp
{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 1 } }
Bomber(3).`;
    expect(errors(source)).toEqual([]);
    const spell = source.replace('"type": "creature", "creatureConfig": { "power": 1, "health": 1 }', '"type": "spell"');
    expect(codes(spell)).toContain('card-spell-keyword');
  });

  it('the kind defaults from the lines: a "When …" line is a creature keyword', () => {
    const source = `Keyword Bomber
{ "parameters": ["amount"] }
When this is destroyed then deal amount damage to all enemy characters.

Card Bomb Imp
{ "cost": 1, "type": "spell" }
Bomber(3).`;
    expect(codes(source)).toContain('card-spell-keyword');
  });
});

describe('a keyword definition is checked once, where it is defined', () => {
  it('reports a mistake in its lines on the line, with the keyword named', () => {
    const source = `Keyword Drain
{ "parameters": ["amount"] }
Deal amount damage to target enemy character.
Frobnicate this.`;
    const found = compileCardDocument(source).diagnostics.find((d) => d.code === 'keyword-body');
    expect(found).toBeDefined();
    expect(source.slice(found!.start, found!.end)).toBe('Frobnicate this.');
    expect(found!.message).toContain('Drain');
  });

  it('needs no header and no summary — only something to mean', () => {
    expect(codes('Keyword Drain\nDeal 1 damage to this.')).toEqual([]);
    expect(codes('Keyword Drain')).toContain('keyword-empty');
    expect(codes('Keyword Drain\n{ "parameters": [] }')).toContain('keyword-empty');
  });

  it('has no summary field: the lines are the explanation', () => {
    const found = compileCardDocument('Keyword Drain\n{ "summary": "Hurt.", "parameters": [] }\nDeal 1 damage to this.').diagnostics.find(
      (d) => d.code === 'keyword-header-field',
    );
    expect(found?.message).toContain('the lines under the keyword are its explanation');
  });

  it('checks the header like a card header: unknown keys, bad parameters and kinds, broken JSON', () => {
    const header = (json: string) => codes(`Keyword Drain\n${json}\nDeal 1 damage to this.`);
    expect(header('{ "colour": "red" }')).toContain('keyword-header-field');
    expect(header('{ "parameters": "amount" }')).toContain('keyword-parameters');
    expect(header('{ "parameters": ["a", "a"] }')).toContain('keyword-parameters');
    expect(header('{ "cardKinds": ["potion"] }')).toContain('keyword-card-kinds');
    expect(header('{ ')).toContain('keyword-header-json');
  });

  it('is one word, and cannot reuse a built-in or an earlier keyword', () => {
    expect(codes('Keyword Two Words\n{ }\nDeal 1 damage to this.')).toContain('keyword-name');
    expect(codes('Keyword Taunt\n{ }\nDeal 1 damage to this.')).toContain('keyword-duplicate');
    expect(codes(`${DRAIN}\n\n${DRAIN}`)).toContain('keyword-duplicate');
  });
});

describe('an editor explains the keywords a document defines', () => {
  it('lists them for hover while the document is half-written', async () => {
    const { documentKeywords } = await import('../src/english/card.js');
    const defs = documentKeywords(`${DRAIN}\n\nCard Half\n{ "cost": 1, "type": "spell"`);
    expect(defs.map((def) => def.name)).toEqual(['Drain']);
    expect(defs[0]!.details).toContain('Heal this for amount.');
    expect(defs[0]!.arity).toEqual([1, 1]);
    // A keyword with a broken header is simply not offered, rather than throwing.
    expect(documentKeywords('Keyword Broken\n{ "summary": ')).toEqual([]);
  });
});
