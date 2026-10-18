/**
 * Characters showcasing the destroy / state-based-action work
 * (docs/design/02-destroy.md, 04-sba.md):
 *
 * - **Lich** — Void Bolt destroys a target *outright* (a `destroy` action,
 *   no HP check): the character lands in the graveyard with reason
 *   `direct-action`.
 * - **Warlord** — Battle Cry damages **every enemy at once**: one cast, a
 *   whole board wipe, simultaneous destruction + batch events.
 * - **Reaper** — Reap counts every death (a `character:destroyed` trigger),
 *   one stack per destroyed character.
 * - **Hag** — Curse of Frailty reduces a target's **max HP**; at 0 max
 *   HP the character is destroyed with reason `hp:maximum-reached-0`.
 * - **Martyr** — Sacrifice destroys *itself* (a self-targeted `destroy`
 *   action) to heal the whole party — a self-destruct that only ends the
 *   game if nobody else stands.
 */
import {
  Character,
  addBuff,
  auto,
  buff,
  cast,
  damage,
  destroy,
  heal,
  maxModifier,
  skill,
} from '../../games/turn-based/index.js';
import type { Character as CharacterType } from '../../games/turn-based/index.js';

/* ------------------------------- Lich -------------------------------- */

/** Void Bolt — destroy target enemy outright (direct-action destroy). */
export const voidBolt = cast({
  name: 'Void Bolt',
  description: 'destroy target enemy outright (no HP check)',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [destroy(targeting.targets[0]!, ctx.self)],
});

export function makeLich(): CharacterType {
  return new Character('Lich', {
    maxHp: 90,
    maxMana: 90,
    speed: 9,
    skills: [skill({ name: 'Necromancy', weight: 1, abilities: [voidBolt] })],
  });
}

/* ------------------------------ Warlord ------------------------------ */

/**
 * Battle Cry — 20 damage to every enemy at once. The cast computes the
 * enemy list itself (`engine.validTargets`), so a single cast can wipe a
 * whole board; every death lands in the same batch (simultaneous). The
 * damage hits **HP** — the life gauge — so it actually kills.
 */
export const battleCry = cast({
  name: 'Battle Cry',
  description: '20 damage to every enemy at once',
  targeting: { who: 'self', count: 1 },
  cast: (ctx) =>
    ctx.engine.validTargets({ who: 'enemy' }, ctx.self).map((enemy) => damage(enemy.gauge('hp'), 20, ctx.self)),
});

export function makeWarlord(): CharacterType {
  return new Character('Warlord', {
    maxHp: 120,
    maxMana: 120,
    speed: 8,
    skills: [skill({ name: 'Commander', weight: 1, abilities: [battleCry] })],
  });
}

/* ------------------------------- Reaper ------------------------------ */

/** Reap — one stack per destroyed character (any death, not just self). */
const reap = auto({
  name: 'Reap',
  event: 'character:destroyed',
  when: (ctx) => ctx.event.character !== ctx.self,
  cast: (ctx) => {
    const vars = ctx.self.findStatus('reaper')?.vars;
    if (vars && typeof vars.stacks === 'number') vars.stacks += 1;
    return [];
  },
});

export function makeReaper(): CharacterType {
  return new Character('Reaper', {
    maxHp: 80,
    maxMana: 80,
    speed: 7,
    skills: [
      skill({
        name: 'Harvester',
        weight: 1,
        variables: () => ({ stacks: 0 }),
        abilities: [reap],
      }),
    ],
  });
}

/* -------------------------------- Hag --------------------------------- */

/**
 * Frail — the buff behind Curse of Frailty. A gauge's max is **derived**,
 * never written: while this buff is attached, the wearer's max HP is
 * re-computed as `base - 30` per instance (clamped at 0), and dispelling
 * the curse reverts it automatically. HP is the life gauge, so when max
 * HP reaches 0, the character is destroyed — the
 * `hp:maximum-reached-0` destroy reason, with the max write in
 * `event.maxChanges`. `stacks: true` so repeated curses each land another
 * −30.
 */
export const frail = buff({
  name: 'Frail',
  weight: 1,
  abilities: [maxModifier({ name: 'Frail', add: -30, gauge: 'hp' })],
});

/**
 * Curse of Frailty — attach one Frail buff to an enemy: −30 max HP
 * (clamped at 0). When max HP reaches 0, the character is destroyed.
 */
export const curseOfFrailty = cast({
  name: 'Curse of Frailty',
  description: "reduce an enemy's max HP by 30 — at 0 max HP they are destroyed",
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => [
    addBuff(targeting.targets[0]!, frail, ctx.self),
  ],
});

export function makeHag(): CharacterType {
  return new Character('Hag', {
    maxHp: 70,
    maxMana: 70,
    speed: 11,
    skills: [skill({ name: 'Curses', weight: 1, abilities: [curseOfFrailty] })],
  });
}

/* ------------------------------- Martyr ------------------------------- */

/**
 * Sacrifice — destroy yourself and heal every ally for 25. The `destroy`
 * action lands in the same apply; the heal is a gauge write. Only ends the
 * game if the Martyr was the last character standing (win/lose-first).
 */
export const sacrifice = cast({
  name: 'Sacrifice',
  description: 'destroy yourself and heal every ally for 25',
  targeting: { who: 'self', count: 1 },
  cast: (ctx) => [
    destroy(ctx.self),
    ...ctx.engine
      .validTargets({ who: 'ally' }, ctx.self)
      .filter((ally) => ally !== ctx.self)
      .map((ally) => heal(ally.gauge('hp'), 25, ctx.self)),
  ],
});

export function makeMartyr(): CharacterType {
  return new Character('Martyr', {
    maxHp: 60,
    maxMana: 60,
    speed: 6,
    skills: [skill({ name: 'Faith', weight: 1, abilities: [sacrifice] })],
  });
}
