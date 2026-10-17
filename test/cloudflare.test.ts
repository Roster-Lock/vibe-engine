/**
 * `CloudflareRoom` (src/multiplayer/cloudflare.ts): a room that can live in a Durable
 * Object without being one. The fakes below stand in for the platform: storage with an
 * alarm, a socket list with attachments, and a host that can throw the room away and
 * rebuild it from storage (an eviction) between any two events.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSE,
  CloudflareRoom,
  PromptTimeoutError,
  RejectedError,
  createClient,
  memoryPair,
  type CloudflareContext,
  type CloudflareSocket,
  type Client,
  type Reply,
} from '../src/multiplayer/index.js';

const tick = (ms = 2) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await tick();
};

const USERS = {
  alice: { authToken: 'token-for-alice', gameInit: { hand: ['ALICE-FIRE'] } },
  bob: { authToken: 'token-for-bob', gameInit: { hand: ['BOB-WIND'] } },
};

/** The platform: storage + alarm + the live sockets. Survives an eviction; the room does not. */
class FakePlatform implements CloudflareContext {
  readonly data = new Map<string, unknown>();
  alarmAt: number | undefined;
  now = 1_000_000;
  readonly sockets: FakeSocket[] = [];
  readonly storage = {
    get: async <T>(key: string) => structuredClone(this.data.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => void this.data.set(key, structuredClone(value)),
    delete: async (key: string) => this.data.delete(key),
    setAlarm: async (at: number) => void (this.alarmAt = at),
    deleteAlarm: async () => void (this.alarmAt = undefined),
  };
  getWebSockets() {
    return this.sockets.filter((socket) => !socket.closed);
  }
  acceptWebSocket(ws: CloudflareSocket) {
    this.sockets.push(ws as FakeSocket);
  }
}

class FakeSocket implements CloudflareSocket {
  attachment: unknown = null;
  closed: { code?: number; reason?: string } | undefined;
  constructor(readonly deliver: (data: string) => void, readonly end: (code?: number, reason?: string) => void) {}
  send(data: string) {
    this.deliver(data);
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.end(code, reason);
  }
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
}

/** A Durable Object stand-in: forwards platform events to whichever room instance is current. */
class Host {
  readonly platform = new FakePlatform();
  room!: CloudflareRoom;
  /** Run on each wake, like a constructor would. */
  setup: (room: CloudflareRoom) => void = () => undefined;
  constructor(setup?: (room: CloudflareRoom) => void) {
    if (setup) this.setup = setup;
  }

  /** Builds a fresh room from storage — a first start, or an eviction and rebuild. */
  async wake(): Promise<CloudflareRoom> {
    this.room = new CloudflareRoom(this.platform, { now: () => this.platform.now, authTimeoutMs: 1000 });
    await this.room.load();
    this.setup(this.room);
    return this.room;
  }
  evict(): Promise<CloudflareRoom> {
    return this.wake();
  }

  /** A client arrives: a real `createClient` on one end, the platform's socket on the other. */
  connect(authToken: string): { client: Client; socket: FakeSocket; frames: string[] } {
    const [clientEnd, serverEnd] = memoryPair();
    const frames: string[] = [];
    const socket: FakeSocket = new FakeSocket(
      (data) => serverEnd.send(data),
      (code, reason) => serverEnd.close(code, reason),
    );
    serverEnd.onMessage((data) => void this.room.webSocketMessage(socket, data as string));
    // The platform reports a close that the *client* started; one the room started it already knows of.
    serverEnd.onClose((code, reason) => {
      if (!socket.closed) socket.closed = { code, reason };
      void this.room.webSocketClose(socket, code, reason);
    });
    const spy = {
      ...clientEnd,
      onMessage: (handler: (d: any) => void) =>
        clientEnd.onMessage((data) => {
          frames.push(data as string);
          handler(data);
        }),
      onClose: (h: any) => clientEnd.onClose(h),
      onOpen: (h: any) => clientEnd.onOpen?.(h),
      send: (d: string) => clientEnd.send(d),
      close: (c?: number, r?: string) => clientEnd.close(c, r),
      get isOpen() {
        return clientEnd.isOpen;
      },
    };
    const client = createClient({ authToken, socket: spy as never });
    this.room.accept(socket);
    return { client, socket, frames };
  }

