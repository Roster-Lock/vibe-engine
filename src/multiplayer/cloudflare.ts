/**
 * `CloudflareRoom` — a room that can live in a Cloudflare Durable Object, without being one.
 *
 * It is a plain class. The Durable Object (a few lines of yours) forwards the platform's
 * events to it, and it keeps everything it needs to survive in `ctx.storage` and in the
 * sockets' attachments:
 *
 * ```ts
 * export class GameRoom extends DurableObject {
 *   room = new CloudflareRoom(this.ctx);
 *   constructor(ctx, env) {
 *     super(ctx, env);
 *     ctx.blockConcurrencyWhile(async () => {
 *       await this.room.load();              // users, pending prompts, timers, saved state
 *       this.room.onConnect((userId) => ...); // handlers are registered on EVERY wake
 *       this.room.onTimer('turn-clock', (data) => ...);
 *     });
 *   }
 *   fetch(request)                         { return this.room.fetch(request); }          // a new websocket
 *   webSocketMessage(ws, message)          { return this.room.webSocketMessage(ws, message); }
 *   webSocketClose(ws, code, reason, clean) { return this.room.webSocketClose(ws, code, reason); }
 *   webSocketError(ws, error)              { return this.room.webSocketError(ws, error); }
 *   alarm()                                { return this.room.alarm(); }
 * }
 * ```
 *
 * ## It is woken by
 * - **a new websocket** — `accept(ws)` (or `fetch`, which makes the pair and calls it);
 * - **a message** — `webSocketMessage`;
 * - **a disconnect** — `webSocketClose` / `webSocketError`;
 * - **a timer** — `alarm`, one platform alarm that carries all of this room's timers.
 *
 * ## What survives being evicted, and what does not
 * Between any two of those events the object may be thrown away and rebuilt. So nothing
 * the room *means* to keep is held only in memory:
 * - **users** (token table + `gameInit`) — `addUser` writes them;
 * - **who is connected** — read from `ctx.getWebSockets()` and each socket's attachment;
 * - **a socket mid-authentication** — its `auth` request id and deadline live in the
 *   attachment and in a timer, so the answer is recognised after a wake;
 * - **prompts** — `ask()` stores them, sends them, and re-sends them when the user returns;
 *   the answer arrives at `onReply`, which is registered on each wake;
 * - **timers** — `setTimer(name, ms, data)` writes to storage and re-arms the alarm;
 * - **your own state** — `save(key, value)` / `read(key)`.
 *
 * What does *not* survive is a promise. `prompt()` (an awaitable `ask`) works while the
 * object stays awake and is what a `RemotePlayer` uses; a game that must outlive eviction
 * is written as `ask` + `onReply` and rebuilt from saved state instead.
 *
 * The wire protocol is the same `MessageBridge` message format as `Room`: the room asks
 * `auth`, the client answers it. A request the room has already sent is matched to its
 * answer by id from the stored table, since a bridge's own pending list would not survive.
 */
import { MessageBridge, type MessageBridgeMessage } from '../util/MessageBridge/index.js';
import { assertFreshToken, findUser } from './auth.js';
import { parseFrame } from './bridge.js';
import { BAD_USER, CLOSE, PATH, type IntentBody, type PromptBody } from './protocol.js';
import type { RoomLike } from './room-like.js';
import { PromptTimeoutError, RoomClosedError, type RoomUser } from './room.js';

/* ------------------- the slice of Cloudflare's API this uses ------------------- */

/** A websocket as a Durable Object sees it (hibernation API). */
export interface CloudflareSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface CloudflareStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface CloudflareContext {
  readonly storage: CloudflareStorage;
  getWebSockets(tag?: string): CloudflareSocket[];
  acceptWebSocket(ws: CloudflareSocket, tags?: string[]): void;
}

