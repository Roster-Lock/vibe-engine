/**
 * The destroy/SBA showcase — a scripted tour of what the engine can do now:
 *
 *   npx tsx src/examples/08-28-2026/demo.ts   (or: npm run example:destroy)
 *
 * Stages:
 *   A. direct destroy (Void Bolt) — a `destroy` action, graveyard move,
 *      `reason: 'direct-action'`, and corpse-proof targeting;
 *   B. board wipe (Battle Cry) — every enemy dies *simultaneously* in one
 *      cast: per-character events + `character:destroyed:batch`, a survivor
 *      + `character:survived:batch`, and a batch trigger (Soul Harvest)
 *      healing once for the whole wipe;
 *   C. death trigger with a reason (Grave Pact) — the killer is found from
 *      `changes` / `source`; the curse fires only because the death did not
 *      end the game (win/lose resolves first);
 *   D. content SBA rule (Pact of Power) — `addStateBasedRule` ends the game
 *      at the win/lose layer when a continuous condition holds.
 *   E. max-HP wipe (Curse of Frailty) — max HP driven to 0 destroys the
 *      character (`reason: 'hp:maximum-reached-0'`).
 *   F. corpse traps explode inside a wipe (queued buff:destroyed triggers).
 *   G. self-destruct (Sacrifice) — a self-targeted `destroy` action.
 *   H. destroy listeners — Doom Clock (countdown that removes itself at
 *      zero), Cursed Shield (backlash on the dispelling character), Blood
 *      Tether / Leash (backlash on the destroying buff's creator / wearer),
 *      and per-instance triggers (Trap Mine: each stacked copy has its own
 *      `uid`, so removing one detonates only that copy).
 */
import {
  Character,
  GameEndInterrupt,
  GameEngine,
  Player,
  auto,
  buff,
  removeBuff,
  win,
  type Decision,
  type GameEvent,
} from '../../games/turn-based/index.js';
import {
  battleCry,
  curseOfFrailty,
  makeHag,
  makeLich,
  makeMartyr,
  makeReaper,
  makeWarlord,
  sacrifice,
  voidBolt,
} from './characters.js';
import {
  bloodTether,
  corpseTrap,
  cursedShield,
  doomClock,
  gravePact,
  leash,
  soulHarvest,
  trapMine,
} from './buffs.js';
import { endTurn, startTurn } from '../../games/round-based/index.js';
import { createEngine } from '../../games/turn-based/index.js';

/** A player that never acts on its own (the demo drives every move). */
class Silent extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

function player(name: string, characters: Character[], team?: string): Silent {
  return new Silent(name, characters, team);
}

/** Logs the events the new machinery produces. */
function logEvent(event: GameEvent): void {
  switch (event.type) {
    case 'gauge:changed':
      if ('target' in event && event.gauge === event.target.gauge('hp')) {
        if (event.to < event.from) {
          console.log(`   ⚔️  ${event.target.name} takes ${event.from - event.to} damage`);
        } else if (event.to > event.from) {
          console.log(`   ✚ ${event.target.name} recovers ${event.to - event.from}`);
        }
      }
      break;
    case 'character:destroyed':
      console.log(
        `   💀 ${event.character.name} destroyed (reason: ${event.reason}` +
          ('maxChanges' in event ? `, max ${event.maxChanges.map((c) => `${c.from}→${c.to}`).join(', ')}` : '') +
          ')',
      );
      break;
    case 'character:destroyed:batch':
      console.log(
        `   💀💀 BATCH: ${event.events.length} destroyed in one wipe — ${event.events.map((c) => c.character.name).join(', ')}`,
      );
      break;
    case 'character:survived':
      console.log(`   🛡️  ${event.character.name} survives the hit`);
      break;
    case 'character:survived:batch':
      console.log(`   🛡️🛡️ BATCH: ${event.events.length} survive — ${event.events.map((c) => c.character.name).join(', ')}`);
      break;
    case 'buff:destroyed':
      console.log(
        `   🧨 ${event.buff.name} destroyed on ${event.character.name} (reason: ${event.reason}` +
          ('source' in event ? `, by ${event.source.name}` : '') +
          ')',
      );
      break;
  }
}

/* --------------------------- Stage A: destroy ------------------------ */

