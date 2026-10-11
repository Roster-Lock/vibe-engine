/**
 * The Explosion buff: a ticking bomb.
 *
 * Run with:  npm run example:explosion
 *
 * - **Tick** — an `auto` ability on the buff listens to `turn:end` and
 *   increments the buff's own `ticker` variable once per turn it stays
 *   around (exactly like Berserk's stacks in the quickstart).
 * - **Blow up** — a buff:destroyed self-listening trigger on the buff fires when the buff ends
 *   *for any reason*: dispelled directly, or dying because its wearer was
 *   destroyed (`removedOnDefeat` now defaults to `true`, so the buff does
 *   not even have to declare it). The creator's defeat never removes it: a
 *   bomb planted by a fallen mage stays armed on its target. A buff's
 *   abilities are detached before its end is announced, so the buff hears it as a
 *   ability is how a buff reacts to its own death.
 *
 * The blast scales with the ticker: `10 × ticker` to the wearer and half
 * that to each ally of the wearer (splash).
 */
import {
  Character,
  GameEngine,
  addBuff,
  auto,
  buff,
  damage,
  isDamage,
  amountOf,
  type GameEvent,
} from '../games/turn-based/index.js';
import { createEngine } from '../games/turn-based/index.js';
import { endTurn, startTurn } from '../games/round-based/index.js';
import { isAlly, isEnemy } from '../games/round-based/index.js';

/* ----------------------------- content ----------------------------- */

const bomb = buff({
  name: 'Explosion',
  weight: 1,
  variables: () => ({ ticker: 0 }),
  abilities: [
    auto({
      name: 'Tick',
      event: 'turn:end',
      cast: (ctx) => {
        const vars = ctx.self.findStatus('explosion')?.vars;
        if (vars && typeof vars.ticker === 'number') vars.ticker += 1;
        return [];
      },
    }),
    auto({
      name: 'Blow Up',
      event: 'buff:destroyed',
      // "When THIS buff dies or is removed" — a self-listening trigger.
      when: (ctx) => ctx.event.buff.id === 'explosion' && ctx.event.character === ctx.self,
      cast: (ctx) => {
        const power = 10 * Number(ctx.event.buff.vars.ticker ?? 0);
        const allies = ctx.engine.registeredCharacters.filter(
          (c) => isAlly(c, ctx.self) && c !== ctx.self,
        );
        return [
          damage(ctx.self.gauge('hp'), power, ctx.event.buff),
          ...allies.map((c) => damage(c.gauge('hp'), Math.floor(power / 2), ctx.event.buff)),
        ];
      },
    }),
  ],
});

/* ------------------------------ setup ------------------------------ */

const engine = createEngine({
  onEvent: (event: GameEvent) => {
    if (event.type === 'buff:added') {
      console.log(`   ${event.character.name} gains ${event.buff.name} (ticker 0)`);
    } else if (event.type === 'buff:destroyed') {
      const ticker = event.buff.vars.ticker;
      console.log(
        `   ${event.character.name} loses ${event.buff.name}` +
          (ticker !== undefined ? ` (ticker ${String(ticker)})` : ''),
      );
    } else if (event.type === 'cycle:detected') {
      console.log(`   ⚠️ cycle: ${event.grantor.name} tried to grant '${event.attemptedId}' (an ancestor)`);
    } else if (isDamage(event) && event.target) {
      console.log(`   ${event.target.name} takes ${amountOf(event)} damage`);
    }
  },
});

const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
const goblin = new Character('Goblin', { maxHp: 60, maxMana: 60 });
const hound = new Character('Hound', { maxHp: 40, maxMana: 40 });
hero.team = 'party';
goblin.team = 'monsters';
hound.team = 'monsters';

engine.registerCharacter(hero);
engine.registerCharacter(goblin);
engine.registerCharacter(hound);

/* ----------------------------- battle ------------------------------ */

console.log('=== Plant the bomb; it ticks once per turn ===');
await engine.addBuff(goblin, bomb, hero); // planted by the hero
await startTurn(engine);
await endTurn(engine); // ticker 1
await startTurn(engine);
await endTurn(engine); // ticker 2
console.log(`   ${goblin.name} bomb ticker: ${String(goblin.findStatus('explosion')?.vars.ticker)}`);

console.log('\n=== Direct removal: the bomb blows up ===');
await engine.removeBuff(goblin, 'explosion');
console.log(`   ${goblin} | ${hound} (blast 20 on the wearer, splash 10)`);

console.log('\n=== The wearer dies: defeat fades the bomb, which blows up ===');
await engine.addBuff(goblin, bomb, hero);
await startTurn(engine);
await endTurn(engine); // ticker 1
await engine.damage(goblin.gauge('hp'), 60); // killing blow — drain the whole HP gauge (life)
console.log(`   ${goblin} | ${hound} (splash 5 from the death explosion)`);

console.log('\n=== A runaway bomb: cycles are detected, not hung ===');
// A bomb that tries to clone itself is a self-cycle (a status granting its
// own ancestor). The engine refuses the grant and removes the offending
// bomb — which blows up via its buff:destroyed self-trigger. No depth-guard error, no hang.
const runaway = buff({
  name: 'Runaway',
  weight: 1,
  stacks: true,
  abilities: [
    auto({
      name: 'Clone',
      event: 'buff:added',
      when: (ctx) => ctx.event.buff.id === 'runaway',
      targeting: { who: 'self' },
      cast: (ctx) => [addBuff(ctx.self, runaway)],
    }),
    auto({
      name: 'Blow Up',
      event: 'buff:destroyed',
      when: (ctx) => ctx.event.buff.id === 'runaway' && ctx.event.character === ctx.self,
      cast: (ctx) => [damage(ctx.self.gauge('hp'), 6, ctx.event.buff)],
    }),
  ],
});
const hound2 = new Character('Hound II', { maxHp: 40, maxMana: 40 });
hound2.team = 'monsters';
engine.registerCharacter(hound2);
await engine.addBuff(hound2, runaway);
console.log(`   ${hound2.name} runaway: ${hound2.hasStatus('runaway') ? 'still ticking (unexpected!)' : 'refused and removed'}`);
console.log(`   ${hound2} (self-destructed for 6)`);

console.log('\n=== Final ===');
console.log(`   ${goblin}`);
console.log(`   ${hound}`);