export interface CloudflareRoomOptions {
  /** How long a new socket has to answer the `auth` request. Default 5000. */
  readonly authTimeoutMs?: number;
  readonly maxTokenLength?: number;
  readonly maxMessageLength?: number;
  /** The clock, for tests. */
  readonly now?: () => number;
  /** Makes the two ends of a websocket, for `fetch`. Default: `new WebSocketPair()`. */
  readonly webSocketPair?: () => { client: unknown; server: CloudflareSocket };
}

/** What `onReply` is told. */
export type Reply =
  | { readonly ok: true; readonly id: string; readonly userId: string; readonly name: string; readonly value: unknown }
  | { readonly ok: false; readonly id: string; readonly userId: string; readonly name: string; readonly error: Error };

/** What is kept in the attachment of each socket. Small: attachments are limited to about 2 KB. */
type Attachment =
  | { readonly phase: 'auth'; readonly authId: string }
  | { readonly phase: 'user'; readonly userId: string; readonly replaced?: boolean };

interface StoredPrompt {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly payload: unknown;
}

interface StoredTimer {
  readonly at: number;
  readonly name: string;
  readonly data: unknown;
}

const KEY = { users: 'room:users', prompts: 'room:prompts', timers: 'room:timers', counter: 'room:counter', state: 'state:' } as const;
const INTERNAL = { auth: '\u0000auth', prompt: '\u0000prompt' } as const;

const defined = (value: unknown): unknown => (value === undefined ? null : value);
const frame = (message: MessageBridgeMessage): string => JSON.stringify(message);

export class CloudflareRoom<Init = unknown> implements RoomLike {
  readonly users: Record<string, RoomUser<Init>> = {};
  readonly #ctx: CloudflareContext;
  readonly #options: CloudflareRoomOptions;
  #prompts: Record<string, StoredPrompt> = {};
  #timers: Record<string, StoredTimer> = {};
  #counter = 0;
  #closed = false;
  readonly #local = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #intents = new Map<string, (userId: string, payload: unknown) => unknown | Promise<unknown>>();
  readonly #replyHandlers = new Set<(reply: Reply) => void>();
  readonly #timerHandlers = new Map<string, (data: unknown) => void | Promise<void>>();
  readonly #onConnect = new Set<(userId: string, info: { reconnect: boolean }) => void>();
  readonly #onDisconnect = new Set<(userId: string) => void>();

  constructor(ctx: CloudflareContext, options: CloudflareRoomOptions = {}) {
    this.#ctx = ctx;
    this.#options = options;
  }

  get #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /* ------------------------------ persistence ------------------------------ */

  /** Reads back everything the room kept. Call once per wake, before handling events. */
  async load(): Promise<void> {
    const { storage } = this.#ctx;
    const users = (await storage.get<Record<string, RoomUser<Init>>>(KEY.users)) ?? {};
    for (const key of Object.keys(this.users)) delete this.users[key];
    Object.assign(this.users, users);
    this.#prompts = (await storage.get<Record<string, StoredPrompt>>(KEY.prompts)) ?? {};
    this.#timers = (await storage.get<Record<string, StoredTimer>>(KEY.timers)) ?? {};
    this.#counter = (await storage.get<number>(KEY.counter)) ?? 0;
  }

  /** Keeps a value of the game's, so it is there after the object is rebuilt. Must be JSON-like. */
  save(key: string, value: unknown): Promise<void> {
    return this.#ctx.storage.put(KEY.state + key, value);
  }

  read<T = unknown>(key: string): Promise<T | undefined> {
    return this.#ctx.storage.get<T>(KEY.state + key);
  }

  forget(key: string): Promise<boolean | void> {
    return this.#ctx.storage.delete(KEY.state + key);
  }

  async #persist(what: 'users' | 'prompts' | 'timers'): Promise<void> {
    const { storage } = this.#ctx;
    if (what === 'users') await storage.put(KEY.users, this.users);
    else if (what === 'prompts') await storage.put(KEY.prompts, this.#prompts);
    else await storage.put(KEY.timers, this.#timers);
  }

  async #nextId(prefix: string): Promise<string> {
    this.#counter += 1;
    await this.#ctx.storage.put(KEY.counter, this.#counter);
    return `${prefix}${this.#counter}`;
  }

