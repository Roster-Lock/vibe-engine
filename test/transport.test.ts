/**
 * The transport (src/multiplayer): a `Room` on the server, `createClient` on the other end.
 *
 * Both ends run a `MessageBridge`. The room asks each new socket for its token with an
 * `auth` request; the client answers with `onRequest('auth', () => authToken)`. The room holds
 * `Record<userId, { authToken, gameInit }>` and looks the answer up. Authentication itself is
 * somebody else's: the room only compares.
 */
import { describe, expect, it } from 'vitest';
import { compileDocument } from '../src/english/index.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import {
  CLOSE,
  PromptTimeoutError,
  RejectedError,
  RemotePlayer,
  Room,
  RoomClosedError,
  attachGame,
  createClient,
  fromWebSocket,
  fromWireAnswer,
  memoryPair,
  toWireRequest,
  type Client,
  type SocketData,
  type SocketLike,
  type WebSocketLike,
  type WireRequest,
} from '../src/multiplayer/index.js';
import {
  Character,
  Player,
  ViewProjector,
  createEngine,
  type ChoiceRequest,
  type Decision,
  type Entity,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { PLAY } from '../src/engine/index.js';
import { GARBAGE } from '../src/engine/index.js';

const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await tick(2);
};

/** A socket that remembers everything that crossed it. */
function spy(socket: SocketLike) {
  const inbound: SocketData[] = [];
  const outbound: string[] = [];
  const wrapped: SocketLike = {
    send: (data) => {
      outbound.push(data);
      socket.send(data);
    },
    close: (code, reason) => socket.close(code, reason),
    onMessage: (handler) =>
      socket.onMessage((data) => {
        inbound.push(data);
        handler(data);
      }),
    onClose: (handler) => socket.onClose(handler),
    onOpen: (handler) => socket.onOpen?.(handler),
    get isOpen() {
      return socket.isOpen;
    },
  };
  return { socket: wrapped, inbound, outbound };
}

const USERS = {
  alice: { authToken: 'token-for-alice', gameInit: { hand: ['ALICE-FIRE', 'ALICE-ICE'] } },
  bob: { authToken: 'token-for-bob', gameInit: { hand: ['BOB-WIND', 'BOB-STONE'] } },
};

/** Connects a client for `authToken` to `room`; returns both ends' traffic. */
function connect(room: Room, authToken: string) {
  const [clientEnd, serverEnd] = memoryPair();
  const client = spy(clientEnd);
  const server = spy(serverEnd);
  room.addWebsocket(server.socket);
  const handle = createClient({ authToken, socket: client.socket });
  return { client: handle, clientSocket: clientEnd, ...client, serverSide: server };
}

/** A bare socket to a room that answers nothing by itself — for driving the protocol by hand. */
function bare(room: Room) {
  const [clientEnd, serverEnd] = memoryPair();
  room.addWebsocket(serverEnd);
  const frames: any[] = [];
  const closes: { code: number; reason: string }[] = [];
  clientEnd.onMessage((data) => frames.push(JSON.parse(data as string)));
  clientEnd.onClose((code, reason) => closes.push({ code, reason }));
  const answerAuth = async (token: unknown) => {
    await settle();
    const ask = frames.find((frame) => frame.messageType === 'request' && frame.path === 'auth');
    clientEnd.send(JSON.stringify({ id: ask.id, messageType: 'response', valueType: 'result', value: token }));
  };
  return { socket: clientEnd, frames, closes, answerAuth };
}

