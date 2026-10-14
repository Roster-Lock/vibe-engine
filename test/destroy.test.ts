/**
 * The destroy model (docs/design/02-destroy.md, 04-sba.md, 05-targeting.md):
 *
 * - `destroy` is an action kind; HP ≤ 0 imposes a destroy (a state-based
 *   rule) — both land in the garbage **simultaneously**,
 * - win/lose resolves first: a game-ending kill fires no
 *   `character:destroyed` events and no death triggers,
 * - the garbage is not targetable (no more fireballing corpses),
 * - on-defeat buffs are cleaned up per `removedOnDefeat` on destroy.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEndInterrupt,
  GameEngine,
  Player,
  auto,
  buff,
  cast,
  damage,
  destroy,
  maxModifier,
  skill,
  type Decision,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

/** A player that never acts on its own. */
class TestPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/** A character with HP and Mana. Mana is the life gauge, so a living
 * character needs a positive maxMana (defaults to maxHp). */
function char(name: string, maxHp: number, hp?: number): Character {
  return new Character(name, { maxHp, maxMana: maxHp, ...(hp !== undefined ? { hp } : {}) });
}

/** A hero with a manual Fireball ability (for targeting tests). */
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

function player(name: string, characters: Character[], team?: string): TestPlayer {
  return new TestPlayer(name, characters, team);
}

function makeEngine(players: TestPlayer[], onEvent?: (e: GameEvent) => void): GameEngine {
  const engine = createEngine(onEvent ? { onEvent } : {});
  engine.registerPlayers(players);
  return engine;
}

describe('destroy action', () => {
  it('moves the character to the garbage and emits character:destroyed with the source', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );

    await engine.destroy(goblin, hero);

    expect(engine.isInPlay(goblin)).toBe(false);
    expect(goblin.destroyed).toBe(true);
    expect(engine.garbage).toContain(goblin);
    expect(engine.isInPlay(hero)).toBe(true);
    expect(engine.isInPlay(shaman)).toBe(true);

    const destroyed = events.filter((e) => e.type === 'character:destroyed');
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]!.character).toBe(goblin);
    expect(destroyed[0]!.reason).toBe('direct-action');
    expect(destroyed[0] && 'source' in destroyed[0] ? destroyed[0].source : undefined).toBe(hero);
    // Explicit destroy: no HP writes.
    expect(destroyed[0]!.changes).toEqual([]);
  });

  it('is a no-op for an already destroyed character', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );

    await engine.destroy(goblin, hero);
    await engine.destroy(goblin, hero);

    expect(engine.garbage).toContain(goblin);
    expect(events.filter((e) => e.type === 'character:destroyed')).toHaveLength(1);
  });

  it('cleans up on-defeat buffs when the target is destroyed (bomb explodes)', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    let bombDamage = 0;
    const bomb = buff({
      name: 'Bomb',
      weight: 1,
      abilities: [
        auto({
          name: 'Blow Up',
          event: 'buff:destroyed',
          when: (ctx) => ctx.event.buff.id === 'bomb' && ctx.event.character === ctx.self,
          cast: (ctx) => {
            bombDamage = 10;
            return [damage(hero.gauge('hp'), 10, ctx.event.buff)];
          },
        }),
      ],
    });
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    await engine.addBuff(goblin, bomb);

    await engine.destroy(goblin, hero);

    expect(engine.garbage).toContain(goblin);
    expect(bombDamage).toBe(10);
    expect(hero.gauge('hp').current).toBe(90);
    expect(goblin.hasStatus('bomb')).toBe(false);
  });

  it('a destroy that ends the game fires no character:destroyed events (win/lose first)', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')],
      (e) => events.push(e),
    );

    await expect(engine.destroy(goblin, hero)).rejects.toBeInstanceOf(GameEndInterrupt);
    expect(events.some((e) => e.type === 'character:destroyed')).toBe(false);
    // The destroy itself landed (garbage), but the win/lose re-check threw
    // before any events fired.
    expect(engine.isInPlay(goblin)).toBe(false);
    expect(goblin.destroyed).toBe(true);
  });
});

