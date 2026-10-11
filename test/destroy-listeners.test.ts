/**
 * The destroy-listener buffs (src/examples/08-28-2026/buffs.ts):
 *
 * - **doomClock** — a turn-start countdown that destroys itself at zero;
 * - **cursedShield** — destroys its dispeller when a *player's character*
 *   removes it (`buff:destroyed` with a `Character` source);
 * - **bloodTether** / **leash** — when a *buff's action* destroys them, deal
 *   damage to the destroying buff's **creator** (`caster`) / **wearer**
 *   (`target`).
 *
 * The attribution rules these rely on (docs/design/02-destroy.md): a buff
 * removed by a skill or direct action carries the acting `Character` as its
 * `buff:destroyed` source; a removal produced by a buff's own ability is
 * attributed to that buff (a `Buff` source); a buff that dies with its
 * wearer carries `reason: 'wearer-destroyed'` and no source.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  Player,
  auto,
  buff,
  removeBuff,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { bloodTether, cursedShield, doomClock, leash, trapMine } from '../src/examples/08-28-2026/buffs.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';

/** A player that never acts on its own. */
class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

function char(name: string, maxHp: number): Character {
  // HP is the life gauge: every character here gets a full mana pool
  // (maxMana equal to maxHp, harmless) so the tests only need to talk about
  // HP damage to defeat or destroy anyone.
  return new Character(name, { maxHp, maxMana: maxHp });
}

function player(name: string, characters: Character[], team?: string): TestPlayer {
  return new TestPlayer(name, characters, team);
}

function makeEngine(players: TestPlayer[], onEvent?: (e: GameEvent) => void): GameEngine {
  const engine = createEngine(onEvent ? { onEvent } : {});
  engine.registerPlayers(players);
  return engine;
}

/** A buff whose own ability removes every enemy buff at each turn start. */
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

describe('doomClock — turn-start countdown that destroys itself at zero', () => {
  it('ticks at each turn:start and removes itself when the count reaches zero', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 40);
    const shaman = char('Shaman', 40);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Party', [hero], 'party'), player('Monsters', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );

    await engine.addBuff(goblin, doomClock);
    expect(goblin.findStatus('doom-clock')!.vars.ticks).toBe(3);

    await startTurn(engine);
    expect(goblin.findStatus('doom-clock')!.vars.ticks).toBe(2);
    await startTurn(engine);
    expect(goblin.findStatus('doom-clock')!.vars.ticks).toBe(1);

    // The third turn start reaches zero: the clock removes itself.
    await startTurn(engine);
    expect(goblin.hasStatus('doom-clock')).toBe(false);

    // Expiry is announced as a removal, attributed to the clock itself (a
    // buff's own trigger is the source of its actions).
    const destroyed = events.find(
      (e): e is Extract<GameEvent, { type: 'buff:destroyed' }> => e.type === 'buff:destroyed',
    );
    expect(destroyed?.reason).toBe('removed');
    expect(destroyed && 'source' in destroyed ? destroyed.source.type : undefined).toBe('buff');
    expect(destroyed && 'source' in destroyed ? destroyed.source.name : undefined).toBe('Doom Clock');
  });

  it('a wearer that never sees another turn start keeps its clock', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 40);
    const shaman = char('Shaman', 40);
    const engine = makeEngine([
      player('Party', [hero], 'party'),
      player('Monsters', [goblin, shaman], 'monsters'),
    ]);
    await engine.addBuff(goblin, doomClock);

    // No turn starts — only the goblin's own death ends the clock. A lethal
    // HP blow kills the wearer, and the clock dies with it.
    await engine.damage(goblin.gauge('hp'), 999, hero);
    expect(goblin.hasStatus('doom-clock')).toBe(false); // died with its wearer
  });
});

describe('cursedShield — backlash against the dispelling character', () => {
  it('deals 12 damage to the character whose action removed it', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 40);
    const shaman = char('Shaman', 40);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Party', [hero], 'party'), player('Monsters', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );

    await engine.addBuff(goblin, cursedShield);
    await engine.removeBuff(goblin, 'cursed-shield', hero); // a player's action

    expect(hero.gauge('hp').current).toBe(88);
    // The backlash is attributed to the shield itself, like a corpse trap.
    const hit = events.find(
      (e): e is Extract<GameEvent, { type: 'gauge:changed' } & { target: Character }> =>
        e.type === 'gauge:changed' && 'target' in e && e.target === hero,
    );
    expect(hit && 'source' in hit ? hit.source.type : undefined).toBe('buff');
  });

  it('does not fire when a buff removes it — only a player\'s character pays', async () => {
    const hero = char('Hero', 100);
    const lich = char('Lich', 80);
    const goblin = char('Goblin', 40);
    const shaman = char('Shaman', 40);
    const engine = makeEngine([
      player('Party', [hero, lich], 'party'),
      player('Monsters', [goblin, shaman], 'monsters'),
    ]);

    // A buff's action (the aura's trigger) purges the shield: a `Buff`
    // source, so the shield stays quiet.
    await engine.addBuff(goblin, cursedShield);
    await engine.addBuff(lich, purgeAura, hero);
    await startTurn(engine);
    expect(goblin.hasStatus('cursed-shield')).toBe(false);
    expect(hero.gauge('hp').current).toBe(100);
  });

  it('does not fire when it dies with its wearer (reason: wearer-destroyed)', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 40);
    const shaman = char('Shaman', 40);
    const engine = makeEngine([
      player('Party', [hero], 'party'),
      player('Monsters', [goblin, shaman], 'monsters'),
    ]);
    await engine.addBuff(goblin, cursedShield);

    await engine.damage(goblin.gauge('hp'), 999, hero); // the goblin dies (HP hit); the shield with it
    expect(hero.gauge('hp').current).toBe(100); // no backlash — no source on the removal
  });
});

