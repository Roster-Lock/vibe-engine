/**
 * The `Game` class in action: a scripted local battle.
 *
 * `LocalGame` (src/multiplayer/local.ts) is a concrete `Game` — it answers
 * the two questions a game must answer every round:
 *
 *   - `collectUserDecisions()` — asks each player to decide
 *   - `runGame(decisions)`     — applies the round through the engine,
 *     ends the turn, and checks for winners
 *
 * `runLoop()` wires them together: it repeats the round until a
 * `GameEndInterrupt` ends the game, and returns the winning `Player`s.
 * Here both sides are `ScriptedPlayer`s (first skill, first valid target).
 *
 * Run with:  npm run example:game
 */
import { fileURLToPath } from 'node:url';
import { Character, cast, damage, heal, isDamage, isHeal, amountOf, skill, type GameEvent } from '../games/turn-based/index.js';
import { LocalGame, ScriptedPlayer } from '../multiplayer/local.js';

/* ----------------------------- content ----------------------------- */

const strike = cast({
  name: 'Strike',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 20, ctx.self)], // lethal: HP
});

const firstAid = cast({
  name: 'First Aid',
  targeting: { who: 'ally', count: 1 },
  cast: (ctx, targeting) => [heal(targeting.targets[0]!.gauge('hp'), 10, ctx.self)],
});

const headbutt = cast({
  name: 'Headbutt',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 25, ctx.self)], // lethal: HP
});

/* ------------------------------ demo ------------------------------- */

if (isMain(import.meta.url)) {
  const hero = new Character('Hero', {
    maxHp: 150,
    maxMana: 150,
    skills: [skill({ name: 'Fighter', weight: 1, abilities: [strike, firstAid] })],
  });
  const goblin = new Character('Goblin Chieftain', {
    maxHp: 100,
    maxMana: 100,
    skills: [skill({ name: 'Chieftain', weight: 1, abilities: [headbutt] })],
  });

  const game = new LocalGame(
    [
      new ScriptedPlayer('Hero', [hero], 'party'),
      new ScriptedPlayer('Goblins', [goblin], 'monsters'),
    ],
    { maxRounds: 20, onEvent: (event) => log(event) },
  );

  console.log(`\n=== ${hero} vs ${goblin} ===`);
  const winners = await game.runLoop();

  console.log('\n=== Final ===');
  console.log(`  ${hero}`);
  console.log(`  ${goblin}`);
  console.log(
    winners.length === 0
      ? '  Result: draw'
      : `  Result: ${winners.map((w) => w.name).join(', ')} win!`,
  );
}

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

/** True when this module is the entry point (not imported by a test). */
function isMain(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(importMetaUrl) === process.argv[1];
}