describe('HP ≤ 0 destruction', () => {
  it('destroys multiple characters in one batch simultaneously', async () => {
    const hero = char('Hero', 100);
    const a = char('A', 30);
    const b = char('B', 30);
    const goblin = char('Goblin', 10);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Party', [hero, a, b], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );

    await engine.apply([damage(a.gauge('hp'), 999, goblin), damage(b.gauge('hp'), 999, goblin)]);

    // Both move to the garbage together; the game continues (hero stands).
    expect(engine.garbage).toContain(a);
    expect(engine.garbage).toContain(b);
    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
    expect(engine.isInPlay(hero)).toBe(true);
    expect(engine.isInPlay(shaman)).toBe(true);
    const destroyed = events.filter((e) => e.type === 'character:destroyed');
    expect(destroyed).toHaveLength(2);
    // HP deaths carry the batch's HP writes and the right reason.
    for (const d of destroyed) {
      expect(d.reason).toBe('hp:current-reached-minimum');
      expect(d.changes.map((c) => [c.from, c.to])).toEqual([[30, 0]]);
    }
  });

  it('destroys a character whose max HP is driven to 0 (reason: hp:maximum-reached-0)', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );

    // Max is derived, not written: a curse buff (maxModifier −20) drives the
    // 20-max goblin's max HP to 0 — the hp:maximum-reached-0 reason.
    await engine.addBuff(goblin, buff({ name: 'Soul Drain', weight: 1, abilities: [maxModifier({ name: 'Soul Drain', gauge: 'hp', add: -20 })] }), hero);

    expect(engine.garbage).toContain(goblin);
    expect(goblin.destroyed).toBe(true);
    expect(goblin.gauge('hp').max).toBe(0);
    const destroyed = events.filter((e) => e.type === 'character:destroyed');
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]!.reason).toBe('hp:maximum-reached-0');
    expect(destroyed[0] && 'maxChanges' in destroyed[0] ? destroyed[0].maxChanges.map((c) => [c.from, c.to]) : undefined).toEqual([[20, 0]]);
    expect(destroyed[0] && 'source' in destroyed[0] ? destroyed[0].source : undefined).toBe(hero);
  });

  it('fires death triggers after the wipe, one per destroyed character', async () => {
    const hero = char('Hero', 100);
    const a = char('A', 30);
    const b = char('B', 30);
    const goblin = char('Goblin', 10);
    const shaman = char('Shaman', 30);
    let deaths = 0;
    const reaper = buff({
      name: 'Reaper',
      weight: 1,
      abilities: [
        auto({
          name: 'Count Deaths',
          event: 'character:destroyed',
          cast: () => {
            deaths += 1;
            return [];
          },
        }),
      ],
    });
    const engine = makeEngine([
      player('Party', [hero, a, b], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    await engine.addBuff(hero, reaper);

    await engine.apply([damage(a.gauge('hp'), 999, goblin), damage(b.gauge('hp'), 999, goblin)]);

    expect(deaths).toBe(2);
    expect(engine.garbage).toContain(a);
    expect(engine.garbage).toContain(b);
  });

  it('a game-ending killing blow fires no destroyed events (win/lose first)', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin], 'monsters')],
      (e) => events.push(e),
    );

    await expect(engine.damage(hero.gauge('hp'), 999)).rejects.toBeInstanceOf(GameEndInterrupt);
    expect(events.some((e) => e.type === 'character:destroyed')).toBe(false);
    // The game ended at the win/lose check *before* the destroy phase — the
    // character never even moved to the garbage.
    expect(engine.isInPlay(hero)).toBe(true);
    expect(hero.destroyed).toBe(false);
  });
});

describe('the garbage is not targetable', () => {
  it('excludes destroyed characters from the targeting pool', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    await engine.destroy(goblin, hero);

    const pool = engine.validTargets({ who: 'enemy' }, hero);
    expect(pool).not.toContain(goblin);
    expect(pool).toContain(shaman);
    expect(engine.isInPlay(goblin)).toBe(false);
    // The character is still registered (garbage is a zone, not an exile).
    expect(engine.registeredCharacters).toContain(goblin);
  });

  it('a manual ability cannot target a destroyed character', async () => {
    const hero = mage('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    await engine.destroy(goblin, hero);

    const fireball = hero.manualAbilities[0]!;
    await expect(
      engine.useAbility(hero, fireball, { targets: [goblin] }),
    ).rejects.toThrow('cannot target');
  });

  it('`isDefeated` stays HP-derived; `destroyed` is the garbage state', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    // A destroy action leaves HP untouched — the character is destroyed but
    // not "HP-defeated". The destroyed flag is what the win/lose check and
    // targeting consult.
    await engine.destroy(goblin, hero);
    expect(goblin.isDefeated).toBe(false);
    expect(goblin.gauge('hp').current).toBe(20);
    expect(goblin.destroyed).toBe(true);
    expect(engine.isInPlay(goblin)).toBe(false);
  });
});

