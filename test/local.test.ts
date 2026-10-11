import { describe, expect, it } from 'vitest';
import {
  Character,
  cast,
  damage,
  heal,
  skill,
} from '../src/games/turn-based/index.js';
import { LocalGame, ScriptedPlayer } from '../src/multiplayer/local.js';

// Strike is the lethal blow of these scripted battles: it hits HP, so a
// 20-damage strike one-shots the 20-HP duellists below.
const strike = cast({
  name: 'Strike',
  targeting: { who: 'enemy' },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 20, ctx.self)],
});

const firstAid = cast({
  name: 'First Aid',
  targeting: { who: 'ally' },
  cast: (ctx, targeting) => [heal(targeting.targets[0]!.gauge('hp'), 10, ctx.self)],
});

function heroGame(goblinHp: number, onEvent?: (e: unknown) => void): LocalGame {
  const hero = new Character('Hero', {
    maxHp: 100,
    maxMana: 100,
    skills: [skill({ name: 'Fighter', weight: 1, abilities: [strike, firstAid] })],
  });
  const goblin = new Character('Goblin', {
    maxHp: goblinHp,
    maxMana: goblinHp,
    skills: [skill({ name: 'Chieftain', weight: 1, abilities: [strike] })],
  });
  return new LocalGame(
    [
      new ScriptedPlayer('Hero', [hero], 'party'),
      new ScriptedPlayer('Goblins', [goblin], 'monsters'),
    ],
    { onEvent },
  );
}

describe('LocalGame', () => {
  it('plays a full scripted battle and returns the winning player', async () => {
    const game = heroGame(40);
    const winners = await game.runLoop();

    const hero = game.players[0]!.characters[0]!;
    const goblin = game.players[1]!.characters[0]!;
    expect(goblin.isDefeated).toBe(true);
    expect(hero.isDefeated).toBe(false);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.name).toBe('Hero');
  });

  it('ends as a draw when nobody can act and the round cap is hit', async () => {
    // No manual abilities on either side: every round is empty, so the
    // maxRounds cap triggers a draw.
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
    const game = new LocalGame(
      [
        new ScriptedPlayer('Hero', [hero], 'party'),
        new ScriptedPlayer('Goblins', [goblin], 'monsters'),
      ],
      { maxRounds: 3 },
    );

    const winners = await game.runLoop();
    expect(winners).toEqual([]);
  });

  it('emits engine events through onEvent', async () => {
    // Three teams, so the first kill (round 1) does not end the game and the
    // engine still emits character:destroyed before the game eventually ends.
    const events: string[] = [];
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      skills: [skill({ name: 'Fighter', weight: 1, abilities: [strike, firstAid] })],
    });
    const goblinA = new Character('Goblin A', {
      maxHp: 20,
      maxMana: 20,
      skills: [skill({ name: 'Chieftain', weight: 1, abilities: [strike] })],
    });
    const goblinB = new Character('Goblin B', {
      maxHp: 20,
      maxMana: 20,
      skills: [skill({ name: 'Chieftain', weight: 1, abilities: [strike] })],
    });
    const game = new LocalGame(
      [
        new ScriptedPlayer('Hero', [hero], 'party'),
        new ScriptedPlayer('Goblins', [goblinA], 'monsters'),
        new ScriptedPlayer('Beasts', [goblinB], 'beasts'),
      ],
      { onEvent: (e) => events.push((e as { type: string }).type) },
    );
    await game.runLoop();

    expect(events).toContain('turn:start');
    expect(events).toContain('turn:end');
    expect(events).toContain('character:destroyed');
  });

  it('runs moves in initiative order: the faster character strikes first', async () => {
    // Both sides one-shot each other with the same 20-damage Strike. The
    // slow Goblin *decides* first (players are listed Goblin first), but the
    // fast Hero must act first and win the duel.
    const hero = new Character('Hero', {
      maxHp: 20,
      maxMana: 20,
      speed: 20,
      skills: [skill({ name: 'Fighter', weight: 1, abilities: [strike] })],
    });
    const goblin = new Character('Goblin', {
      maxHp: 20,
      maxMana: 20,
      speed: 5,
      skills: [skill({ name: 'Chieftain', weight: 1, abilities: [strike] })],
    });
    const game = new LocalGame(
      [
        new ScriptedPlayer('Goblins', [goblin], 'monsters'),
        new ScriptedPlayer('Hero', [hero], 'party'),
      ],
      { maxRounds: 1 },
    );

    const winners = await game.runLoop();
    expect(winners).toHaveLength(1);
    expect(winners[0]!.name).toBe('Hero');
  });

  it('breaks speed ties with the seeded engine rng (reproducible per game)', async () => {
    // Same-speed duel: each side one-shots the other, so the winner is
    // whoever the tie-break puts first. ScriptedPlayer secrets are
    // deterministic, so the same game must pick the same winner every time.
    const makeGame = (): LocalGame => {
      const a = new Character('A', {
        maxHp: 20,
        maxMana: 20,
        speed: 10,
        skills: [skill({ name: 'Fighter', weight: 1, abilities: [strike] })],
      });
      const b = new Character('B', {
        maxHp: 20,
        maxMana: 20,
        speed: 10,
        skills: [skill({ name: 'Chieftain', weight: 1, abilities: [strike] })],
      });
      return new LocalGame(
        [
          new ScriptedPlayer('Team A', [a], 'a'),
          new ScriptedPlayer('Team B', [b], 'b'),
        ],
        { maxRounds: 1 },
      );
    };

    const results = [];
    for (let i = 0; i < 4; i++) {
      const game = makeGame();
      const winners = await game.runLoop();
      results.push(winners[0]!.name);
    }
    // All four runs agree: the tie-break is seeded, not random per run.
    expect(new Set(results).size).toBe(1);
  });
});
