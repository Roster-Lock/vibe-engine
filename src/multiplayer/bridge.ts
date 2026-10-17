/**
 * Runs a `MessageBridge` over a socket.
 *
 * The bridge turns requests, responses and events into plain messages and hands them to
 * the `sendMessage` it was built with; this wires that to a socket (JSON text each way)
 * and tears the bridge down when the socket closes, so a request still waiting fails
 * instead of hanging.
 */
import { MessageBridge, type MessageBridgeMessage } from '../util/MessageBridge/index.js';
import type { SocketData, SocketLike } from './socket.js';

export interface BridgeOverSocket {
  readonly bridge: MessageBridge;
}

export interface BridgeOptions {
  /**
   * Looks at each message before the bridge does. Return `false` to drop it — how a room
   * ignores everything from a socket that has not authenticated.
   */
  readonly filter?: (message: MessageBridgeMessage) => boolean;
  /** Called with a reason when something arrives that is not a bridge message. */
  readonly onProtocolError?: (reason: string) => void;
  /** The longest text frame accepted. A longer one is not read; `onTooLarge` is called instead. */
  readonly maxLength?: number;
  readonly onTooLarge?: () => void;
}

/** Parses one frame into a bridge message, or says why it cannot be. */
export function parseFrame(data: SocketData): { message: MessageBridgeMessage } | { error: string } {
  if (typeof data !== 'string') return { error: 'binary messages are not accepted' };
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { error: 'that message is not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || typeof (raw as { messageType?: unknown }).messageType !== 'string') {
    return { error: 'that is not a message' };
  }
  return { message: raw as MessageBridgeMessage };
}

/** A bridge whose messages go out over `socket` and whose incoming ones come from it. */
export function bridgeOver(socket: SocketLike, options: BridgeOptions = {}): BridgeOverSocket {
  const bridge = new MessageBridge((message) => {
    if (socket.isOpen) socket.send(JSON.stringify(message));
  });
  socket.onMessage((data) => {
    if (options.maxLength !== undefined && typeof data === 'string' && data.length > options.maxLength) {
      options.onTooLarge?.();
      return;
    }
    const parsed = parseFrame(data);
    if ('error' in parsed) {
      options.onProtocolError?.(parsed.error);
      return;
    }
    if (options.filter && !options.filter(parsed.message)) return;
    // The bridge rejects a message it cannot place (a response nobody asked for, a malformed
    // body); a peer sending those must not be able to raise an unhandled rejection here.
    bridge.handleMessage(parsed.message).catch((error: unknown) => {
      options.onProtocolError?.(error instanceof Error ? error.message : String(error));
    });
  });
  socket.onClose(() => bridge.destroy());
  return { bridge };
}
