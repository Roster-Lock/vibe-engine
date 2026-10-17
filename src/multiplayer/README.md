# multiplayer

The network / opponent layer. Every module here plugs a *source of
decisions* into the `Game` loop (`../engine/game.ts`): a `Game` collects
`Decision`s via `collectUserDecisions()` and applies them in `runGame()`,
and each `Player` (`../engine/player.ts`) answers with `decide(engine)`.

## Modules

- `local.ts` — same-machine play: `LocalGame` (a concrete `Game`) runs any
  mix of players against each other, plus `ScriptedPlayer` (first skill,
  first valid target — deterministic, handy for tests and scripted battles).
- `random-ai.ts` — `RandomAI`: a `Player` that randomly chooses a skill and
  random valid targets for each living character, every round.
- `room.ts`, `client.ts`, `protocol.ts`, `socket.ts`, `wire.ts`, `online.ts` —
  **online play over WebSockets** (see below).
- `webrtc.ts` — *planned*: peer-to-peer play, syncing each side's decisions
  and the game state between two clients over WebRTC.

## Examples

```ts
import { LocalGame, ScriptedPlayer } from './local.js';
import { RandomAI } from './random-ai.js';

const game = new LocalGame([
  new ScriptedPlayer('Hero', [hero], 'party'),
  new RandomAI('Goblins', [goblin], 'monsters'),
], { onEvent: log });

const winners = await game.runLoop();   // Player[] — the surviving side
```

A human player works the same way: `decide()` waits for input instead of
computing it (see `../ui/human-player.ts`).

## Online play

A `Room` on the server, `createClient` on the other end. Authentication is somebody
else's job: the room is told which token belongs to which user and only compares.

```ts
// server
const room = new Room({
  alice: { authToken: tokenIssuedToAlice, gameInit: { deck: [...] } },
  bob:   { authToken: tokenIssuedToBob,   gameInit: { deck: [...] } },
});
wss.on('connection', (ws) => room.addWebsocket(ws));   // the room asks the socket for its token
const projector = new ViewProjector(engine);
attachGame(room, engine, projector, { alice: alicePlayer, bob: bobPlayer });
// a RemotePlayer's choices go to its client as prompts

// client
const client = createClient({ url, authToken });       // answers the room's `auth` request with the token
await client.ready;
client.on('view', render);                              // the game as you may see it
client.on('event', animate);                            // what just happened, redacted for you
client.onPrompt(async (name, payload) => answer);       // the room needs an answer from you
```

- **The room asks for the token.** Both ends run a `MessageBridge`; the room does
  `await bridge.sendRequest('auth', {})` and the client answers with
  `onRequest('auth', () => authToken)`. A token nobody holds, an empty or oversized one, a
  non-string, or silence for `authTimeoutMs` gets the socket closed (`4001`, `Bad User`);
  until it answers a socket is sent nothing but the question and its other messages are
  dropped.
- **Tokens are compared in constant time** over every user, and each user needs a token of
  their own. A token and a user's `gameInit` are never put on the wire.
- **One live socket per user.** Connecting again with the same token replaces the older
  socket (closed with `4002`). A user who drops can come back: prompts still waiting are
  sent again, with a fresh view.
- **What a client is sent is what it may see** — `ViewProjector` in `../engine/views.ts`.
  A client answers a choice by the *position* of the option it picks, never by naming a
  card.
- `socket.ts` adapts the standard WebSocket (`fromWebSocket`), and `memoryPair()` gives two
  connected in-memory ends for tests and for running a server and clients in one process.

`npm run example:online` plays a commit / reveal round between two clients this way.

### On Cloudflare

`CloudflareRoom` is the same room as a plain class a Durable Object can forward to (it is
not itself a Durable Object). It is woken by `accept`/`fetch`, `webSocketMessage`,
`webSocketClose`/`webSocketError` and `alarm`, and keeps what it needs in `ctx.storage` and
socket attachments so it can be evicted between any two. `load()` on each wake;
`save`/`read` for the game's state; `setTimer(name, ms, data)` + `onTimer(name, fn)` for
timeouts (one platform alarm carries them all); `ask` + `onReply` for prompts that outlive
eviction (`prompt()` for the awake case). Handlers are registered on every wake. See the
class's doc comment for the Durable Object shell.
