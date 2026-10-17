/**
 * The smallest socket the transport needs, so the same room and client run over a real
 * WebSocket, a test double, or anything else that can send text and tell you what
 * arrived.
 *
 * `fromWebSocket` adapts the standard WebSocket API — a browser's `WebSocket`, Node's
 * global `WebSocket`, and the `ws` library's server sockets all offer
 * `addEventListener` — so a server needs no more than
 * `wss.on('connection', (ws) => room.addWebsocket(ws))`.
 */

/** What arrived on a socket: text, or something binary the transport will refuse. */
export type SocketData = string | ArrayBuffer | ArrayBufferView | Blob;

export interface SocketLike {
  send(data: string): void;
  /** Closes the connection. The codes `4000`–`4999` are free for an application to use. */
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: SocketData) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  /** Called once the connection is open (for a client socket that is still connecting). */
  onOpen?(handler: () => void): void;
  readonly isOpen: boolean;
}

/** The part of the standard WebSocket API this adapter uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
  readonly readyState: number;
}

/** Whether `value` already has the transport's shape, so it needs no adapting. */
export function isSocketLike(value: unknown): value is SocketLike {
  const candidate = value as Partial<SocketLike> | null;
  return !!candidate && typeof candidate.onMessage === 'function' && typeof candidate.onClose === 'function';
}

/** Wraps a standard WebSocket. */
export function fromWebSocket(ws: WebSocketLike): SocketLike {
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onMessage: (handler) => ws.addEventListener('message', ((event: { data: SocketData }) => handler(event.data)) as never),
    onClose: (handler) =>
      ws.addEventListener('close', ((event: { code: number; reason: string }) => handler(event.code, event.reason)) as never),
    onOpen: (handler) => ws.addEventListener('open', (() => handler()) as never),
    get isOpen() {
      return ws.readyState === 1;
    },
  };
}

/**
 * Two connected ends, in memory — for tests, and for running a server and its clients
 * in one process. Delivery is asynchronous (a microtask), like a real socket, so code
 * that works here does not depend on a message arriving before `send` returns.
 */
export function memoryPair(): [client: SocketLike, server: SocketLike] {
  type End = {
    socket: SocketLike;
    receive(data: SocketData): void;
    closed(code: number, reason: string): void;
  };
  // Closing is two steps, as on a real socket: no more can be *sent* at once, but what
  // was already on its way still arrives, and only then do both ends hear about the close.
  let closing = false;
  let closed = false;
  const make = (): { end: End; peer: { other?: End } } => {
    const messageHandlers: ((data: SocketData) => void)[] = [];
    const closeHandlers: ((code: number, reason: string) => void)[] = [];
    const peer: { other?: End } = {};
    const end: End = {
      socket: {
        send(data) {
          if (closing) throw new Error('memory socket: the connection is closed');
          const other = peer.other;
          queueMicrotask(() => other?.receive(data));
        },
        close(code = 1000, reason = '') {
          if (closing) return;
          closing = true;
          const other = peer.other;
          queueMicrotask(() => {
            closed = true;
            end.closed(code, reason);
            other?.closed(code, reason);
          });
        },
        onMessage: (handler) => void messageHandlers.push(handler),
        onClose: (handler) => void closeHandlers.push(handler),
        onOpen: (handler) => queueMicrotask(handler),
        get isOpen() {
          return !closing;
        },
      },
      receive: (data) => {
        if (!closed) for (const handler of messageHandlers) handler(data);
      },
      closed: (code, reason) => {
        for (const handler of closeHandlers) handler(code, reason);
      },
    };
    return { end, peer };
  };
  const a = make();
  const b = make();
  a.peer.other = b.end;
  b.peer.other = a.end;
  return [a.end.socket, b.end.socket];
}
