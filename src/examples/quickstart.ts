/**
 * Quickstart: a tiny scripted battle written the way a *content creator*
 * would write it. Everything below is "content" — no engine internals.
 *
 * Run with:  npm run example
 *
 * It demonstrates:
 *  - manual abilities  (cast: player picks targets)
 *  - prompt-triggered  (prompt: event asks the player for targets)
 *  - auto-triggered    (auto: event picks its own targets)
 *  - passives          (transform actions — the action itself says which way)
 *  - buffs with weight + own variables (stacking)
 *  - permanent skills vs removable buffs
 */
import {
  GameEngine,
  Character,
  buff,
  cast,
  prompt,
  auto,
  passiveActionModifier,
  skill,
  damage,
  heal,
  changeGaugeBy,
  gaugeTransform,
  gaugeTransformCtx,
  wasTakenBy,
  isDamage,
  isHeal,
  amountOf,
  type GameEvent,
} from '../games/turn-based/index.js';
import { createEngine } from '../games/turn-based/index.js';
import { endTurn, startTurn } from '../games/round-based/index.js';

/* ----------------------------- content ----------------------------- */

// --- Hero skills ---

const strike = cast({
  name: 'Strike',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [
    changeGaugeBy(ctx.self.gauge('mana'), -10), // costs 10 mana
    damage(targeting.targets[0]!.gauge('hp'), 20, ctx.self), // lethal damage
  ],
});

// Incoming damage is capped at 50: Math.max(previousUpdate, current - 50).
// One listener sees every action flowing past the hero; the action itself
// carries its direction, so an incoming-only modifier just checks it.
const ironHide = passiveActionModifier({
  name: 'Iron Hide',
  transform: (action, ctx) =>
    action.direction !== 'incoming'
      ? action
      : gaugeTransform((prev) => (cur, max) => Math.max(prev(cur, max), cur - 50))(action, ctx),
});

// On turn start, if badly hurt, recover a little.
const secondWind = auto({
  name: 'Second Wind',
  event: 'turn:start',
  when: (ctx) => ctx.self.gauge('hp').current < ctx.self.gauge('hp').max * 0.4,
  cast: (ctx) => [heal(ctx.self.gauge('hp'), 12)],
});

// Every turn start, the player may ask an ally to rally (the player's `choose` picks one).
const rally = prompt({
  name: 'Rally',
  event: 'turn:start',
  prompt: () => ({ who: 'ally', count: 1 }),
  cast: (ctx, targeting) => [heal(targeting.targets[0]!.gauge('hp'), 6, ctx.self)],
});

// --- Goblin buffs ---

const thorns = buff({
  name: 'Thorns',
  weight: 2,
  abilities: [
    auto({
      name: 'Retaliation',
      event: 'gauge:changed',
      when: (ctx) => {
        if (!('source' in ctx.event)) return false;
        const source = ctx.event.source;
        return (
          wasTakenBy(ctx.event, ctx.self) &&
          source.type === 'character' &&
          source !== ctx.self
        );
      },
      targets: (ctx) => {
        if (!('source' in ctx.event)) return [];
        const source = ctx.event.source;
        return source.type === 'character' && source !== ctx.self ? [source] : [];
      },
      cast: (ctx, targeting) => {
        const attacker = targeting?.targets[0];
        return attacker ? [damage(attacker.gauge('hp'), 8, ctx.self)] : [];
      },
    }),
  ],
});

// Stacks at end of turn while wounded; each stack adds 5 outgoing damage.
// Transformers live on abilities — Berserk's is a passive action modifier.
const berserk = buff({
  name: 'Berserk',
  weight: 1,
  variables: () => ({ stacks: 0 }),
  abilities: [
    passiveActionModifier({
      name: 'Berserk Rage',
      transform: (action, ctx) =>
        action.direction !== 'outgoing'
          ? action
          : gaugeTransformCtx((prev, tctx) => (cur, max) => {
              const stacks = Number(tctx.status?.vars.stacks ?? 0);
              return prev(cur, max) - 5 * stacks;
            })(action, ctx),
    }),
    auto({
      name: 'Enrage',
      event: 'turn:end',
      when: (ctx) => ctx.self.gauge('hp').current < ctx.self.gauge('hp').max / 2,
      cast: (ctx) => {
        const stacks = ctx.self.findStatus('berserk')?.vars;
        if (stacks && typeof stacks.stacks === 'number') stacks.stacks += 1;
        return [];
      },
    }),
  ],
});

const headbutt = cast({
  name: 'Headbutt',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 25, ctx.self)], // lethal: HP
});

/* ------------------------------ setup ------------------------------ */

const engine = createEngine({
  onEvent: (event: GameEvent) => {
    if (isDamage(event) && event.target) {
      console.log(
        `   ${event.target.name} takes ${amountOf(event)} damage` +
          ('source' in event ? ` from ${event.source.name}` : ''),
      );
    } else if (isHeal(event) && event.target) {
      console.log(`   ${event.target.name} recovers ${amountOf(event)}`);
    } else if (event.type === 'character:destroyed') {
      console.log(`   💀 ${event.character.name} is defeated!`);
    } else if (event.type === 'gauge:maxChanged') {
      console.log(`   ${event.gauge.id} max changed ${event.from} -> ${event.to}`);
    }
  },
});

const hero = new Character('Hero', {
  maxHp: 100,
  maxMana: 100,
  skills: [
    skill({ name: 'Fighter', weight: 1, abilities: [strike, ironHide, secondWind, rally] }),
  ],
});
const goblin = new Character('Goblin Chieftain', {
  maxHp: 100,
  maxMana: 100,
  skills: [skill({ name: 'Chieftain', weight: 1, abilities: [headbutt] })],
});
hero.team = 'party';
goblin.team = 'monsters';

engine.registerCharacter(hero);
engine.registerCharacter(goblin);
await engine.addBuff(goblin, thorns);
await engine.addBuff(goblin, berserk);

/* ----------------------------- battle ------------------------------ */

console.log(`\n=== ${hero} vs ${goblin} ===`);
for (let round = 1; round <= 4 && !hero.isDefeated && !goblin.isDefeated; round++) {
  console.log(`\n--- Round ${round} ---`);
  await startTurn(engine);

  await engine.useAbility(hero, strike, { targets: [goblin] });
  if (!goblin.isDefeated) await engine.useAbility(goblin, headbutt, { targets: [hero] });

  await endTurn(engine);
  console.log(
    `   berserk stacks: ${goblin.findStatus('berserk')?.vars.stacks ?? 0} | ` +
      `hero hp: ${hero.gauge('hp').current}`,
  );
}

console.log('\n=== Final ===');
console.log(`  ${hero}`);
console.log(`  ${goblin}`);
console.log(`  Result: ${!hero.isDefeated && !goblin.isDefeated ? 'both alive' : hero.isDefeated ? 'Goblin wins' : 'Hero wins'}`);