async function stageDirectDestroy(): Promise<void> {
  console.log('\n=== Stage A — direct destroy (Void Bolt) ===');
  const lich = makeLich();
  const goblin = new Character('Goblin', { maxHp: 40, maxMana: 40 });
  const shaman = new Character('Shaman', { maxHp: 40, maxMana: 40 });
  const engine = createEngine({ onEvent: logEvent });
  engine.registerPlayers([player('Party', [lich], 'party'), player('Monsters', [goblin, shaman], 'monsters')]);

  console.log('  Lich casts Void Bolt on Goblin… (no mana check — a destroy action)');
  await engine.useAbility(lich, voidBolt, { targets: [goblin] });

  console.log(`  → goblin destroyed: ${goblin.destroyed} | in graveyard: ${!engine.isInPlay(goblin)}`);
  console.log(`  → graveyard: ${engine.graveyard.map((c) => c.name).join(', ') || '(empty)'}`);
  console.log(
    `  → Lich can still target: ${engine.validTargets({ who: 'enemy' }, lich).map((c) => c.name).join(', ')}` +
      '  (corpses are never targetable)',
  );
}

/* ------------------------ Stage B: board wipe ------------------------ */

async function stageBoardWipe(): Promise<void> {
  console.log('\n=== Stage B — board wipe (Battle Cry) ===');
  const warlord = makeWarlord();
  warlord.gauge('hp').current = 100; // pre-damaged so Soul Harvest's heal is visible
  const m1 = new Character('Minion A', { maxHp: 20, maxMana: 20 });
  const m2 = new Character('Minion B', { maxHp: 20, maxMana: 20 });
  const m3 = new Character('Minion C', { maxHp: 50, maxMana: 50 }); // survives the 20-damage cry
  const engine = createEngine({ onEvent: logEvent });
  engine.registerPlayers([player('Party', [warlord], 'party'), player('Horde', [m1, m2, m3], 'monsters')]);
  await engine.addBuff(warlord, soulHarvest);

  console.log('  Warlord roars: Battle Cry (20 HP — life — to every enemy at once)');
  await engine.useAbility(warlord, battleCry, { targets: [warlord] });

  console.log(`  → destroyed together: ${[m1, m2].filter((m) => !engine.isInPlay(m)).map((m) => m.name).join(', ')}`);
  console.log(`  → survivor: ${engine.isInPlay(m3) ? m3.name : '(none)'}`);
  console.log(
    `  → Soul Harvest (batch trigger) healed the Warlord once for the whole wipe: ${warlord.gauge('hp').current - 100} HP healed → ${warlord.gauge('hp').current}/120`,
  );
}

/* ------------------- Stage C: death trigger + reason ----------------- */

async function stageGravePact(): Promise<void> {
  console.log('\n=== Stage C — death trigger reads the destroy reason (Grave Pact) ===');
  const reaper = makeReaper();
  const ally = new Character('Ally', { maxHp: 100, maxMana: 100 });
  const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
  const engine = createEngine({ onEvent: logEvent });
  engine.registerPlayers([player('Party', [reaper, ally], 'party'), player('Monsters', [goblin], 'monsters')]);
  await engine.addBuff(reaper, gravePact);

  console.log('  Goblin strikes the Reaper down (999 HP damage)…');
  await engine.damage(reaper.gauge('hp'), 999, goblin);

  console.log(`  → reaper destroyed (reason: hp:current-reached-minimum); killer found in changes`);
  console.log(`  → Grave Pact cursed the killer: goblin at ${goblin.gauge('hp').current}/100`);
  console.log('  (the curse fired because the death did NOT end the game — win/lose resolves first)');
}

/* ------------------------ Stage D: content SBA ----------------------- */

async function stageStateBasedRule(): Promise<void> {
  console.log('\n=== Stage D — content state-based rule (Pact of Power) ===');
  const lich = makeLich();
  const goblin = new Character('Goblin', { maxHp: 40, maxMana: 40 });
  const shaman = new Character('Shaman', { maxHp: 40, maxMana: 40 });
  const partyP = player('Party', [lich], 'party');
  const monstersP = player('Monsters', [goblin, shaman], 'monsters');
  const engine = createEngine({ onEvent: logEvent });
  engine.registerPlayers([partyP, monstersP]);

  // Nine sigils on the Lich (the rule is registered *after* — rules check at settles).
  for (let i = 0; i < 9; i++) {
    await engine.addBuff(lich, buff({ name: `Sigil ${i + 1}`, weight: 1 }));
  }
  engine.addStateBasedRule({
    name: 'Pact of Power',
    when: (e) => e.registeredCharacters.reduce((n, c) => n + c.buffs.length, 0) > 8,
    then: () => [win('party')],
  });

  console.log('  The Lich holds 9 sigils; the Pact fires on the next settle (a single poke)…');
  let winners: string[] = [];
  try {
    await engine.damage(goblin.gauge('hp'), 1, lich);
  } catch (error) {
    if (error instanceof GameEndInterrupt) winners = error.winners.map((w) => w.name);
  }
  console.log(`  → game ended at the win/lose layer: ${winners.join(', ')} win (Pact of Power)`);
}

