/**
 * **`cast(player, card)`** — put a card on the stack as `player`, if it can be.
 *
 * The language's *Cast this card* is an effect that has to start a cast, but
 * casting is the card game's business (mana, targets, timing), not the engine's or
 * the IR's. So, as with `draw`, a game registers its own for its engine and the
 * effect asks the engine it is running on.
 *
 * Returns **whether it was cast**. `false` means it could not be — too expensive,
 * no legal target — and nothing happened to the card, so the ability can fall back
 * to something else ("otherwise move it to its owner's garbage"). The card is
 * revealed by being cast: the stack is public.
 */
import type { Entity, GameEngine, Player } from '../../engine/index.js';

/** `free`: cast it without paying its cost ("…without paying its cost"). */
export type CastFn = (player: Player, card: Entity, options?: { readonly free?: boolean }) => Promise<boolean>;

const ENGINE_CASTS = new WeakMap<GameEngine, CastFn>();

/** The cards `player` could cast right now from where they are (a hand, a stolen pile). */
export type CastableFn = (player: Player) => readonly Entity[];

const ENGINE_CASTABLE = new WeakMap<GameEngine, CastableFn>();

export function setEngineCastable(engine: GameEngine, castable: CastableFn): void {
  ENGINE_CASTABLE.set(engine, castable);
}

export function engineCastable(engine: GameEngine): CastableFn | undefined {
  return ENGINE_CASTABLE.get(engine);
}

export function setEngineCast(engine: GameEngine, cast: CastFn): void {
  ENGINE_CASTS.set(engine, cast);
}

export function engineCast(engine: GameEngine): CastFn | undefined {
  return ENGINE_CASTS.get(engine);
}
