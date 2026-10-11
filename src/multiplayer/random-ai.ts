/**
 * An AI player that randomly chooses a skill and random targets for each of
 * its living characters, every round.
 *
 * ```ts
 * const goblins = new RandomAI('Goblins', [goblin], 'monsters');
 * const winners = await new LocalGame([you, goblins]).runLoop();
 * ```
 */
import {
  Player,
  commitSecret,
  createRandomSeed,
  type Decision,
  type GameEngine,
  type TargetPattern,
} from '../engine/index.js';
import type { Character } from '../engine/index.js';

export class RandomAI extends Player {
  /** A fresh random secret per AI, committed and revealed in the seed ceremony. */
  readonly #secret = createRandomSeed();

  constructor(name: string, characters: readonly Character[], team?: string) {
    super(name, characters, team);
  }

  override commitSeed(): string {
    return commitSecret(this.#secret);
  }

  override revealSeed(): string {
    return this.#secret;
  }

  /** Picks a random skill and random valid targets per living character. */
  async decide(engine: GameEngine): Promise<Decision[]> {
    const decisions: Decision[] = [];
    for (const character of this.livingCharacters) {
      const abilities = character.manualAbilities;
      if (abilities.length === 0) continue;

      const ability = pickRandom(abilities);
      if (!ability) continue;

      const options = engine.validTargets(ability.targeting, character);
      if (options.length === 0) continue;

      const count = Math.min(desiredCount(ability.targeting), options.length);
      const targets = sample(options, count);
      if (targets.length > 0) {
        decisions.push({ character, ability, targets });
      }
    }
    return decisions;
  }
}

/** How many targets the pattern wants (random within a range). */
function desiredCount(pattern: TargetPattern): number {
  if (typeof pattern.count === 'number') return pattern.count;
  if (Array.isArray(pattern.count)) {
    const [min, max] = pattern.count;
    const lo = min ?? 1;
    const hi = max ?? lo;
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }
  return 1;
}

/** `count` distinct random items from `items` (in random order). */
function sample<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!);
  }
  return out;
}

function pickRandom<T>(items: readonly T[]): T | undefined {
  return items[Math.floor(Math.random() * items.length)];
}
