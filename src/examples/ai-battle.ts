/**
 * An AI vs AI battle: both sides are `RandomAI`s, so every round every
 * fighter randomly picks a skill and random targets. Run it a few times —
 * the randomness makes each battle play out differently.
 *
 * Run with:  npm run example:ai
 */
import { Character, cast, damage, heal, isDamage, isHeal, amountOf, skill, type GameEvent } from '../games/turn-based/index.js';
import { LocalGame } from '../multiplayer/local.js';
import { RandomAI } from '../multiplayer/random-ai.js';

/* ----------------------------- content ----------------------------- */

const strike = cast({
  name: 'Strike',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 20, ctx.self)], // lethal: HP
});

const firstAid = cast({
  name: 'First Aid',
  targeting: { who: 'ally', count: 1 },
  cast: (ctx, targeting) => [heal(targeting.targets[0]!.gauge('hp'), 15, ctx.self)],
});

const headbutt = cast({
  name: 'Headbutt',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 22, ctx.self)], // lethal: HP
});

/* ------------------------------ demo ------------------------------- */

const hero = new Character('Hero', {
  maxHp: 150,
  maxMana: 150,
  skills: [skill({ name: 'Fighter', weight: 1, abilities: [strike, firstAid] })],
});
const goblin = new Character('Goblin Chieftain', {
  maxHp: 120,
  maxMana: 120,
  skills: [skill({ name: 'Chieftain', weight: 1, abilities: [headbutt] })],
});

const game = new LocalGame(
  [
    new RandomAI('Hero', [hero], 'party'),
    new RandomAI('Goblins', [goblin], 'monsters'),
  ],
  { maxRounds: 60, onEvent: (event) => log(event) },
);

console.log(`\n=== ${hero} vs ${goblin} — AI vs AI ===`);
const winners = await game.runLoop();

console.log('\n=== Final ===');
console.log(`  ${hero}`);
console.log(`  ${goblin}`);
console.log(
  winners.length === 0
    ? '  Result: draw'
    : `  Result: ${winners.map((w) => w.name).join(', ')} win!`,
);

function log(event: GameEvent): void {
  if (isDamage(event) && event.target) {
    console.log(
      `   ${event.target.name} takes ${amountOf(event)} damage` +
        ('source' in event ? ` from ${event.source.name}` : ''),
    );
  } else if (isHeal(event) && event.target) {
    console.log(`   ${event.target.name} recovers ${amountOf(event)}`);
  } else if (event.type === 'character:destroyed') {
    console.log(`   💀 ${event.character.name} is defeated!`);
  }
}