  /* -------------------------------- users --------------------------------- */

  async addUser(userId: string, user: RoomUser<Init>): Promise<void> {
    assertFreshToken(this.users, userId, user.authToken);
    if (userId in this.users) throw new Error(`Room: ${userId} is already in the room`);
    this.users[userId] = user;
    await this.#persist('users');
  }

  get userIds(): string[] {
    return Object.keys(this.users);
  }

  gameInit(userId: string): Init {
    const user = this.users[userId];
    if (!user) throw new Error(`Room: no user "${userId}"`);
    return user.gameInit;
  }

  /* ----------------------- waking: a new websocket ------------------------ */

  /** The Durable Object's `fetch` for a websocket upgrade: makes the pair, accepts one end. */
  fetch(_request?: unknown): Response {
    const { client, server } = this.#options.webSocketPair?.() ?? globalPair();
    this.accept(server);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  /** Takes a new socket, and asks it who it is. */
  accept(ws: CloudflareSocket): void {
    if (this.#closed) throw new RoomClosedError();
    this.#ctx.acceptWebSocket(ws);
    const authId = `auth-${this.#now}-${Math.random().toString(36).slice(2, 10)}`;
    ws.serializeAttachment({ phase: 'auth', authId } satisfies Attachment);
    ws.send(frame({ id: authId, messageType: 'request', path: PATH.auth, value: {} }));
    void this.#putTimer(`${INTERNAL.auth}:${authId}`, INTERNAL.auth, this.#options.authTimeoutMs ?? 5000, { authId });
  }

  /* ----------------------- waking: a websocket message ---------------------- */

  async webSocketMessage(ws: CloudflareSocket, data: string | ArrayBuffer): Promise<void> {
    const attachment = this.#attachment(ws);
    if (!attachment) return ws.close(CLOSE.rejected, BAD_USER);
    const max = this.#options.maxMessageLength ?? 1_000_000;
    if (typeof data === 'string' && data.length > max) return ws.close(CLOSE.protocol, 'message too large');
    const parsed = parseFrame(data as string);

    if (attachment.phase === 'auth') {
      // Until the token is accepted the only thing listened to is the answer to our `auth`.
      if ('error' in parsed) return ws.close(CLOSE.rejected, BAD_USER);
      const message = parsed.message;
      if (message.messageType !== 'response' || message.id !== attachment.authId) return;
      await this.#admit(ws, message.valueType === 'result' ? message.value : undefined);
      return;
    }

    if (attachment.replaced) return; // an older socket that was replaced
    const { userId } = attachment;
    if ('error' in parsed) return this.#tell(ws, PATH.error, { message: parsed.error });
    const message = parsed.message;

    // An answer to something we asked: matched against the stored table, not a bridge's memory.
    if (message.messageType === 'response') {
      await this.#answer(userId, message);
      return;
    }
    // Everything else goes through a bridge, which only needs the handlers (no memory of its own).
    const bridge = new MessageBridge((out) => ws.send(frame(out)));
    bridge.onRequest(PATH.intent, (body: IntentBody) => this.#runIntent(userId, body));
    try {
      await bridge.handleMessage(message);
    } catch (error) {
      this.#tell(ws, PATH.error, { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async #admit(ws: CloudflareSocket, token: unknown): Promise<void> {
    const found = findUser(this.users, token, this.#options.maxTokenLength ?? 1024);
    if (found === null) return ws.close(CLOSE.rejected, BAD_USER);
    const userId = found;
    const previous = this.#liveSockets().filter(({ id }) => id === userId);
    const reconnect = previous.length > 0 || (await this.read<boolean>(`seen:${userId}`)) === true;
    for (const { ws: old } of previous) {
      old.serializeAttachment({ phase: 'user', userId, replaced: true } satisfies Attachment);
      old.close(CLOSE.replaced, 'replaced by a newer connection');
    }
    const waiting = this.#attachment(ws);
    ws.serializeAttachment({ phase: 'user', userId } satisfies Attachment);
    if (waiting?.phase === 'auth') await this.#clearTimer(`${INTERNAL.auth}:${waiting.authId}`);
    await this.save(`seen:${userId}`, true);
    this.#tell(ws, PATH.welcome, { userId });
    // Whatever the room was waiting on this user for, it is still waiting.
    for (const pending of Object.values(this.#prompts)) if (pending.userId === userId) this.#sendPrompt(ws, pending);
    for (const listener of this.#onConnect) listener(userId, { reconnect });
  }

  async #runIntent(userId: string, body: IntentBody): Promise<unknown> {
    const handler = typeof body?.name === 'string' ? this.#intents.get(body.name) : undefined;
    if (!handler) throw new Error(`there is no "${String(body?.name)}" to do`);
    return defined(await handler(userId, body.payload));
  }

  async #answer(userId: string, message: Extract<MessageBridgeMessage, { messageType: 'response' }>): Promise<void> {
    const pending = this.#prompts[message.id];
    // Somebody else's prompt, or one already settled: nothing to do.
    if (!pending || pending.userId !== userId) return;
    delete this.#prompts[message.id];
    await this.#persist('prompts');
    await this.#clearTimer(`${INTERNAL.prompt}:${pending.id}`);
    const reply: Reply =
      message.valueType === 'result'
        ? { ok: true, id: pending.id, userId, name: pending.name, value: message.value }
        : { ok: false, id: pending.id, userId, name: pending.name, error: new Error(String(message.value)) };
    this.#deliver(reply);
  }

  #deliver(reply: Reply): void {
    const local = this.#local.get(reply.id);
    if (local) {
      this.#local.delete(reply.id);
      if (reply.ok) local.resolve(reply.value);
      else local.reject(reply.error);
    }
    for (const handler of this.#replyHandlers) handler(reply);
  }

  /* ----------------------- waking: a disconnect ------------------------ */

  async webSocketClose(ws: CloudflareSocket, _code?: number, _reason?: string): Promise<void> {
    const attachment = this.#attachment(ws);
    if (!attachment || attachment.phase !== 'user' || attachment.replaced) return;
    // Another live socket for the same user means this was not a departure.
    const stillHere = this.#liveSockets().some(({ ws: other, id }) => other !== ws && id === attachment.userId);
    if (stillHere) return;
    for (const listener of this.#onDisconnect) listener(attachment.userId);
  }

  async webSocketError(ws: CloudflareSocket, _error?: unknown): Promise<void> {
    await this.webSocketClose(ws);
  }

  /* ------------------------------ connections ------------------------------ */

  #attachment(ws: CloudflareSocket): Attachment | undefined {
    const value = ws.deserializeAttachment() as Attachment | null | undefined;
    return value && typeof value === 'object' && 'phase' in value ? value : undefined;
  }

  /** Authenticated, not-replaced sockets and whose they are. */
  #liveSockets(): { ws: CloudflareSocket; id: string }[] {
    const live: { ws: CloudflareSocket; id: string }[] = [];
    for (const ws of this.#ctx.getWebSockets()) {
      const attachment = this.#attachment(ws);
      if (attachment?.phase === 'user' && !attachment.replaced) live.push({ ws, id: attachment.userId });
    }
    return live;
  }

  get connected(): string[] {
    return [...new Set(this.#liveSockets().map(({ id }) => id))];
  }

  isConnected(userId: string): boolean {
    return this.#liveSockets().some(({ id }) => id === userId);
  }

  onConnect(listener: (userId: string, info: { reconnect: boolean }) => void): () => void {
    this.#onConnect.add(listener);
    return () => void this.#onConnect.delete(listener);
  }

  onDisconnect(listener: (userId: string) => void): () => void {
    this.#onDisconnect.add(listener);
    return () => void this.#onDisconnect.delete(listener);
  }

  /* -------------------------------- talking -------------------------------- */

  #tell(ws: CloudflareSocket, path: string, value: unknown): void {
    ws.send(frame({ messageType: 'event', path, value: defined(value) }));
  }

  send(userId: string, path: string, value: unknown): boolean {
    const target = this.#liveSockets().find(({ id }) => id === userId);
    if (!target) return false;
    this.#tell(target.ws, path, value);
    return true;
  }

  broadcast(path: string, value: unknown): void {
    for (const userId of this.connected) this.send(userId, path, value);
  }

  onIntent(name: string, handler: (userId: string, payload: unknown) => unknown | Promise<unknown>): () => void {
    if (this.#intents.has(name)) throw new Error(`Room: "${name}" already has a handler`);
    this.#intents.set(name, handler);
    return () => void this.#intents.delete(name);
  }

  #sendPrompt(ws: CloudflareSocket, pending: StoredPrompt): void {
    const body: PromptBody = { name: pending.name, payload: defined(pending.payload) };
    ws.send(frame({ id: pending.id, messageType: 'request', path: PATH.prompt, value: body }));
  }

  /**
   * Asks a user something, and stores the question. The answer arrives at `onReply` — also
   * after the object has been rebuilt. If the user is away it is asked when they return.
   * Returns the prompt's id.
   */
  async ask(userId: string, name: string, payload: unknown, options: { timeoutMs?: number } = {}): Promise<string> {
    if (this.#closed) throw new RoomClosedError();
    if (!(userId in this.users)) throw new Error(`Room: no user "${userId}"`);
    const id = await this.#nextId('prompt-');
    this.#prompts[id] = { id, userId, name, payload: defined(payload) };
    await this.#persist('prompts');
    if (options.timeoutMs !== undefined) await this.#putTimer(`${INTERNAL.prompt}:${id}`, INTERNAL.prompt, options.timeoutMs, { id });
    const target = this.#liveSockets().find((live) => live.id === userId);
    if (target) this.#sendPrompt(target.ws, this.#prompts[id]!);
    return id;
  }

  /** `ask`, as a promise — good while the object stays awake. Lost if it is evicted first. */
  async prompt<T = unknown>(userId: string, name: string, payload: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    // Registered before the question goes out so a fast answer is not missed.
    const nextId = `prompt-${this.#counter + 1}`;
    const result = new Promise<T>((resolve, reject) => {
      this.#local.set(nextId, { resolve: resolve as (value: unknown) => void, reject });
    });
    result.catch(() => undefined);
    try {
      const id = await this.ask(userId, name, payload, options);
      if (id !== nextId) throw new Error('Room: prompt ids raced');
    } catch (error) {
      this.#local.delete(nextId);
      throw error;
    }
    return result;
  }

  /** Called with each answer (or failure, or timeout) to a prompt. Register on every wake. */
  onReply(handler: (reply: Reply) => void): () => void {
    this.#replyHandlers.add(handler);
    return () => void this.#replyHandlers.delete(handler);
  }

  /* -------------------------------- timers -------------------------------- */

  /**
   * Runs `onTimer(name)` handlers with `data` after `delayMs`, even across eviction: it is
   * stored, and the platform alarm is set to the earliest. Returns the timer's id.
   */
  async setTimer(name: string, delayMs: number, data: unknown = null): Promise<string> {
    if (name.startsWith('\u0000')) throw new Error('Room: that timer name is reserved');
    const id = await this.#nextId('timer-');
    await this.#putTimer(id, name, delayMs, data);
    return id;
  }

  async clearTimer(id: string): Promise<boolean> {
    return this.#clearTimer(id);
  }

  /** Handles timers of this name when they fire. Register on every wake. One handler per name. */
  onTimer(name: string, handler: (data: unknown) => void | Promise<void>): () => void {
    if (this.#timerHandlers.has(name)) throw new Error(`Room: "${name}" already has a timer handler`);
    this.#timerHandlers.set(name, handler);
    return () => void this.#timerHandlers.delete(name);
  }

  /** The timers waiting, soonest first. */
  get timers(): { id: string; name: string; at: number; data: unknown }[] {
    return Object.entries(this.#timers)
      .filter(([, timer]) => !timer.name.startsWith('\u0000'))
      .map(([id, timer]) => ({ id, ...timer }))
      .sort((a, b) => a.at - b.at);
  }

  async #putTimer(key: string, name: string, delayMs: number, data: unknown): Promise<void> {
    this.#timers[key] = { at: this.#now + delayMs, name, data };
    await this.#persist('timers');
    await this.#rearm();
  }

  async #clearTimer(id: string): Promise<boolean> {
    if (!(id in this.#timers)) return false;
    delete this.#timers[id];
    await this.#persist('timers');
    await this.#rearm();
    return true;
  }

  /** The socket still waiting to answer the `auth` request with this id, if any. */
  #socketAwaiting(authId: string): CloudflareSocket | undefined {
    return this.#ctx.getWebSockets().find((ws) => {
      const attachment = this.#attachment(ws);
      return attachment?.phase === 'auth' && attachment.authId === authId;
    });
  }

  async #rearm(): Promise<void> {
    const times = Object.values(this.#timers).map((timer) => timer.at);
    if (times.length === 0) await this.#ctx.storage.deleteAlarm();
    else await this.#ctx.storage.setAlarm(Math.min(...times));
  }

  /* ----------------------------- waking: an alarm ----------------------------- */

  /** The Durable Object's `alarm()`: runs every timer that is due, then sets the alarm for the next. */
  async alarm(): Promise<void> {
    const now = this.#now;
    const due = Object.entries(this.#timers)
      .filter(([, timer]) => timer.at <= now)
      .sort((a, b) => a[1].at - b[1].at);
    // Removed before they run, so a timer that throws is not run again for ever.
    for (const [id] of due) delete this.#timers[id];
    await this.#persist('timers');
    await this.#rearm();
    for (const [, timer] of due) {
      if (timer.name === INTERNAL.auth) {
        const waiting = this.#socketAwaiting((timer.data as { authId: string }).authId);
        waiting?.close(CLOSE.authTimeout, 'authentication timed out');
      } else if (timer.name === INTERNAL.prompt) {
        const pending = this.#prompts[(timer.data as { id: string }).id];
        if (!pending) continue;
        delete this.#prompts[pending.id];
        await this.#persist('prompts');
        this.#deliver({ ok: false, id: pending.id, userId: pending.userId, name: pending.name, error: new PromptTimeoutError(pending.name, pending.userId) });
      } else {
        await this.#timerHandlers.get(timer.name)?.(timer.data);
      }
    }
  }

  /** Closes every socket and fails what was waiting. Clears timers. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const pending of Object.values(this.#prompts)) {
      this.#deliver({ ok: false, id: pending.id, userId: pending.userId, name: pending.name, error: new RoomClosedError() });
    }
    this.#prompts = {};
    this.#timers = {};
    await this.#persist('prompts');
    await this.#persist('timers');
    await this.#ctx.storage.deleteAlarm();
    for (const ws of this.#ctx.getWebSockets()) ws.close(CLOSE.roomClosed, 'the room was closed');
  }
}

/** The platform's `WebSocketPair`, as `{ client, server }`. */
function globalPair(): { client: unknown; server: CloudflareSocket } {
  const Pair = (globalThis as { WebSocketPair?: new () => Record<number, unknown> }).WebSocketPair;
  if (!Pair) throw new Error('CloudflareRoom.fetch: this environment has no WebSocketPair — pass webSocketPair');
  const pair = new Pair();
  return { client: pair[0], server: pair[1] as CloudflareSocket };
}