describe('batch events', () => {
  it('emits one character:destroyed:batch per wipe carrying every victim', async () => {
    const hero = char('Hero', 100);
    const a = char('A', 30);
    const b = char('B', 30);
    const c = char('C', 30);
    const goblin = char('Goblin', 10);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Party', [hero, a, b, c], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );

    await engine.apply([damage(a.gauge('hp'), 999, goblin), damage(b.gauge('hp'), 999, goblin), damage(c.gauge('hp'), 999, goblin)]);

    const destroyed = events.filter((e) => e.type === 'character:destroyed');
    const batches = events.filter((e) => e.type === 'character:destroyed:batch');
    expect(destroyed).toHaveLength(3);
    expect(batches).toHaveLength(1);
    // The batch carries the full victim list, in destruction order.
    expect(batches[0]!.events.map((e) => e.character)).toEqual([a, b, c]);
    expect(batches[0]!.events).toEqual(destroyed);
  });

  it('fires the batch event even for a single destruction', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Hero', [hero], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );

    await engine.destroy(goblin, hero);

    const batches = events.filter((e) => e.type === 'character:destroyed:batch');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events.map((e) => e.character)).toEqual([goblin]);
    expect(batches[0]!.events[0]!.reason).toBe('direct-action');
  });

  it('emits character:survived:batch once per batch of survivors', async () => {
    const hero = char('Hero', 100);
    const a = char('A', 30);
    const b = char('B', 30);
    const goblin = char('Goblin', 10);
    const shaman = char('Shaman', 30);
    const events: GameEvent[] = [];
    const engine = makeEngine(
      [player('Party', [hero, a, b], 'party'), player('Goblins', [goblin, shaman], 'monsters')],
      (e) => events.push(e),
    );

    await engine.apply([damage(a.gauge('hp'), 10, goblin), damage(b.gauge('hp'), 10, goblin)]);

    const survived = events.filter((e) => e.type === 'character:survived');
    const batches = events.filter((e) => e.type === 'character:survived:batch');
    expect(survived).toHaveLength(2);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events.map((e) => e.character)).toEqual([a, b]);
  });
});

