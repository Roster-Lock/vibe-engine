/**
 * A full match, AI against AI:
 *
 *   npx tsx examples/card-game/demo.ts
 *
 * Everything you see — trades, taunt blocking a lethal swing, an on-death trigger
 * drawing a card, +2/+2 changing a creature's derived stat line, fatigue,
 * and the match ending the moment a hero falls — is the engine's action
 * pipeline doing its job. The card layer only deals cards and counts mana.
 */
import { amountOf, isDamage, isHeal, type GameEvent } from '../../src/games/turn-based/index.js';
import { GreedyAI } from './ai.js';
import { STARTER_DECK } from './cards.js';
import { CardGame } from './game.js';

const describe = (event: GameEvent): string | undefined => {
  if (isDamage(event) && 'target' in event) {
    const from = 'source' in event ? ` from ${event.source.name}` : '';
    return `${event.target.name} takes ${amountOf(event)}${from} (${event.target.gauge('hp').current} hp left)`;
  }
  if (isHeal(event) && 'target' in event) {
    return `${event.target.name} recovers ${amountOf(event)}`;
  }
  if (event.type === 'character:destroyed') return `💀 ${event.character.name} dies`;
  if (event.type === 'buff:added' && event.buff.id !== 'mana-crystal' && event.buff.id !== 'summoning-sickness') {
    return `${event.character.name} gains ${event.buff.name}`;
  }
  return undefined;
};

const game = new CardGame(
  [new GreedyAI('Jaina', 'mages', STARTER_DECK), new GreedyAI('Rexxar', 'hunters', STARTER_DECK)],
  {
    onEvent: (event) => {
      const line = describe(event);
      if (line) console.log(`       ${line}`);
    },
  },
);

console.log('=== Jaina vs Rexxar ===');
const winners = await game.runLoop();

console.log('\n=== Final ===');
for (const player of game.players) {
  const side = game.sideOf(player);
  console.log(
    `  ${player.name}: ${side.hero.gauge('hp').current} hp · ${side.board.length} on board · ` +
      `${side.hand.size} in hand · ${side.deck.size} in deck · fatigue ${side.fatigue}`,
  );
}
console.log(
  winners.length === 0
    ? `  Result: a draw after ${game.turn} turns`
    : `  Result: ${winners.map((w) => w.name).join(', ')} wins on turn ${game.turn}`,
);