/* ------------------------ Stage E: max-HP wipe ----------------------- */

async function stageMaxWipe(): Promise<void> {
  console.log('\n=== Stage E — max-HP wipe (Curse of Frailty) ===');
  const hag = makeHag();
  const goblin = new Character('Goblin', { maxHp: 40, maxMana: 40 });
  const shaman = new Character('Shaman', { maxHp: 40, maxMana: 40 });
  const engine = createEngine({ onEvent: logEvent });
  engine.registerPlayers([player('Party', [hag], 'party'), player('Monsters', [goblin, shaman], 'monsters')]);

  console.log('  Hag curses the Goblin: max HP 40 → 10 → 0…');
  await engine.useAbility(hag, curseOfFrailty, { targets: [goblin] }); // 40 → 10 (clamped)
  await engine.useAbility(hag, curseOfFrailty, { targets: [goblin] }); // 10 → 0 → destroyed

  console.log(`  → goblin destroyed: ${goblin.destroyed} | max HP now ${goblin.gauge('hp').max}`);
  console.log(`  → destroy reason: hp:maximum-reached-0 (event.maxChanges carries the max writes)`);
}

/* ------------------- Stage F: corpse trap during a wipe -------------- */

async function stageCorpseTrap(): Promise<void> {
  console.log('\n=== Stage F — corpse traps explode inside a wipe ===');
  const warlord = makeWarlord();
  const m1 = new Character('Minion A', { maxHp: 20, maxMana: 20 });
  const m2 = new Character('Minion B', { maxHp: 20, maxMana: 20 });
  const m3 = new Character('Minion C', { maxHp: 50, maxMana: 50 }); // survives — keeps the game going
  const engine = createEngine({ onEvent: logEvent });
  engine.registerPlayers([player('Party', [warlord], 'party'), player('Horde', [m1, m2, m3], 'monsters')]);
  await engine.addBuff(m1, corpseTrap);
  await engine.addBuff(m2, corpseTrap);

  console.log('  Two minions carry corpse traps; Warlord roars (a third minion survives the cry)…');
  await engine.useAbility(warlord, battleCry, { targets: [warlord] });

  console.log(`  → warlord at ${warlord.gauge('hp').current}/120 — each trap dealt 12 during the destroy phase`);
  console.log('  (the traps fire at the drain (queued triggers), after the character:destroyed events)');
}

/* --------------------------- Stage G: martyr -------------------------- */

async function stageMartyr(): Promise<void> {
  console.log('\n=== Stage G — self-destruct (Sacrifice) ===');
  const martyr = makeMartyr();
  const ally = new Character('Ally', { maxHp: 50, maxMana: 50 });
  ally.gauge('hp').current = 30;
  const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
  const engine = createEngine({ onEvent: logEvent });
  engine.registerPlayers([player('Party', [martyr, ally], 'party'), player('Monsters', [goblin], 'monsters')]);
  await engine.addBuff(martyr, corpseTrap);

  console.log('  Martyr sacrifices itself: destroy self + heal the party…');
  await engine.useAbility(martyr, sacrifice, { targets: [martyr] });

  console.log(`  → martyr destroyed by its own action; ally healed to ${ally.gauge('hp').current}/50`);
  console.log(`  → the corpse trap exploded on the martyr's own destruction: goblin at ${goblin.gauge('hp').current}/100`);
  console.log('  (the game continued — the ally still stands; win/lose resolves first)');
}

/* -------------------- Stage H: destroy listeners --------------------- */

/**
 * A buff whose ability removes enemy buffs at every turn start — the
 * "buff's action" path: the removals are attributed to this aura, so a
 * destroyed buff sees it (a `Buff`) as its destroyer.
 */
const purgeAura = buff({
  name: 'Purge Aura',
  weight: 1,
  abilities: [
    auto({
      name: 'Purge',
      event: 'turn:start',
      targets: (ctx) => ctx.engine.validTargets({ who: 'enemy' }, ctx.self),
      cast: (ctx, targeting) =>
        (targeting?.targets ?? []).flatMap((c) => c.buffs.map((b) => removeBuff(c, b))),
    }),
  ],
});