describe('authenticating', () => {
  it('asks for the token itself, as an auth request, and the client answers it', async () => {
    const room = new Room(USERS);
    const c = connect(room, 'token-for-alice');
    await c.client.ready;
    const ask = c.inbound.map((frame) => JSON.parse(frame as string)).find((m) => m.path === 'auth');
    expect(ask).toMatchObject({ messageType: 'request', path: 'auth', value: {} });
    const answer = c.outbound.map((frame) => JSON.parse(frame)).find((m) => m.messageType === 'response');
    expect(answer).toMatchObject({ id: ask.id, valueType: 'result', value: 'token-for-alice' });
    // The client says nothing until it is asked.
    expect(JSON.parse(c.outbound[0]!).messageType).toBe('response');
  });

  it('accepts a token the room holds and tells the client who it is', async () => {
    const room = new Room(USERS);
    const c = connect(room, 'token-for-bob');
    expect(await c.client.ready).toEqual({ userId: 'bob' });
    expect(c.client.userId).toBe('bob');
    expect(room.isConnected('bob')).toBe(true);
    expect(room.connected).toEqual(['bob']);
  });

  it('rejects a token nobody holds, says so, and closes', async () => {
    const room = new Room(USERS);
    const c = connect(room, 'a-guess');
    const closed = new Promise<{ code: number }>((resolve) => c.client.on('closed', resolve));
    await expect(c.client.ready).rejects.toBeInstanceOf(RejectedError);
    await expect(c.client.ready).rejects.toThrow(/Bad User/);
    await settle();
    expect(room.connected).toEqual([]);
    expect(await closed).toEqual({ code: CLOSE.rejected, reason: 'Bad User' });
  });

  it('tells a rejected socket nothing about the room', async () => {
    const room = new Room(USERS);
    const c = connect(room, 'a-guess');
    await c.client.ready.catch(() => undefined);
    await settle();
    // The only thing it was ever sent is the question.
    expect(c.inbound.map((frame) => JSON.parse(frame as string).path)).toEqual(['auth']);
    const wire = c.inbound.join('');
    for (const secret of ['alice', 'bob', 'token-for', 'ALICE-FIRE']) expect(wire).not.toContain(secret);
  });

  it('treats a near-miss, an empty token and an oversized one the same', async () => {
    const room = new Room(USERS, { maxTokenLength: 64 });
    const reasons: string[] = [];
    for (const token of ['token-for-alicf', 'token-for-alice ', 'x'.repeat(200)]) {
      const c = connect(room, token);
      await c.client.ready.catch((error: Error) => reasons.push((error as RejectedError).reason));
    }
    expect(reasons).toEqual(['Bad User', 'Bad User', 'Bad User']);
  });

  it('ignores everything a socket says before it has answered, and still waits for the answer', async () => {
    const room = new Room(USERS, { authTimeoutMs: 40 });
    const c = bare(room);
    c.socket.send(JSON.stringify({ messageType: 'request', id: 'x', path: 'intent', value: { name: 'end-turn' } }));
    c.socket.send(JSON.stringify({ messageType: 'event', path: 'intent', value: {} }));
    await settle();
    expect(c.closes).toEqual([]); // not hung up on yet...
    expect(c.frames.map((frame) => frame.path)).toEqual(['auth']); // ...and not answered
    await c.answerAuth('token-for-alice');
    await settle();
    expect(room.connected).toEqual(['alice']);
  });

  it('turns away a socket whose answer is not a token the room holds, whatever it is', async () => {
    const room = new Room(USERS);
    for (const answer of [null, 42, { token: 'token-for-alice' }, ['token-for-alice'], '']) {
      const c = bare(room);
      await c.answerAuth(answer);
      await settle();
      expect(c.closes).toEqual([{ code: CLOSE.rejected, reason: 'Bad User' }]);
    }
    expect(room.connected).toEqual([]);
  });

  it('turns away a socket whose first message is not a message at all', async () => {
    const room = new Room(USERS);
    const text = bare(room);
    text.socket.send('token-for-alice'); // the old way: a bare token
    const binary = bare(room);
    (binary.socket as unknown as { send(d: unknown): void }).send(new Uint8Array([1, 2, 3]));
    await settle();
    expect(text.closes).toEqual([{ code: CLOSE.rejected, reason: 'Bad User' }]);
    expect(binary.closes).toEqual([{ code: CLOSE.rejected, reason: 'Bad User' }]);
    expect(room.connected).toEqual([]);
  });

  it('closes a socket that never sends a token', async () => {
    const room = new Room(USERS, { authTimeoutMs: 20 });
    const [clientEnd, serverEnd] = memoryPair();
    room.addWebsocket(serverEnd);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      clientEnd.onClose((code, reason) => resolve({ code, reason })),
    );
    expect(await closed).toEqual({ code: CLOSE.authTimeout, reason: 'authentication timed out' });
  });

  it('never puts a token or a gameInit on the wire', async () => {
    const room = new Room(USERS);
    const a = connect(room, 'token-for-alice');
    const b = connect(room, 'token-for-bob');
    await Promise.all([a.client.ready, b.client.ready]);
    room.broadcast('error', { message: 'hello' });
    await a.client.intent('nothing').catch(() => undefined);
    await settle();
    for (const frames of [a.inbound, b.inbound]) {
      const wire = frames.join('');
      expect(wire).not.toContain('token-for');
      expect(wire).not.toContain('ALICE-FIRE');
      expect(wire).not.toContain('gameInit');
    }
  });

  it('keeps gameInit on the server, for the game to read', () => {
    const room = new Room(USERS);
    expect(room.gameInit('alice')).toEqual({ hand: ['ALICE-FIRE', 'ALICE-ICE'] });
    expect(room.userIds).toEqual(['alice', 'bob']);
    expect(() => room.gameInit('nobody')).toThrow(/no user "nobody"/);
  });

  it('refuses two users with the same token, an empty token, or the same user twice', () => {
    expect(() => new Room({ a: { authToken: 'same', gameInit: 1 }, b: { authToken: 'same', gameInit: 2 } })).toThrow(
      /same auth token/,
    );
    expect(() => new Room({ a: { authToken: '', gameInit: 1 } })).toThrow(/non-empty auth token/);
    const room = new Room(USERS);
    expect(() => room.addUser('alice', { authToken: 'other', gameInit: { hand: [] } })).toThrow(/already in the room/);
  });

  it('lets a user be added after the room is made', async () => {
    const room = new Room<{ hand: string[] }>(USERS);
    room.addUser('cy', { authToken: 'token-for-cy', gameInit: { hand: [] } });
    const c = connect(room, 'token-for-cy');
    expect(await c.client.ready).toEqual({ userId: 'cy' });
  });
});

