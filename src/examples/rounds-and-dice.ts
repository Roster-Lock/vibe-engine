/**
 * Commit & reveal, and dice — written the way a card creator would write them,
 * then run. Every card below is plain English; nothing here is engine code.
 *
 * Run with:  npm run example:rounds
 *
 * It demonstrates (docs/design/20-secret-choices-and-dice.md):
 *  1. a sealed round — everyone commits a card face down, then they reveal
 *  2. what a commitment is: a vague one (two goblins) loses the game
 *  3. a card chosen by its id, which is never vague
 *  4. secret numbers, revealed together
 *  5. dice — "the" is the first roll, "that" the most recent
 */
import { compileDocument } from '../english/index.js';
import { ZoneDictionary } from '../english/zone-dictionary.js';
import { PLAY } from '../engine/index.js';
import {
  Character,
  GameEndInterrupt,
  Player,
  createEngine,
  pickById,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Decision,
  type Entity,
  type GameEvent,
} from '../games/turn-based/index.js';
import { DECK, GARBAGE, HAND } from '../games/cards/zones.js';
import { ViewProjector } from '../engine/index.js';
import { setEngineCast } from '../games/cards/cast.js';

const ZONES = new ZoneDictionary([HAND.id, DECK.id]);

/** A card in a hand: an entity with a unique id, as every card has online. */
class Card implements Entity {
  readonly type = 'card' as const;
  constructor(
    readonly name: string,
    readonly id: string,
  ) {}
}

/** What a seat does when asked: write something down, or pick a card by id. */
type Move = { write: string } | { id: string } | { number: number } | { vote: string };

/** The order the table was asked in, for the vote examples. */
const order: string[] = [];

class Seat extends Player {
  constructor(
    name: string,
    characters: readonly Character[],
    private readonly move: Move,
  ) {
    super(name, characters);
  }
  async decide(): Promise<Decision[]> {
    return [];
  }
  override async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    if (request.kind === 'label' && 'vote' in this.move) {
      order.push(this.name);
      return { kind: 'label', value: this.move.vote };
    }
    if (request.kind === 'number' && 'number' in this.move) return { kind: 'number', value: this.move.number };
    if (request.kind === 'select' && 'write' in this.move) return { kind: 'written', text: this.move.write };
    if (request.kind === 'select' && 'id' in this.move) return pickById(this.move.id);
    return { kind: 'confirm', yes: true };
  }
}

interface Player_ {
  readonly name: string;
  readonly move: Move;
  readonly hand?: readonly Card[];
  readonly deck?: readonly Card[];
}

function banner(title: string, document: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
  console.log(document.split('\n').map((line) => `  | ${line}`).join('\n'));
}

/** Compiles `document`, seats the players, and runs its first ability for the first. */
async function play(
  document: string,
  seats: readonly Player_[],
  rolls: readonly (readonly number[])[] = [],
  caster = 0,
) {
  const compiled = compileDocument(document, { zones: ZONES, bind: { aliases: { library: DECK.id } } });
  for (const diagnostic of compiled.diagnostics) {
    console.log(`  ! ${diagnostic.severity}: ${diagnostic.message}`);
  }
  const ability = compiled.abilities[0]!;
  const events: GameEvent[] = [];
  let nextRoll = 0;
  const engine = createEngine({
    seed: 'example',
    onEvent: (event: GameEvent) => events.push(event),
    ...(rolls.length > 0 ? { roller: () => rolls[nextRoll++]! } : {}),
  });
  for (const zone of [DECK, HAND, GARBAGE, PLAY]) engine.zones.declare(zone);
  const players: Player[] = [];
  for (const seat of seats) {
    const hero = new Character(`${seat.name}'s hero`, {
      gauges: [{ id: 'hp', max: 30 }],
      skills: [{ name: ability.name, weight: 1, abilities: [ability] }],
    });
    const player = new Seat(seat.name, [hero], seat.move);
    engine.registerPlayer(player);
    for (const card of seat.hand ?? []) await engine.addEntity(card, HAND.id, { owner: player });
    for (const card of seat.deck ?? []) await engine.addEntity(card, DECK.id, { owner: player });
    players.push(player);
  }
  const zone = (name: string, player: Player): string =>
    engine.zones.members(name, player).filter((m) => m.type === 'card').map((m) => m.name).join(', ') || '—';
  let ended: GameEndInterrupt | undefined;
  try {
    await engine.useAbility(players[caster]!.characters[0]!, ability, { targets: [] });
  } catch (error) {
    if (!(error instanceof GameEndInterrupt)) throw error;
    ended = error;
  }
  return { engine, events, players, zone, ended, hp: (player: Player) => player.characters[0]!.findGauge('hp')!.current };
}

