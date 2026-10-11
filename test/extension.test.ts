/**
 * The extension system, end to end — the acceptance test for
 * `docs/design/17-extension-system.md`.
 *
 * This file *is* a game. It declares a vocabulary the engine has never heard of
 * — a `summon` action and a `summon:resolved` event — by augmenting the open
 * maps in `contracts.ts`, then teaches the engine to execute the action through
 * the registry. Nothing in `src/engine` mentions either one.
 *
 * The augmentation below is why these tests are worth having as a permanent
 * suite rather than a throwaway spike: it widens `Action` and `GameEvent`
 * program-wide for the whole typecheck, so if the engine ever grows a closed
 * `switch`, a missing `default`, or a cast that assumes a fixed vocabulary,
 * `npm run typecheck` breaks here rather than in a game author's repo.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  auto,
  cast,
  damage,
  heal,
  move,
  passiveActionModifier,
  skill,
  type ActionDirection,
  type Entity,
  type EventSource,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import type { Action, ActionMap, GameEventMap } from '../src/engine/contracts.js';
import { createEngine } from '../src/games/turn-based/index.js';

/* ---------------------- a game declares its vocabulary ---------------------- */

declare module '../src/engine/contracts.js' {
  interface ActionMap {
    summon: {
      type: 'summon';
      unitName: string;
      maxHp: number;
      // The pipeline fields every action must carry (ActionBase) — without
      // these the engine's transformer pass does not compile.
      source?: EventSource;
      direction?: ActionDirection;
      bypasses?: readonly string[];
    };
    /**
     * A *targeted* game action — deliberately here alongside `summon` (which is
     * board-wide and has no subject) so the two cases the registry must
     * distinguish are both exercised.
     */
    bless: {
      type: 'bless';
      target: Character;
      amount: number;
      source?: EventSource;
      direction?: ActionDirection;
      bypasses?: readonly string[];
    };
  }
  interface GameEventMap {
    'summon:resolved': { type: 'summon:resolved'; name: string };
  }
  /**
   * A targeting value of the game's own. The engine answers `'self'` and
   * `'any'`; everything else — including `'ally'`/`'enemy'`, which live in
   * `src/games/round-based/targeting.ts` — is a game's to declare.
   */
  interface TargetWhoMap {
    /** Anything that is not the ability's owner. */
    other: 'other';
  }
}

/** The game's own action builder — the engine has no idea this exists. */
function summon(unitName: string, maxHp: number): Extract<Action, { type: 'summon' }> {
  return { type: 'summon', unitName, maxHp };
}

function bless(target: Character, amount: number): Extract<Action, { type: 'bless' }> {
  return { type: 'bless', target, amount };
}

/* --------------------------------- tests --------------------------------- */

describe('a game declares its own action', () => {
  it('executes it through the registry, with the action narrowed', async () => {
    const engine = createEngine();
    const summoned: string[] = [];

    engine.actions.register('summon', (action) => {
      // `action` is narrowed to the game's own type — `unitName` and `maxHp`
      // are reachable with no cast and no `switch`.
      summoned.push(`${action.unitName}(${action.maxHp})`);
    });

    await engine.apply([summon('Goblin', 7)]);

    expect(summoned).toEqual(['Goblin(7)']);
  });

  it('runs async handlers and awaits them before the next action', async () => {
    const engine = createEngine();
    const order: string[] = [];

    engine.actions.register('summon', async (action) => {
      await Promise.resolve();
      order.push(`summon:${action.unitName}`);
    });

    await engine.apply([summon('First', 1), summon('Second', 1)]);

    expect(order).toEqual(['summon:First', 'summon:Second']);
  });

  it('lets the handler reach the engine through the context', async () => {
    const engine = createEngine();
    engine.actions.register('summon', (action, ctx) => {
      ctx.engine.registerCharacter(new Character(action.unitName, { maxHp: action.maxHp }));
    });

    await engine.apply([summon('Goblin', 7)]);

    expect(engine.registeredCharacters.map((c) => c.name)).toEqual(['Goblin']);
  });
});