describe('same-batch death triggers', () => {
  it('a buff that dies with its wearer still hears the death (HP kill)', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    let cursed = 0;
    const gravePact = buff({
      name: 'Grave Pact',
      weight: 1,
      // removedOnDefeat defaults to true — the buff dies with its wearer,
      // yet its self-death trigger still fires: the destroy phase collects
      // the death's triggers before the on-defeat cleanup.
      abilities: [
        auto({
          name: 'Final Curse',
          event: 'character:destroyed',
          when: (ctx) => ctx.event.character === ctx.self,
          cast: () => {
            cursed += 1;
            return [];
          },
        }),
      ],
    });
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    await engine.addBuff(goblin, gravePact);

    await engine.damage(goblin.gauge('hp'), 20, hero);

    expect(cursed).toBe(1);
    // The buff is gone (cleaned up on defeat) — the trigger still ran.
    expect(goblin.hasStatus('grave-pact')).toBe(false);
  });

  it('...and for a direct-action destroy', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    let cursed = 0;
    const gravePact = buff({
      name: 'Grave Pact',
      weight: 1,
      abilities: [
        auto({
          name: 'Final Curse',
          event: 'character:destroyed',
          when: (ctx) => ctx.event.character === ctx.self,
          cast: () => {
            cursed += 1;
            return [];
          },
        }),
      ],
    });
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    await engine.addBuff(goblin, gravePact);

    await engine.destroy(goblin, hero);

    expect(cursed).toBe(1);
    expect(goblin.hasStatus('grave-pact')).toBe(false);
  });

  it('a buff on a dying character hears character:destroyed:batch for the wipe', async () => {
    const hero = char('Hero', 100);
    const a = char('A', 30);
    const b = char('B', 30);
    const goblin = char('Goblin', 10);
    const shaman = char('Shaman', 30);
    const batchSizes: number[] = [];
    const deathNote = buff({
      name: 'Death Note',
      weight: 1,
      abilities: [
        auto({
          name: 'Note',
          event: 'character:destroyed:batch',
          cast: (ctx) => {
            batchSizes.push(ctx.event.events.length);
            return [];
          },
        }),
      ],
    });
    const engine = makeEngine([
      player('Party', [hero, a, b], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    await engine.addBuff(a, deathNote); // the buff rides a dying character

    await engine.apply([damage(a.gauge('hp'), 999, goblin), damage(b.gauge('hp'), 999, goblin)]);

    expect(batchSizes).toEqual([2]);
    expect(a.hasStatus('death-note')).toBe(false);
  });

  it('a buff can carry several removed abilities; all fire, in order', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 20);
    const shaman = char('Shaman', 30);
    const order: string[] = [];
    const trap = buff({
      name: 'Trap',
      weight: 1,
      abilities: [
        auto({
          name: 'First',
          event: 'buff:destroyed',
          when: (ctx) => ctx.event.buff.id === 'trap' && ctx.event.character === ctx.self,
          cast: () => {
            order.push('first');
            return [];
          },
        }),
        auto({
          name: 'Second',
          event: 'buff:destroyed',
          when: (ctx) => ctx.event.buff.id === 'trap' && ctx.event.character === ctx.self,
          cast: () => {
            order.push('second');
            return [];
          },
        }),
      ],
    });
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    await engine.addBuff(goblin, trap);

    await engine.destroy(goblin, hero);

    // Both self-triggers fire — order is seeded-shuffled like any triggers.
    expect([...order].sort()).toEqual(['first', 'second']);
  });

  it('buff:destroyed carries a reason: "wearer-destroyed" vs "removed"', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 30);
    const shaman = char('Shaman', 30);
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    const observations: Array<[string, string | undefined]> = [];
    const watcher = buff({
      name: 'Watcher',
      weight: 1,
      abilities: [
        auto({
          name: 'Watch',
          event: 'buff:destroyed',
          when: (ctx) => ctx.event.buff.id === 'marker',
          cast: (ctx) => {
            observations.push([ctx.event.reason, 'source' in ctx.event ? ctx.event.source.name : undefined]);
            return [];
          },
        }),
      ],
    });
    await engine.addBuff(hero, watcher);
    await engine.addBuff(goblin, buff({ name: 'Marker', weight: 1 }));

    await engine.removeBuff(goblin, 'marker', hero); // dispel — source is the hero

    await engine.addBuff(goblin, buff({ name: 'Marker', weight: 1 }));
    await engine.damage(goblin.gauge('hp'), 999, hero); // destroyed — the buff dies with it

    expect(observations).toEqual([
      ['removed', 'Hero'], // dispelled by the hero
      ['wearer-destroyed', undefined], // died with the goblin
    ]);
  });

  it('a buff\'s own buff:destroyed self-trigger sees the reason and source of its end', async () => {
    const hero = char('Hero', 100);
    const goblin = char('Goblin', 30);
    const shaman = char('Shaman', 30);
    const engine = makeEngine([
      player('Hero', [hero], 'party'),
      player('Goblins', [goblin, shaman], 'monsters'),
    ]);
    const seen: Array<[string, string | undefined]> = [];
    const bomb = buff({
      name: 'Bomb',
      weight: 1,
      abilities: [
        auto({
          name: 'Blow Up',
          event: 'buff:destroyed',
          when: (ctx) => ctx.event.buff.id === 'bomb' && ctx.event.character === ctx.self,
          cast: (ctx) => {
            seen.push([ctx.event.reason, 'source' in ctx.event ? ctx.event.source.name : undefined]);
            return [];
          },
        }),
      ],
    });
    await engine.addBuff(goblin, bomb);
    await engine.removeBuff(goblin, 'bomb', hero);
    await engine.addBuff(goblin, bomb);
    await engine.damage(goblin.gauge('hp'), 999, hero);

    expect(seen).toEqual([
      ['removed', 'Hero'],
      ['wearer-destroyed', undefined],
    ]);
  });
});
