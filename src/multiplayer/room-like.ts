/**
 * What the game side needs from a room, so `RemotePlayer` and `attachGame` work with the
 * in-memory `Room` and with `CloudflareRoom` alike.
 */
export interface RoomLike {
  /** The users in the room. Only `gameInit` is read through this; tokens stay in the room. */
  readonly users: Readonly<Record<string, { readonly gameInit: unknown }>>;
  /** The users with a live, authenticated connection right now. */
  readonly connected: string[];
  isConnected(userId: string): boolean;
  onConnect(listener: (userId: string, info: { reconnect: boolean }) => void): () => void;
  onDisconnect(listener: (userId: string) => void): () => void;
  /** Sends an event to one user. Returns false if they are not connected (nothing is queued). */
  send(userId: string, path: string, value: unknown): boolean;
  /** Asks a user something and waits for the answer. */
  prompt<T = unknown>(userId: string, name: string, payload: unknown, options?: { timeoutMs?: number }): Promise<T>;
}