describe('dispatch is a registry, not a closed switch', () => {
  it('throws a naming error for an action with no handler', async () => {
    const engine = createEngine();

    await expect(engine.apply([summon('Goblin', 7)])).rejects.toThrow(
      /No handler registered for action "summon"/,
    );
  });

  it('names the registration call in the error, so the fix is obvious', async () => {
    const engine = createEngine();

    await expect(engine.apply([summon('Goblin', 7)])).rejects.toThrow(
      /engine\.actions\.register\("summon"/,
    );
  });

  it('refuses to register the same tag twice', () => {
    const engine = createEngine();
    engine.actions.register('summon', () => {});

    expect(() => engine.actions.register('summon', () => {})).toThrow(
      /a handler for "summon" is already registered/,
    );
  });

  it('registers every built-in through the same registry a game uses', () => {
    const engine = createEngine();

    expect(engine.actions.registered).toEqual(
      expect.arrayContaining([
        'move',
        'addBuff',
        'removeBuff',
        'destroy',
        'transform',
        'popTransform',
        'win',
        'lose',
      ]),
    );
    // `gauge` is deliberately absent: it never reaches `#execute` (it is
    // batched and settled instead), so it is an engine invariant rather than
    // a replaceable handler.
    expect(engine.actions.has('gauge')).toBe(false);
  });

  it('still executes the built-ins normally', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 20 });
    engine.registerCharacter(hero);

    await engine.damage(hero.gauge('hp'), 5);

    expect(hero.gauge('hp').current).toBe(15);
  });
});

describe('a game declares its own event', () => {
  it('emits it and survives the versioned-event plumbing', async () => {
    const engine = createEngine();
    const seen: string[] = [];
    const engineWithObserver = createEngine({
      onEvent: (event) => {
        if (event.type === 'summon:resolved') seen.push(event.name);
      },
    });

    await engineWithObserver.emit({ type: 'summon:resolved', name: 'Goblin' });

    expect(seen).toEqual(['Goblin']);
    // The plain engine is untouched — the event is per-engine, not global state.
    expect(engine.actions.registered.length).toBeGreaterThan(0);
  });

  it('reaches a triggered ability, with ctx.event narrowed to it', async () => {
    const engine = createEngine();
    const fired: string[] = [];

    const hero = new Character('Hero', {
      maxHp: 30,
      skills: [
        skill({
          name: 'Summoner',
          weight: 1,
          abilities: [
            auto({
              name: 'On Summon',
              event: 'summon:resolved',
              cast: (ctx) => {
                // Narrowed to the game's own event shape.
                fired.push(ctx.event.name);
                return [heal(ctx.self.gauge('hp'), 3)];
              },
            }),
          ],
        }),
      ],
    });
    engine.registerCharacter(hero);
    hero.gauge('hp').current = 10;

    await engine.emit({ type: 'summon:resolved', name: 'Goblin' });
    // A game event is queued and drained exactly like a built-in one: `emit`
    // records it and collects its listeners, and the triggers run when the
    // resolution unit completes.
    await engine.apply([]);

    expect(fired).toEqual(['Goblin']);
    expect(hero.gauge('hp').current).toBe(13);
  });
});

