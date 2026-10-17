/**
 * The client's end of the transport.
 *
 * ```ts
 * const client = createClient({ url: 'wss://example.com/room/7', authToken });
 * await client.ready;                            // resolves once the room accepts the token
 * client.on('view', (view) => render(view));     // the whole game, as you may see it
 * client.on('event', (event) => animate(event)); // what just happened, redacted for you
 * client.onPrompt(async (name, payload) => ...); // the room needs an answer from you
 * await client.intent('end-turn');               // ask for something to happen
 * ```
 *
 * **The room asks for the token**: the client answers the room's `auth` request with it,
 * `bridge.onRequest('auth', () => authToken)`. Where the token comes from (a login, a link,
 * a cookie) is not this module's business: `createClient` is handed it.
 */
import type { GameView, ViewEvent } from '../engine/index.js';
import { bridgeOver } from './bridge.js';
import { BAD_USER, CLOSE, PATH, type IntentBody, type PromptBody } from './protocol.js';
import { fromWebSocket, isSocketLike, type SocketLike, type WebSocketLike } from './socket.js';

export interface ClientOptions {
  /** The token the room expects for this user. Given to the room when it asks. */
  readonly authToken: string;
  /** Where to connect, using `WebSocket` (the global one unless `WebSocket` is given). */
  readonly url?: string;
  /** Already-open or connecting socket to use instead of connecting to `url`. */
  readonly socket?: SocketLike | WebSocketLike;
  /** A WebSocket constructor, for an environment that has no global one. */
  readonly WebSocket?: new (url: string) => WebSocketLike;
}

/** Why the room did not accept the connection. */
export class RejectedError extends Error {
  constructor(readonly reason: string) {
    super(`the room rejected the connection: ${reason}`);
    this.name = 'RejectedError';
  }
}

export interface ClientEvents {
  view: GameView;
  event: ViewEvent;
  /** The room could not make sense of something the client sent. */
  error: string;
  closed: { code: number; reason: string };
}

export interface Client {
  /** Resolves with the user id once the room accepts the token; rejects with `RejectedError` if it does not. */
  readonly ready: Promise<{ userId: string }>;
  readonly userId: string | undefined;
  /** The most recent `view` the room sent. */
  readonly view: GameView | undefined;
  /** Subscribes to something the room sends. Returns a function that unsubscribes. */
  on<K extends keyof ClientEvents>(type: K, listener: (payload: ClientEvents[K]) => void): () => void;
  /**
   * Answers the room's prompts: called with the prompt's name and payload, and whatever it
   * returns (or resolves to) is the reply. If it throws, the room is told it could not answer.
   */
  onPrompt(handler: (name: string, payload: unknown) => unknown | Promise<unknown>): void;
  /** Asks for something to happen. Resolves with the result; rejects with the room's error. */
  intent<T = unknown>(name: string, payload?: unknown): Promise<T>;
  close(): void;
}

export function createClient(options: ClientOptions): Client {
  const socket = openSocket(options);
  const listeners: { [K in keyof ClientEvents]: Set<(payload: ClientEvents[K]) => void> } = {
    view: new Set(),
    event: new Set(),
    error: new Set(),
    closed: new Set(),
  };
  const emit = <K extends keyof ClientEvents>(type: K, payload: ClientEvents[K]): void => {
    for (const listener of listeners[type]) listener(payload);
  };
  let promptHandler: ((name: string, payload: unknown) => unknown | Promise<unknown>) | undefined;
  let userId: string | undefined;
  let view: GameView | undefined;
  let settled = false;

  let resolveReady!: (value: { userId: string }) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<{ userId: string }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A caller who never awaits `ready` must not get an unhandled rejection for a rejected token.
  ready.catch(() => undefined);

  const { bridge } = bridgeOver(socket, {
    onProtocolError: (reason) => emit('error', reason),
  });

  // The room asks who we are; this is the whole of authentication from this side.
  bridge.onRequest(PATH.auth, () => options.authToken);
  bridge.onRequest(PATH.prompt, async (body: PromptBody) => {
    if (!promptHandler) throw new Error('this client has no way to answer that');
    const value = await promptHandler(body.name, body.payload);
    return value === undefined ? null : value;
  });
  bridge.onEvent(PATH.welcome, (body: { userId: string }) => {
    userId = body.userId;
    settled = true;
    resolveReady({ userId: body.userId });
  });
  bridge.onEvent(PATH.view, (body: GameView) => {
    view = body;
    emit('view', body);
  });
  bridge.onEvent(PATH.event, (body: ViewEvent) => emit('event', body));
  bridge.onEvent(PATH.error, (body: { message: string }) => emit('error', body.message));

  socket.onClose((code, reason) => {
    if (!settled) {
      settled = true;
      rejectReady(
        code === CLOSE.rejected
          ? new RejectedError(reason || BAD_USER)
          : new Error(`the connection closed before the room answered (${code}${reason ? `: ${reason}` : ''})`),
      );
    }
    emit('closed', { code, reason });
  });

  return {
    ready,
    get userId() {
      return userId;
    },
    get view() {
      return view;
    },
    on(type, listener) {
      (listeners[type] as Set<typeof listener>).add(listener);
      return () => void (listeners[type] as Set<typeof listener>).delete(listener);
    },
    onPrompt(handler) {
      promptHandler = handler;
    },
    async intent<T>(name: string, payload?: unknown): Promise<T> {
      // Nothing will ever answer on a connection that is gone: say so now, not never.
      if (!socket.isOpen) throw new Error('the connection is closed');
      const body: IntentBody = payload === undefined ? { name } : { name, payload };
      return (await bridge.sendRequest(PATH.intent, body)) as T;
    },
    close() {
      socket.close(1000, 'client closed');
    },
  };
}

function openSocket(options: ClientOptions): SocketLike {
  if (options.socket) return isSocketLike(options.socket) ? options.socket : fromWebSocket(options.socket);
  if (!options.url) throw new Error('createClient: give it a url to connect to, or a socket');
  const Impl = options.WebSocket ?? (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Impl) throw new Error('createClient: this environment has no WebSocket — pass one as the WebSocket option');
  return fromWebSocket(new Impl(options.url));
}