describe('connections', () => {
  it('replaces an older connection of the same user, closing it', async () => {
    const room = new Room(USERS);
    const first = connect(room, 'token-for-alice');
    await first.client.ready;
    const closed = new Promise<{ code: number }>((resolve) => first.client.on('closed', resolve));
    const second = connect(room, 'token-for-alice');
    await second.client.ready;
    expect((await closed).code).toBe(CLOSE.replaced);
    expect(room.connected).toEqual(['alice']);
  });

  it('announces connects (and reconnects) and disconnects, but not a replacement as a disconnect', async () => {
    const room = new Room(USERS);
    const log: string[] = [];
    room.onConnect((userId, { reconnect }) => log.push(`${userId} in${reconnect ? ' again' : ''}`));
    room.onDisconnect((userId) => log.push(`${userId} out`));
    const a = connect(room, 'token-for-alice');
    await a.client.ready;
    const again = connect(room, 'token-for-alice'); // replaces
    await again.client.ready;
    await settle();
    expect(log).toEqual(['alice in', 'alice in again']);
    again.client.close();
    await settle();
    expect(log).toEqual(['alice in', 'alice in again', 'alice out']);
    expect(room.isConnected('alice')).toBe(false);
  });

  it('says when everyone has arrived', async () => {
    const room = new Room(USERS);
    let everyone = false;
    void room.whenConnected().then(() => (everyone = true));
    const a = connect(room, 'token-for-alice');
    await a.client.ready;
    await settle();
    expect(everyone).toBe(false);
    const b = connect(room, 'token-for-bob');
    await b.client.ready;
    await settle();
    expect(everyone).toBe(true);
  });

  it('ignores what an older, replaced socket says', async () => {
    const room = new Room(USERS);
    room.onIntent('mine', (userId) => userId);
    const first = connect(room, 'token-for-alice');
    await first.client.ready;
    const second = connect(room, 'token-for-alice');
    await second.client.ready;
    await settle();
    // The older socket is closed; anything it still tried to send is dropped.
    await expect(first.client.intent('mine')).rejects.toThrow();
    await expect(second.client.intent('mine')).resolves.toBe('alice');
  });

  it('sending to a user who is not here reports it and queues nothing', async () => {
    const room = new Room(USERS);
    expect(room.send('alice', 'error', { message: 'x' })).toBe(false);
    const a = connect(room, 'token-for-alice');
    await a.client.ready;
    expect(room.send('alice', 'error', { message: 'x' })).toBe(true);
  });
});

