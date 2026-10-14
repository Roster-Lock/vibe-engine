/**
 * The restrictions system (docs/design/11-restrictions.md, slice 3):
 *
 * - `restriction({ on, when })` **abilities** on buffs/skills — "cannot be
 *   X if Y", with `when` as the "if Y"; ids are derived `"{statusId}:{index}"`
 *   (e.g. `hexproof:0`);
 * - gauge `intent` on gauge actions (`damage`/`heal`/`set`/`other`) so
 *   "cannot be damaged but healing is fine" is checkable;
 * - the four gates: targeting (`validTargets`), destroy (`canDestroy`),
 *   actions (`apply`, before transformers), win/lose (`resolveGameEnd` +
 *   `#execute`);
 * - "can't beats can" with named exceptions (`include` for targeting,
 *   `bypasses` naming restriction ids for the rest);
 * - blocked attempts are no-ops, not errors — except targeting at
 *   `useAbility`, which keeps throwing "cannot target …".
 */
import { describe, expect, it } from 'vitest';
import {
  Buff,
  Character,
  GameEndInterrupt,
  GameEngine,
  Player,
  buff,
  cast,
  changeGaugeBy,
  damage,
  destroy,
  heal,
  lose,
  restriction,
  skill,
  win,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { isAlly, isEnemy } from '../src/games/round-based/index.js';

/** A player that never acts on its own. */
class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

function char(name: string, maxHp: number, hp?: number): Character {
  // HP is the life gauge: the built-in death rules attach to HP at
  // construction. `maxMana` (defaulting to `maxHp`) is just a resource now.
  return new Character(name, { maxHp, maxMana: maxHp, ...(hp !== undefined ? { hp } : {}) });
}

function player(name: string, characters: Character[], team?: string): TestPlayer {
  return new TestPlayer(name, characters, team);
}

function makeEngine(players: TestPlayer[], onEvent?: (e: GameEvent) => void): GameEngine {
  const engine = createEngine(onEvent ? { onEvent } : {});
  engine.registerPlayers(players);
  return engine;
}

/** A hero with a manual Fireball ability targeting enemies (for targeting tests). */
function mage(name: string, maxHp: number): Character {
  return new Character(name, {
    maxHp,
    maxMana: maxHp,
    skills: [
      skill({
        name: 'Mage',
        weight: 1,
        abilities: [
          cast({
            name: 'Fireball',
            targeting: { who: 'enemy' },
            cast: (ctx, t) => [damage(t.targets[0]!.gauge('hp'), 5, ctx.self)],
          }),
        ],
      }),
    ],
  });
}

describe('targeting gate (on: "target")', () => {
  it('hexproof: enemies cannot target the character, allies can', async () => {
    const hero = mage('Hero', 100);
    const goblin = char('Goblin', 20);
    const wolf = char('Wolf', 20);
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, wolf], 'monsters'),
    ]);

    const hexproof = buff({
      name: 'Hexproof',
      weight: 1,
      abilities: [
        restriction({ on: 'target', when: (ctx) => isEnemy(ctx.self, ctx.sourceCharacter!) }),
      ],
    });
    await engine.addBuff(goblin, hexproof);

    // The enemy's targeting pool no longer contains the hexproof character,
    // but the ally's does.
    expect(engine.validTargets({ who: 'enemy' }, hero).map((c) => c.name)).toEqual(['Wolf']);
    expect(engine.validTargets({ who: 'ally' }, wolf)).toContain(goblin);

    // useAbility keeps its contract: an invalid target is an error, not a no-op.
    await expect(engine.useAbility(hero, hero.manualAbilities[0]!, { targets: [goblin] })).rejects.toThrow(
      /cannot target "Goblin"/,
    );
  });

  it('hexproof: the include field punches through (named exception for targeting)', async () => {
    const hero = mage('Hero', 100);
    const goblin = char('Goblin', 20);
    const engine = makeEngine([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);

    const hexproof = buff({
      name: 'Hexproof',
      weight: 1,
      abilities: [
        restriction({ on: 'target', when: (ctx) => isEnemy(ctx.self, ctx.sourceCharacter!) }),
      ],
    });
    await engine.addBuff(goblin, hexproof);

    // No include: hexproof blocks the pool.
    expect(engine.validTargets({ who: 'enemy' }, hero)).not.toContain(goblin);

    // Include names the exception: the spell gets through anyway.
    const fireball = cast({
      name: 'Fireball',
      targeting: { who: 'enemy', include: [goblin] },
      cast: (ctx, t) => [damage(t.targets[0]!.gauge('hp'), 5, ctx.self)],
    });
    hero.addBuff(new Buff(buff({ name: 'Pyro', weight: 1, abilities: [fireball] })));
    await engine.useAbility(hero, fireball, { targets: [goblin] });
    expect(goblin.gauge('hp').current).toBe(15);
  });
});

