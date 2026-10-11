/**
 * Stamina — an **extra gauge** with a **conditional buff gate**
 * (docs/design/04-sba.md): while stamina is at 20% or below, a Tired buff
 * is attached (halving initiative via the derived-stat system); when
 * stamina recovers, the buff is removed. The engine never knows "stamina"
 * exists — it is just a Gauge carrying a GaugeBuffGate.
 *
 * Run with:  npm run example:stamina
 */
import { fileURLToPath } from 'node:url';
import {
  Character,
  Gauge,
  buff,
  stat,
} from '../games/turn-based/index.js';
import { createEngine } from '../games/turn-based/index.js';

const tired = buff({
  name: 'Tired',
  weight: 1,
  abilities: [stat({ name: 'Tired', stat: 'speed', multiply: 0.5 })],
});

const stamina = new Gauge('stamina', 100, {
  buffGates: [{ name: 'Tired Gate', when: (g) => g.current <= g.max * 0.2, buff: tired }],
});

const hero = new Character('Hero', { maxHp: 100, gauges: [stamina] });

/* ------------------------------ demo ------------------------------- */

if (isMain(import.meta.url)) {
  const { GameEngine, damage, heal } = await import('../engine/index.js');
  const engine = createEngine();
  // No players registered — the demo drives the engine directly, so gauge
  // writes never end the game.
  engine.registerCharacter(hero);

  console.log(`\n${hero.name} — speed ${hero.speed}, stamina ${stamina.current}/${stamina.max}`);
  console.log('  (no players: the game never ends while we poke the gauges)\n');

  // Sprint: burn 85 stamina — 15 left, below the 20% threshold.
  await engine.damage(stamina, 85, hero);
  console.log(`⚡ Sprint! stamina ${stamina.current}/${stamina.max}`);
  console.log(`   Tired attached: ${hero.hasStatus('tired')} — speed ${hero.speed} (halved by the stat ability)`);

  // Keep pushing while exhausted — the gate stays put (no re-application).
  await engine.damage(stamina, 10, hero);
  console.log(`⚡ Sprint again! stamina ${stamina.current}/${stamina.max} — still Tired: ${hero.hasStatus('tired')}`);

  // Catch your breath: back above 20% — the gate closes, the buff leaves.
  await engine.heal(stamina, 35, hero);
  console.log(`🌬️  Catch your breath! stamina ${stamina.current}/${stamina.max}`);
  console.log(`   Tired removed: ${!hero.hasStatus('tired')} — speed ${hero.speed} again`);

  console.log('\nDone.');
}

/** True when this module is the entry point (not imported by a test). */
function isMain(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  return fileURLToPath(importMetaUrl) === process.argv[1];
}
