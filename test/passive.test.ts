import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  auto,
  buff,
  cast,
  changeGaugeBy,
  damage,
  gaugeDelta,
  maxModifier,
  passiveActionModifier,
  redirectGauge,
  replaceAction,
  setGauge,
  skill,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';

describe('passive action modifiers', () => {
  it('transforms incoming actions when the action says it is incoming', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', {
      maxHp: 100,
      skills: [
        skill({
          name: 'Fighter',
          weight: 1,
          abilities: [
            passiveActionModifier({
              name: 'Iron Hide',
              transform: (action) => {
                if (action.direction !== 'incoming' || action.type !== 'gauge') return action;
                // Cap incoming damage at 50: use the previous update, or
                // deal at most `current - 50`.
                return { ...action, update: (cur: number, max: number) => Math.max(action.update(cur, max), cur - 50) };
              },
            }),
          ],
        }),
      ],
    });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    // Incoming damage to the hero is capped at 50...
    await engine.damage(hero.gauge('hp'), 100, goblin);
    expect(hero.gauge('hp').current).toBe(50);

    // ...but the hero's own outgoing damage is left alone by the same
    // listener: that action carried `direction: 'outgoing'`, so it skipped it.
    await engine.damage(goblin.gauge('hp'), 100, hero);
    expect(goblin.gauge('hp').current).toBe(0);
  });

  it('only modifies one direction when the modifier checks it', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    // A buff carrying an outgoing-only modifier: +10 outgoing damage.
    const powerUp = buff({
      name: 'Power Up',
      weight: 1,
      abilities: [
        passiveActionModifier({
          name: 'Momentum',
          transform: (action) => {
            if (action.direction !== 'outgoing' || action.type !== 'gauge') return action;
            return { ...action, update: (cur: number, max: number) => action.update(cur, max) - 10 };
          },
        }),
      ],
    });
    await engine.addBuff(hero, powerUp);

    // Outgoing: 10 damage became 20.
    await engine.damage(goblin.gauge('hp'), 10, hero);
    expect(goblin.gauge('hp').current).toBe(80);

    // Incoming to the hero is untouched: the modifier skipped it.
    await engine.damage(hero.gauge('hp'), 30, goblin);
    expect(hero.gauge('hp').current).toBe(70);
  });

  it('one listener can handle both directions', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    // Momentum: outgoing damage +10, incoming damage -10 — one listener,
    // branching on the direction the action itself carries.
    const momentum = passiveActionModifier({
      name: 'Momentum',
      transform: (action) => {
        if (action.type !== 'gauge') return action;
        if (action.direction === 'outgoing') {
          return { ...action, update: (cur: number, max: number) => action.update(cur, max) - 10 };
        }
        if (action.direction === 'incoming') {
          return { ...action, update: (cur: number, max: number) => action.update(cur, max) + 10 };
        }
        return action;
      },
    });
    await engine.addBuff(hero, buff({ name: 'Momentum', weight: 1, abilities: [momentum] }));

    await engine.damage(goblin.gauge('hp'), 30, hero); // outgoing: 40 damage
    expect(goblin.gauge('hp').current).toBe(60);

    await engine.damage(hero.gauge('hp'), 30, goblin); // incoming: 20 damage
    expect(hero.gauge('hp').current).toBe(80);
  });

  it('adds damage in both directions, with a bigger boost going in', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    // Bloodlust: +10 to the hero's outgoing damage, +30 to damage aimed at
    // the hero — one listener, branching on the action's direction.
    const bloodlust = passiveActionModifier({
      name: 'Bloodlust',
      transform: (action) => {
        if (action.type !== 'gauge') return action;
        if (action.direction === 'outgoing') {
          return { ...action, update: (cur: number, max: number) => action.update(cur, max) - 10 };
        }
        if (action.direction === 'incoming') {
          return { ...action, update: (cur: number, max: number) => action.update(cur, max) - 30 };
        }
        return action;
      },
    });
    await engine.addBuff(hero, buff({ name: 'Bloodlust', weight: 1, abilities: [bloodlust] }));

    // Outgoing: the hero's 30 damage becomes 40.
    await engine.damage(goblin.gauge('hp'), 30, hero);
    expect(goblin.gauge('hp').current).toBe(60);

    // Incoming: 30 damage aimed at the hero becomes 60.
    await engine.damage(hero.gauge('hp'), 30, goblin);
    expect(hero.gauge('hp').current).toBe(40);
  });

  it('leaves a gauge max alone — max changes are not actions', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    engine.registerCharacter(hero);

    // A buff with both a maxModifier and a passive modifier that rewrites
    // every gauge action it sees. The passive modifier has no effect on the
    // max: a gauge's maximum is derived from statuses, never written.
    await engine.addBuff(
      hero,
      buff({
        name: 'Fortify',
        weight: 1,
        abilities: [
          maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 }),
          passiveActionModifier({
            name: 'Rewriter',
            transform: (action) =>
              action.type === 'gauge'
                ? { ...action, update: (cur: number, max: number) => action.update(cur, max) + 1000 }
                : action,
          }),
        ],
      }),
    );

    expect(hero.gauge('hp').max).toBe(150); // the modifier cannot touch the derived max
    expect(hero.gauge('hp').current).toBe(100); // raising max does not refill the gauge
  });

  it('caps a set-to-half ability\'s damage at 10 (the min of the action and 10)', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', {
      maxHp: 100,
      skills: [
        skill({
          name: 'Mage',
          weight: 1,
          abilities: [
            // The ability: sets the target's HP to half its current value.
            cast({
              name: 'Drain Half',
              targeting: { who: 'enemy' },
              cast: (_ctx, t) => [
                setGauge(t.targets[0]!.gauge('hp'), Math.floor(t.targets[0]!.gauge('hp').current / 2)),
              ],
            }),
          ],
        }),
      ],
    });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    const drainHalf = hero.skills[0]!.abilities[0]!;

    // First, without any modifier: 100 hp -> half, so the ability deals 50.
    await engine.useAbility(hero, drainHalf, { targets: [goblin] });
    expect(goblin.gauge('hp').current).toBe(50);

    // Reset the goblin, then add the modifier as a buff: it deals the
    // minimum of what the action would do and 10 — half of 100 would be
    // 50 damage, so the target only takes 10 (100 -> 90).
    await engine.heal(goblin.gauge('hp'), 50);
    expect(goblin.gauge('hp').current).toBe(100);
    const capAtTen = passiveActionModifier({
      name: 'Cap at Ten',
      transform: (action) =>
        action.type !== 'gauge'
          ? action
          : { ...action, update: (cur: number, max: number) => Math.max(action.update(cur, max), cur - 10) },
    });
    await engine.addBuff(hero, buff({ name: 'Cap at Ten', weight: 1, abilities: [capAtTen] }));

    await engine.useAbility(hero, drainHalf, { targets: [goblin] });
    expect(goblin.gauge('hp').current).toBe(90);

    // The "min" side: small damage passes through untouched (min(5, 10) = 5).
    await engine.damage(goblin.gauge('hp'), 5, hero);
    expect(goblin.gauge('hp').current).toBe(85);
  });

  it('the target\'s incoming transformers wrap after the source\'s outgoing ones (phase order)', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    // Self-cast buff on the SOURCE: outgoing damage +5 (flat).
    const pumpUp = buff({
      name: 'Pump up',
      weight: 2,
      abilities: [
        passiveActionModifier({
          name: 'Pump up',
          transform: (action) =>
            action.direction !== 'outgoing' || action.type !== 'gauge'
              ? action
              : { ...action, update: (cur: number, max: number) => action.update(cur, max) - 5 },
        }),
      ],
    });
    // Enemy-cast buff on the TARGET: incoming damage halved (non-commutative,
    // so the order is observable).
    const terror = buff({
      name: 'Terror',
      weight: 1,
      abilities: [
        passiveActionModifier({
          name: 'Terror',
          transform: (action) =>
            action.direction !== 'incoming' || action.type !== 'gauge'
              ? action
              : {
                  ...action,
                  update: (cur: number, max: number) => {
                    const prev = action.update(cur, max);
                    return cur - (cur - prev) * 0.5;
                  },
                },
        }),
      ],
    });
    await engine.addBuff(hero, pumpUp);
    await engine.addBuff(goblin, terror);

    // The outgoing phase wraps first (+5 on the base), then the incoming
    // phase wraps on top (halve the result): (10 + 5) * 0.5 = 7.5 damage.
    // Weight does not interleave the phases — the target's buff is still
    // outside the source's even at a lower weight.
    await engine.damage(goblin.gauge('hp'), 10, hero);
    expect(goblin.gauge('hp').current).toBe(92.5);
  });

  it('a buff\'s declared direction decides where it lands among equal weights — not who cast it', async () => {
    // Two same-weight, direction-agnostic modifiers on the HERO, so their
    // position in the hero's status list decides the net order. Both
    // engines cast in the SAME order — Terror first, then Pump up — and
    // both are self-cast; only the declared directions differ.
    const pumpUp = buff({
      name: 'Pump up',
      weight: 1,
      direction: 'out to in',
      abilities: [
        passiveActionModifier({
          name: 'Pump up',
          transform: (action) =>
            action.type !== 'gauge'
              ? action
              : { ...action, update: (cur: number, max: number) => action.update(cur, max) - 5 },
        }),
      ],
    });
    const terror = buff({
      name: 'Terror',
      weight: 1,
      direction: 'in to out',
      abilities: [
        passiveActionModifier({
          name: 'Terror',
          transform: (action) =>
            action.type !== 'gauge'
              ? action
              : {
                  ...action,
                  update: (cur: number, max: number) => {
                    const prev = action.update(cur, max);
                    return cur - (cur - prev) * 0.5;
                  },
                },
        }),
      ],
    });

    // Declared: Pump up is 'out to in' — it lands at the FRONT of the
    // weight group even though it was cast second: [Pump up, Terror].
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    await engine.addBuff(hero, terror, hero);
    await engine.addBuff(hero, pumpUp, hero);
    expect(hero.statuses.map((s) => s.name)).toEqual(['Pump up', 'Terror']);

    // Pump up (front) is applied first — +5 on the base 10, then Terror
    // halves: (10 + 5) * 0.5 = 7.5 damage.
    await engine.damage(goblin.gauge('hp'), 10, hero);
    expect(goblin.gauge('hp').current).toBe(92.5);

    // Control — the same two buffs WITHOUT a declared direction keep stable
    // cast order: [Terror, Pump up] flips the net to 10 * 0.5 + 5 = 10
    // damage.
    const engine2 = createEngine();
    const hero2 = new Character('Hero', { maxHp: 100 });
    const goblin2 = new Character('Goblin', { maxHp: 100 });
    engine2.registerCharacter(hero2);
    engine2.registerCharacter(goblin2);
    await engine2.addBuff(hero2, buff({ name: 'Terror', weight: 1, abilities: terror.abilities ?? [] }), hero2);
    await engine2.addBuff(hero2, buff({ name: 'Pump up', weight: 1, abilities: pumpUp.abilities ?? [] }), hero2);
    expect(hero2.statuses.map((s) => s.name)).toEqual(['Terror', 'Pump up']);
    await engine2.damage(goblin2.gauge('hp'), 10, hero2);
    expect(goblin2.gauge('hp').current).toBe(90);
  });
});

