/**
 * **`create(player, creature)`** — make a new creature, in play under `player`'s control.
 *
 * What a creature *is* (its stats, keywords, triggers) is a game's business, defined in its
 * content (`Creature Giant Golem 6/6`); the language's *Create a Giant Golem.* only names it. So, as
 * with `draw` and `cast`, a game registers its own for its engine.
 */
import type { Entity, GameEngine, Player } from '../../engine/index.js';

export type CreateFn = (player: Player, creature: string) => Promise<Entity | undefined>;

const ENGINE_CREATES = new WeakMap<GameEngine, CreateFn>();

export function setEngineCreate(engine: GameEngine, create: CreateFn): void {
  ENGINE_CREATES.set(engine, create);
}

export function engineCreate(engine: GameEngine): CreateFn | undefined {
  return ENGINE_CREATES.get(engine);
}