describe('a game action joins the pipeline by declaring a subject', () => {
  /** A passive that rewrites a `bless` on its own wearer. */
  function doubler(fired: string[]) {
    return skill({
      name: 'Amplifier',
      weight: 1,
      abilities: [
        passiveActionModifier({
          name: 'Amplify',
          transform: (action) => {
            if (action.type !== 'bless') return action;
            fired.push(`saw:${action.amount}`);
            return { ...action, amount: action.amount * 2 };
          },
        }),
      ],
    });
  }

  it('runs the action through the target\'s transformers when a subject is declared', async () => {
    const engine = createEngine();
    const fired: string[] = [];
    const applied: number[] = [];

    const hero = new Character('Hero', { maxHp: 30, skills: [doubler(fired)] });
    engine.registerCharacter(hero);

    engine.actions.register(
      'bless',
      (action) => {
        applied.push(action.amount);
      },
      // Without this the engine cannot tell the action has a character
      // subject, and the passive below never sees it.
      { subject: (action) => action.target },
    );

    await engine.apply([bless(hero, 5)]);

    expect(fired).toEqual(['saw:5']);
    expect(applied).toEqual([10]);
  });

  it('does NOT reach the transformers when no subject is declared', async () => {
    const engine = createEngine();
    const fired: string[] = [];
    const applied: number[] = [];

    const hero = new Character('Hero', { maxHp: 30, skills: [doubler(fired)] });
    engine.registerCharacter(hero);

    // Same action, same target — but no `subject`, so the engine treats it as
    // having no character subject and the passive is bypassed entirely.
    engine.actions.register('bless', (action) => {
      applied.push(action.amount);
    });

    await engine.apply([bless(hero, 5)]);

    expect(fired).toEqual([]);
    expect(applied).toEqual([5]);
  });

  it('resolves the subject for its own built-ins through the same registry', () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 30 });
    engine.registerCharacter(hero);

    // `gauge` is never dispatched (it is batched) yet must still resolve a
    // subject, or "cannot be damaged" would silently stop blocking.
    expect(engine.actionTarget(damage(hero.gauge('hp'), 1))).toBe(hero);
    expect(engine.actionTarget(bless(hero, 1))).toBeUndefined();
  });
});

describe('the open maps stay well-formed', () => {
  it('keeps built-in actions narrowing alongside the game vocabulary', () => {
    // A compile-time assertion more than a runtime one: if augmenting the map
    // had flattened the union instead of widening it, these narrowings would
    // be `never` and this file would not compile.
    const describe = (action: Action): string => {
      if (action.type === 'gauge') return `gauge:${action.intent ?? 'other'}`;
      if (action.type === 'move') return `move:${action.to.id}`;
      if (action.type === 'summon') return `summon:${action.unitName}`;
      return action.type;
    };

    expect(describe(summon('Goblin', 7))).toBe('summon:Goblin');
  });

  it('exposes the maps as types for a game to augment', () => {
    // Referencing them keeps the augmentation targets part of the public
    // surface — if either name stops being exported, this file stops compiling.
    type _Maps = [ActionMap['summon'], GameEventMap['summon:resolved']];
    const sample: _Maps = [summon('Goblin', 7), { type: 'summon:resolved', name: 'Goblin' }];
    expect(sample[1].name).toBe('Goblin');
  });
});