/* ---------------------------------- 1 ---------------------------------- */

async function showdown(): Promise<void> {
  const document = `Ability Showdown
All players commit a card from their hand face down.
When they are ready, reveal.
All players move the card they committed to their garbage.`;
  banner('1. Showdown — everyone commits a card face down, then reveals', document);
  const { players, zone, events } = await play(document, [
    { name: 'Alice', move: { id: 'a-2' }, hand: [new Card('Wisp', 'a-1'), new Card('Bolt', 'a-2')] },
    { name: 'Bob', move: { id: 'b-1' }, hand: [new Card('Imp', 'b-1'), new Card('Orc', 'b-2')] },
  ]);
  console.log('\n  events:', events.filter((e) => e.type.startsWith('choice:')).map((e) => e.type).join(' → '));
  for (const player of players) {
    console.log(`  ${player.name}: hand [${zone('hand', player)}]  garbage [${zone('garbage', player)}]`);
  }
}

/* ---------------------------------- 2 ---------------------------------- */

async function vague(): Promise<void> {
  const document = `Ability Showdown
All players commit a card from their hand face down.
When they are ready, reveal.
All players move the card they committed to their garbage.`;
  banner('2. A vague commitment loses — Bob writes "Goblin" but holds two', document);
  const goblins = [new Card('Goblin', 'b-1'), new Card('Goblin', 'b-2')];
  const { events, ended } = await play(document, [
    { name: 'Alice', move: { write: 'Wisp' }, hand: [new Card('Wisp', 'a-1')] },
    { name: 'Bob', move: { write: 'Goblin' }, hand: goblins },
  ]);
  const forfeit = events.find((e) => e.type === 'choice:forfeited');
  if (forfeit?.type === 'choice:forfeited') console.log(`\n  ${forfeit.player.name} forfeits: ${forfeit.reason}`);
  console.log(`  winners: ${ended ? ended.winners.map((w) => w.name).join(', ') : '(game continues)'}`);
}

/* ---------------------------------- 3 ---------------------------------- */

async function byId(): Promise<void> {
  const document = `Ability Showdown
All players commit a card from their hand face down.
When they are ready, reveal.
All players move the card they committed to their garbage.`;
  banner('3. The same two goblins, chosen by id — never vague', document);
  const { players, zone, ended } = await play(document, [
    { name: 'Alice', move: { id: 'a-1' }, hand: [new Card('Wisp', 'a-1')] },
    { name: 'Bob', move: { id: 'b-2' }, hand: [new Card('Goblin', 'b-1'), new Card('Goblin', 'b-2')] },
  ]);
  for (const player of players) {
    console.log(`  ${player.name}: hand [${zone('hand', player)}]  garbage [${zone('garbage', player)}]`);
  }
  console.log(`  game over: ${ended ? 'yes' : 'no'}`);
}

/* ---------------------------------- 4 ---------------------------------- */

async function numbers(): Promise<void> {
  const document = `Ability Bid
All players commit a number from 1 to 6 face down.
When they are ready, reveal.`;
  banner('4. Secret numbers, revealed together', document);
  const { events } = await play(document, [
    { name: 'Alice', move: { number: 4 } },
    { name: 'Bob', move: { number: 2 } },
  ]);
  const revealed = events.find((e) => e.type === 'choice:revealed');
  if (revealed?.type === 'choice:revealed') {
    for (const { player, answer } of revealed.answers) {
      console.log(`  ${player.name} committed ${answer.kind === 'number' ? answer.value : '?'}`);
    }
  }
}