describe('talking', () => {
  it('asks a user something and gets the answer', async () => {
    const room = new Room(USERS);
    const c = connect(room, 'token-for-alice');
    c.client.onPrompt((name, payload) => `${name}:${JSON.stringify(payload)}`);
    await c.client.ready;
    await expect(room.prompt('alice', 'greet', { n: 1 })).resolves.toBe('greet:{"n":1}');
  });

  it('keeps a prompt for a user who is not here yet, and sends it when they arrive', async () => {
    const room = new Room(USERS);
    const answer = room.prompt('alice', 'ready?', null);
    const c = connect(room, 'token-for-alice');
    c.client.onPrompt(() => 'yes');
    await expect(answer).resolves.toBe('yes');
  });

  it('sends an unanswered prompt again when the user reconnects, and takes the answer once', async () => {
    const room = new Room(USERS);
    const first = connect(room, 'token-for-alice');
    let seen = 0;
    first.client.onPrompt(() => {
      seen += 1;
      return new Promise(() => undefined); // never answers
    });
    await first.client.ready;
    const answer = room.prompt('alice', 'move', {});
    await settle();
    first.client.close();
    await settle();
    const second = connect(room, 'token-for-alice');
    second.client.onPrompt(() => 'moved');
    await expect(answer).resolves.toBe('moved');
    expect(seen).toBe(1);
  });

  it('fails the prompt when the client says it cannot answer', async () => {
    const room = new Room(USERS);
    const c = connect(room, 'token-for-alice');
    c.client.onPrompt(() => {
      throw new Error('I have no idea');
    });
    await c.client.ready;
    await expect(room.prompt('alice', 'x', null)).rejects.toThrow('I have no idea');
  });

  it('fails the prompt when the client has no way to answer', async () => {
    const room = new Room(USERS);
    const c = connect(room, 'token-for-alice');
    await c.client.ready;
    await expect(room.prompt('alice', 'x', null)).rejects.toThrow(/no way to answer/);
  });

  it('times a prompt out', async () => {
    const room = new Room(USERS);
    const c = connect(room, 'token-for-alice');
    c.client.onPrompt(() => new Promise(() => undefined));
    await c.client.ready;
    await expect(room.prompt('alice', 'x', null, { timeoutMs: 20 })).rejects.toBeInstanceOf(PromptTimeoutError);
  });

  it('refuses a reply to somebody else\'s prompt', async () => {
    const room = new Room(USERS);
    const a = connect(room, 'token-for-alice');
    const b = connect(room, 'token-for-bob');
    a.client.onPrompt(() => new Promise(() => undefined));
    await Promise.all([a.client.ready, b.client.ready]);
    const answered: unknown[] = [];
    void room.prompt('alice', 'secret', null).then((value) => answered.push(value));
    await settle();
    const errors: string[] = [];
    b.client.on('error', (message) => errors.push(message));
    // Bob guesses Alice's prompt id and answers it.
    const ask = a.inbound.map((frame) => JSON.parse(frame as string)).find((m) => m.path === 'prompt');
    b.clientSocket.send(JSON.stringify({ id: ask.id, messageType: 'response', valueType: 'result', value: 'forged' }));
    await settle();
    expect(answered).toEqual([]);
    expect(errors).toEqual([]); // Bob's bridge never asked anything, so the reply goes nowhere
    expect(room.isConnected('bob')).toBe(true);
  });

  it('fails what is still waiting, and closes everyone, when the room closes', async () => {
    const room = new Room(USERS);
    const c = connect(room, 'token-for-alice');
    c.client.onPrompt(() => new Promise(() => undefined));
    await c.client.ready;
    const closed = new Promise<{ code: number }>((resolve) => c.client.on('closed', resolve));
    const waiting = room.prompt('alice', 'x', null);
    await settle();
    room.close();
    await expect(waiting).rejects.toBeInstanceOf(RoomClosedError);
    expect((await closed).code).toBe(CLOSE.roomClosed);
    expect(() => room.addWebsocket(memoryPair()[1])).toThrow(RoomClosedError);
  });

  it('runs a client\'s intent with who it came from, and answers it', async () => {
    const room = new Room(USERS);
    room.onIntent('echo', (userId, payload) => ({ from: userId, payload }));
    room.onIntent('boom', () => {
      throw new Error('not allowed');
    });
    const c = connect(room, 'token-for-bob');
    await c.client.ready;
    await expect(c.client.intent('echo', { n: 2 })).resolves.toEqual({ from: 'bob', payload: { n: 2 } });
    await expect(c.client.intent('boom')).rejects.toThrow('not allowed');
    await expect(c.client.intent('nothing')).rejects.toThrow(/no "nothing" to do/);
  });

  it('allows only one handler for an intent name', () => {
    const room = new Room(USERS);
    room.onIntent('go', () => 1);
    expect(() => room.onIntent('go', () => 2)).toThrow(/already has a handler/);
  });

  it('answers a message it cannot read without hanging up', async () => {
    const room = new Room(USERS);
    const c = connect(room, 'token-for-alice');
    await c.client.ready;
    const errors: string[] = [];
    c.client.on('error', (message) => errors.push(message));
    c.clientSocket.send('this is not json');
    c.clientSocket.send(JSON.stringify({ type: 'nonsense' }));
    c.clientSocket.send(JSON.stringify({ messageType: 'event', path: 'nobody-listens', value: 1 }));
    (c.clientSocket as unknown as { send(d: unknown): void }).send(new Uint8Array([1]));
    await settle();
    expect(errors.slice(0, 2)).toEqual(['that message is not valid JSON', 'that is not a message']);
    expect(errors).toContain('binary messages are not accepted');
    expect(room.isConnected('alice')).toBe(true);
  });

  it('hangs up on a message that is far too large', async () => {
    const room = new Room(USERS, { maxMessageLength: 300 });
    const c = connect(room, 'token-for-alice');
    await c.client.ready;
    const closed = new Promise<{ code: number }>((resolve) => c.client.on('closed', resolve));
    c.clientSocket.send(JSON.stringify({ messageType: 'event', path: 'x', value: 'y'.repeat(2000) }));
    expect((await closed).code).toBe(CLOSE.protocol);
  });
});

