/**
 * What goes over the wire between a server and a client.
 *
 * Both ends speak through a `MessageBridge` (`src/util/MessageBridge`), so there is no
 * message format of our own: just the bridge's requests, responses and events, at these
 * **paths**.
 *
 * | Path | Kind | From | Carries |
 * | --- | --- | --- | --- |
 * | `auth` | request | server → client | `{}` → the client's auth token |
 * | `prompt` | request | server → client | `{ name, payload }` → the client's reply |
 * | `intent` | request | client → server | `{ name, payload }` → the server's result |
 * | `welcome` | event | server → client | `{ userId }` — the token was accepted |
 * | `view` | event | server → client | `{ view }` — the game as this user may see it |
 * | `event` | event | server → client | `{ event }` — one thing that happened, redacted |
 * | `error` | event | server → client | `{ message }` — something could not be understood |
 *
 * **The server asks for the token.** A new connection is sent an `auth` request; the
 * client answers it with its token (`client.onRequest('auth', () => authToken)`). Until
 * the answer is a token the room holds, the socket is nobody and everything it sends but
 * that answer is ignored. Authentication itself — who a token belongs to, how it was
 * issued — is somebody else's job: the room is only told which token is whose.
 *
 * Note for anything that answers a request: the bridge drops a response whose value is
 * `undefined` (it does not survive JSON), so a handler returns `null` for "nothing".
 */

export const PATH = {
  auth: 'auth',
  prompt: 'prompt',
  intent: 'intent',
  welcome: 'welcome',
  view: 'view',
  event: 'event',
  error: 'error',
} as const;

/** Close codes. `4000`–`4999` are the range WebSocket leaves to applications. */
export const CLOSE = {
  /** The token was not one the room holds. The reason says only `Bad User`. */
  rejected: 4001,
  /** The same user connected again; this older connection was closed. */
  replaced: 4002,
  /** The client did not answer the `auth` request in time. */
  authTimeout: 4003,
  /** A message that could not be accepted at all (too large). */
  protocol: 4004,
  /** The room was closed by the server. */
  roomClosed: 4005,
} as const;

/** The reason given when a token is not recognised — the same for every kind of wrong. */
export const BAD_USER = 'Bad User';

/** The body of a `prompt` request. */
export interface PromptBody {
  readonly name: string;
  readonly payload: unknown;
}

/** The body of an `intent` request. */
export interface IntentBody {
  readonly name: string;
  readonly payload?: unknown;
}
