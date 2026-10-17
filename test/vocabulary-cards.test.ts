/**
 * One card per piece of the language's vocabulary (examples/card-game/vocabulary.ts):
 * each compiles, none heals or makes anything invincible, and a pile of them plays whole games.
 */
import { describe, expect, it } from 'vitest';
import { commitSecret } from '../src/engine/index.js';
import { GreedyAI } from '../examples/card-game/ai.js';
import { CardGame } from '../examples/card-game/game.js';
import { playableCards } from '../examples/card-game/english.js';
import { VOCABULARY, vocabularyCards } from '../examples/card-game/vocabulary.js';

class Salted extends GreedyAI {
  constructor(name: string, team: string, deck: ConstructorParameters<typeof GreedyAI>[2], readonly salt: string) {
    super(name, team, deck);
  }
  override commitSeed() {
    return commitSecret(this.salt + this.id);
  }
  override revealSeed() {
    return this.salt + this.id;
  }
}

describe('the vocabulary cards', () => {
  it.each(VOCABULARY.map(([label, text]) => [label, text]))('%s compiles on its own', (_label, text) => {
    const { cards, diagnostics } = playableCards(text as string);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(cards).toHaveLength(1);
  });

  it('compile together with no diagnostics', () => {
    const { cards, diagnostics } = vocabularyCards();
    expect(diagnostics).toEqual([]);
    expect(cards).toHaveLength(VOCABULARY.length);
  });

  it('never heal and never make anything invincible', () => {
    for (const [, text] of VOCABULARY) {
      expect(text).not.toMatch(/\bheal|healing|healed|prevented/i);
    }
  });

  it('play whole games without error', async () => {
    const authored = vocabularyCards();
    const { cards } = authored;
    for (let g = 0; g < 8; g += 1) {
      const shuffled = (offset: number) => [...cards, ...cards].sort((a, b) => ((a.name.length * (g + 3) + offset) % 7) - ((b.name.length * (g + 3) + offset) % 7)).slice(0, 30);
      const game = new CardGame([new Salted('North', 'n', shuffled(0), `a${g}`), new Salted('South', 's', shuffled(3), `b${g}`)], { log: () => undefined });
      game.installZones(authored);
      game.installCreatures(authored.creatures);
      await expect(game.runLoop()).resolves.toBeDefined();
    }
  });

  it('plays sealed rounds with several copies of one card in hand (each physical card has its own id)', async () => {
    const { cards } = vocabularyCards();
    const mine = cards.filter((c) => ['Mutual Sacrifice', 'Forced Offering', 'Secret Ballot', 'Council of War'].includes(c.name));
    for (let g = 0; g < 5; g += 1) {
      const deck = () => Array.from({ length: 30 }, (_, i) => mine[i % mine.length]!);
      const game = new CardGame([new Salted('North', 'n', deck(), `c${g}`), new Salted('South', 's', deck(), `d${g}`)], { log: () => undefined });
      await expect(game.runLoop()).resolves.toBeDefined();
      const ids = game.sideOf(game.players[0] as never).deck.cards.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
