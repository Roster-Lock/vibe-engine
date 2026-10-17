/**
 * Decks against each other: every deck plays every other, as first and second player, many
 * times, each game shuffled differently. Then one game is narrated.
 *
 *   npx tsx examples/card-game/tournament.ts [gamesPerPairing]
 */
import { commitSecret } from '../../src/engine/index.js';
import { amountOf, isDamage, type GameEvent } from '../../src/games/turn-based/index.js';
import { GreedyAI } from './ai.js';
import type { Card } from './cards.js';
import { DECKS, deckProblems, type Deck } from './decks.js';
import { CardGame } from './game.js';

/** A greedy AI whose contribution to the shuffle seed varies by game, so repeats differ. */
class SaltedAI extends GreedyAI {
  constructor(name: string, team: string, deck: readonly Card[], readonly salt: string) {
    super(name, team, deck);
  }
  override commitSeed(): string {
    return commitSecret(`${this.salt}:${this.id}`);
  }
  override revealSeed(): string {
    return `${this.salt}:${this.id}`;
  }
}

interface Result {
  winner: 0 | 1 | null;
  turns: number;
  hp: [number, number];
  game: CardGame;
}

async function play(first: Deck, second: Deck, salt: string, onEvent?: (e: GameEvent) => void): Promise<Result> {
  const players = [new SaltedAI(first.name, 'north', first.cards, salt), new SaltedAI(second.name, 'south', second.cards, salt)];
  const game = new CardGame(players, { log: () => undefined, ...(onEvent ? { onEvent } : {}) });
  const winners = await game.runLoop();
  const winner = winners.length === 1 ? (winners[0] === players[0] ? 0 : 1) : null;
  return {
    winner,
    turns: game.turn,
    hp: [game.sideOf(players[0]!).hero.gauge('hp').current, game.sideOf(players[1]!).hero.gauge('hp').current],
    game,
  };
}

for (const deck of DECKS) {
  const problems = deckProblems(deck);
  if (problems.length) throw new Error(problems.join('; '));
}
const perPairing = Number(process.argv[2] ?? 20);
console.log('Decks');
for (const deck of DECKS) console.log(`  ${deck.name.padEnd(13)} (${deck.cards.length} cards)  ${deck.blurb}`);

const wins = new Map<string, number>();
const games = new Map<string, number>();
const matrix = new Map<string, number>(); // "A>B" -> A's wins against B
let draws = 0;
let totalTurns = 0;
let total = 0;
for (const a of DECKS) {
  for (const b of DECKS) {
    if (a === b) continue;
    for (let i = 0; i < perPairing; i += 1) {
      const result = await play(a, b, `${a.name}/${b.name}/${i}`);
      total += 1;
      totalTurns += result.turns;
      for (const deck of [a, b]) games.set(deck.name, (games.get(deck.name) ?? 0) + 1);
      if (result.winner === null) {
        draws += 1;
        continue;
      }
      const [w, l] = result.winner === 0 ? [a, b] : [b, a];
      wins.set(w.name, (wins.get(w.name) ?? 0) + 1);
      matrix.set(`${w.name}>${l.name}`, (matrix.get(`${w.name}>${l.name}`) ?? 0) + 1);
    }
  }
}

console.log(`\n${total} games, ${draws} drawn, average ${(totalTurns / total).toFixed(1)} turns\n`);
console.log('Win rate');
for (const deck of [...DECKS].sort((x, y) => (wins.get(y.name) ?? 0) / games.get(y.name)! - (wins.get(x.name) ?? 0) / games.get(x.name)!)) {
  const w = wins.get(deck.name) ?? 0;
  console.log(`  ${deck.name.padEnd(13)} ${w}/${games.get(deck.name)}  ${((100 * w) / games.get(deck.name)!).toFixed(0)}%`);
}
console.log('\nHead to head (row beats column, out of ' + 2 * perPairing + ')');
console.log(''.padEnd(15) + DECKS.map((d) => d.name.slice(0, 11).padEnd(12)).join(''));
for (const a of DECKS) {
  console.log(
    a.name.padEnd(15) +
      DECKS.map((b) => (a === b ? '-'.padEnd(12) : String((matrix.get(`${a.name}>${b.name}`) ?? 0)).padEnd(12))).join(''),
  );
}

/* ----------------------- one game, narrated ----------------------- */
const [x, y] = DECKS;
console.log(`\n=== ${x!.name} (first) vs ${y!.name} ===`);
const lines: string[] = [];
const result = await play(x!, y!, 'narrated', (event) => {
  if (isDamage(event) && 'target' in event) lines.push(`    ${event.target.name} takes ${amountOf(event)} (${event.target.gauge('hp').current} hp left)`);
  else if (event.type === 'character:destroyed') lines.push(`    ${event.character.name} dies`);
});
console.log(lines.slice(0, 40).join('\n'));
if (lines.length > 40) console.log(`    ... ${lines.length - 40} more events`);
console.log(
  result.winner === null
    ? `Draw after ${result.turns} turns`
    : `${[x, y][result.winner]!.name} wins on turn ${result.turns} (heroes ${result.hp.join(' / ')} hp)`,
);
