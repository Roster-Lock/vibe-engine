/**
 * A tiny headless battle for testing a compiled ability — the same arena
 * the Create page's "Run test battle" button uses and the tests drive
 * directly (test/english.test.ts).
 *
 * The cast (the user's ability) sits on a skill of the party's Hero. The
 * monsters are the targets of choice; Paladin stands in as an ally.
 * Running the ability goes through the real engine (`useAbility`), so the
 * action pipeline, destroy phase, buffs and win/lose all behave exactly as
 * they would in a game.
 */
import {
  Character,
  GameEngine,
  GameEndInterrupt,
  Player,
  skill,
  type Decision,
  type GameEvent,
  type AnyTriggeredAbility,
  type ManualAbility,
} from '../games/turn-based/index.js';
import type { Character as CharacterType } from '../games/turn-based/index.js';
import { createEngine } from '../games/turn-based/index.js';
import { endTurn, startTurn } from '../games/round-based/index.js';

/** A player that never acts on its own — the arena runs one explicit cast. */
class StandInPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

export interface Arena {
  readonly engine: GameEngine;
  readonly hero: CharacterType;
  readonly ally: CharacterType;
  readonly goblin: CharacterType;
  readonly bruiser: CharacterType;
  readonly you: Player;
  readonly foes: Player;
  /** Every engine event of this arena's run, in order. */
  readonly events: GameEvent[];
}

export interface ArenaRun {
  /** The winners when the run ended the game (a draw = empty array). */
  readonly winners: Player[] | undefined;
  /** The character the ability's targeting picked, when it picked one. */
  readonly picked: CharacterType | undefined;
}

/** Builds a fresh arena. Each call gives a clean game state. */
export function buildArena(
  ability: ManualAbility,
  seed = 'english-arena',
  triggers: readonly AnyTriggeredAbility[] = [],
): Arena {
  const events: GameEvent[] = [];
  // A document's own `when … then …` triggers belong to no status, so the
  // arena is the host that places them: they ride on the Hero's skill
  // alongside the ability under test.
  const hero = new Character('Hero', {
    maxHp: 100,
    maxMana: 40,
    skills: [skill({ name: 'Custom Skill', weight: 1, abilities: [ability, ...triggers] })],
  });
  const ally = new Character('Paladin', { maxHp: 90 });
  const goblin = new Character('Goblin', { maxHp: 40 });
  const bruiser = new Character('Bruiser', { maxHp: 55 });
  const you = new StandInPlayer('You', [hero, ally], 'party');
  const foes = new StandInPlayer('Foes', [goblin, bruiser], 'monsters');
  const engine = createEngine({ seed, onEvent: (event) => events.push(event) });
  engine.registerPlayers([you, foes]);
  return { engine, hero, ally, goblin, bruiser, you, foes, events };
}

/**
 * Uses the compiled ability once from the Hero's hand — picking the first
 * valid target for targeting abilities — then plays one `turn:start` so
 * turn-triggered buffs (Poison's tick) have a chance to fire. A
 * `GameEndInterrupt` (the game ended) is captured, not thrown.
 */
export async function runArena(
  arena: Arena,
  ability: ManualAbility,
  opts: { startTurn?: boolean } = {},
): Promise<ArenaRun> {
  const { engine, hero } = arena;
  const openWithTurnStart = opts.startTurn ?? true;
  const pool = engine.validTargets(ability.targeting, hero);
  const targets: CharacterType[] =
    ability.targeting.who === 'self'
      ? pool.includes(hero)
        ? [hero]
        : []
      : pool.slice(0, 1);

  let winners: Player[] | undefined;
  try {
    await engine.useAbility(hero, ability, { targets });
    if (openWithTurnStart) await startTurn(engine);
  } catch (error) {
    if (error instanceof GameEndInterrupt) {
      winners = error.winners;
    } else {
      throw error;
    }
  }
  return { winners, picked: targets[0] };
}
