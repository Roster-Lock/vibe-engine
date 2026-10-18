/**
 * An online game over real WebSockets: a server listens on localhost, two clients connect
 * to it with their auth tokens (plus one with a wrong token, which is turned away), and
 * they play a commit / reveal round.
 *
 * Run with:  npx tsx src/examples/online-server.ts
 */
import { compileDocument } from '../english/index.js';
import { ZoneDictionary } from '../english/zone-dictionary.js';
import { PLAY } from '../engine/index.js';
import { Character, ViewProjector, createEngine, type Entity } from '../games/turn-based/index.js';
import { GARBAGE } from '../games/cards/zones.js';
import { WebSocketServer } from 'ws';
import {
  RemotePlayer,
  Room,
  attachGame,
  createClient,
  type Client,
  type WireRequest,
} from '../multiplayer/index.js';

class Card implements Entity {
  readonly type = 'card' as const;
  constructor(readonly name: string) {}
}

// What the server knows about each user. The tokens come from whatever signs players in.
const room = new Room({
  alice: { authToken: 'alice-secret-token', gameInit: { hand: ['Fireball', 'Frostbolt', 'Wisp'] } },
  bob: { authToken: 'bob-secret-token', gameInit: { hand: ['Dragon', 'Imp', 'Orc'] } },
});

// The game: a hand per player, visible to its owner only.
const engine = createEngine({ seed: 'online' });
for (const zone of [PLAY, GARBAGE]) engine.zones.declare(zone);
engine.zones.declare({ id: 'hand', visibility: 'owner', scope: 'per-player' });
const projector = new ViewProjector(engine);
const players: Record<string, RemotePlayer> = {};
for (const userId of room.userIds) {
  players[userId] = new RemotePlayer(userId, [new Character(`${userId}'s hero`, { gauges: [{ id: 'hp', max: 20 }] })], room, userId, projector);
  engine.registerPlayer(players[userId]!);
  for (const name of room.gameInit(userId).hand) await engine.addEntity(new Card(name), 'hand', { owner: players[userId]! });
}
attachGame(room, engine, projector, players);

const wss = new WebSocketServer({ port: 0 });
wss.on('connection', (ws) => room.addWebsocket(ws as never));
await new Promise((resolve) => wss.once('listening', resolve));
const url = `ws://localhost:${(wss.address() as { port: number }).port}`;
console.log('server listening on', url);

/** Connects a client for a token, recording every frame it receives. */
function connect(authToken: string, picks: string) {
  const inbound: string[] = [];
  const client = createClient({ authToken, url });
  client.onPrompt((name, payload) => {
    const request = payload as WireRequest;
    if (name !== 'choose' || request.kind !== 'select') throw new Error('unexpected prompt');
    console.log(`  [${authToken.split('-')[0]}] asked to choose among`, request.options.map((o) => (o.hidden ? '·' : o.name)).join(', '), `-> ${picks}`);
    return { kind: 'select', chosen: [request.options.findIndex((o) => o.hidden !== true && o.name === picks)] };
  });
  client.on('event', (event) => inbound.push(JSON.stringify(event)));
  client.on('view', (view) => inbound.push(JSON.stringify(view)));
  return { client, inbound };
}

const stranger = createClient({ authToken: 'a-guess', url });
await stranger.ready.then(
  () => console.log('stranger got in?!'),
  (error: Error) => console.log('stranger turned away:', error.message),
);

const alice = connect('alice-secret-token', 'Fireball');
const bob = connect('bob-secret-token', 'Imp');
console.log('connected:', (await Promise.all([alice.client.ready, bob.client.ready])).map((r) => r.userId).join(', '));
await new Promise((resolve) => setTimeout(resolve, 10));

const handsSeenBy = (client: Client): string =>
  client
    .view!.zones.filter((zone) => zone.id === 'hand')
    .map((zone) => `${zone.owner}: [${zone.members.map((m) => (m.hidden ? '·' : m.name)).join(', ')}]${zone.hiddenCount ? ` + ${zone.hiddenCount} hidden` : ''}`)
    .join('   ');

console.log('\nBefore the round');
console.log('  Alice is shown  ', handsSeenBy(alice.client));
console.log('  Bob is shown    ', handsSeenBy(bob.client));

const document = `Ability Showdown
All players commit a card from their hand face down.
When they are ready, reveal.
All players move the card they committed to their garbage.`;
const showdown = compileDocument(document, { zones: new ZoneDictionary(['hand']) }).abilities[0]!;
console.log('\n' + document.split('\n').map((line) => `  | ${line}`).join('\n'));
await showdown.cast({ self: players.alice!.characters[0]!, engine }, { targets: [] });
await new Promise((resolve) => setTimeout(resolve, 10));

console.log('\nAfter the round, in the engine');
for (const userId of room.userIds) {
  const garbage = engine.zones.members('garbage', players[userId]!).map((m) => m.name).join(', ');
  console.log(`  ${userId}'s garbage: ${garbage}`);
}

const leaked = (frames: string[], names: string[]): string[] => names.filter((name) => frames.join('').includes(name));
console.log('\nWhat Bob\'s connection was ever sent about Alice\'s hand');
console.log('  her kept cards (Frostbolt, Wisp):', leaked(bob.inbound, ['Frostbolt', 'Wisp']).length === 0 ? 'never sent' : 'LEAKED');
console.log('  her played card (Fireball):      ', leaked(bob.inbound, ['Fireball']).length > 0 ? 'sent, once she revealed it' : 'not sent');
console.log('  any auth token:                  ', leaked([...alice.inbound, ...bob.inbound], ['secret-token']).length === 0 ? 'never sent' : 'LEAKED');

for (const c of [alice, bob]) c.client.close();
room.close();
wss.close();
