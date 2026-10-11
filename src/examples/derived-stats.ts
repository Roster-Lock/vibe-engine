/**
 * stat — the ability that derives a named stat from a **function of the
 * game state**, written the way a content creator would.
 *
 * "The Ant Queen's toughness is equal to the number of creatures you
 * control" — the Magic-style derived stat. Here toughness is the **max
 * HP** (the life gauge): while the swarm lives, the Queen's max HP is the
 * swarm's size. Her power is derived too — it is her current HP, which the
 * swarm's size feeds. No action ever writes these values; they are
 * re-derived whenever the world changes.
 *
 * Run with:  npm run example:stat
 */
import {
  Character,
  GameEngine,
  Player,
  buff,
  cast,
  damage,
  destroy,
  skill,
  stat,
  type Decision,
  type GameEvent,
  type StatContext,
} from '../games/turn-based/index.js';
import { createEngine } from '../games/turn-based/index.js';

/* ----------------------------- content ----------------------------- */

// The swarm — every in-play character this creature's controller controls,
// except itself.
const swarmSize = (ctx: StatContext): number =>
  ctx.engine.registeredCharacters.filter(
    (c) => c !== ctx.self && c.controller === ctx.self.controller && ctx.engine.isInPlay(c),
  ).length;

// "Toughness is equal to the number of creatures you control": while this
// skill is attached (always — it is a skill), the Queen's max HP IS the
// swarm's size plus herself. A `value` function **replaces** the running
// value (MTG "equal to"); later contributions in weight order still
// rewrite it. The binding is the **gauge** — `gauge: 'hp'` derives the HP
// gauge's max, and the read is the gauge itself: `queen.gauge('hp').max`.
const swarmMind = skill({
  name: 'Swarm Mind',
  weight: 1,
  abilities: [
    stat({
      name: 'Swarm Mind',
      gauge: 'hp',
      value: (ctx) => swarmSize(ctx) + 1, // +1 for the Queen herself
    }),
  ],
});

// "Her power is equal to her current health" — a second derived stat, this
// one a buff so the example can attach and remove it. Because max HP is
// swarm-derived, her power follows the swarm too.
const bloodPrice = buff({
  name: 'Blood Price',
  weight: 2,
  abilities: [
    stat({
      name: 'Blood Price',
      stat: 'power',
      value: (ctx) => ctx.self.gauge('hp').current,
    }),
  ],
});

// A manual ability that reads the derived stat at cast time.
const swarmStrike = cast({
  name: 'Swarm Strike',
  description: 'deal damage to an enemy equal to your power',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), ctx.self.stat('power') ?? 0, ctx.self)],
});

const queen = new Character('Ant Queen', {
  maxHp: 1, // alone, she is a 1/1
  maxMana: 30,
  stats: { power: 1 }, // the base power — replaced by Blood Price while it is attached
  skills: [
    swarmMind,
    skill({ name: 'Command', weight: 3, abilities: [swarmStrike] }),
  ],
});

const droneA = new Character('Drone A', { maxHp: 2 });
const droneB = new Character('Drone B', { maxHp: 2 });
const wolf = new Character('Wolf', { maxHp: 6 });

/* ------------------------------ setup ------------------------------ */

const engine = createEngine({
  onEvent: (event: GameEvent) => {
    if (event.type === 'gauge:maxChanged') {
      console.log(`   📈 ${event.gauge.id} max ${event.from} → ${event.to}`);
    }
  },
});

// The controllers are stamped by hand — the "hive" player never registers,
// so the game cannot end mid-demo (win/lose needs registered players).
class Hive extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}
const hive = new Hive('Hive', [queen, droneA, droneB], 'hive');
for (const character of [queen, droneA, droneB]) {
  character.controller = hive;
}
for (const character of [queen, droneA, droneB, wolf]) {
  engine.registerCharacter(character);
}

/* ------------------------------ the show ---------------------------- */

const log = (line: string): void => console.log(line);

log(`Swarm: 2 drones. Queen max HP = ${queen.gauge('hp').max} (derived), power = ${queen.stat('power')} (base).`);

await engine.addBuff(queen, bloodPrice);
await engine.heal(queen.gauge('hp'), 99, queen); // fill her to her swarm-sized max — power follows
log(`Blood Price attached. Queen power = ${queen.stat('power')} (= her current HP).`);

log('');
log('A drone dies — the swarm shrinks, and the derived stats follow:');
await engine.apply([destroy(droneA)]);
log(`Swarm: 1 drone. Queen max HP = ${queen.gauge('hp').max}, power = ${queen.stat('power')} (current clamps down).`);

log('');
log('The Queen strikes — damage equal to her power:');
await engine.useAbility(queen, swarmStrike, { targets: [wolf] });
log(`Wolf HP: 6 → ${wolf.gauge('hp').current}.`);

log('');
log('The last drone dies — and the Queen shrinks to a lonely 1/1:');
await engine.apply([destroy(droneB)]);
log(`Swarm: none. Queen max HP = ${queen.gauge('hp').max}, power = ${queen.stat('power')} — she still stands.`);

log('');
log('Everything was derived — no action ever wrote a max or a stat.');