/* ---------------------------------- 5 ---------------------------------- */

async function dice(): Promise<void> {
  const document = `Ability Gamble
Roll a d6.
Store that value as AttackerRoll.
Roll a d20.
Deal AttackerRoll damage to this.
Deal that value damage to this.`;
  banner('5. Dice — "that" is the most recent roll; "Store … as" keeps an earlier one', document);
  const { players, hp } = await play(
    document,
    [
      { name: 'Hero', move: { number: 1 } },
      { name: 'Rival', move: { number: 1 } },
    ],
    [[4], [15]],
  );
  console.log(`\n  rolled a 4 then a 15 → hero takes 4 then 15: hp ${hp(players[0]!)} of 30`);
}

/* ---------------------------------- 6 ---------------------------------- */

async function drawing(): Promise<void> {
  const document = `Ability Study
Roll a d6.
Draw(you, that value).
Draw(all opponents, 1).`;
  banner('6. Draw(player, count) — here the count is a die roll', document);
  const deck = (prefix: string): Card[] => [1, 2, 3, 4, 5, 6, 7].map((n) => new Card(`${prefix}${n}`, `${prefix}-${n}`));
  const { players, zone } = await play(
    document,
    [
      { name: 'Alice', move: { number: 1 }, deck: deck('A') },
      { name: 'Bob', move: { number: 1 }, deck: deck('B') },
    ],
    [[3]],
  );
  for (const player of players) console.log(`  ${player.name}: hand [${zone('hand', player)}]`);
}

/* ---------------------------------- 7 ---------------------------------- */

async function table(): Promise<void> {
  const document = `Ability Deck of Many Things
Roll a d20.
  1: Deal 25 damage to this.
  2 to 5: Deal 5 damage to this.
  6 to 19: Heal this for 3.
  20: Draw(you, 2). Heal this for 10.`;
  banner('7. A roll table — a result per line', document);
  for (const roll of [1, 4, 12, 20]) {
    const { players, hp, zone } = await play(
      document,
      [
        { name: 'Hero', move: { number: 1 }, deck: [new Card('H1', 'h-1'), new Card('H2', 'h-2'), new Card('H3', 'h-3')] },
        { name: 'Rival', move: { number: 1 } },
      ],
      [[roll]],
    );
    console.log(`  rolled ${String(roll).padStart(2)} → hero hp ${hp(players[0]!)}, hand [${zone('hand', players[0]!)}]`);
  }
}

/* ---------------------------------- 8 ---------------------------------- */

async function duel(): Promise<void> {
  const document = `Ability Duel
Roll a d20.
Store that value as AttackerRoll.
Roll a d20.
Store that value as DefenderRoll.
If AttackerRoll > DefenderRoll, Deal 10 damage to this.
If AttackerRoll < DefenderRoll, Deal 20 damage to this.
If AttackerRoll = DefenderRoll, Deal 1 damage to this.`;
  banner('8. A duel — two stored rolls compared', document);
  for (const [attacker, defender] of [[15, 4], [4, 15], [9, 9]] as const) {
    const { players, hp } = await play(
      document,
      [
        { name: 'Hero', move: { number: 1 } },
        { name: 'Rival', move: { number: 1 } },
      ],
      [[attacker], [defender]],
    );
    console.log(`  ${String(attacker).padStart(2)} vs ${String(defender).padStart(2)} → hero hp ${hp(players[0]!)}`);
  }
}

/* ---------------------------------- 9 ---------------------------------- */

