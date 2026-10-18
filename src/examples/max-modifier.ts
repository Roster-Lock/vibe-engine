/**
 * maxModifier — the ability that changes a gauge's **maximum**, written the
 * way a content creator would: a declarative contribution riding on a buff
 * or a skill.
 *
 * A gauge's maximum is never set by an **action** — it is **derived** from
 * the wearer's base max plus the `maxModifier` contributions of every
 * attached status, applied in ascending weight order (like any
 * transformer). Adding a buff applies its contribution; **any removal
 * reverts it automatically**.
 *
 * Run with:  npm run example:max
 *
 * Each modifier rewrites the running max as `max = max * multiply + add`.
 * Weight decides the order — a `+50` then a `×1.5 + 50` gives a different
 * total than the same two in the opposite order.
 */
import {
  Character,
  GameEngine,
  addBuff,
  buff,
  cast,
  maxModifier,
  removeBuff,
  skill,
  type GameEvent,
} from '../games/turn-based/index.js';
import { createEngine } from '../games/turn-based/index.js';

/* ----------------------------- content ----------------------------- */

// A buff that adds 50 to the wearer's max HP while it is attached — the
// natural reading of "your max HP is boosted".
const fortify = buff({
  name: 'Fortify',
  weight: 1,
  abilities: [maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 })],
});

// A second buff that also multiplies — stacked with Fortify, the weights
// decide the total (1 then 2 above).
const giantBlood = buff({
  name: 'Giant Blood',
  weight: 2,
  abilities: [maxModifier({ gauge: 'hp', name: 'Giant Blood', multiply: 1.5, add: 50 })],
});

// A curse is just a *negative* maxModifier buff. `stacks: true` lets it be
// cast repeatedly — each cast lands another −30. HP is the life gauge, so
// this curse wipes **max HP**: driving it to 0 destroys the character
// (`hp:maximum-reached-0`).
const frail = buff({
  name: 'Frail',
  weight: 1,
  abilities: [maxModifier({ name: 'Frail', add: -30, gauge: 'hp' })],
});

// The Hag's manual ability: curses an enemy with one Frail instance.
const weaken = cast({
  name: 'Curse of Frailty',
  description: "reduce an enemy's max HP by 30 (at 0 max HP they are destroyed)",
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [addBuff(targeting.targets[0]!, frail, ctx.self)],
});

const hag = new Character('Hag', {
  maxHp: 60,
  maxMana: 60,
  skills: [skill({ name: 'Curses', weight: 1, abilities: [weaken] })],
});

/* ------------------------------ setup ------------------------------ */

const engine = createEngine({
  onEvent: (event: GameEvent) => {
    if (event.type === 'gauge:maxChanged') {
      console.log(`   📈 ${event.gauge.id} max ${event.from} → ${event.to}`);
    }
  },
});

const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
const goblin = new Character('Goblin', { maxHp: 40, maxMana: 40 });
engine.registerCharacter(hero);
engine.registerCharacter(goblin);
engine.registerCharacter(hag);

/* ----------------------------- tour ------------------------------- */

console.log('=== 1. A maxModifier buff re-derives the wearer\'s max ===');
await engine.addBuff(hero, fortify);
console.log(`  ${hero}  (100 → 150: base 100 + Fortify's 50; raising max never refills the gauge)`);

console.log('\n=== 2. Weighted composition: Fortify (+50) then Giant Blood (×1.5 + 50) ===');
await engine.addBuff(hero, giantBlood);
// (100 + 50) × 1.5 + 50 = 275
console.log(`  ${hero}  (150 → 275: (100 + 50) × 1.5 + 50)`);
console.log('  (swap the weights and the total changes — order matters, as with any modifier)');

console.log('\n=== 3. Removing a buff reverts its contribution automatically ===');
await engine.removeBuff(hero, 'fortify');
// Only Giant Blood left: 100 × 1.5 + 50 = 200
console.log(`  ${hero}  (275 → 200: only Giant Blood left — 100 × 1.5 + 50)`);

console.log('\n=== 4. A curse is just a negative maxModifier buff ===');
console.log('  The Hag curses the full Goblin (max HP −30, clamped at 0)…');
await engine.useAbility(hag, weaken, { targets: [goblin] });
console.log(`  ${goblin.name}: hp max 40 → ${goblin.gauge('hp').max}, current clamps 40 → ${goblin.gauge('hp').current}`);
console.log('  …and a second curse drives hp max to 0 — the Goblin is destroyed.');
await engine.useAbility(hag, weaken, { targets: [goblin] });
console.log(`  destroyed: ${goblin.destroyed} | hp max ${goblin.gauge('hp').max} (10 − 30 → clamped at 0)`);

console.log('\n=== 5. Lowering max clamps current down; removing the curse lifts the clamp ===');
const squire = new Character('Squire', { maxHp: 40, maxMana: 40 });
engine.registerCharacter(squire);
await engine.addBuff(squire, frail);
console.log(`  ${squire.name}: hp max 40 → ${squire.gauge('hp').max}, current clamps 40 → ${squire.gauge('hp').current}`);
await engine.removeBuff(squire, 'frail');
console.log(`  ${squire.name}: hp max back to ${squire.gauge('hp').max}; current stays ${squire.gauge('hp').current} — raising max never refills`);

console.log('\nDone.');
