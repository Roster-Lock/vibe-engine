/**
 * A `Room` — the server's end of the transport.
 *
 * ```ts
 * const room = new Room({
 *   alice: { authToken: 'token-issued-to-alice', gameInit: { deck: [...] } },
 *   bob:   { authToken: 'token-issued-to-bob',   gameInit: { deck: [...] } },
 * });
 * wss.on('connection', (ws) => room.addWebsocket(ws));
 * ```
 *
 * Every socket gets a `MessageBridge`. **The room asks for the token**: a new socket is
 * sent an `auth` request, and the client's answer is looked up in `room.users`:
 *
 * ```ts
 * const authToken = await bridge.sendRequest('auth', {});
 * // ...find the user whose authToken it is; if nobody, ws.close(4001, 'Bad User')
 * ```
 *
 * **Authentication happens elsewhere.** Whatever signs players in decides whose token is
 * whose and hands the room that table; the room only checks. It never issues a token and
 * never sends one back, and `gameInit` — what the server needs to set a user up — never
 * goes on the wire.
 *
 * - **Until the token is accepted a socket is nobody.** Everything it sends except the
 *   answer to `auth` is dropped, it is sent nothing, and a wrong token — or none within
 *   `authTimeoutMs` — closes it.
 * - **One live socket per user.** A second connection with the same token *replaces* the
 *   first (a reconnect, a second tab); the older one is closed.
 * - **A dropped player can come back.** A prompt the room is still waiting on stays
 *   pending and is asked again, over the new connection, when they return.
 *
 * This room keeps its state in memory and uses promises, so it needs a process that stays
 * alive. For a host that sleeps between messages (Cloudflare), see `CloudflareRoom`.
 */
import type { MessageBridge } from '../util/MessageBridge/index.js';
import { assertFreshToken, findUser } from './auth.js';
import { bridgeOver } from './bridge.js';
import { BAD_USER, CLOSE, PATH, type IntentBody, type PromptBody } from './protocol.js';
import type { RoomLike } from './room-like.js';
import { fromWebSocket, isSocketLike, type SocketLike, type WebSocketLike } from './socket.js';

export interface RoomUser<Init = unknown> {
  /** The token this user will present. Issued by whatever authenticates them. */
  readonly authToken: string;
  /** What the server needs to set this user up in the game. Never sent to any client. */
  readonly gameInit: Init;
}

export interface RoomOptions {
  /** How long a new socket has to answer the `auth` request. Default 5000. */
  readonly authTimeoutMs?: number;
  /** The longest token accepted. Default 1024. */
  readonly maxTokenLength?: number;
  /** The longest message accepted. Default 1,000,000. */
  readonly maxMessageLength?: number;
}

/** A prompt that was not answered in time. */
export class PromptTimeoutError extends Error {
  constructor(name: string, userId: string) {
    super(`${userId} did not answer "${name}" in time`);
    this.name = 'PromptTimeoutError';
  }
}

/** A prompt that can never be answered because the room closed. */
export class RoomClosedError extends Error {
  constructor() {
    super('the room was closed');
    this.name = 'RoomClosedError';
  }
}

interface Connection {
  readonly socket: SocketLike;
  readonly bridge: MessageBridge;
  /** False once the socket has closed or been replaced. */
  alive: boolean;
}

interface Pending {
  readonly id: number;
  readonly userId: string;
  readonly name: string;
  readonly payload: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** A bridge answers with a defined value or nothing arrives; "nothing" is `null`. */
const defined = (value: unknown): unknown => (value === undefined ? null : value);

export class Room<Init = unknown> implements RoomLike {
  /** The users in the room, by id. Add with `addUser`. */
  readonly users: Record<string, RoomUser<Init>> = {};
  readonly #connections = new Map<string, Connection>();
  readonly #pending = new Map<number, Pending>();
  readonly #intents = new Map<string, (userId: string, payload: unknown) => unknown | Promise<unknown>>();
  readonly #onConnect = new Set<(userId: string, info: { reconnect: boolean }) => void>();
  readonly #onDisconnect = new Set<(userId: string) => void>();
  readonly #everConnected = new Set<string>();
  readonly #authTimeoutMs: number;
  readonly #maxTokenLength: number;
  readonly #maxMessageLength: number;
  #nextPrompt = 1;
  #closed = false;