async function votes(): Promise<void> {
  const tally = `
If votes for Attack > votes for Retreat, Deal 10 damage to this.
If votes for Attack < votes for Retreat, Deal 20 damage to this.`;
  const kinds: [string, string][] = [
    ['commit / reveal', 'All players commit Attack or Retreat face down.\nWhen they are ready, reveal.'],
    ['the caster goes first', 'Starting with you, each player chooses Attack or Retreat.'],
    ['the caster goes last', 'Ending with you, each player chooses Attack or Retreat.'],
    ['a random player goes first', 'Starting with a random player, each player chooses Attack or Retreat.'],
    ['reverse order', 'In reverse order, each player chooses Attack or Retreat.'],
  ];
  banner('9. Votes — five kinds (seats Alice, Bob, Cara, Dev; Cara casts; the die shows 2)', kinds.map(([, line]) => line).join('\n'));
  const choice = ['Attack', 'Retreat', 'Attack', 'Attack'];
  for (const [name, line] of kinds) {
    order.length = 0;
    const { players, hp } = await play(
      `Ability Council\n${line}${tally}`,
      ['Alice', 'Bob', 'Cara', 'Dev'].map((who, i) => ({ name: who, move: { vote: choice[i]! } })),
      [[2]],
      2,
    );
    console.log(`  ${name.padEnd(28)} asked: ${order.join(' → ').padEnd(26)} 3–1 for Attack → Cara hp ${hp(players[2]!)}`);
  }
}

/* --------------------------------- 10 --------------------------------- */

async function visibility(): Promise<void> {
  console.log(`\n${'─'.repeat(72)}\n10. Who can see what\n${'─'.repeat(72)}`);
  const engine = createEngine({ seed: 'example' });
  engine.zones.declare(PLAY);
  engine.zones.declare({ id: 'forehead', visibility: 'custom', scope: 'per-player' });
  engine.zones.declare({ id: 'secret', visibility: 'hidden', scope: 'per-player' });
  const seats = ['Alice', 'Bob', 'Cara'].map(
    (name) => new Seat(name, [new Character(`${name}'s hero`, { gauges: [{ id: 'hp', max: 1 }] })], { number: 1 }),
  );
  for (const seat of seats) engine.registerPlayer(seat);
  const [alice, bob, cara] = seats as [Seat, Seat, Seat];
  const worn = new Card('Joker', 'j-1');
  const held = new Card('Ace', 'a-1');
  await engine.addEntity(worn, 'forehead', { owner: alice });
  await engine.addEntity(held, 'secret', { owner: alice });
  const row = (card: Card): string => seats.map((s) => `${s.name} ${engine.canSee(s, card) ? 'sees' : '— '}`).join('  ');
  console.log('  a custom zone starts out seen by nobody:');
  console.log(`    Joker on Alice's forehead   ${row(worn)}`);
  engine.setViewers(engine.zones.zone('forehead', alice)!, [bob, cara]);
  console.log('  everyone but its owner may look:');
  console.log(`    Joker on Alice's forehead   ${row(worn)}`);
  console.log(`  a hidden card, then shown to Bob only:`);
  console.log(`    Ace in Alice's secret pile  ${row(held)}`);
  const grant = engine.showTo(held, [bob]);
  console.log(`    …shown to Bob               ${row(held)}`);
  await engine.moveTo(held, 'forehead', { owner: alice });
  console.log(`    …it moves (the grant ends)  ${row(held)}   grant active: ${grant.active}`);
}

/* --------------------------------- 11 --------------------------------- */