describe('the standard WebSocket', () => {
  /** A stand-in for the browser's WebSocket: addEventListener, readyState, send. */
  class FakeWebSocket implements WebSocketLike {
    static last: FakeWebSocket | undefined;
    readyState = 0;
    readonly sent: string[] = [];
    readonly #listeners = new Map<string, ((event: never) => void)[]>();
    constructor(readonly url: string) {
      FakeWebSocket.last = this;
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {}
    addEventListener(type: string, listener: (event: never) => void): void {
      this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    }
    fire(type: string, event: unknown = {}): void {
      for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
    }
  }

  const answerOf = (ws: FakeWebSocket, path: string) => {
    const ask = ws.sent.map((frame) => JSON.parse(frame)).find((m) => m.path === path);
    return ask;
  };

  it('answers the room\'s auth request once it is open', async () => {
    const client = createClient({ url: 'wss://example.test/room', authToken: 'tok', WebSocket: FakeWebSocket });
    const ws = FakeWebSocket.last!;
    expect(ws.url).toBe('wss://example.test/room');
    expect(ws.sent).toEqual([]); // the client speaks only when spoken to
    ws.readyState = 1;
    ws.fire('open');
    ws.fire('message', { data: JSON.stringify({ messageType: 'request', id: 'q1', path: 'auth', value: {} }) });
    await settle();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ id: 'q1', messageType: 'response', valueType: 'result', value: 'tok' });
    ws.fire('message', { data: JSON.stringify({ messageType: 'event', path: 'welcome', value: { userId: 'u' } }) });
    await expect(client.ready).resolves.toEqual({ userId: 'u' });
  });

  it('adapts one for the server side too', async () => {
    const ws = new FakeWebSocket('server-side');
    ws.readyState = 1;
    const room = new Room(USERS);
    room.addWebsocket(ws);
    const ask = answerOf(ws, 'auth');
    expect(ask).toMatchObject({ messageType: 'request', path: 'auth' });
    ws.fire('message', {
      data: JSON.stringify({ id: ask.id, messageType: 'response', valueType: 'result', value: 'token-for-alice' }),
    });
    await settle();
    expect(room.connected).toEqual(['alice']);
    expect(JSON.parse(ws.sent[1]!)).toEqual({ messageType: 'event', path: 'welcome', value: { userId: 'alice' } });
    expect(fromWebSocket(ws).isOpen).toBe(true);
  });

  it('needs a url or a socket, and a WebSocket to use', () => {
    expect(() => createClient({ authToken: 't' })).toThrow(/url to connect to, or a socket/);
  });
});

/* ------------------------- a game over the transport ------------------------ */

