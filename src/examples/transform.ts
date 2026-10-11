/**
 * Transformations — the `transform` action and the form stack, written the
 * way a content creator would (docs/spec/03-actions.md §2.5,
 * docs/spec/04-character-status.md §6).
 *
 * Run with:  npm run example:transform
 *
 * A transform swaps a character's **form** — skills, gauge maxes (current
 * clamps down), name, icon — while the identity (the Character object)
 * never changes and buffs persist. Transforms stack, keyed by **source**:
 *
 * - a **buff** key pops its entry — reverting the form — when that buff is
 *   removed (dispelled, dies with its wearer, taken by the cascade);
 * - a **character** source (or no source) is a permanent transform.
 */
import {
  Character,
  GameEngine,
  addBuff,
  auto,
  buff,
  cast,
  damage,
  maxModifier,
  popTransform,
  removeBuff,
  skill,
  transform,
  transformModifier,
  type GameEvent,
} from '../games/turn-based/index.js';
import { createEngine } from '../games/turn-based/index.js';
import { endTurn, startTurn } from '../games/round-based/index.js';

/* ----------------------------- content ----------------------------- */

// A buff whose `buff:added` self-trigger transforms its own wearer. The
// transform is keyed by the buff instance — dispelling the curse reverts
// the form (and the Sheep skill leaves with it).
const polymorph = buff({
  name: 'Polymorph',
  weight: 1,
  abilities: [
    auto({
      name: 'Turn into Sheep',
      event: 'buff:added',
      when: (ctx) => ctx.event.buff.uid === ctx.status.uid,
      cast: (ctx) => [
        transform(ctx.self, {
          name: 'Sheep',
          // HP is the life gauge — a form with hp 0 would be dead on arrival.
          gauges: { hp: 5, mana: 5 },
          skills: [
            skill({
              name: 'Startled Bleat',
              weight: 1,
              abilities: [
                auto({
                  name: 'Bleat',
                  event: 'turn:start',
                  cast: (ctx) => [damage(ctx.self.gauge('hp'), 1)],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  ],
});

// A second form that can stack on top of the first — the last transform
// that names an aspect wins.
const giant = buff({
  name: 'Giant Form',
  weight: 1,
  abilities: [
    auto({
      name: 'Grow Giant',
      event: 'buff:added',
      when: (ctx) => ctx.event.buff.uid === ctx.status.uid,
      cast: (ctx) => [transform(ctx.self, { name: 'Giant Sheep', gauges: { hp: 30, mana: 30 } })],
    }),
  ],
});

// A permanent transform: cast by the Druid (a character source), so nothing
// pops it. It rewrites the base the statuses' maxModifiers derive from.
const wildShape = {
  name: 'Wild Shape',
  description: "become a Bear — +20 max HP, −10 mana, and a claw attack",
  form: {
    name: 'Bear',
    // base 40 − 10 (the description) — mana is a resource, not the life gauge.
    gauges: { hp: 120, mana: 30 },
    skills: [
      skill({
        name: 'Bear Claw',
        weight: 1,
        abilities: [
          auto({
            name: 'Claw',
            event: 'turn:start',
            cast: (ctx) => [damage(ctx.self.gauge('hp'), 0)], // (a real claw would target an enemy)
          }),
        ],
      }),
    ],
  },
};

const fortify = buff({
  name: 'Fortify',
  weight: 1,
  abilities: [maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 })],
});

// A hex: a buff **tied** to a transformation via `transformModifier`. While
// the buff is attached, its form *pins* the wearer — an opponent can push
// "Demon form" on a hexed hero, but the hex's form is what shows until the
// hex ends (then the Demon surfaces). Removing the buff reverts the hero.
const hex = buff({
  name: 'Hex',
  weight: 1,
  abilities: [
    transformModifier({
      name: 'Toad Form',
      form: { name: 'Toad', gauges: { hp: 5, mana: 5 } }, // a 0 hp max would kill on attach
    }),
  ],
});

// An opponent's direct undo: pop the current effective transformation. On a
// hexed hero this dispels the hex (the tie cannot dangle) — and the form
// the hex was suppressing surfaces.
const dispelForm = cast({
  name: 'Dispel Form',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [popTransform(targeting.targets[0]!, ctx.self)],
});

const exorcist = new Character('Exorcist', {
  maxHp: 60,
  maxMana: 60,
  skills: [skill({ name: 'Exorcisms', weight: 1, abilities: [dispelForm] })],
});

/* ------------------------------ setup ------------------------------ */

const engine = createEngine({
  onEvent: (event: GameEvent) => {
    if (event.type === 'gauge:maxChanged') {
      console.log(`   📈 ${event.gauge.id} max ${event.from} → ${event.to}`);
    } else if (event.type === 'character:transformed') {
      console.log(
        event.reason === 'pushed'
          ? `   🔮 ${event.character.name} transforms into ${event.form.name ?? 'a new form'}`
          : `   🔮 ${event.character.name} is no longer ${event.form.name ?? 'transformed'}`,
      );
    }
  },
});

const hero = new Character('Hero', { maxHp: 100, maxMana: 40 });
const druid = new Character('Druid', { maxHp: 80, maxMana: 80 });
engine.registerCharacter(hero);
engine.registerCharacter(druid);
engine.registerCharacter(exorcist);

/* ----------------------------- tour ------------------------------- */

console.log('=== 1. A buff-keyed transform: Polymorph (dispelling reverts) ===');
await engine.addBuff(hero, polymorph);
console.log(`  ${hero.name} (${hero}) — name swapped, max 100 → 5, current clamped to 5`);
await startTurn(engine); // the Sheep's own skill fires
console.log(`  Sheep's own skill is live: ${hero} (Startled Bleat bit itself)`);
await engine.removeBuff(hero, 'polymorph');
console.log(`  dispelled → back to ${hero.name} (${hero}) — max 100, current stays ${hero.gauge('hp').current} (no refill)`);

console.log('\n=== 2. Transforms stack — the last transform that names an aspect wins ===');
await engine.addBuff(hero, polymorph);
console.log(`  ${hero.name} (max ${hero.gauge('hp').max}) — polymorph again`);
await engine.addBuff(hero, giant);
console.log(`  ${hero.name} (max ${hero.gauge('hp').max}) — Giant Form on top: name and max are the Giant Sheep\'s`);
await engine.removeBuff(hero, 'giant-form');
console.log(`  dispel Giant Form → ${hero.name} (max ${hero.gauge('hp').max}) — back to the Sheep`);
await engine.removeBuff(hero, 'polymorph');
console.log(`  dispel Polymorph → ${hero.name} (max ${hero.gauge('hp').max}) — fully reverted`);

console.log('\n=== 3. A permanent transform (character source) ===');
console.log('  The Druid wild-shapes the Hero — a permanent form:');
await engine.apply([transform(hero, wildShape.form)], { source: druid });
console.log(`  ${hero.name} (max ${hero.gauge('hp').max}, mana ${hero.gauge('mana').max}) — nothing pops a character key`);
console.log('  …and Fortify (+50) now rewrites the *transformed* base: 120 + 50 =');
await engine.addBuff(hero, fortify);
console.log(`  ${hero.gauge('hp').max} — maxModifier contributions compose over the form`);

console.log('\n=== 4. A hex tie pins the form — the hex holds ===');
const squire = new Character('Squire', { maxHp: 100, maxMana: 100 });
engine.registerCharacter(squire);
await engine.addBuff(squire, hex);
console.log(`  ${squire.name} (max ${squire.gauge('hp').max}) — the hex ties the Squire to a Toad form`);
console.log('  An opponent pushes "Demon form" on the hexed Squire…');
await engine.apply([transform(squire, { name: 'Demon', gauges: { hp: 200, mana: 200 } })]);
console.log(`  …but the hex holds: still ${squire.name} (max ${squire.gauge('hp').max}) — the attempt is recorded underneath`);
console.log('  Dispelling the hex releases the pinned form:');
await engine.removeBuff(squire, 'hex');
console.log(`  ${squire.name} (max ${squire.gauge('hp').max}) — the suppressed Demon surfaces`);

console.log('\n=== 5. The popTransform action — an opponent pops the form directly ===');
await engine.addBuff(squire, hex);
console.log(`  Hexed again: ${squire.name} (max ${squire.gauge('hp').max})`);
console.log('  The Exorcist tries to pop the hexed Squire…');
await engine.useAbility(exorcist, dispelForm, { targets: [squire] });
console.log(`  …but the hex holds: still ${squire.name} (max ${squire.gauge('hp').max}) — a live tie refuses the pop; only removing the hex works`);
await engine.removeBuff(squire, 'hex');
console.log(`  Dispelling the hex: ${squire.name} (max ${squire.gauge('hp').max}) — the suppressed Demon surfaces`);
console.log('  Now — with no tie — popping works:');
await engine.useAbility(exorcist, dispelForm, { targets: [squire] });
console.log(`  ${squire.name} (max ${squire.gauge('hp').max}) — the Demon form was popped, back to the base form`);

console.log('\nDone.');