  /** Time passes; the platform fires the alarm if it is due. */
  async advance(ms: number): Promise<void> {
    this.platform.now += ms;
    const at = this.platform.alarmAt;
    if (at !== undefined && at <= this.platform.now) {
      this.platform.alarmAt = undefined;
      await this.room.alarm();
    }
  }
}

async function started(setup?: (room: CloudflareRoom) => void) {
  const host = new Host(setup);
  const room = await host.wake();
  for (const [id, user] of Object.entries(USERS)) await room.addUser(id, user);
  return host;
}

describe('a new websocket', () => {
  it('asks who it is, and lets in the user whose token it answers with', async () => {
    const host = await started();
    const a = host.connect('token-for-alice');
    expect(await a.client.ready).toEqual({ userId: 'alice' });
    expect(host.room.connected).toEqual(['alice']);
    expect(host.room.isConnected('alice')).toBe(true);
  });

  it('turns away a token nobody holds, with the same reason whatever was wrong', async () => {
    const host = await started();
    const closes: (number | undefined)[] = [];
    for (const token of ['guess', 'token-for-alicf', '']) {
      const c = host.connect(token);
      await expect(c.client.ready).rejects.toBeInstanceOf(RejectedError);
      await expect(c.client.ready).rejects.toThrow(/Bad User/);
      closes.push(c.socket.closed?.code);
    }
    expect(closes).toEqual([CLOSE.rejected, CLOSE.rejected, CLOSE.rejected]);
    expect(host.room.connected).toEqual([]);
  });

  it('sends a socket that has not authenticated only the question', async () => {
    const host = await started();
    const c = host.connect('wrong');
    await c.client.ready.catch(() => undefined);
    await settle();
    expect(c.frames.map((f) => JSON.parse(f).path)).toEqual(['auth']);
    expect(c.frames.join('')).not.toContain('ALICE-FIRE');
  });

  it('ignores what an unauthenticated socket says, and closes it if it never answers', async () => {
    const host = await started();
    const [, serverEnd] = memoryPair();
    const socket = new FakeSocket(() => undefined, () => undefined);
    host.room.accept(socket);
    await host.room.webSocketMessage(socket, JSON.stringify({ messageType: 'request', id: 'x', path: 'intent', value: { name: 'go' } }));
    await host.room.webSocketMessage(socket, JSON.stringify({ messageType: 'response', id: 'not-the-auth-id', valueType: 'result', value: 'token-for-alice' }));
    expect(host.room.connected).toEqual([]);
    expect(socket.closed).toBeUndefined();
    void serverEnd;
    await host.advance(999);
    expect(socket.closed).toBeUndefined();
    await host.advance(2);
    expect(socket.closed).toEqual({ code: CLOSE.authTimeout, reason: 'authentication timed out' });
  });

  it('recognises the answer to its question after being evicted in between', async () => {
    const host = await started();
    const [, serverEnd] = memoryPair();
    void serverEnd;
    const sent: string[] = [];
    const socket = new FakeSocket((d) => sent.push(d), () => undefined);
    host.room.accept(socket);
    const ask = JSON.parse(sent[0]!);
    await host.evict(); // the object is rebuilt; the question lived in the socket's attachment
    await host.room.webSocketMessage(socket, JSON.stringify({ id: ask.id, messageType: 'response', valueType: 'result', value: 'token-for-bob' }));
    expect(host.room.connected).toEqual(['bob']);
  });

  it('cancels the auth deadline once the user is in', async () => {
    const host = await started();
    const a = host.connect('token-for-alice');
    await a.client.ready;
    await settle();
    expect(host.platform.alarmAt).toBeUndefined();
    await host.advance(10_000);
    expect(a.socket.closed).toBeUndefined();
  });

  it('replaces an older socket of the same user, closing it, and does not call that a disconnect', async () => {
    const log: string[] = [];
    const host = await started((room) => {
      room.onConnect((userId, { reconnect }) => log.push(`${userId} in${reconnect ? ' again' : ''}`));
      room.onDisconnect((userId) => log.push(`${userId} out`));
    });
    const first = host.connect('token-for-alice');
    await first.client.ready;
    const second = host.connect('token-for-alice');
    await second.client.ready;
    await settle();
    expect(first.socket.closed?.code).toBe(CLOSE.replaced);
    expect(host.room.connected).toEqual(['alice']);
    expect(log).toEqual(['alice in', 'alice in again']);
  });
});

describe('a message', () => {
  it('runs a client\'s intent with who it came from', async () => {
    const host = await started((room) => {
      room.onIntent('echo', (userId, payload) => ({ from: userId, payload }));
      room.onIntent('boom', () => {
        throw new Error('not allowed');
      });
    });
    const b = host.connect('token-for-bob');
    await b.client.ready;
    await expect(b.client.intent('echo', { n: 1 })).resolves.toEqual({ from: 'bob', payload: { n: 1 } });
    await expect(b.client.intent('boom')).rejects.toThrow('not allowed');
    await expect(b.client.intent('nothing')).rejects.toThrow(/no "nothing" to do/);
  });

  it('keeps working across an eviction: the next message is handled by the rebuilt room', async () => {
    const host = await started((room) => room.onIntent('who', (userId) => userId));
    const a = host.connect('token-for-alice');
    await a.client.ready;
    await host.evict(); // the socket and its attachment are the platform's; the user is still alice
    await expect(a.client.intent('who')).resolves.toBe('alice');
    expect(host.room.connected).toEqual(['alice']);
  });

  it('sends events to one user, or to everyone, and says if the user is away', async () => {
    const host = await started();
    const a = host.connect('token-for-alice');
    const b = host.connect('token-for-bob');
    await Promise.all([a.client.ready, b.client.ready]);
    const seen: string[] = [];
    a.client.on('error', (m) => seen.push(`a:${m}`));
    b.client.on('error', (m) => seen.push(`b:${m}`));
    expect(host.room.send('alice', 'error', { message: 'one' })).toBe(true);
    host.room.broadcast('error', { message: 'all' });
    await settle();
    expect(seen.sort()).toEqual(['a:all', 'a:one', 'b:all']);
    a.client.close();
    await settle();
    expect(host.room.send('alice', 'error', { message: 'x' })).toBe(false);
  });

  it('never puts a token or gameInit on the wire', async () => {
    const host = await started();
    const a = host.connect('token-for-alice');
    await a.client.ready;
    host.room.send('alice', 'error', { message: 'hi' });
    await settle();
    const wire = a.frames.join('');
    expect(wire).not.toContain('token-for');
    expect(wire).not.toContain('ALICE-FIRE');
  });

  it('refuses a reply to somebody else\'s prompt', async () => {
    const host = await started();
    const a = host.connect('token-for-alice');
    const b = host.connect('token-for-bob');
    a.client.onPrompt(() => new Promise(() => undefined));
    await Promise.all([a.client.ready, b.client.ready]);
    const replies: Reply[] = [];
    host.room.onReply((reply) => replies.push(reply));
    const id = await host.room.ask('alice', 'secret', null);
    await settle();
    const bobFrame = JSON.stringify({ id, messageType: 'response', valueType: 'result', value: 'forged' });
    await host.room.webSocketMessage(b.socket, bobFrame);
    expect(replies).toEqual([]);
  });
});

describe('a disconnect', () => {
  it('tells listeners when the last socket of a user goes', async () => {
    const out: string[] = [];
    const host = await started((room) => room.onDisconnect((userId) => out.push(userId)));
    const a = host.connect('token-for-alice');
    await a.client.ready;
    a.client.close();
    await settle();
    expect(out).toEqual(['alice']);
    expect(host.room.isConnected('alice')).toBe(false);
  });

  it('treats an error like a close', async () => {
    const out: string[] = [];
    const host = await started((room) => room.onDisconnect((userId) => out.push(userId)));
    const a = host.connect('token-for-alice');
    await a.client.ready;
    a.socket.closed = { code: 1006 };
    await host.room.webSocketError(a.socket, new Error('boom'));
    expect(out).toEqual(['alice']);
  });

  it('says a user is away after an eviction too, from the platform\'s socket list', async () => {
    const host = await started();
    const a = host.connect('token-for-alice');
    await a.client.ready;
    await host.evict();
    expect(host.room.connected).toEqual(['alice']);
    a.client.close();
    await settle();
    expect(host.room.connected).toEqual([]);
  });
});

describe('prompts', () => {
  it('asks a user, and the answer arrives at onReply', async () => {
    const replies: Reply[] = [];
    const host = await started((room) => room.onReply((reply) => replies.push(reply)));
    const a = host.connect('token-for-alice');
    a.client.onPrompt((name, payload) => `${name}:${JSON.stringify(payload)}`);
    await a.client.ready;
    const id = await host.room.ask('alice', 'greet', { n: 1 });
    await settle();
    expect(replies).toEqual([{ ok: true, id, userId: 'alice', name: 'greet', value: 'greet:{"n":1}' }]);
  });

  it('resolves prompt() while the object stays awake', async () => {
    const host = await started();
    const a = host.connect('token-for-alice');
    a.client.onPrompt(() => 'yes');
    await a.client.ready;
    await expect(host.room.prompt('alice', 'ok?', null)).resolves.toBe('yes');
  });

  it('keeps a prompt for a user who is away and asks it when they arrive', async () => {
    const replies: Reply[] = [];
    const host = await started((room) => room.onReply((reply) => replies.push(reply)));
    await host.room.ask('alice', 'ready?', null);
    const a = host.connect('token-for-alice');
    a.client.onPrompt(() => 'yes');
    await a.client.ready;
    await settle();
    expect(replies.map((r) => (r.ok ? r.value : 'err'))).toEqual(['yes']);
  });

  it('survives an eviction: the stored prompt is answered at the new onReply', async () => {
    const replies: Reply[] = [];
    const host = await started((room) => room.onReply((reply) => replies.push(reply)));
    const a = host.connect('token-for-alice');
    a.client.onPrompt(async () => {
      await tick(30);
      return 'late';
    });
    await a.client.ready;
    const id = await host.room.ask('alice', 'move', null);
    await tick(5);
    await host.evict(); // the object that asked is gone; the question is in storage
    await tick(60);
    expect(replies).toEqual([{ ok: true, id, userId: 'alice', name: 'move', value: 'late' }]);
  });

  it('asks again when the user comes back on a new socket, and takes the answer once', async () => {
    const replies: Reply[] = [];
    const host = await started((room) => room.onReply((reply) => replies.push(reply)));
    const first = host.connect('token-for-alice');
    first.client.onPrompt(() => new Promise(() => undefined));
    await first.client.ready;
    await host.room.ask('alice', 'move', null);
    await settle();
    first.client.close();
    await settle();
    const second = host.connect('token-for-alice');
    second.client.onPrompt(() => 'moved');
    await second.client.ready;
    await settle();
    expect(replies.map((r) => (r.ok ? r.value : 'err'))).toEqual(['moved']);
  });

  it('reports a client that cannot answer', async () => {
    const replies: Reply[] = [];
    const host = await started((room) => room.onReply((reply) => replies.push(reply)));
    const a = host.connect('token-for-alice');
    a.client.onPrompt(() => {
      throw new Error('no idea');
    });
    await a.client.ready;
    await host.room.ask('alice', 'x', null);
    await settle();
    expect(replies[0]).toMatchObject({ ok: false });
    expect((replies[0] as { error: Error }).error.message).toBe('no idea');
  });

  it('times a prompt out using the alarm', async () => {
    const replies: Reply[] = [];
    const host = await started((room) => room.onReply((reply) => replies.push(reply)));
    const a = host.connect('token-for-alice');
    a.client.onPrompt(() => new Promise(() => undefined));
    await a.client.ready;
    const waiting = host.room.prompt('alice', 'x', null, { timeoutMs: 500 });
    waiting.catch(() => undefined);
    await settle();
    await host.advance(499);
    expect(replies).toEqual([]);
    await host.advance(2);
    await expect(waiting).rejects.toBeInstanceOf(PromptTimeoutError);
    expect(replies[0]).toMatchObject({ ok: false });
  });
});

describe('timers', () => {
  it('runs a timer when the alarm goes, with its data', async () => {
    const fired: unknown[] = [];
    const host = await started((room) => room.onTimer('clock', (data) => void fired.push(data)));
    await host.room.setTimer('clock', 1000, { turn: 3 });
    expect(host.platform.alarmAt).toBe(host.platform.now + 1000);
    await host.advance(999);
    expect(fired).toEqual([]);
    await host.advance(1);
    expect(fired).toEqual([{ turn: 3 }]);
    expect(host.platform.alarmAt).toBeUndefined();
    expect(host.room.timers).toEqual([]);
  });

  it('sets the alarm for the soonest, and the next one after each fires', async () => {
    const fired: string[] = [];
    const host = await started((room) => {
      room.onTimer('a', () => void fired.push('a'));
      room.onTimer('b', () => void fired.push('b'));
    });
    await host.room.setTimer('b', 2000);
    await host.room.setTimer('a', 500);
    expect(host.platform.alarmAt).toBe(host.platform.now + 500);
    await host.advance(500);
    expect(fired).toEqual(['a']);
    expect(host.platform.alarmAt).toBe(host.platform.now + 1500);
    await host.advance(1500);
    expect(fired).toEqual(['a', 'b']);
  });

  it('runs every timer that is due when the alarm finally goes, soonest first', async () => {
    const fired: string[] = [];
    const host = await started((room) => {
      room.onTimer('a', () => void fired.push('a'));
      room.onTimer('b', () => void fired.push('b'));
    });
    await host.room.setTimer('b', 200);
    await host.room.setTimer('a', 100);
    await host.advance(5000);
    expect(fired).toEqual(['a', 'b']);
  });

  it('can be cleared, and clearing the last one removes the alarm', async () => {
    const fired: string[] = [];
    const host = await started((room) => room.onTimer('x', () => void fired.push('x')));
    const id = await host.room.setTimer('x', 100);
    expect(await host.room.clearTimer(id)).toBe(true);
    expect(await host.room.clearTimer(id)).toBe(false);
    expect(host.platform.alarmAt).toBeUndefined();
    await host.advance(1000);
    expect(fired).toEqual([]);
  });

  it('survives an eviction: the timer fires in the rebuilt room', async () => {
    const fired: unknown[] = [];
    const host = await started((room) => room.onTimer('clock', (data) => void fired.push(data)));
    await host.room.setTimer('clock', 1000, 'tick');
    await host.evict();
    expect(host.room.timers).toHaveLength(1);
    await host.advance(1000);
    expect(fired).toEqual(['tick']);
  });

  it('does not run a timer that throws again', async () => {
    let runs = 0;
    const host = await started((room) =>
      room.onTimer('bad', () => {
        runs += 1;
        throw new Error('oops');
      }),
    );
    await host.room.setTimer('bad', 10);
    await expect(host.advance(10)).rejects.toThrow('oops');
    expect(host.room.timers).toEqual([]);
    await host.advance(1000);
    expect(runs).toBe(1);
  });

  it('keeps the names that belong to the room for itself', async () => {
    const host = await started();
    await expect(host.room.setTimer('\u0000auth', 1)).rejects.toThrow(/reserved/);
    expect(() => {
      host.room.onTimer('x', () => undefined);
      host.room.onTimer('x', () => undefined);
    }).toThrow(/already has a timer handler/);
  });
});

describe('saved state', () => {
  it('keeps users and game state across an eviction', async () => {
    const host = await started();
    await host.room.save('game', { turn: 4, board: ['x', 'o'] });
    await host.evict();
    expect(host.room.userIds).toEqual(['alice', 'bob']);
    expect(host.room.gameInit('bob')).toEqual({ hand: ['BOB-WIND'] });
    expect(await host.room.read('game')).toEqual({ turn: 4, board: ['x', 'o'] });
    await host.room.forget('game');
    expect(await host.room.read('game')).toBeUndefined();
  });

  it('lets a user in after an eviction using the stored table', async () => {
    const host = await started();
    await host.evict();
    const b = host.connect('token-for-bob');
    expect(await b.client.ready).toEqual({ userId: 'bob' });
  });

  it('refuses a shared token, an empty token, or a user twice', async () => {
    const host = await started();
    await expect(host.room.addUser('cy', { authToken: 'token-for-alice', gameInit: {} })).rejects.toThrow(/same auth token/);
    await expect(host.room.addUser('cy', { authToken: '', gameInit: {} })).rejects.toThrow(/non-empty auth token/);
    await expect(host.room.addUser('alice', { authToken: 'fresh', gameInit: {} })).rejects.toThrow(/already in the room/);
  });
});

describe('closing', () => {
  it('closes every socket, fails what was waiting, and clears the alarm', async () => {
    const replies: Reply[] = [];
    const host = await started((room) => room.onReply((reply) => replies.push(reply)));
    const a = host.connect('token-for-alice');
    a.client.onPrompt(() => new Promise(() => undefined));
    await a.client.ready;
    await host.room.ask('alice', 'x', null);
    await host.room.setTimer('later', 1000);
    await settle();
    await host.room.close();
    expect(a.socket.closed?.code).toBe(CLOSE.roomClosed);
    expect(replies[0]).toMatchObject({ ok: false });
    expect(host.platform.alarmAt).toBeUndefined();
    expect(() => host.room.accept(new FakeSocket(() => undefined, () => undefined))).toThrow();
  });
});