class Card implements Entity {
  readonly type = 'card' as const;
  constructor(readonly name: string) {}
}

class Idle extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

const SHOWDOWN = `Ability Showdown
All players commit a card from their hand face down.
When they are ready, reveal.
All players move the card they committed to their garbage.`;

/** A room, an engine, a remote player per user, and the link between them. */
async function onlineGame() {
  const room = new Room(USERS);
  const events: GameEvent[] = [];
  const engine = createEngine({ seed: 's', onEvent: (event: GameEvent) => events.push(event) });
  for (const zone of [PLAY, GARBAGE]) engine.zones.declare(zone);
  engine.zones.declare({ id: 'hand', visibility: 'owner', scope: 'per-player' });
  const projector = new ViewProjector(engine);
  const players: Record<string, RemotePlayer> = {};
  for (const [userId, user] of Object.entries(USERS)) {
    const hero = new Character(`${userId} hero`, { gauges: [{ id: 'hp', max: 10 }] });
    players[userId] = new RemotePlayer(userId, [hero], room, userId, projector);
    engine.registerPlayer(players[userId]!);
    for (const name of user.gameInit.hand) await engine.addEntity(new Card(name), 'hand', { owner: players[userId]! });
  }
  const link = attachGame(room, engine, projector, players);
  const compiled = compileDocument(SHOWDOWN, { zones: new ZoneDictionary(['hand']) });
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return { room, engine, projector, players, link, ability: compiled.abilities[0]!, events };
}

/** A client that answers a "choose a card" prompt by picking the named card. */
function picker(client: Client, name: string) {
  client.onPrompt((promptName, payload) => {
    if (promptName !== 'choose') throw new Error(`unexpected prompt ${promptName}`);
    const request = payload as WireRequest;
    if (request.kind !== 'select') throw new Error('expected a card to pick');
    const index = request.options.findIndex((option) => option.hidden !== true && option.name === name);
    return { kind: 'select', chosen: [index] };
  });
}