describe('destroy gate (on: "destroy")', () => {
  it('indestructible: sits at 0 HP, is not destroyed, owner does not lose; an HP refill saves it', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')],
      (e) => events.push(e),
    );

    const indestructible = buff({
      name: 'Indestructible',
      weight: 1,
      abilities: [restriction({ on: 'destroy' })],
    });
    await engine.addBuff(goblin, indestructible);

    // attemptBlocked is the queryable "why can't I do that" answer.
    const blocking = engine.attemptBlocked({
      kind: 'destroy',
      target: goblin,
      ctx: { self: goblin, source: hero, sourceCharacter: hero, engine },
    });
    expect(blocking?.id).toBe('indestructible:0');
    expect(engine.canDestroy(goblin, hero)).toBe(false);

    // Lethal HP damage: HP hits 0, but the HP→destroy rule is gated —
    // the character stays, no destroyed event, and the owner does not lose.
    await engine.damage(goblin.gauge('hp'), 999, hero); // does not throw GameEndInterrupt
    expect(goblin.gauge('hp').current).toBe(0);
    expect(goblin.isDefeated).toBe(true);
    expect(goblin.destroyed).toBe(false);
    expect(engine.isInPlay(goblin)).toBe(true);
    expect(events.filter((e) => e.type === 'character:destroyed')).toHaveLength(0);

    // An explicit destroy action is a no-op too.
    await engine.destroy(goblin, hero);
    expect(engine.isInPlay(goblin)).toBe(true);

    // A later HP refill saves it.
    await engine.heal(goblin.gauge('hp'), 30, hero);
    expect(goblin.gauge('hp').current).toBe(30);
    expect(goblin.isDefeated).toBe(false);
  });

  it('a named exception pierces a destroy restriction (bypasses names the rule)', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const goblin2 = char('Goblin 2', 100);
    const shaman = char('Shaman', 100);
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, goblin2, shaman], 'monsters'),
    ]);
    const indestructible = buff({ name: 'Indestructible', weight: 1, abilities: [restriction({ on: 'destroy' })] });
    await engine.addBuff(goblin, indestructible);
    await engine.addBuff(goblin2, indestructible);

    // Without an exception: blocked.
    await engine.destroy(goblin, hero);
    expect(engine.isInPlay(goblin)).toBe(true);

    // Raw action with bypasses: gets through anyway. (The shaman keeps the
    // monsters team standing, so the destruction does not end the game.)
    await engine.apply([{ type: 'destroy', target: goblin, source: hero, bypasses: ['indestructible:0'] }]);
    expect(engine.isInPlay(goblin)).toBe(false);

    // The destroy sugar accepts the same option.
    await engine.destroy(goblin2, hero, { bypasses: ['indestructible:0'] });
    expect(engine.isInPlay(goblin2)).toBe(false);
    expect(engine.isInPlay(shaman)).toBe(true);
  });
});

