import { describe, expect, it } from 'vitest';
import {
  Character,
  Player,
  type Decision,
} from '../src/games/turn-based/index.js';

class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

describe('Player', () => {
  it('stamps the team tag onto its characters', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    new TestPlayer('Hero', [hero], 'party');
    expect(hero.team).toBe('party');
  });

  it('tracks defeated and living characters', () => {
    const a = new Character('A', { maxHp: 10 });
    const b = new Character('B', { maxHp: 10 });
    const player = new TestPlayer('Team', [a, b]);

    expect(player.isDefeated).toBe(false);
    expect(player.livingCharacters.map((c) => c.name)).toEqual(['A', 'B']);

    a.gauge('hp').current = 0;
    expect(player.isDefeated).toBe(false);
    expect(player.livingCharacters.map((c) => c.name)).toEqual(['B']);

    b.gauge('hp').current = 0;
    expect(player.isDefeated).toBe(true);
    expect(player.livingCharacters).toEqual([]);
  });

  it('a player with no characters counts as defeated', () => {
    const player = new TestPlayer('Nobody', []);
    expect(player.isDefeated).toBe(true);
  });

  it('keeps its own copy of the character list', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    const roster = [hero];
    const player = new TestPlayer('Hero', roster);
    roster.pop();
    expect(player.characters).toEqual([hero]);
  });
});