describe('a game over the transport', () => {
  it('sends each user a view in which only their own hand is visible', async () => {
    const g = await onlineGame();
    const a = connect(g.room, 'token-for-alice');
    const b = connect(g.room, 'token-for-bob');
    await Promise.all([a.client.ready, b.client.ready]);
    await settle();
    const handOf = (client: Client, who: string) => client.view!.zones.find((z) => z.key === `hand:${who}`)!;
    expect(handOf(a.client, 'alice').members.map((m) => (m.hidden ? '·' : m.name))).toEqual(['ALICE-FIRE', 'ALICE-ICE']);
    expect(handOf(a.client, 'bob').members).toEqual([]);
    expect(handOf(a.client, 'bob').hiddenCount).toBe(2);
    expect(handOf(b.client, 'bob').members.map((m) => (m.hidden ? '·' : m.name))).toEqual(['BOB-WIND', 'BOB-STONE']);
    expect(a.inbound.join('')).not.toContain('BOB-');
    expect(b.inbound.join('')).not.toContain('ALICE-');
  });

  it('plays a commit / reveal round: choices travel as prompts and nothing hidden leaks to the other client', async () => {
    const g = await onlineGame();
    const a = connect(g.room, 'token-for-alice');
    const b = connect(g.room, 'token-for-bob');
    picker(a.client, 'ALICE-FIRE');
    picker(b.client, 'BOB-WIND');
    await Promise.all([a.client.ready, b.client.ready]);
    await settle();
    const bobHeard: ViewEventLike[] = [];
    b.client.on('event', (event) => bobHeard.push(event as ViewEventLike));

    await g.ability.cast({ self: g.players.alice!.characters[0]!, engine: g.engine }, { targets: [] });
    await settle();

    // Both chosen cards ended up in their owners' garbage...
    const garbage = (who: string) => g.engine.zones.members('garbage', g.players[who]!).map((m) => m.name);
    expect(garbage('alice')).toEqual(['ALICE-FIRE']);
    expect(garbage('bob')).toEqual(['BOB-WIND']);
    // ...and what Bob's client heard never named Alice's other card, and named her played card only from the reveal on.
    const wire = b.inbound.join('');
    expect(wire).not.toContain('ALICE-ICE');
    const revealedAt = bobHeard.findIndex((e) => e.type === 'choice:revealed');
    expect(revealedAt).toBeGreaterThan(-1);
    expect(JSON.stringify(bobHeard.slice(0, revealedAt))).not.toContain('ALICE-FIRE');
    expect(JSON.stringify(bobHeard[revealedAt])).toContain('ALICE-FIRE');
    // Neither client ever saw a token.
    expect(a.inbound.join('') + b.inbound.join('')).not.toContain('token-for');
  });

  it('carries a prompt through a dropped connection: the player comes back and the game goes on', async () => {
    const g = await onlineGame();
    const a = connect(g.room, 'token-for-alice');
    picker(a.client, 'ALICE-FIRE');
    const b1 = connect(g.room, 'token-for-bob');
    b1.client.onPrompt(() => new Promise(() => undefined)); // Bob's first connection never answers
    await Promise.all([a.client.ready, b1.client.ready]);
    await settle();

    const running = g.ability.cast({ self: g.players.alice!.characters[0]!, engine: g.engine }, { targets: [] });
    await settle();
    b1.client.close(); // Bob drops with the question outstanding
    await settle();
    const b2 = connect(g.room, 'token-for-bob'); // and comes back
    picker(b2.client, 'BOB-STONE');
    await running;

    expect(g.engine.zones.members('garbage', g.players.bob!).map((m) => m.name)).toEqual(['BOB-STONE']);
  });

  it('gives a client that answers nonsense the default answer after a few tries, rather than stalling', async () => {
    const g = await onlineGame();
    const a = connect(g.room, 'token-for-alice');
    const b = connect(g.room, 'token-for-bob');
    picker(a.client, 'ALICE-FIRE');
    let asked = 0;
    b.client.onPrompt(() => {
      asked += 1;
      return { kind: 'banana' };
    });
    await Promise.all([a.client.ready, b.client.ready]);
    await settle();
    await g.ability.cast({ self: g.players.alice!.characters[0]!, engine: g.engine }, { targets: [] });
    expect(asked).toBe(3);
    // The default pick (the first card) was played for him.
    expect(g.engine.zones.members('garbage', g.players.bob!).map((m) => m.name)).toEqual(['BOB-WIND']);
  });

  it('sends a view again to a user who reconnects, and syncViews to everyone', async () => {
    const g = await onlineGame();
    const a = connect(g.room, 'token-for-alice');
    await a.client.ready;
    await settle();
    let views = 0;
    a.client.on('view', () => (views += 1));
    const again = connect(g.room, 'token-for-alice');
    let reconnectViews = 0;
    again.client.on('view', () => (reconnectViews += 1));
    await again.client.ready;
    await settle();
    expect(reconnectViews).toBe(1);
    g.link.syncViews();
    await settle();
    expect(reconnectViews).toBe(2);
    expect(views).toBe(0); // the replaced connection was closed and hears nothing more
  });

  it('stops talking to the engine once detached', async () => {
    const g = await onlineGame();
    const a = connect(g.room, 'token-for-alice');
    await a.client.ready;
    await settle();
    const heard: unknown[] = [];
    a.client.on('event', (event) => heard.push(event));
    g.link.detach();
    await g.engine.roll(1, 6);
    await settle();
    expect(heard).toEqual([]);
  });
});

interface ViewEventLike {
  type: string;
  [key: string]: unknown;
}