  constructor(users: Readonly<Record<string, RoomUser<Init>>> = {}, options: RoomOptions = {}) {
    this.#authTimeoutMs = options.authTimeoutMs ?? 5000;
    this.#maxTokenLength = options.maxTokenLength ?? 1024;
    this.#maxMessageLength = options.maxMessageLength ?? 1_000_000;
    for (const [userId, user] of Object.entries(users)) this.addUser(userId, user);
  }

  /* -------------------------------- users -------------------------------- */

  /** Lets a user in. Each user needs a token of their own, or one connection could be taken for another. */
  addUser(userId: string, user: RoomUser<Init>): void {
    assertFreshToken(this.users, userId, user.authToken);
    if (userId in this.users) throw new Error(`Room: ${userId} is already in the room`);
    this.users[userId] = user;
  }

  /** The ids of the users in the room. */
  get userIds(): string[] {
    return Object.keys(this.users);
  }

  /** What the server needs to set `userId` up. Server-side only. */
  gameInit(userId: string): Init {
    const user = this.users[userId];
    if (!user) throw new Error(`Room: no user "${userId}"`);
    return user.gameInit;
  }

  /* ------------------------------ connections ----------------------------- */

  /**
   * Takes a new socket and asks it who it is. Until it answers with a token the room
   * holds, it is not a user and is sent nothing.
   */
  addWebsocket(input: SocketLike | WebSocketLike): void {
    if (this.#closed) throw new RoomClosedError();
    const socket = isSocketLike(input) ? input : fromWebSocket(input);
    let userId: string | undefined;
    const connection = { socket, alive: true } as Connection & { bridge: MessageBridge };
    socket.onClose(() => {
      connection.alive = false;
      if (userId !== undefined && this.#connections.get(userId) === connection) {
        this.#connections.delete(userId);
        for (const listener of this.#onDisconnect) listener(userId);
      }
    });
    const { bridge } = bridgeOver(socket, {
      maxLength: this.#maxMessageLength,
      onTooLarge: () => socket.close(CLOSE.protocol, 'message too large'),
      // Until the token is accepted the only thing listened to is the answer to our `auth`.
      filter: (message) => userId !== undefined || message.messageType === 'response',
      onProtocolError: (reason) => {
        if (userId === undefined) socket.close(CLOSE.rejected, BAD_USER);
        else if (connection.alive) connection.bridge.sendEvent(PATH.error, { message: reason });
      },
    });
    (connection as { bridge: MessageBridge }).bridge = bridge;
    void this.#admit(connection, (id) => (userId = id));
  }

  /** Asks the socket for its token and, if the room holds it, makes the socket that user's. */
  async #admit(connection: Connection, setUser: (userId: string) => void): Promise<void> {
    const { socket, bridge } = connection;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let token: unknown;
    try {
      token = await Promise.race([
        bridge.sendRequest(PATH.auth, {}),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AuthTimeout()), this.#authTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof AuthTimeout) socket.close(CLOSE.authTimeout, 'authentication timed out');
      return; // the socket closed (or refused to answer) before it said who it was
    } finally {
      if (timer) clearTimeout(timer);
    }

    const found = findUser(this.users, token, this.#maxTokenLength);
    if (found === null) {
      socket.close(CLOSE.rejected, BAD_USER);
      return;
    }
    if (!connection.alive) return;
    const userId = found;
    setUser(userId);

    bridge.onRequest(PATH.intent, (body: IntentBody) => this.#runIntent(userId, body));

    const previous = this.#connections.get(userId);
    const reconnect = this.#everConnected.has(userId);
    this.#connections.set(userId, connection);
    this.#everConnected.add(userId);
    if (previous) {
      previous.alive = false;
      previous.socket.close(CLOSE.replaced, 'replaced by a newer connection');
    }

    bridge.sendEvent(PATH.welcome, { userId });
    // Whatever the room was waiting on this user for, it is still waiting.
    for (const pending of this.#pending.values()) if (pending.userId === userId) this.#sendPrompt(pending, connection);
    for (const listener of this.#onConnect) listener(userId, { reconnect });
  }

  async #runIntent(userId: string, body: IntentBody): Promise<unknown> {
    const handler = typeof body?.name === 'string' ? this.#intents.get(body.name) : undefined;
    if (!handler) throw new Error(`there is no "${String(body?.name)}" to do`);
    return defined(await handler(userId, body.payload));
  }

  /** Who is connected right now. */
  get connected(): string[] {
    return [...this.#connections.keys()];
  }

  isConnected(userId: string): boolean {
    return this.#connections.has(userId);
  }

  /** Resolves once every one of `userIds` (default: everyone in the room) is connected. */
  whenConnected(...userIds: string[]): Promise<void> {
    const wanted = userIds.length > 0 ? userIds : this.userIds;
    const ready = (): boolean => wanted.every((id) => this.isConnected(id));
    if (ready()) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.onConnect(() => {
        if (ready()) {
          off();
          resolve();
        }
      });
    });
  }

  /** Called when a user has authenticated (`reconnect` is true if they had been here before). */
  onConnect(listener: (userId: string, info: { reconnect: boolean }) => void): () => void {
    this.#onConnect.add(listener);
    return () => void this.#onConnect.delete(listener);
  }

  /** Called when a user's live socket closes (not when it is replaced by their own newer one). */
  onDisconnect(listener: (userId: string) => void): () => void {
    this.#onDisconnect.add(listener);
    return () => void this.#onDisconnect.delete(listener);
  }

  /* -------------------------------- talking -------------------------------- */

  /** Sends an event to one user. Returns false if they are not connected (nothing is queued). */
  send(userId: string, path: string, value: unknown): boolean {
    const connection = this.#connections.get(userId);
    if (!connection?.alive) return false;
    try {
      connection.bridge.sendEvent(path, defined(value));
      return true;
    } catch {
      return false; // the bridge was torn down under us; the close handler does the tidying
    }
  }

  /** Sends an event to everyone connected. */
  broadcast(path: string, value: unknown): void {
    for (const userId of this.#connections.keys()) this.send(userId, path, value);
  }

  /**
   * Asks a user for something and waits for the answer. Resolves with their reply;
   * rejects if they say they cannot answer, if it times out, or if the room closes. If
   * they are not connected — or drop while it is open — the prompt stays pending and is
   * asked again when they come back.
   */
  prompt<T = unknown>(userId: string, name: string, payload: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new RoomClosedError());
    if (!(userId in this.users)) return Promise.reject(new Error(`Room: no user "${userId}"`));
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        id: this.#nextPrompt++,
        userId,
        name,
        payload,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (options.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(pending.id);
          reject(new PromptTimeoutError(name, userId));
        }, options.timeoutMs);
      }
      this.#pending.set(pending.id, pending);
      const connection = this.#connections.get(userId);
      if (connection) this.#sendPrompt(pending, connection);
    });
  }

