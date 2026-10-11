/**
 * The trigger queue (docs/design/04-sba.md, slice 2):
 *
 * - events queue their matching triggers; the queue drains after the
 *   resolution unit completes (a move's apply, or a turn hook),
 * - death triggers from a wipe run after ALL destructions and events are
 *   complete — each trigger sees the full wipe,
 * - the game-end check short-circuits the drain: queued death triggers
 *   never run if a trigger's own actions end the game,
 * - triggers appended while draining run after the current ones (FIFO).
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEndInterrupt,
  GameEngine,
  Player,
  auto,
  buff,
  damage,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';

class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

function char(name: string, maxHp: number): Character {
  // HP is the life gauge — the built-in death rules attach to HP at
  // construction. Give everyone full HP (maxMana is just a resource now).
  return new Character(name, { maxHp, maxMana: maxHp });
}

function player(name: string, characters: Character[], team?: string): TestPlayer {
  return new TestPlayer(name, characters, team);
}

function makeEngine(players: TestPlayer[]): GameEngine {
  const engine = createEngine();
  engine.registerPlayers(players);
  return engine;
}

describe('the trigger queue', () => {
  it('a wipe\'s death triggers see the full wipe (all destructions settled first)', async () => {
    const hero = char('Hero', 100);
    const a = char('A', 30);
    const b = char('B', 30);
    const goblin = char('Goblin', 10);
    const shaman = char('Shaman', 30);
    let graveyardAtCast = -1;
    const observer = buff({
      name: 'Observer',
      weight: 1,
      abilities: [
        auto({
          name: 'See Wipe',
          event: 'character:destroyed',
          cast: (ctx) => {
            // At cast time (after the drain boundary) both deaths have
            // fully settled — the graveyard already holds the whole wipe.
            graveyardAtCast = ctx.engine.graveyard.length;
            return [];
          },
        }),
      ],
    });
    const engine = makeEngine([
      player('Party', [hero, a, b], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    await engine.addBuff(hero, observer);

    // HP is the life gauge — a wipe of lethal (HP) damage.
    await engine.apply([damage(a.gauge('hp'), 999, goblin), damage(b.gauge('hp'), 999, goblin)]);

    expect(graveyardAtCast).toBe(2);
  });

  it('queued death triggers never run when a trigger\'s own actions end the game', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    let deathTriggers = 0;
    const finisher = buff({
      name: 'Finisher',
      weight: 1,
      abilities: [
        auto({
          name: 'Finish',
          event: 'turn:end',
          cast: (ctx) => [damage(goblin.gauge('hp'), 999, ctx.self)],
        }),
      ],
    });
    const watcher = buff({
      name: 'Watcher',
      weight: 1,
      abilities: [
        auto({
          name: 'Count Own Death',
          event: 'character:destroyed',
          cast: () => {
            deathTriggers += 1;
            return [];
          },
        }),
      ],
    });
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin], 'monsters'),
    ]);
    await engine.addBuff(hero, finisher);
    await engine.addBuff(goblin, watcher);

    // The finisher's damage kills goblin inside its own drain; the
    // win/lose check throws (win/lose-first) before any destroyed event,
    // so the watcher's queued trigger never runs.
    await expect(endTurn(engine)).rejects.toBeInstanceOf(GameEndInterrupt);
    expect(deathTriggers).toBe(0);
    expect(engine.isInPlay(goblin)).toBe(true); // destroy phase never ran either
  });

  it('triggers queued by a trigger\'s own actions run after it (FIFO)', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const seen: string[] = [];
    const first = buff({
      name: 'First',
      weight: 1,
      abilities: [
        auto({
          name: 'First',
          event: 'turn:end',
          cast: (ctx) => {
            seen.push('first');
            // Damaging goblin queues the second trigger (gauge:changed).
            return [damage(goblin.gauge('hp'), 5, ctx.self)];
          },
        }),
      ],
    });
    const second = buff({
      name: 'Second',
      weight: 1,
      abilities: [
        auto({
          name: 'Second',
          event: 'gauge:changed',
          when: (ctx) => 'target' in ctx.event && ctx.event.target === goblin,
          cast: () => {
            seen.push('second');
            return [];
          },
        }),
      ],
    });
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin], 'monsters'),
    ]);
    await engine.addBuff(hero, first);
    await engine.addBuff(goblin, second);

    await endTurn(engine);

    expect(seen).toEqual(['first', 'second']);
  });

  it('a trigger on character:destroyed:batch fires once per wipe (vs once per death)', async () => {
    const hero = char('Hero', 100);
    const a = char('A', 30);
    const b = char('B', 30);
    const c = char('C', 30);
    const goblin = char('Goblin', 10);
    const shaman = char('Shaman', 30);
    let perDeath = 0;
    let perBatch = 0;
    let batchSizes: number[] = [];
    const reaper = buff({
      name: 'Reaper',
      weight: 1,
      abilities: [
        auto({
          name: 'Per Death',
          event: 'character:destroyed',
          cast: () => {
            perDeath += 1;
            return [];
          },
        }),
        auto({
          name: 'Per Batch',
          event: 'character:destroyed:batch',
          cast: (ctx) => {
            perBatch += 1;
            batchSizes.push(ctx.event.events.length);
            return [];
          },
        }),
      ],
    });
    const engine = makeEngine([
      player('Party', [hero, a, b, c], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    await engine.addBuff(hero, reaper);

    await engine.apply([
      damage(a.gauge('hp'), 999, goblin),
      damage(b.gauge('hp'), 999, goblin),
      damage(c.gauge('hp'), 999, goblin),
    ]);

    expect(perDeath).toBe(3);
    expect(perBatch).toBe(1);
    expect(batchSizes).toEqual([3]);
  });
});