describe('a choice on the wire', () => {
  const alice = new Idle('Alice', [new Character('A', { gauges: [{ id: 'hp', max: 5 }] })]);
  const cards = [new Card('Fire'), new Card('Ice')];
  const engine = createEngine({ seed: 's' });
  const projector = new ViewProjector(engine);
  const select: ChoiceRequest = { kind: 'select', prompt: 'Pick', chooser: alice, options: cards, count: 1 };

  it('describes the options the player may see and numbers every one', async () => {
    engine.zones.declare(PLAY);
    engine.registerPlayer(alice);
    await engine.addEntity(cards[0]!, 'play');
    // 'Fire' is on the table (visible); 'Ice' is in no zone the engine knows, so it is a placeholder.
    const wire = toWireRequest(projector, alice, select);
    expect(wire.kind).toBe('select');
    if (wire.kind === 'select') {
      expect(wire.options[0]).toMatchObject({ name: 'Fire' });
      expect(wire.options[1]).toEqual({ hidden: true });
    }
  });

  it('reads a position as the option at that position', () => {
    expect(fromWireAnswer(select, { kind: 'select', chosen: [1] })).toEqual({ kind: 'select', chosen: [cards[1]] });
    expect(fromWireAnswer(select, { kind: 'select', chosen: [] })).toEqual({ kind: 'select', chosen: [] });
  });

  it('rejects a position that is not an option, or the wrong kind of answer', () => {
    expect(fromWireAnswer(select, { kind: 'select', chosen: [2] })).toBeUndefined();
    expect(fromWireAnswer(select, { kind: 'select', chosen: [-1] })).toBeUndefined();
    expect(fromWireAnswer(select, { kind: 'select', chosen: [0.5] })).toBeUndefined();
    expect(fromWireAnswer(select, { kind: 'select', chosen: 'one' })).toBeUndefined();
    expect(fromWireAnswer(select, { kind: 'number', value: 1 })).toBeUndefined();
    expect(fromWireAnswer(select, null)).toBeUndefined();
    expect(fromWireAnswer(select, 'Fire')).toBeUndefined();
  });

  it('reads the other kinds of answer', () => {
    const number: ChoiceRequest = { kind: 'number', prompt: 'n', chooser: alice, min: 1, max: 6 };
    const confirm: ChoiceRequest = { kind: 'confirm', prompt: 'ok?', chooser: alice };
    const label: ChoiceRequest = { kind: 'label', prompt: 'vote', chooser: alice, options: ['Attack', 'Retreat'] };
    expect(fromWireAnswer(number, { kind: 'number', value: 4 })).toEqual({ kind: 'number', value: 4 });
    expect(fromWireAnswer(number, { kind: 'number', value: 'four' })).toBeUndefined();
    expect(fromWireAnswer(number, { kind: 'number', value: Number.NaN })).toBeUndefined();
    expect(fromWireAnswer(confirm, { kind: 'confirm', yes: false })).toEqual({ kind: 'confirm', yes: false });
    expect(fromWireAnswer(confirm, { kind: 'confirm', yes: 'yes' })).toBeUndefined();
    expect(fromWireAnswer(label, { kind: 'label', value: 'Attack' })).toEqual({ kind: 'label', value: 'Attack' });
    // A value out of range is still an answer: the engine decides what it costs.
    expect(fromWireAnswer(number, { kind: 'number', value: 99 })).toEqual({ kind: 'number', value: 99 });
  });

  it('accepts a value written down for a card or a name', () => {
    const label: ChoiceRequest = { kind: 'label', prompt: 'vote', chooser: alice, options: ['Attack', 'Retreat'] };
    expect(fromWireAnswer(select, { kind: 'written', text: 'Fire' })).toEqual({ kind: 'written', text: 'Fire' });
    expect(fromWireAnswer(label, { kind: 'written', text: 'Attack' })).toEqual({ kind: 'written', text: 'Attack' });
    const confirm: ChoiceRequest = { kind: 'confirm', prompt: 'ok?', chooser: alice };
    expect(fromWireAnswer(confirm, { kind: 'written', text: 'yes' })).toBeUndefined();
  });

  it('sends a vote with the votes cast so far, as player ids', () => {
    const bob = new Idle('Bob', []);
    const label: ChoiceRequest = {
      kind: 'label',
      prompt: 'vote',
      chooser: alice,
      options: ['Attack', 'Retreat'],
      prior: [{ player: bob, option: 'Attack' }],
    };
    expect(toWireRequest(projector, alice, label)).toEqual({
      kind: 'label',
      prompt: 'vote',
      options: ['Attack', 'Retreat'],
      prior: [{ player: 'bob', option: 'Attack' }],
    });
  });
});

describe('engine.observe', () => {
  it('hears every event beside the onEvent option, and stops when told to', async () => {
    const seen: string[] = [];
    const viaOption: string[] = [];
    const engine = createEngine({ seed: 's', onEvent: (e: GameEvent) => viaOption.push(e.type) });
    const stop = engine.observe((e) => seen.push(e.type));
    const second: string[] = [];
    engine.observe((e) => second.push(e.type));
    await engine.roll(1, 6);
    expect(seen).toContain('roll:made');
    expect(seen).toEqual(viaOption);
    expect(second).toEqual(seen);
    stop();
    const before = seen.length;
    await engine.roll(1, 6);
    expect(seen.length).toBe(before);
    expect(second.length).toBeGreaterThan(before);
  });
});