describe('maxModifier — deriving a gauge\'s maximum from attached statuses', () => {
  it('adds to the wearer\'s max while attached (and reverts on removal)', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(hero, buff({ name: 'Fortify', weight: 1, abilities: [maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 })] }));

    expect(hero.gauge('hp').max).toBe(150);
    expect(hero.gauge('hp').current).toBe(100); // raising max does not refill the gauge

    // Current-value writes are untouched: damage is not +50.
    await engine.damage(hero.gauge('hp'), 30);
    expect(hero.gauge('hp').current).toBe(70);

    // Dispelling reverts the contribution automatically.
    await engine.removeBuff(hero, 'fortify');
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.gauge('hp').current).toBe(70); // lowering max back does not touch current
  });

  it('multiplies and adds: max = max * multiply + add', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(
      hero,
      buff({
        name: 'Giant Blood',
        weight: 1,
        abilities: [maxModifier({ gauge: 'hp', name: 'Giant Blood', multiply: 1.5, add: 50 })],
      }),
    );

    // 100 * 1.5 + 50 = 200.
    expect(hero.gauge('hp').max).toBe(200);
    expect(hero.gauge('hp').current).toBe(100);
  });

  it('composes in ascending weight order like every other transformer', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    engine.registerCharacter(hero);
    // Weight 1 first, weight 2 second: 100 + 50 = 150, then 150 * 1.5 + 50 = 275.
    await engine.addBuff(hero, buff({ name: 'Fortify', weight: 1, abilities: [maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 })] }));
    await engine.addBuff(hero, buff({ name: 'Giant Blood', weight: 2, abilities: [maxModifier({ gauge: 'hp', name: 'Giant Blood', multiply: 1.5, add: 50 })] }));
    expect(hero.gauge('hp').max).toBe(275);

    // Reversed weights: 100 * 1.5 + 50 = 200, then + 50 = 250.
    const engine2 = createEngine();
    const hero2 = new Character('Hero', { maxHp: 100 });
    engine2.registerCharacter(hero2);
    await engine2.addBuff(hero2, buff({ name: 'Giant Blood', weight: 1, abilities: [maxModifier({ gauge: 'hp', name: 'Giant Blood', multiply: 1.5, add: 50 })] }));
    await engine2.addBuff(hero2, buff({ name: 'Fortify', weight: 2, abilities: [maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 })] }));
    expect(hero2.gauge('hp').max).toBe(250);
  });

  it('applies a skill-provided maxModifier at registration', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', {
      maxHp: 100,
      skills: [
        skill({
          name: 'Giant Blood',
          weight: 1,
          abilities: [maxModifier({ gauge: 'hp', name: 'Giant Blood', multiply: 1.5, add: 50 })],
        }),
      ],
    });
    engine.registerCharacter(hero);
    expect(hero.gauge('hp').max).toBe(200);
    expect(hero.gauge('hp').current).toBe(100);
  });

  it('targets mana with gauge: \'mana\'', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 50 });
    engine.registerCharacter(hero);
    await engine.addBuff(
      hero,
      buff({ name: 'Arcane Well', weight: 1, abilities: [maxModifier({ name: 'Arcane Well', add: 30, gauge: 'mana' })] }),
    );
    expect(hero.gauge('mana').max).toBe(80);
    expect(hero.gauge('hp').max).toBe(100); // hp untouched
    await engine.removeBuff(hero, 'arcane-well');
    expect(hero.gauge('mana').max).toBe(50);
  });

  it('emits gauge:maxChanged when the derived max changes', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({
      onEvent: (event) => events.push(event),
    });
    const hero = new Character('Hero', { maxHp: 100 });
    engine.registerCharacter(hero);
    const maxChanged = (): Extract<GameEvent, { type: 'gauge:maxChanged' }>[] =>
      events.filter((e): e is Extract<GameEvent, { type: 'gauge:maxChanged' }> => e.type === 'gauge:maxChanged');

    await engine.addBuff(hero, buff({ name: 'Fortify', weight: 1, abilities: [maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 })] }));
    expect(maxChanged()).toHaveLength(1);
    expect(maxChanged()[0]!.from).toBe(100);
    expect(maxChanged()[0]!.to).toBe(150);

    // No event when a status without a maxModifier is added.
    await engine.addBuff(hero, buff({ name: 'Decoy', weight: 2 }));
    expect(maxChanged()).toHaveLength(1);

    await engine.removeBuff(hero, 'fortify');
    expect(maxChanged()).toHaveLength(2);
    expect(maxChanged()[1]!.from).toBe(150);
    expect(maxChanged()[1]!.to).toBe(100);
  });

  it('re-clamps the current value when a lowered max drops below it', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    engine.registerCharacter(hero);
    // A -30 max curse on the full hero: derived max 70 — the gauge clamps
    // down to it.
    await engine.addBuff(hero, buff({ name: 'Frail', weight: 1, abilities: [maxModifier({ gauge: 'hp', name: 'Frail', add: -30 })] }));
    expect(hero.gauge('hp').max).toBe(70);
    expect(hero.gauge('hp').current).toBe(70);
  });

  it('lets a status trigger on gauge:maxChanged — fired on buff add/remove only', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    engine.registerCharacter(hero);
    // A listener that pings the wearer whenever their max HP changes.
    await engine.addBuff(
      hero,
      buff({
        name: 'Resonance',
        weight: 1,
        abilities: [
          auto({
            name: 'Resonance Strike',
            event: 'gauge:maxChanged',
            when: (ctx) => ctx.event.gauge === hero.gauge('hp'),
            cast: (ctx) => [damage(ctx.self.gauge('hp'), 1)],
          }),
        ],
      }),
    );

    // Adding a maxModifier buff fires gauge:maxChanged → the trigger pings.
    await engine.addBuff(hero, buff({ name: 'Fortify', weight: 2, abilities: [maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 })] }));
    expect(hero.gauge('hp').max).toBe(150);
    expect(hero.gauge('hp').current).toBe(99);

    // Removing it fires again (max 150 → 100) → another ping.
    await engine.removeBuff(hero, 'fortify');
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.gauge('hp').current).toBe(98);

    // A status that does not change max fires nothing.
    await engine.addBuff(hero, buff({ name: 'Decoy', weight: 2 }));
    expect(hero.gauge('hp').current).toBe(98);
  });
});

