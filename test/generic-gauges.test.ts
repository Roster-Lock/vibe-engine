/**
 * Gauges are generic — the engine has no built-in gauge.
 *
 * `'hp'` and `'mana'` are content, not concepts: a gauge is lethal because a
 * `GaugeSba` attached to *it* destroys the character, and the convenience
 * predicate `isDefeated` reads whichever gauge the character declares as its
 * `lifeGauge`. Nothing here declares an `hp` gauge, and the engine works
 * anyway — which is the point of the slice these tests guard.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  damage,
  destroy,
  transform,
  type GameEvent,
  type GaugeSba,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

/** "This gauge is life" — the ordinary shape a death rule has. */
const depletes: GaugeSba = {
  name: 'Depleted',
  aspect: 'current',
  priority: 10,
  when: (gauge) => gauge.current <= gauge.min,
  then: (character) => [destroy(character)],
  reason: 'stamina:current-reached-minimum',
};

/** A dancer whose life is a `stamina` gauge — no hp, no mana. */
function dancer(): Character {
  return new Character('Dancer', {
    gauges: [{ id: 'stamina', max: 5, sbas: [depletes] }],
    lifeGauge: 'stamina',
  });
}

describe('a character needs no hp gauge', () => {
  it('builds from declared gauges alone', () => {
    const hero = dancer();

    expect(hero.gauges.map((g) => g.id)).toEqual(['stamina']);
    expect(hero.gauge('stamina')?.current).toBe(5);
    // `gauge(id)` throws for a missing gauge; `findGauge` is the optional form.
    expect(hero.findGauge('hp')).toBeUndefined();
    expect(hero.findGauge('mana')).toBeUndefined();
  });

  it('fails loudly when asked for a gauge the character does not have', () => {
    const hero = dancer();

    expect(() => hero.gauge('hp')).toThrow(/"hp" gauge/);
    expect(() => hero.gauge('mana')).toThrow(/"mana" gauge/);
  });

  it('takes the deprecated hp sugar and an explicit gauge identically', () => {
    // Both spellings produce the same gauge; the sugar only adds the
    // built-in death rules that `maxHp` has always implied.
    const sugared = new Character('Sugared', { maxHp: 10 });
    const declared = new Character('Declared', { gauges: [{ id: 'hp', max: 10 }] });

    expect(sugared.gauge('hp')?.max).toBe(10);
    expect(declared.gauge('hp')?.max).toBe(10);
    // The legacy path still materializes the empty mana gauge it always did.
    expect(sugared.gauge('mana')?.max).toBe(0);
    // ...but a purely-declared character gets only what it asked for.
    expect(declared.findGauge('mana')).toBeUndefined();
  });
});

describe('an arbitrary gauge can be the life gauge', () => {
  it('destroys its owner when the declared gauge bottoms out', async () => {
    const engine = createEngine();
    const hero = dancer();
    engine.registerCharacter(hero);

    await engine.damage(hero.gauge('stamina')!, 5);

    expect(hero.destroyed).toBe(true);
    expect(engine.isInPlay(hero)).toBe(false);
  });

  it('reports the death with the rule\'s own reason', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = dancer();
    engine.registerCharacter(hero);

    await engine.damage(hero.gauge('stamina')!, 5);

    const destroyed = events.find((e) => e.type === 'character:destroyed');
    expect(destroyed && 'reason' in destroyed && destroyed.reason).toBe(
      'stamina:current-reached-minimum',
    );
  });

  it('reads `isDefeated` from the declared life gauge, not from hp', () => {
    const hero = dancer();

    expect(hero.isDefeated).toBe(false);
    hero.gauge('stamina')!.current = 0;
    expect(hero.isDefeated).toBe(true);
  });

  it('does not call a character defeated when it declares no life gauge', () => {
    // A card with a cost gauge but no life: only rules or an explicit
    // `destroy` can remove it.
    const card = new Character('Relic', { gauges: [{ id: 'charge', max: 3 }] });

    card.gauge('charge')!.current = 0;

    expect(card.isDefeated).toBe(false);
    expect(card.gauge('charge')?.current).toBe(0);
  });

  it('emits character:survived for a watched gauge — not only for hp', async () => {
    // The engine used to collect `changes` and emit `survived` only when the
    // gauge was literally `character.gauge('hp')`, so a stamina-death game got none of
    // the forensics hp always had. A watched gauge (one carrying rules) now
    // reports like any other.
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = dancer();
    engine.registerCharacter(hero);

    await engine.damage(hero.gauge('stamina')!, 2);

    const survived = events.find((e) => e.type === 'character:survived');
    expect(survived).toBeDefined();
    expect(survived && 'changes' in survived && survived.changes).toHaveLength(1);
    expect(hero.gauge('stamina')?.current).toBe(3);
  });
});

describe('a transform can name any gauge by id', () => {
  it('rewrites a non-hp gauge max and clamps its current value', async () => {
    const engine = createEngine();
    const hero = dancer();
    engine.registerCharacter(hero);

    expect(hero.transformedBaseMax('stamina')).toBe(5);

    await engine.apply([transform(hero, { name: 'Weary Dancer', gauges: { stamina: 2 } })]);

    expect(hero.transformedBaseMax('stamina')).toBe(2);
    expect(hero.gauge('stamina')?.max).toBe(2);
    // Raising a max never refills; lowering it clamps the current value down.
    expect(hero.gauge('stamina')?.current).toBe(2);
  });

  it('ignores a gauge id the character does not have', async () => {
    const engine = createEngine();
    const hero = dancer();
    engine.registerCharacter(hero);

    await engine.apply([transform(hero, { gauges: { loyalty: 4 } })]);

    expect(hero.findGauge('loyalty')).toBeUndefined();
    expect(hero.gauge('stamina')?.max).toBe(5);
  });

  it('stores a form gauge-keyed, with nothing to normalize', () => {
    const hero = new Character('Hero', { maxHp: 20 });
    const action = transform(hero, { name: 'Sheep', gauges: { hp: 5 } });

    // A form names gauges by id and nothing else. The `maxHp`/`maxMana` input
    // aliases were removed once content migrated, so there is no second
    // spelling to normalize and no way to name a gauge the character lacks.
    expect(action.form).toEqual({ name: 'Sheep', gauges: { hp: 5 } });
  });

  it('rejects a negative gauge max at the builder', () => {
    const hero = new Character('Hero', { maxHp: 20 });

    expect(() => transform(hero, { gauges: { hp: -1 } })).toThrow(/finite number >= 0/);
    expect(() => transform(hero, { gauges: { hp: -5 }})).toThrow(/finite number >= 0/);
  });
});

describe('damage is a gauge write, not an hp concept', () => {
  it('writes whatever gauge it is handed', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { gauges: [{ id: 'charge', max: 10 }] });
    engine.registerCharacter(hero);

    await engine.apply([damage(hero.gauge('charge')!, 4)]);

    expect(hero.gauge('charge')?.current).toBe(6);
  });
});