describe('a game declares its own entity kind', () => {
  /**
   * A non-character entity: something that lives in a zone, announces zone
   * changes, and is visible to targeting — with no gauges, no statuses and no
   * mention in the engine.
   *
   * The engine's `Entity` is deliberately structural (`type` + `name`), which
   * is what makes this possible without an entity registry: anything with
   * those two fields already *is* an entity. `examples/card-game` uses the
   * same seam for the ability objects on its stack.
   */
  interface RuneObject extends Entity {
    readonly type: 'rune';
    readonly name: string;
    readonly school: string;
  }

  const rune = (name: string, school: string): RuneObject => ({ type: 'rune', name, school });

  it('places it in a zone the game declared, and reports the transition', async () => {
    const engine = new GameEngine();
    const events: GameEvent[] = [];
    const engineWithLog = new GameEngine({ onEvent: (e) => events.push(e) });

    // A zone of the game's own, declared as data.
    engineWithLog.zones.declare({ id: 'runes', visibility: 'public', group: 'in-play' });
    const stone = rune('Stone Rune', 'earth');

    await engineWithLog.addEntity(stone, 'runes');

    expect(engineWithLog.zones.zoneOf(stone)?.id).toBe('runes');
    expect(engineWithLog.zones.entitiesOf<RuneObject>('rune')).toEqual([stone]);
    expect(events.some((e) => e.type === 'zone:changed')).toBe(true);
    // The engine narrows entity kinds structurally, so this never needed a
    // registry entry — but it must also not be mistaken for a character.
    expect(engine.registeredCharacters).toEqual([]);
  });

  it('moves it between zones with the ordinary move action', async () => {
    const engine = new GameEngine();
    engine.zones.declare({ id: 'runes', visibility: 'public', group: 'in-play' });
    engine.zones.declare({ id: 'spent', visibility: 'public', group: 'removed' });
    const stone = rune('Stone Rune', 'earth');
    await engine.addEntity(stone, 'runes');

    await engine.apply([move(stone, engine.zones.zone('spent')!)]);

    expect(engine.zones.zoneOf(stone)?.id).toBe('spent');
  });

  it('filters a zone by the game\'s own kind', () => {
    const engine = new GameEngine();
    engine.zones.declare({ id: 'runes', visibility: 'public' });
    const stone = rune('Stone', 'earth');
    const flame = rune('Flame', 'fire');

    engine.zones.add(stone, engine.zones.zone('runes')!);
    engine.zones.add(flame, engine.zones.zone('runes')!);

    expect(engine.zones.zone('runes')!.of<RuneObject>('rune').map((r) => r.school)).toEqual([
      'earth',
      'fire',
    ]);
  });
});

describe("a game declares its own targeting value", () => {
  function scene(): { engine: GameEngine; a: Character; b: Character; c: Character } {
    const engine = new GameEngine();
    const a = new Character('A', { maxHp: 10 });
    const b = new Character('B', { maxHp: 10 });
    const c = new Character('C', { maxHp: 10 });
    for (const ch of [a, b, c]) engine.registerCharacter(ch);
    return { engine, a, b, c };
  }

  it("answers 'self' and 'any' with no help from a game", () => {
    const { engine, a, b, c } = scene();

    expect(engine.validTargets({ who: 'self' }, a)).toEqual([a]);
    expect(engine.validTargets({ who: 'any' }, a)).toEqual([a, b, c]);
  });

  it('throws a naming error for a value with no resolver', () => {
    const { engine, a } = scene();

    // 'ally' is declared by the round-based layer. This bare engine has no
    // resolver for it, so asking is a loud error rather than an empty pool —
    // a forgotten registration must not look like "nothing in range".
    expect(() => engine.validTargets({ who: 'ally' }, a)).toThrow(
      /No targeting resolver registered for who "ally"/,
    );
    expect(() => engine.validTargets({ who: 'ally' }, a)).toThrow(
      /engine\.targeting\.register\("ally"/,
    );
  });

  it('uses a resolver the game registered', () => {
    const { engine, a, b, c } = scene();
    engine.targeting.register('other', (self, candidate) => candidate !== self);

    expect(engine.validTargets({ who: 'other' }, a)).toEqual([b, c]);
    expect(engine.targeting.registered).toEqual(['other']);
  });

  it('drives the real ability pipeline through the registered value', async () => {
    const { engine, a, b } = scene();
    engine.targeting.register('other', (self, candidate) => candidate !== self);

    const page = cast({
      name: 'Page',
      targeting: { who: 'other', count: 1 },
      cast: (_ctx, targeting) => [damage(targeting!.targets[0]!.gauge('hp'), 3)],
    });
    const hero = new Character('Hero', {
      maxHp: 10,
      skills: [skill({ name: 'S', weight: 1, abilities: [page] })],
    });
    engine.registerCharacter(hero);

    await engine.useAbility(hero, page, { targets: [b] });

    expect(b.gauge('hp').current).toBe(7);
  });
});
