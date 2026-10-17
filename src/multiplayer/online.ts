/**
 * Connects a game to a `Room`: each connected user is sent the game as *they* may see
 * it, and then each thing that happens, redacted for them.
 *
 * ```ts
 * const projector = new ViewProjector(engine);
 * const link = attachGame(room, engine, projector, { alice: alicePlayer, bob: bobPlayer });
 * // a user who connects (or reconnects) is sent a fresh view; every event after goes to
 * // each connected user as their own redacted copy
 * ```
 *
 * A user who is not connected when something happens is not queued the events they
 * missed — they are sent a whole fresh `view` when they come back, which is both
 * simpler and cannot get out of step.
 */
import type { GameEngine, Player, ViewProjector } from '../engine/index.js';
import { PATH } from './protocol.js';
import type { RoomLike } from './room-like.js';

export interface GameLink {
  /** Sends every connected user a fresh view — call it at a boundary a client should redraw at. */
  syncViews(): void;
  /** Stops listening to the engine and the room. */
  detach(): void;
}

export function attachGame(
  room: RoomLike,
  engine: GameEngine,
  projector: ViewProjector,
  players: Readonly<Record<string, Player>>,
): GameLink {
  const sendView = (userId: string): void => {
    const player = players[userId];
    if (player) room.send(userId, PATH.view, projector.viewFor(player));
  };

  const stopEvents = engine.observe((event) => {
    for (const [userId, player] of Object.entries(players)) {
      if (!room.isConnected(userId)) continue;
      const redacted = projector.eventFor(player, event);
      if (redacted) room.send(userId, PATH.event, redacted);
    }
  });
  const stopConnects = room.onConnect((userId) => sendView(userId));
  // Anyone already here gets the view straight away.
  for (const userId of room.connected) sendView(userId);

  return {
    syncViews() {
      for (const userId of room.connected) sendView(userId);
    },
    detach() {
      stopEvents();
      stopConnects();
    },
  };
}
