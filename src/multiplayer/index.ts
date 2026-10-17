/**
 * The transport: a `Room` on the server, `createClient` on the other end, and the glue
 * that streams a game between them. See `room.ts` for how connections are accepted.
 */
export { Room, PromptTimeoutError, RoomClosedError, type RoomOptions, type RoomUser } from './room.js';
export { createClient, RejectedError, type Client, type ClientEvents, type ClientOptions } from './client.js';
export { BAD_USER, CLOSE, PATH, type IntentBody, type PromptBody } from './protocol.js';
export type { RoomLike } from './room-like.js';
export { findUser } from './auth.js';
export { fromWebSocket, isSocketLike, memoryPair, type SocketData, type SocketLike, type WebSocketLike } from './socket.js';
export { RemotePlayer, fromWireAnswer, toWireRequest, type RemotePlayerOptions, type WireAnswer, type WireRequest } from './wire.js';
export { attachGame, type GameLink } from './online.js';
export {
  CloudflareRoom,
  type CloudflareContext,
  type CloudflareRoomOptions,
  type CloudflareSocket,
  type CloudflareStorage,
  type Reply,
} from './cloudflare.js';