async function stageDestroyListeners(): Promise<void> {
  console.log('\n=== Stage H — destroy listeners (Doom Clock, Cursed Shield, Blood Tether, Leash) ===');

  // H1 — Doom Clock: a countdown that destroys itself at zero.
  console.log('  H1. Doom Clock on the Goblin (3 ticks)…');
  const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
  const goblin = new Character('Goblin', { maxHp: 40, maxMana: 40 });
  const engine = createEngine({ onEvent: logEvent });
  engine.registerPlayers([player('Party', [hero], 'party'), player('Monsters', [goblin], 'monsters')]);
  await engine.addBuff(goblin, doomClock);
  await startTurn(engine); // 3 → 2
  await startTurn(engine); // 2 → 1
  console.log(`  → after two turns the clock still ticks: ${goblin.hasStatus('doom-clock') ? 'yes' : 'no'}`);
  await startTurn(engine); // 1 → 0 → destroy self
  console.log(`  → at the third turn start it reached zero and removed itself: ${goblin.hasStatus('doom-clock') ? 'still there' : 'gone'}`);

  // H2 — Cursed Shield: destroyed by a player's character → that character pays.
  console.log('\n  H2. Hero dispels the Goblin\'s Cursed Shield…');
  const hero2 = new Character('Hero', { maxHp: 100, maxMana: 100 });
  const goblin2 = new Character('Goblin', { maxHp: 40, maxMana: 40 });
  const shaman2 = new Character('Shaman', { maxHp: 40, maxMana: 40 });
  const engine2 = createEngine({ onEvent: logEvent });
  engine2.registerPlayers([
    player('Party', [hero2], 'party'),
    player('Monsters', [goblin2, shaman2], 'monsters'),
  ]);
  await engine2.addBuff(goblin2, cursedShield);
  await engine2.removeBuff(goblin2, 'cursed-shield', hero2); // a player's action
  console.log(`  → the shield bit the dispeller: hero at ${hero2.gauge('hp').current}/100 (12 backlash)`);

  // H3 — Blood Tether + Leash: destroyed by a buff's action → the
  //     destroyer's creator (Hero, who cast the aura) and wearer (Lich,
  //     who wears it) each take the backlash.
  console.log('\n  H3. A Purge Aura (cast by the Hero onto the Lich) purges the Shaman\'s tether and leash…');
  const hero3 = new Character('Hero', { maxHp: 100, maxMana: 100 });
  const lich = new Character('Lich', { maxHp: 80, maxMana: 80 });
  const shaman3 = new Character('Shaman', { maxHp: 60, maxMana: 60 });
  const engine3 = createEngine({ onEvent: logEvent });
  engine3.registerPlayers([
    player('Party', [hero3, lich], 'party'),
    player('Monsters', [shaman3], 'monsters'),
  ]);
  await engine3.addBuff(shaman3, bloodTether);
  await engine3.addBuff(shaman3, leash);
  await engine3.addBuff(lich, purgeAura, hero3); // creator: Hero, wearer: Lich
  await startTurn(engine3); // the aura's trigger removes both enemy buffs
  console.log(`  → Blood Tether cursed the destroyer's creator: hero at ${hero3.gauge('hp').current}/100`);
  console.log(`  → Leash cursed the destroyer's wearer: lich at ${lich.gauge('hp').current}/80`);

  // H4 — per-instance triggers: each buff has a unique `uid`; a stacked
  // bomb's self-trigger matches its own instance, so removing ONE copy
  // detonates only that copy (the id-based filter would set off every copy).
  console.log('\n  H4. Two stacked Trap Mines on the Goblin; Hero removes one…');
  const hero4 = new Character('Hero', { maxHp: 100, maxMana: 100 });
  const goblin4 = new Character('Goblin', { maxHp: 40, maxMana: 40 });
  const shaman4 = new Character('Shaman', { maxHp: 40, maxMana: 40 });
  const engine4 = createEngine({ onEvent: logEvent });
  engine4.registerPlayers([
    player('Party', [hero4], 'party'),
    player('Monsters', [goblin4, shaman4], 'monsters'),
  ]);
  await engine4.addBuff(goblin4, trapMine);
  await engine4.addBuff(goblin4, trapMine);
  const mineA = goblin4.buffs[0]!;
  const mineB = goblin4.buffs[1]!;
  console.log(`  → two mines armed: ${mineA.uid} and ${mineB.uid}`);
  await engine4.removeBuff(goblin4, mineA); // dispel exactly this instance
  console.log(`  → one detonation (10 damage): goblin at ${goblin4.gauge('hp').current}/40`);
  console.log(`  → the other copy is still armed: ${goblin4.hasStatus('trap-mine') ? mineB.uid : 'gone'}`);
}

/* ------------------------------- main -------------------------------- */

export async function runDemo(): Promise<void> {
  console.log('TinyQuest — the destroy/SBA showcase (docs/design/02, 04)');
  await stageDirectDestroy();
  await stageBoardWipe();
  await stageGravePact();
  await stageStateBasedRule();
  await stageMaxWipe();
  await stageCorpseTrap();
  await stageMartyr();
  await stageDestroyListeners();
  console.log('\nDone.');
}

// Runnable directly:  npx tsx src/examples/08-28-2026/demo.ts
import { pathToFileURL } from 'node:url';
const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) await runDemo();