describe('gauge gate (on: "gauge") — intent split', () => {
  it('spell-ward: damage is blocked, healing works', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')],
      (e) => events.push(e),
    );

    const spellWard = buff({
      name: 'Spell Ward',
      weight: 1,
      abilities: [
        restriction({ on: 'gauge', when: (ctx) => ctx.gauge === ctx.self.gauge('hp') && ctx.intent === 'damage' }),
      ],
    });
    await engine.addBuff(goblin, spellWard);

    goblin.gauge('hp').current = 50;
    const before = goblin.gauge('hp').current;

    // Damage: a silent no-op — no write lands, no gauge:changed event.
    await engine.damage(goblin.gauge('hp'), 10, hero);
    expect(goblin.gauge('hp').current).toBe(before);
    expect(events.filter((e) => e.type === 'gauge:changed')).toHaveLength(0);

    // Healing is fine.
    await engine.heal(goblin.gauge('hp'), 10, hero);
    expect(goblin.gauge('hp').current).toBe(60);

    // A generic changeGaugeBy is stamped 'other' — not damage, so it passes.
    await engine.apply([changeGaugeBy(goblin.gauge('hp'), -10, hero)]);
    expect(goblin.gauge('hp').current).toBe(50);
  });

  it('a blanket gauge restriction blocks every write, whatever the intent', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const engine = makeEngine([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);

    await engine.addBuff(goblin, buff({ name: 'Rock Skin', weight: 1, abilities: [restriction({ on: 'gauge' })] }));

    await engine.damage(goblin.gauge('hp'), 10, hero);
    expect(goblin.gauge('hp').current).toBe(100);
    await engine.heal(goblin.gauge('hp'), 10, hero);
    expect(goblin.gauge('hp').current).toBe(100);
    await engine.apply([changeGaugeBy(goblin.gauge('hp'), -10, hero)]);
    expect(goblin.gauge('hp').current).toBe(100);
  });
});

describe('buff gate (on: "buff")', () => {
  it('blocked add/removeBuff are silent no-ops, not errors', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const engine = makeEngine([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);

    // A buff that lands while the character has no restrictions yet…
    const marker = buff({ name: 'Marker', weight: 1 });
    await engine.addBuff(goblin, marker, hero);
    expect(goblin.hasStatus('marker')).toBe(true);

    // …then the character gains "cannot be buffed".
    await engine.addBuff(goblin, buff({ name: 'Cannot Be Buffed', weight: 1, abilities: [restriction({ on: 'buff' })] }));

    // Adding is refused (a no-op), removing is refused too.
    await engine.addBuff(goblin, buff({ name: 'Extra', weight: 1 }), hero);
    expect(goblin.hasStatus('extra')).toBe(false);
    await engine.apply([{ type: 'removeBuff', target: goblin, buff: 'marker', source: hero }]);
    expect(goblin.hasStatus('marker')).toBe(true);
  });
});

describe('win/lose gates (on: "lose" / on: "win")', () => {
  it('cannot lose the game: the owner does not lose even when its last character falls', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const engine = makeEngine([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);

    // "Cannot lose the game" outlives its wearer's defeat — a pact-style
    // effect, so it declares `removedOnDefeat: false` (ordinary buffs fade
    // with their wearer, which would end the protection at the destroy
    // phase's game-end recheck).
    const cannotLose = buff({
      name: 'Cannot Lose',
      weight: 1,
      removedOnDefeat: false,
      abilities: [restriction({ on: 'lose' })],
    });
    await engine.addBuff(hero, cannotLose);

    // The killing blow drains hero's HP to 0 (HP is the life gauge) and
    // destroys hero (no indestructible), but the game does not end: the
    // party cannot be judged lost while its character says so.
    await engine.damage(hero.gauge('hp'), 999, goblin); // must not throw GameEndInterrupt
    expect(hero.destroyed).toBe(true);
    expect(engine.garbage).toContain(hero);

    // An explicit lose action is blocked the same way.
    await engine.apply([lose('party')]); // must not throw GameEndInterrupt
    expect(engine.isInPlay(goblin)).toBe(true);
  });

  it('cannot lose the game: without the restriction the same blow ends the game', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const engine = makeEngine([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);

    let interrupt: unknown;
    await engine.damage(hero.gauge('hp'), 999, goblin).catch((e) => {
      interrupt = e;
    });
    expect(interrupt).toBeInstanceOf(GameEndInterrupt);
  });

  it('cannot win the game: a win declaration for the team is a no-op', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 100);
    const engine = makeEngine([player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')]);

    await engine.addBuff(hero, buff({ name: 'Cannot Win', weight: 1, abilities: [restriction({ on: 'win' })] }));

    await engine.apply([win('party')]); // must not throw GameEndInterrupt
    expect(engine.isInPlay(goblin)).toBe(true);
  });
});