describe('replacement effects — damage into mana loss', () => {
  it('redirectGauge turns incoming damage into mana loss (Mana Shield)', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 50 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    const shield = buff({
      name: 'Mana Shield',
      weight: 1,
      abilities: [
        passiveActionModifier({
          name: 'Mana Shield',
          transform: redirectGauge((t) => t.gauge('hp'), (t) => t.gauge('mana'), {
            direction: 'incoming',
            intent: 'damage',
          }),
        }),
      ],
    });
    await engine.addBuff(hero, shield);

    // Incoming damage becomes mana loss; HP never moves.
    await engine.damage(hero.gauge('hp'), 30, goblin);
    expect(hero.gauge('hp').current).toBe(100);
    expect(hero.gauge('mana').current).toBe(20);

    // The owner's outgoing damage is not redirected: the goblin still takes it.
    await engine.damage(goblin.gauge('hp'), 40, hero);
    expect(goblin.gauge('hp').current).toBe(60);

    // The intent filter ('damage') lets non-damage HP movement through.
    await engine.apply([changeGaugeBy(hero.gauge('hp'), -30, goblin)]);
    expect(hero.gauge('hp').current).toBe(70);
    expect(hero.gauge('mana').current).toBe(20);

    // Heals still heal HP.
    await engine.heal(hero.gauge('hp'), 10, goblin);
    expect(hero.gauge('hp').current).toBe(80);
    expect(hero.gauge('mana').current).toBe(20);
  });

  it('damage beyond the current mana is lost, not spilled onto HP', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 20 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    await engine.addBuff(
      hero,
      buff({
        name: 'Mana Shield',
        weight: 1,
        abilities: [
          passiveActionModifier({
            name: 'Mana Shield',
            transform: redirectGauge((t) => t.gauge('hp'), (t) => t.gauge('mana'), {
              direction: 'incoming',
              intent: 'damage',
            }),
          }),
        ],
      }),
    );

    // 60 damage with 20 mana: mana clamps at 0, the rest is simply lost.
    await engine.damage(hero.gauge('hp'), 60, goblin);
    expect(hero.gauge('mana').current).toBe(0);
    expect(hero.gauge('hp').current).toBe(100);
  });

  it('redirectGauge with direction outgoing burns the target\'s mana instead of HP', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 50 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    await engine.addBuff(
      hero,
      buff({
        name: 'Mana Burn',
        weight: 1,
        abilities: [
          passiveActionModifier({
            name: 'Mana Burn',
            transform: redirectGauge((t) => t.gauge('hp'), (t) => t.gauge('mana'), { direction: 'outgoing' }),
          }),
        ],
      }),
    );

    // The hero's attack drains the goblin's mana; its HP is safe.
    await engine.damage(goblin.gauge('hp'), 30, hero);
    expect(goblin.gauge('hp').current).toBe(100);
    expect(goblin.gauge('mana').current).toBe(20);

    // Damage aimed at the hero is untouched (the redirect is outgoing-only).
    await engine.damage(hero.gauge('hp'), 10, goblin);
    expect(hero.gauge('hp').current).toBe(90);
  });

  it('a replacement flows on through the rest of the phase — later transformers see it, direction carried', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 50 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    let seenDirection: string | undefined;

    // Weight 1: replace incoming HP damage with an equal mana loss — the raw
    // replaceAction spelling of the shield.
    await engine.addBuff(
      hero,
      buff({
        name: 'Mana Shield',
        weight: 1,
        abilities: [
          passiveActionModifier({
            name: 'Mana Shield',
            transform: replaceAction(
              (action, ctx) =>
                action.type === 'gauge' &&
                action.direction === 'incoming' &&
                ctx.target?.gauge('hp') === action.target &&
                gaugeDelta(action) < 0,
              (action, ctx) => ({
                type: 'gauge',
                target: ctx.target!.gauge('mana'),
                update: (cur: number) => cur + gaugeDelta(action),
                intent: 'damage',
                source: action.source,
              }),
            ),
          }),
        ],
      }),
    );
    // Weight 2: halve any incoming mana loss — and record what it saw.
    await engine.addBuff(
      hero,
      buff({
        name: 'Mana Absorb',
        weight: 2,
        abilities: [
          passiveActionModifier({
            name: 'Mana Absorb',
            transform: (action) => {
              if (action.type !== 'gauge' || action.direction !== 'incoming') return action;
              seenDirection = action.direction;
              if (action.target !== hero.gauge('mana')) return action;
              return {
                ...action,
                update: (cur: number, max: number) => cur - (cur - action.update(cur, max)) * 0.5,
              };
            },
          }),
        ],
      }),
    );

    // The shield's replacement (mana -30) flowed through the weight-2
    // modifier, which halved it: 50 -> 35. HP never moved, and the carried
    // direction reached the later transformer.
    await engine.damage(hero.gauge('hp'), 30, goblin);
    expect(hero.gauge('hp').current).toBe(100);
    expect(hero.gauge('mana').current).toBe(35);
    expect(seenDirection).toBe('incoming');
  });
});
