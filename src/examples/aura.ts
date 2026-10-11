/**
 * Auras: an ability that applies a status to other characters matching a
 * condition — and the status it applies is **permanent**: it can never be
 * removed, but it still has a `weight` (sort order + action-pipeline order),
 * exactly like any other status.
 *
 * Run with:  npm run example:aura
 *
 * Two pieces:
 *
 * 1. The **mark** — a buff declared `removable: false`. It is applied at
 *    runtime like any buff, but every removal attempt (action, sugar, or
 *    `Character.removeBuff`) is a no-op. Its weight keeps it sorted in the
 *    target's status list and ordered in the action pipeline.
 *
 * 2. The **aura** — itself a buff (so it *can* be removed) whose `auto`
 *    ability listens to `turn:start` and applies the mark to every character
 *    that matches the condition (here: allies that are not already marked).
 *    The `match` is where a real aura's "who counts" lives; the engine's
 *    duplicate-buff guard keeps re-fires from stacking duplicates.
 *
 * The lifecycle: dispels bounce off the mark — but when the **aura** goes,
 * every mark it granted is destroyed with it (the engine's removal
 * cascade). That is the mark's only way out. The aura goes either when it
 * is removed (dispelled, stolen…) or when its wearer is **defeated**
 * (`removedOnDefeat` — the default — the aura fades with the paladin).
 * Note the direction: a buff is removed when the character it is *attached
 * to* falls; the *creator's* defeat leaves buffs on their targets alone.
 */
import {
  Character,
  GameEngine,
  addBuff,
  auto,
  buff,
  damage,
  gaugeTransform,
  passiveActionModifier,
  type GameEvent,
} from '../games/turn-based/index.js';
import { createEngine } from '../games/turn-based/index.js';
import { endTurn, startTurn } from '../games/round-based/index.js';

/* ----------------------------- content ----------------------------- */

// 1. The permanent mark. `removable: false` is the whole trick: applied at
//    runtime, never dispelled, still weighted (2 here — lower weights run
//    first in the pipeline). It can carry abilities like any other status.
const blessed = buff({
  name: 'Blessed',
  weight: 2,
  removable: false,
  abilities: [
    passiveActionModifier({
      name: 'Blessed Ward',
      // Incoming damage is capped at 3 per hit.
      transform: (action, ctx) =>
        action.direction !== 'incoming'
          ? action
          : gaugeTransform((prev) => (cur, max) => Math.max(prev(cur, max), cur - 3))(action, ctx),
    }),
  ],
});

// 2. The aura itself — a *buff*, so it can be removed (dispelled, stolen…).
//    Every turn start it marks each ally (except itself) that matches the
//    condition — here, any ally not carrying the mark yet. 'ally' includes
//    the owner, so the `match` excludes `ctx.self` ("other characters").
//
//    `removedOnDefeat: true` — the aura fades when the paladin falls, and
//    the cascade then destroys every mark it granted.
//
//    Note the cast applies the mark with **no explicit source**: the engine
//    then attributes the addBuff to this aura buff itself, which is what
//    links each mark back to its grantor — the link the removal cascade
//    follows. (A skill-aura variant — `skill` instead of `buff` — is a
//    permanent aura: it can never be removed, so its marks never die.)
const blessingAura = buff({
  name: 'Blessing Aura',
  weight: 1,
  removedOnDefeat: true,
  abilities: [
    auto({
      name: 'Bless the Faithful',
      event: 'turn:start',
      targeting: {
        who: 'ally',
        match: (ctx, c) => c !== ctx.self && !c.hasStatus('blessed'),
      },
      cast: (ctx, targeting) =>
        targeting ? targeting.targets.map((c) => addBuff(c, blessed)) : [],
    }),
  ],
});

/* ------------------------------ setup ------------------------------ */

const engine = createEngine({
  onEvent: (event: GameEvent) => {
    if (event.type === 'buff:added') {
      console.log(
        `   ${event.character.name} gains ${event.buff.name}` +
          (event.buff.removable ? '' : ' (permanent)'),
      );
    } else if (event.type === 'buff:destroyed') {
      console.log(`   ${event.character.name} loses ${event.buff.name}`);
    }
  },
});

const paladin = new Character('Paladin', { maxHp: 100, maxMana: 100 });
const squire = new Character('Squire', { maxHp: 50, maxMana: 50 });
const goblin = new Character('Goblin', { maxHp: 60, maxMana: 60 });
paladin.team = 'party';
squire.team = 'party';
goblin.team = 'monsters';

engine.registerCharacter(paladin);
engine.registerCharacter(squire);
engine.registerCharacter(goblin);

/* ----------------------------- battle ------------------------------ */

console.log('=== The paladin activates the aura ===');
await engine.addBuff(paladin, blessingAura); // arms the aura's trigger
await startTurn(engine); // turn:start -> the aura fires
console.log(`  ${squire.name} statuses: ${squire.statuses.map((s) => `${s.name} (weight ${s.weight})`).join(', ')}`);
console.log(`  ${paladin.name} statuses: ${paladin.statuses.map((s) => s.name).join(', ')}`);

console.log('\n=== The mark works (incoming damage capped at 3) ===');
await engine.damage(squire.gauge('hp'), 10, goblin);
console.log(`  ${squire} (10 damage -> capped to 3)`);

console.log('\n=== Dispels bounce off the mark… ===');
await engine.removeBuff(squire, 'blessed');
console.log(`  removeBuff(squire, 'blessed') -> still ${squire.hasStatus('blessed') ? 'present' : 'gone'}`);

console.log('\n=== …but removing the aura destroys the marks it granted ===');
await engine.removeBuff(paladin, 'blessing-aura');
console.log(`  ${squire.name} blessed: ${squire.hasStatus('blessed') ? 'still present' : 'destroyed with the aura'}`);
await engine.damage(squire.gauge('hp'), 10, goblin);
console.log(`  ${squire} (no longer capped)`);

console.log('\n=== The paladin falls: defeat fades the aura and its marks ===');
// A fresh scene (own team so the earlier aura cannot reach it).
const paladin2 = new Character('Paladin II', { maxHp: 100, maxMana: 100 });
const squire2 = new Character('Squire II', { maxHp: 50, maxMana: 50 });
paladin2.team = 'party-2';
squire2.team = 'party-2';
engine.registerCharacter(paladin2);
engine.registerCharacter(squire2);
await engine.addBuff(paladin2, blessingAura);
await startTurn(engine); // the aura marks Squire II (see the event log)
await engine.damage(paladin2.gauge('hp'), 100); // killing blow — HP is the life gauge
console.log(`  Paladin II defeated -> aura ${paladin2.hasStatus('blessing-aura') ? 'still present' : 'faded'}`);
console.log(`  ${squire2.name} blessed: ${squire2.hasStatus('blessed') ? 'still present' : 'destroyed with the aura'}`);

console.log('\n=== Final ===');
console.log(`  ${paladin}`);
console.log(`  ${squire}`);
console.log(`  ${goblin}`);