  /** Asks over `connection`'s bridge; the bridge matches the reply to the request. */
  #sendPrompt(pending: Pending, connection: Connection): void {
    const body: PromptBody = { name: pending.name, payload: defined(pending.payload) };
    connection.bridge.sendRequest(PATH.prompt, body).then(
      (value) => {
        if (this.#pending.get(pending.id) !== pending) return;
        this.#settle(pending);
        pending.resolve(value);
      },
      (error: unknown) => {
        // A connection that ended takes its unanswered requests with it: the prompt is
        // still wanted, and goes out again when the user is back. Anything else is the
        // client saying it could not answer.
        if (!connection.alive || this.#pending.get(pending.id) !== pending) return;
        this.#settle(pending);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  #settle(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    this.#pending.delete(pending.id);
  }

  /** Handles a client's `intent` of this name. One handler per name. */
  onIntent(name: string, handler: (userId: string, payload: unknown) => unknown | Promise<unknown>): () => void {
    if (this.#intents.has(name)) throw new Error(`Room: "${name}" already has a handler`);
    this.#intents.set(name, handler);
    return () => void this.#intents.delete(name);
  }

  /** Closes every connection and fails every prompt still waiting. */
  close(): void {
    this.#closed = true;
    for (const pending of [...this.#pending.values()]) {
      this.#settle(pending);
      pending.reject(new RoomClosedError());
    }
    for (const connection of this.#connections.values()) {
      connection.alive = false;
      connection.socket.close(CLOSE.roomClosed, 'the room was closed');
    }
    this.#connections.clear();
  }
}

class AuthTimeout extends Error {}