describe('bloodTether — backlash against the destroying buff\'s creator', () => {
  it('deals 12 damage to the creator of the buff whose action destroyed it', async () => {
    const hero = char('Hero', 100);
    const lich = char('Lich', 80);
    const shaman = char('Shaman', 60);
    const engine = makeEngine([
      player('Party', [hero, lich], 'party'),
      player('Monsters', [shaman], 'monsters'),
    ]);

    // The Hero casts the aura onto the Lich: the aura's creator is the
    // Hero, its wearer the Lich. The aura's own trigger removes the tether.
    await engine.addBuff(shaman, bloodTether);
    await engine.addBuff(lich, purgeAura, hero);
    await startTurn(engine);

    expect(shaman.hasStatus('blood-tether')).toBe(false);
    expect(hero.gauge('hp').current).toBe(88); // the creator pays
    expect(lich.gauge('hp').current).toBe(80); // the wearer does not
  });

  it('fizzles when the destroying buff has no creator', async () => {
    const hero = char('Hero', 100);
    const lich = char('Lich', 80);
    const shaman = char('Shaman', 60);
    const engine = makeEngine([
      player('Party', [hero, lich], 'party'),
      player('Monsters', [shaman], 'monsters'),
    ]);
    await engine.addBuff(shaman, bloodTether);
    await engine.addBuff(lich, purgeAura); // applied with no source → no creator

    await startTurn(engine);
    expect(hero.gauge('hp').current).toBe(100);
  });

  it('ignores character-driven removals — only a buff\'s action triggers it', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 40);
    const shaman = char('Shaman', 60);
    const engine = makeEngine([
      player('Party', [hero], 'party'),
      player('Monsters', [goblin, shaman], 'monsters'),
    ]);
    await engine.addBuff(shaman, bloodTether);

    await engine.removeBuff(shaman, 'blood-tether', hero); // a player's action
    expect(hero.gauge('hp').current).toBe(100);
  });
});

describe('leash — backlash against the destroying buff\'s wearer', () => {
  it('deals 12 damage to the wearer of the buff whose action destroyed it', async () => {
    const hero = char('Hero', 100);
    const lich = char('Lich', 80);
    const shaman = char('Shaman', 60);
    const engine = makeEngine([
      player('Party', [hero, lich], 'party'),
      player('Monsters', [shaman], 'monsters'),
    ]);

    await engine.addBuff(shaman, leash);
    await engine.addBuff(lich, purgeAura, hero); // creator: Hero, wearer: Lich
    await startTurn(engine);

    expect(shaman.hasStatus('leash')).toBe(false);
    expect(lich.gauge('hp').current).toBe(68); // the wearer pays
    expect(hero.gauge('hp').current).toBe(100); // the creator does not
  });

  it('fires together with bloodTether when one buff removes both', async () => {
    const hero = char('Hero', 100);
    const lich = char('Lich', 80);
    const shaman = char('Shaman', 60);
    const engine = makeEngine([
      player('Party', [hero, lich], 'party'),
      player('Monsters', [shaman], 'monsters'),
    ]);

    await engine.addBuff(shaman, bloodTether);
    await engine.addBuff(shaman, leash);
    await engine.addBuff(lich, purgeAura, hero);
    await startTurn(engine); // the aura's single trigger removes both

    expect(hero.gauge('hp').current).toBe(88); // tether → the creator
    expect(lich.gauge('hp').current).toBe(68); // leash → the wearer
  });
});

describe('trapMine — per-instance self-triggers (Status.uid)', () => {
  it('detonates only the removed copy when stacked mines share a wearer', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 40);
    const shaman = char('Shaman', 40);
    const engine = makeEngine([
      player('Party', [hero], 'party'),
      player('Monsters', [goblin, shaman], 'monsters'),
    ]);

    await engine.addBuff(goblin, trapMine);
    await engine.addBuff(goblin, trapMine);
    const mineA = goblin.buffs[0]!;
    const mineB = goblin.buffs[1]!;
    expect(mineA.uid).not.toBe(mineB.uid);

    // Removing exactly one instance detonates only that copy.
    await engine.removeBuff(goblin, mineA);

    expect(goblin.gauge('hp').current).toBe(30); // one detonation (10), not two
    expect(goblin.buffs).toEqual([mineB]); // the sibling is still armed
  });

  it('emits one buff:destroyed per instance when the wearer dies with stacked mines', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 40);
    const shaman = char('Shaman', 40);
    const destroyedUids: string[] = [];
    const engine = makeEngine(
      [player('Party', [hero], 'party'), player('Monsters', [goblin, shaman], 'monsters')],
      (e) => {
        if (e.type === 'buff:destroyed' && e.buff.id === 'trap-mine') destroyedUids.push(e.buff.uid);
      },
    );

    await engine.addBuff(goblin, trapMine);
    await engine.addBuff(goblin, trapMine);
    const mineA = goblin.buffs[0]!;
    const mineB = goblin.buffs[1]!;

    await engine.damage(goblin.gauge('hp'), 999, hero); // the goblin dies (HP hit); both mines with it

    // Each copy's own removal announces its own event — one per instance,
    // even though they share a kind id and a wearer.
    expect(destroyedUids.sort()).toEqual([mineA.uid, mineB.uid].sort());
    expect(goblin.buffs).toHaveLength(0);
    expect(goblin.destroyed).toBe(true);
  });
});