async function boxedPresent(): Promise<void> {
  const document = `Ability Open Present
Reveal this.
Cast this if you can, otherwise move it to its owner's garbage.

Zone boxed
Cards in this zone have Open Present for all opponents.`;
  banner('11. The Boxed Present — a Zone section gives its cards an ability they never printed', document);
  const engine = createEngine({ seed: 'example' });
  for (const zone of [PLAY, GARBAGE]) engine.zones.declare(zone);
  engine.zones.declare({ id: 'boxed', visibility: 'hidden', scope: 'per-player' });
  engine.zones.declare({ id: 'stack', visibility: 'public' });
  const [alice, bob] = ['Alice', 'Bob'].map(
    (name) => new Seat(name, [new Character(`${name}'s hero`, { gauges: [{ id: 'hp', max: 1 }] })], { number: 1 }),
  ) as [Seat, Seat];
  engine.registerPlayer(alice);
  engine.registerPlayer(bob);
  // This game casts a card only if it is cheap (the card's id ends in a number: its cost).
  setEngineCast(engine, async (_player, card) => {
    if (Number((card as Card).id.split('-')[1]) > 3) return false;
    await engine.moveTo(card, 'stack', { reason: 'cast' });
    return true;
  });
  const cheap = new Card('Spark', 'spark-1');
  const dear = new Card('Colossus', 'colossus-9');
  await engine.addEntity(cheap, 'boxed', { owner: alice });
  await engine.addEntity(dear, 'boxed', { owner: alice });
  const compiled = compileDocument(document, { zones: new ZoneDictionary(['boxed']) });
  const openPresent = compiled.abilities[0]!;
  // The game applies the Zone section once its zones and players exist: every
  // player's boxed cards can be opened by that player's opponents.
  for (const zone of compiled.zones) await zone.apply(engine);
  const where = (card: Card): string => {
    const zone = engine.zones.zoneOf(card)!;
    return `${zone.id}${zone.owner ? ` (${zone.owner.name}'s)` : ''}, Bob ${engine.canSee(bob, card) ? 'can' : 'cannot'} see it`;
  };
  console.log(`  before: ${cheap.name} in ${where(cheap)}; ${dear.name} in ${where(dear)}`);
  console.log(`  Bob may open: ${engine.abilitiesFor(bob, cheap).map((a) => a.name).join(', ')}; Alice may open: ${engine.abilitiesFor(alice, cheap).length === 0 ? 'nothing' : '?'}`);
  await engine.useCardAbility(bob, cheap, openPresent);
  await engine.useCardAbility(bob, dear, openPresent);
  console.log(`  after:  ${cheap.name} in ${where(cheap)}; ${dear.name} in ${where(dear)}`);
}

/* --------------------------------- 12 --------------------------------- */

async function views(): Promise<void> {
  console.log(`\n${'─'.repeat(72)}\n12. What a client is sent — Bob's view of the game\n${'─'.repeat(72)}`);
  const engine = createEngine({ seed: 'example' });
  for (const zone of [PLAY, GARBAGE]) engine.zones.declare(zone);
  engine.zones.declare({ id: 'deck', visibility: 'hidden', scope: 'per-player', ordered: true });
  engine.zones.declare({ id: 'hand', visibility: 'owner', scope: 'per-player' });
  const [alice, bob] = ['Alice', 'Bob'].map(
    (name) => new Seat(name, [new Character(`${name}'s hero`, { gauges: [{ id: 'hp', max: 30 }] })], { number: 1 }),
  ) as [Seat, Seat];
  engine.registerPlayer(alice);
  engine.registerPlayer(bob);
  for (const [name, zone, owner] of [
    ['Fireball', 'hand', alice],
    ['Frostbolt', 'hand', alice],
    ['Wisp', 'hand', bob],
    ['Dragon', 'deck', alice],
    ['Imp', 'deck', alice],
  ] as const) {
    await engine.addEntity(new Card(name, `${name.toLowerCase()}-1`), zone, { owner });
  }
  const projector = new ViewProjector(engine);
  for (const viewer of [bob, alice]) {
    console.log(`  ${viewer.name} is sent:`);
    for (const zone of projector.viewFor(viewer).zones) {
      if (zone.id === 'play' || zone.id === 'garbage') continue;
      const cards = zone.members.map((slot) => (slot.hidden === true ? '·' : slot.name)).join(' ');
      console.log(`    ${zone.key.padEnd(11)} size ${zone.size}  cards [${cards}]  not shown: ${zone.hiddenCount}`);
    }
  }
}

await showdown();
await vague();
await byId();
await numbers();
await dice();
await drawing();
await table();
await duel();
await votes();
await visibility();
await boxedPresent();
await views();
