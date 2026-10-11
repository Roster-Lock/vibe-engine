/**
 * Transformations — the `transform` action and the form stack
 * (docs/spec/03-actions.md §2.5, docs/spec/04-character-status.md §6,
 * docs/design/01-entities.md "Identity vs form").
 *
 * A transform swaps a character's *form* — skills, gauge maxes (current
 * clamps down), name, icon — while the identity (the Character object)
 * never changes and buffs persist. Transforms stack, keyed by **source**:
 * a buff-keyed transform pops (reverting the form) when that buff is
 * removed; a character source — or no source — is permanent.
 */
import { describe, expect, it } from 'vitest';
import {
  Character,
  GameEngine,
  addBuff,
  auto,
  buff,
  damage,
  heal,
  maxModifier,
  passiveActionModifier,
  popTransform,
  removeBuff,
  restriction,
  skill,
  transform,
  transformModifier,
  type GameEvent,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';

/** A buff whose `buff:added` self-trigger transforms its own wearer. */
function selfTransformingBuff(name: string, form: Parameters<typeof transform>[1]): ReturnType<typeof buff> {
  return buff({
    name,
    weight: 1,
    abilities: [
      auto({
        name: `Apply ${name}`,
        event: 'buff:added',
        when: (ctx) => ctx.event.buff.uid === ctx.status.uid,
        cast: (ctx) => [transform(ctx.self, form)],
      }),
    ],
  });
}

/** A hex: a buff tied to a form — the form pins while the buff is attached. */
function hex(name: string, form: Parameters<typeof transform>[1]): ReturnType<typeof buff> {
  return buff({ name, weight: 1, abilities: [transformModifier({ name: `${name} Form`, form })] });
}

/**
 * A **timed hex**: a transformation tied to the time its buff stays alive.
 * Alongside the `transformModifier` tie, the buff carries a `turn:start`
 * countdown in its own `vars`; when it reaches 0 the buff removes itself,
 * and the removal pops the transformation with it (the same expiry shape as
 * the `doomClock` example buff — `src/examples/08-28-2026/buffs.ts`).
 */
function timedHex(
  name: string,
  form: Parameters<typeof transform>[1],
  turns: number,
): ReturnType<typeof buff> {
  return buff({
    name,
    weight: 1,
    variables: () => ({ remaining: turns }),
    abilities: [
      transformModifier({ name: `${name} Form`, form }),
      auto({
        name: `${name} Timer`,
        event: 'turn:start',
        cast: (ctx) => {
          const remaining = Number(ctx.status.vars.remaining) - 1;
          ctx.status.vars.remaining = remaining;
          // The ticker lives on the buff, so the owning status is the buff
          // itself — remove exactly that instance when the countdown ends.
          return remaining <= 0 && ctx.status.type === 'buff' ? [removeBuff(ctx.self, ctx.status)] : [];
        },
      }),
    ],
  });
}

describe('the transform action — swapping a character\'s form', () => {
  it('swaps name, the hp max (current clamps down) and skills', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      skills: [skill({ name: 'Strike', weight: 1, abilities: [] })],
    });
    engine.registerCharacter(hero);

    await engine.apply([
      transform(hero, {
        name: 'Dire Wolf',
        gauges: { hp: 50 },
        skills: [skill({ name: 'Wolf Bite', weight: 2 })],
      }),
    ]);

    expect(hero.name).toBe('Dire Wolf');
    expect(hero.gauge('hp').max).toBe(50);
    expect(hero.gauge('hp').current).toBe(50); // clamped down from 100
    // The base skill left; the transformed skill (with fresh vars) is there.
    expect(hero.skills.map((s) => s.name)).toEqual(['Wolf Bite']);
    expect(hero.skills[0]!.target).toBe(hero);
  });

  it('raising max never refills the gauge', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100, hp: 40 });
    engine.registerCharacter(hero);

    await engine.apply([transform(hero, { gauges: { hp: 200 }})]);
    expect(hero.gauge('hp').max).toBe(200);
    expect(hero.gauge('hp').current).toBe(40); // untouched — no refill on raise
  });

  it('swaps a gauge max by id (mana)', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 50, mana: 20 });
    engine.registerCharacter(hero);

    await engine.apply([transform(hero, { gauges: { mana: 80 }})]);
    expect(hero.gauge('mana').max).toBe(80);
    expect(hero.gauge('mana').current).toBe(20); // raising does not refill
    expect(hero.gauge('hp').max).toBe(100); // hp untouched

    await engine.apply([transform(hero, { gauges: { mana: 10 }})]);
    expect(hero.gauge('mana').max).toBe(10);
    expect(hero.gauge('mana').current).toBe(10); // clamped down
  });

  it('a transform that does not name skills keeps the current skills', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      skills: [skill({ name: 'Strike', weight: 1 })],
    });
    engine.registerCharacter(hero);

    await engine.apply([transform(hero, { name: 'Wolf', gauges: { hp: 60 }})]);

    expect(hero.name).toBe('Wolf');
    expect(hero.gauge('hp').max).toBe(60);
    expect(hero.skills.map((s) => s.name)).toEqual(['Strike']); // untouched
  });

  it('leaves buffs attached across the swap, with their abilities still live', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    await engine.addBuff(
      hero,
      buff({
        name: 'Fury',
        weight: 1,
        abilities: [
          passiveActionModifier({
            name: 'Fury',
            transform: (action) =>
              action.direction !== 'outgoing' || action.type !== 'gauge'
                ? action
                : { ...action, update: (cur: number, max: number) => action.update(cur, max) - 10 },
          }),
        ],
      }),
    );

    await engine.apply([transform(hero, { name: 'Wolf', gauges: { hp: 60 }})]);

    expect(hero.buffs.map((b) => b.name)).toEqual(['Fury']); // persisted
    // The buff's transformer still runs on the transformed character.
    await engine.damage(goblin.gauge('hp'), 10, hero);
    expect(goblin.gauge('hp').current).toBe(80); // 10 became 20
  });

  it('flows through the pipeline like every action (incoming, with direction)', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    const seen: Array<{ type: string; direction: string | undefined }> = [];
    await engine.addBuff(
      hero,
      buff({
        name: 'Watcher',
        weight: 1,
        abilities: [
          passiveActionModifier({
            name: 'Watch',
            transform: (action, ctx) => {
              seen.push({ type: action.type, direction: action.direction });
              return action;
            },
          }),
        ],
      }),
    );

    await engine.apply([transform(hero, { name: 'Wolf' })]);
    expect(seen).toEqual([{ type: 'transform', direction: 'incoming' }]);
    expect(hero.name).toBe('Wolf'); // the transformer passed it through
  });
});

describe('the transform stack — keyed by source, popped on removal', () => {
  it('stacks: the last transform that names an aspect wins', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    await engine.addBuff(hero, selfTransformingBuff('Form A', { name: 'A', gauges: { hp: 60 }}));
    await engine.addBuff(hero, selfTransformingBuff('Form B', { name: 'B', gauges: { hp: 90, mana: 20 }}));

    expect(hero.name).toBe('B');
    expect(hero.gauge('hp').max).toBe(90);
    expect(hero.gauge('mana').max).toBe(20);
    expect(hero.transforms).toHaveLength(2);

    // Popping the top (dispelling Form B) reverts to A's form — A names no
    // maxMana, so the base form's mana max shows.
    await engine.removeBuff(hero, 'form-b');
    expect(hero.name).toBe('A');
    expect(hero.gauge('hp').max).toBe(60);
    expect(hero.gauge('mana').max).toBe(100);
    expect(hero.transforms).toHaveLength(1);

    // Popping the last reverts to the base form.
    await engine.removeBuff(hero, 'form-a');
    expect(hero.name).toBe('Hero');
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.transforms).toHaveLength(0);
  });

  it('reverts the form when its keying buff is dispelled', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    await engine.addBuff(hero, selfTransformingBuff('Polymorph', { name: 'Sheep', gauges: { hp: 5 }}));
    expect(hero.name).toBe('Sheep');
    expect(hero.gauge('hp').max).toBe(5);
    expect(hero.gauge('hp').current).toBe(5); // clamped down

    await engine.removeBuff(hero, 'polymorph');

    expect(hero.name).toBe('Hero');
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.gauge('hp').current).toBe(5); // raising max back never refills
    expect(hero.transforms).toHaveLength(0);
  });

  it('pops when its keying buff dies with its wearer', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    await engine.addBuff(hero, selfTransformingBuff('Polymorph', { name: 'Sheep', gauges: { hp: 5 }}));
    expect(hero.transforms).toHaveLength(1);

    // A killing blow (HP is the life gauge) destroys the hero — the
    // polymorph buff dies with its wearer (removedOnDefeat defaults to
    // true) and its transform pops.
    await engine.damage(hero.gauge('hp'), 999, goblin).catch(() => undefined);
    expect(hero.transforms).toHaveLength(0);
  });

  it('pops a transform on another character when its keying buff is dispelled', async () => {
    const engine = createEngine();
    const mage = new Character('Mage', { maxHp: 100, maxMana: 100 });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(mage);
    engine.registerCharacter(goblin);

    // A buff on the mage that transforms an enemy: the key is the mage's
    // buff instance, but the form lands on the goblin.
    const hex = buff({
      name: 'Hex',
      weight: 1,
      abilities: [
        auto({
          name: 'Sheepify',
          event: 'buff:added',
          when: (ctx) => ctx.event.buff.uid === ctx.status.uid,
          targeting: { who: 'enemy' },
          cast: (ctx, t) =>
            t && t.targets.length > 0 ? [transform(t.targets[0]!, { name: 'Sheep', gauges: { hp: 5 }})] : [],
        }),
      ],
    });
    await engine.addBuff(mage, hex);
    expect(goblin.name).toBe('Sheep');
    expect(goblin.gauge('hp').max).toBe(5);

    // Dispelling the curse (on the mage) pops the transform (on the goblin).
    await engine.removeBuff(mage, 'hex');
    expect(goblin.name).toBe('Goblin');
    expect(goblin.gauge('hp').max).toBe(100);
    expect(goblin.transforms).toHaveLength(0);
  });

  it('a permanent transform (character source) survives buff removal', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const druid = new Character('Druid', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(druid);

    // Cast by a character: keyed by the druid — nothing pops a character
    // key, so the form is permanent.
    await engine.apply([transform(hero, { name: 'Bear', gauges: { hp: 120 }})], { source: druid });
    expect(hero.name).toBe('Bear');

    await engine.addBuff(hero, buff({ name: 'Decoy', weight: 1 }));
    await engine.removeBuff(hero, 'decoy'); // unrelated removal — no pop

    expect(hero.name).toBe('Bear');
    expect(hero.gauge('hp').max).toBe(120);
    expect(hero.transforms).toHaveLength(1);
    expect(hero.transforms[0]!.source).toBe(druid);
  });

  it('a sourceless transform is permanent too', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    await engine.apply([transform(hero, { name: 'Lich', gauges: { hp: 150 }})]);
    expect(hero.transforms[0]!.source).toBeUndefined();

    await engine.addBuff(hero, buff({ name: 'Decoy', weight: 1 }));
    await engine.removeBuff(hero, 'decoy');
    expect(hero.name).toBe('Lich');
    expect(hero.gauge('hp').max).toBe(150);
  });

  it('composes with maxModifier statuses over the transformed base', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    await engine.addBuff(hero, selfTransformingBuff('Polymorph', { gauges: { hp: 50 }}));
    expect(hero.gauge('hp').max).toBe(50);

    // The maxModifier rewrites the *transformed* base: 50 + 50 = 100.
    await engine.addBuff(hero, buff({ name: 'Fortify', weight: 1, abilities: [maxModifier({ gauge: 'hp', name: 'Fortify', add: 50 })] }));
    expect(hero.gauge('hp').max).toBe(100);

    // Reverting the form restores the original base: 100 + 50 = 150.
    await engine.removeBuff(hero, 'polymorph');
    expect(hero.gauge('hp').max).toBe(150);
  });

  it('a form that shrank max HP keeps the shrunken max as the derived base', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(hero, selfTransformingBuff('Polymorph', { gauges: { hp: 30 }}));
    await engine.damage(hero.gauge('hp'), 10); // 30 → 20
    expect(hero.gauge('hp').current).toBe(20);

    // Revert: max back to 100, current stays 20 (no refill).
    await engine.removeBuff(hero, 'polymorph');
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.gauge('hp').current).toBe(20);
  });

  it('transformed skills are live, and reverting detaches their triggers', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    const howl = skill({
      name: 'Wolf Howl',
      weight: 1,
      abilities: [auto({ name: 'Howl', event: 'turn:start', cast: (ctx) => [damage(ctx.self.gauge('hp'), 1)] })],
    });

    await engine.addBuff(
      hero,
      selfTransformingBuff('Polymorph', { name: 'Wolf', skills: [howl] }),
    );
    await startTurn(engine); // the transformed skill hears the turn
    expect(hero.gauge('hp').current).toBe(99);

    await engine.removeBuff(hero, 'polymorph'); // revert — base skills return
    expect(hero.skills.map((s) => s.name)).toEqual([]);
    await startTurn(engine); // the howl trigger is gone
    expect(hero.gauge('hp').current).toBe(99);
  });

  it('driving max HP to 0 destroys the character (the derived-max rule)', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    // HP is the life gauge: a form whose max HP is 0 (a maxModifier on HP
    // would do the same) drives the derived max to 0 — the death.
    await engine.apply([transform(hero, { gauges: { hp: 0 }})]);
    expect(hero.destroyed).toBe(true);
  });
});

describe('the character:transformed event', () => {
  const transformedEvents = (events: GameEvent[]): Extract<GameEvent, { type: 'character:transformed' }>[] =>
    events.filter((e): e is Extract<GameEvent, { type: 'character:transformed' }> => e.type === 'character:transformed');

  it('fires on push, carrying the form, reason and source', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const druid = new Character('Druid', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(druid);

    await engine.apply([transform(hero, { name: 'Bear', gauges: { hp: 120 }})], { source: druid });

    const fired = transformedEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.reason).toBe('pushed');
    expect(fired[0]!.character).toBe(hero);
    // A form is gauge-keyed: it names gauges by id, so an announced form
    // carries only gauge ids.
    expect(fired[0]!.form).toEqual({ name: 'Bear', gauges: { hp: 120 } });
    expect('source' in fired[0]! && fired[0]!.source).toBe(druid);
    // The push is announced before the numeric part (gauge:maxChanged).
    const types = events.map((e) => e.type);
    expect(types.indexOf('character:transformed')).toBeLessThan(types.indexOf('gauge:maxChanged'));
  });

  it('a sourceless push fires the no-source version', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    await engine.apply([transform(hero, { name: 'Wolf' })]);

    const fired = transformedEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.reason).toBe('pushed');
    expect('source' in fired[0]!).toBe(false);
  });

  it('fires on pop with reason \'popped\' and the form that left', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    const form = { name: 'Sheep', gauges: { hp: 5 } };
    await engine.addBuff(hero, selfTransformingBuff('Polymorph', form));

    await engine.removeBuff(hero, 'polymorph');

    const fired = transformedEvents(events);
    expect(fired).toHaveLength(2); // push + pop
    expect(fired[0]!.reason).toBe('pushed');
    expect(fired[1]!.reason).toBe('popped');
    expect(fired[1]!.character).toBe(hero);
    expect(fired[1]!.form).toEqual({ name: 'Sheep', gauges: { hp: 5 } });
    // The removal carried no source, so the pop is the no-source version.
    expect('source' in fired[1]!).toBe(false);
  });

  it('a dispel with a source carries it on the pop', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const cleric = new Character('Cleric', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(cleric);
    await engine.addBuff(hero, selfTransformingBuff('Polymorph', { name: 'Sheep', gauges: { hp: 5 }}));

    await engine.removeBuff(hero, 'polymorph', cleric);

    const pop = transformedEvents(events).find((e) => e.reason === 'popped')!;
    expect('source' in pop && pop.source).toBe(cleric);
  });

  it('a trigger can listen to it — "when I transform, gain 5"', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100, hp: 90 });
    engine.registerCharacter(hero);
    await engine.addBuff(
      hero,
      buff({
        name: 'Shapeshifter',
        weight: 1,
        abilities: [
          auto({
            name: 'Second Skin',
            event: 'character:transformed',
            when: (ctx) => ctx.event.character === ctx.self && ctx.event.reason === 'pushed',
            cast: (ctx) => [heal(ctx.self.gauge('hp'), 5)],
          }),
        ],
      }),
    );

    await engine.apply([transform(hero, { name: 'Wolf' })]);
    expect(hero.gauge('hp').current).toBe(95); // the trigger heard the push
    // A second push fires it again — the trigger is live across pushes.
    await engine.apply([transform(hero, { name: 'Bear' })]);
    expect(hero.gauge('hp').current).toBe(100);
  });
});

describe('transformModifier — a buff tied to a transformation', () => {
  it('transforms its wearer while attached and reverts on removal', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    await engine.addBuff(hero, hex('Hex', { name: 'Toad', gauges: { hp: 3 }}));

    expect(hero.name).toBe('Toad');
    expect(hero.gauge('hp').max).toBe(3);
    expect(hero.gauge('hp').current).toBe(3); // clamped down
    expect(hero.transforms).toHaveLength(1);
    expect(hero.transforms[0]!.tied).toBe(true); // a live tie
    expect(hero.transforms[0]!.source).toBe(hero.findBuff('hex'));

    // The tie pops with the buff — the hero returns to normal.
    await engine.removeBuff(hero, 'hex');
    expect(hero.name).toBe('Hero');
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.transforms).toHaveLength(0);
  });

  it('pins the form: a push while the tie is active is recorded but does not change the form', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(hero, hex('Hex', { name: 'Toad', gauges: { hp: 3 }}));

    // An opponent pushes "Demon form" while the hex is active — the attempt
    // is recorded underneath, but the hex's form is what the hero looks like.
    await engine.apply([transform(hero, { name: 'Demon', gauges: { hp: 200 }})]);

    expect(hero.name).toBe('Toad');
    expect(hero.gauge('hp').max).toBe(3);
    expect(hero.transforms).toHaveLength(2);
    expect(hero.transforms[1]!.tied).toBe(false); // the suppressed attempt

    // Dispelling the hex releases the pinned form — the Demon surfaces.
    await engine.removeBuff(hero, 'hex');
    expect(hero.name).toBe('Demon');
    expect(hero.gauge('hp').max).toBe(200);
    expect(hero.transforms).toHaveLength(1);
  });

  it('a suppressed push emits no character:transformed event (nothing changed)', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(hero, hex('Hex', { name: 'Toad', gauges: { hp: 3 }}));
    const transformed = events.filter((e) => e.type === 'character:transformed');

    await engine.apply([transform(hero, { name: 'Demon', gauges: { hp: 200 }})]);

    expect(transformed).toHaveLength(1); // only the tie's own push
    expect(transformed[0]!.reason).toBe('pushed');
    expect(hero.name).toBe('Toad');
  });

  it('ties stack in buff order — equal weights keep application order', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    // Both weight 1: the buff stack sorts stably, so the more recent hex
    // is the most outgoing.
    await engine.addBuff(hero, hex('Hex', { name: 'Toad', gauges: { hp: 3 }}));
    await engine.addBuff(hero, hex('Rat Hex', { name: 'Rat', gauges: { hp: 2 }}));

    expect(hero.name).toBe('Rat'); // the most recent of equal weights
    expect(hero.gauge('hp').max).toBe(2);

    await engine.removeBuff(hero, 'rat-hex');
    expect(hero.name).toBe('Toad'); // back to the older tie
    expect(hero.gauge('hp').max).toBe(3);

    await engine.removeBuff(hero, 'hex');
    expect(hero.name).toBe('Hero');
    expect(hero.gauge('hp').max).toBe(100);
  });

  it('the strongest tie wins by weight — the most outgoing hex is current', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    // Hex1 is the stronger curse (weight 2); hex2 lands later but weaker.
    await engine.addBuff(hero, buff({ name: 'Hex', weight: 2, abilities: [transformModifier({ name: 'Toad Form', form: { name: 'Toad', gauges: { hp: 3 }} })] }));
    await engine.addBuff(hero, buff({ name: 'Rat Hex', weight: 1, abilities: [transformModifier({ name: 'Rat Form', form: { name: 'Rat', gauges: { hp: 2 }} })] }));

    expect(hero.name).toBe('Toad'); // weight 2 beats the newer weight 1
    expect(hero.gauge('hp').max).toBe(3);

    // Dispelling the strongest reveals the next strongest.
    await engine.removeBuff(hero, 'hex');
    expect(hero.name).toBe('Rat');
    expect(hero.gauge('hp').max).toBe(2);

    await engine.removeBuff(hero, 'rat-hex');
    expect(hero.name).toBe('Hero');
    expect(hero.gauge('hp').max).toBe(100);
  });

  it('the outermost transformation buff is the active version — newest out-to-in lands outside', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    // Both declared `direction: 'out to in'`: among equal weights the newest
    // tie lands at the **front** of the buff stack — the outside — and the
    // fold makes that outermost buff's form the character's form.
    await engine.addBuff(
      hero,
      buff({ name: 'Hex', weight: 1, direction: 'out to in', abilities: [transformModifier({ name: 'Toad Form', form: { name: 'Toad', gauges: { hp: 3 }} })] }),
    );
    await engine.addBuff(
      hero,
      buff({ name: 'Rat Hex', weight: 1, direction: 'out to in', abilities: [transformModifier({ name: 'Rat Form', form: { name: 'Rat', gauges: { hp: 2 }} })] }),
    );

    // The newest out-to-in tie sits on the outside of the stack...
    expect(hero.buffs.map((b) => b.name)).toEqual(['Rat Hex', 'Hex']);
    // ...and the outermost buff's form is the active version.
    expect(hero.name).toBe('Rat');
    expect(hero.gauge('hp').max).toBe(2);
    expect(hero.transforms.some((t) => t.tied && t.source === hero.buffs[0])).toBe(true);

    // Removing the outermost reveals the next one out.
    await engine.removeBuff(hero, 'rat-hex');
    expect(hero.name).toBe('Toad');
    expect(hero.gauge('hp').max).toBe(3);
    expect(hero.transforms.some((t) => t.tied && t.source === hero.buffs[0])).toBe(true);

    // Removing the last reverts to the base form.
    await engine.removeBuff(hero, 'hex');
    expect(hero.name).toBe('Hero');
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.transforms).toHaveLength(0);
  });

  it('pushing a weaker hex while a stronger one holds changes nothing', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(hero, buff({ name: 'Hex', weight: 2, abilities: [transformModifier({ name: 'Toad Form', form: { name: 'Toad', gauges: { hp: 3 }} })] }));
    const transformed = events.filter((e) => e.type === 'character:transformed');

    await engine.addBuff(hero, buff({ name: 'Rat Hex', weight: 1, abilities: [transformModifier({ name: 'Rat Form', form: { name: 'Rat', gauges: { hp: 2 }} })] }));

    expect(hero.name).toBe('Toad'); // the stronger hex still shows
    expect(transformed).toHaveLength(1); // the weaker push changed nothing
  });

  it('a suppressed push does not reset the tie\'s skill variables', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    const ticked: number[] = [];
    await engine.addBuff(
      hero,
      hex('Hex', {
        name: 'Toad',
        gauges: { hp: 20 },
        skills: [
          skill({
            name: 'Croak',
            weight: 1,
            variables: () => ({ count: 0 }),
            abilities: [
              auto({
                name: 'Croak',
                event: 'turn:start',
                cast: (ctx) => {
                  const vars = ctx.self.findStatus('croak')?.vars;
                  if (vars && typeof vars.count === 'number') vars.count += 1;
                  ticked.push(vars ? Number(vars.count) : 0);
                  return [];
                },
              }),
            ],
          }),
        ],
      }),
    );
    await startTurn(engine); // croak ticks once
    expect(ticked).toEqual([1]);

    // A suppressed push must not swap the tie's skills (that would reset
    // the croak's vars to a fresh copy).
    await engine.apply([transform(hero, { name: 'Demon' })]);
    await startTurn(engine);
    expect(ticked).toEqual([1, 2]); // the same instance kept counting
  });
});

describe('the popTransform action — popping a transformation directly', () => {
  it('pops the top transformation, returning to the previous state', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const mage = new Character('Mage', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(mage);
    // A permanent Wolf, then a Demon pushed on top (keyed by the mage —
    // the stack is keyed by source, so two different sources stack).
    await engine.apply([transform(hero, { name: 'Wolf', gauges: { hp: 60 }})]);
    await engine.apply([transform(hero, { name: 'Demon', gauges: { hp: 200 }}, mage)]);

    await engine.apply([popTransform(hero, mage)]);

    expect(hero.name).toBe('Wolf'); // the previous state
    expect(hero.gauge('hp').max).toBe(60);
    expect(hero.transforms).toHaveLength(1);
  });

  it('pops to the base form when nothing else is stacked', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.apply([transform(hero, { name: 'Demon', gauges: { hp: 200 }})]);

    await engine.apply([popTransform(hero)]);
    expect(hero.name).toBe('Hero');
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.transforms).toHaveLength(0);
  });

  it('keeps the hex: popping a hexed character is refused (the tie pins)', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(hero, hex('Hex', { name: 'Toad', gauges: { hp: 3 }}));
    await engine.apply([transform(hero, { name: 'Demon', gauges: { hp: 200 }})]);

    // The current effective form is the tie's — popping is refused: the
    // state-based rule re-asserts the hex's form, and the buff stays.
    await engine.apply([popTransform(hero)]);

    expect(hero.name).toBe('Toad');
    expect(hero.gauge('hp').max).toBe(3);
    expect(hero.hasStatus('hex')).toBe(true); // the hex is kept
    expect(hero.transforms).toHaveLength(2); // the suppressed Demon too
  });

  it('is a no-op on an empty stack', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    await engine.apply([popTransform(hero)]);
    expect(hero.name).toBe('Hero');
    expect(hero.transforms).toHaveLength(0);
  });

  it('is blocked by a form lock restriction', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.apply([transform(hero, { name: 'Demon', gauges: { hp: 200 }})]);
    await engine.addBuff(hero, buff({ name: 'Form Lock', weight: 1, abilities: [restriction({ on: 'transform' })] }));

    await engine.apply([popTransform(hero)]);

    expect(hero.name).toBe('Demon'); // the pop was a no-op
    expect(hero.transforms).toHaveLength(1);
  });

  it('emits the popped event', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const mage = new Character('Mage', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(mage);
    await engine.apply([transform(hero, { name: 'Demon', gauges: { hp: 200 }}, mage)]);

    await engine.apply([popTransform(hero, mage)]);

    const popped = events.find((e): e is Extract<GameEvent, { type: 'character:transformed' }> => e.type === 'character:transformed' && e.reason === 'popped')!;
    expect(popped.character).toBe(hero);
    expect(popped.form).toEqual({ name: 'Demon', gauges: { hp: 200 } });
    expect('source' in popped && popped.source).toBe(mage);
  });
});

describe('the form-stack SBA step', () => {
  it('cleans a dangling tie — a keying buff removed by the bypass path', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(hero, hex('Hex', { name: 'Toad', gauges: { hp: 3 }}));
    const hexBuff = hero.findBuff('hex')!;

    // Content bypasses the engine and yanks the buff off directly — the tie
    // is now dangling. The next settle's form-stack SBA step removes it.
    hero.removeStatus(hexBuff);
    expect(hero.name).toBe('Toad'); // still pinned until the pass runs

    await engine.heal(hero.gauge('hp'), 1); // a settle

    expect(hero.name).toBe('Hero'); // the pass reverted the form
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.transforms).toHaveLength(0);
    const popped = events.some(
      (e): e is Extract<GameEvent, { type: 'character:transformed' }> =>
        e.type === 'character:transformed' && e.reason === 'popped',
    );
    expect(popped).toBe(true);
  });
});

describe('transform gates', () => {
  it('a "cannot be transformed" restriction blocks the action (a no-op)', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(
      hero,
      buff({
        name: 'Form Lock',
        weight: 1,
        abilities: [restriction({ name: 'Form Lock', on: 'transform' })],
      }),
    );

    await engine.apply([transform(hero, { name: 'Sheep', gauges: { hp: 5 }})]);

    expect(hero.name).toBe('Hero');
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.transforms).toHaveLength(0);
  });

  it('emits gauge:maxChanged when a transform changes a max', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    const maxChanged = (): Extract<GameEvent, { type: 'gauge:maxChanged' }>[] =>
      events.filter((e): e is Extract<GameEvent, { type: 'gauge:maxChanged' }> => e.type === 'gauge:maxChanged');

    await engine.addBuff(hero, selfTransformingBuff('Polymorph', { gauges: { hp: 50 }}));
    expect(maxChanged()).toHaveLength(1);
    expect(maxChanged()[0]!.from).toBe(100);
    expect(maxChanged()[0]!.to).toBe(50);

    // Reverting fires it again.
    await engine.removeBuff(hero, 'polymorph');
    expect(maxChanged()).toHaveLength(2);
    expect(maxChanged()[1]!.from).toBe(50);
    expect(maxChanged()[1]!.to).toBe(100);
  });

  it('applies a transform before registration — the derived max is silent at setup', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    await engine.apply([transform(hero, { gauges: { hp: 40 }, skills: [skill({ name: 'Wolf Bite', weight: 1 })] })]);

    engine.registerCharacter(hero);

    expect(hero.gauge('hp').max).toBe(40);
    expect(hero.skills.map((s) => s.name)).toEqual(['Wolf Bite']);
  });

  it('healing is unaffected by a transform that only changes the form', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100, hp: 30 });
    engine.registerCharacter(hero);
    await engine.apply([transform(hero, { name: 'Wolf' })]);
    await engine.heal(hero.gauge('hp'), 20);
    expect(hero.gauge('hp').current).toBe(50);
  });
});

describe('timed transformations — a transformation tied to how long its buff is alive', () => {
  it('when two transformation buffs are active, expiring the inactive one removes its entry from the stack', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    // Two transformation buffs of equal weight: the last-applied (Hex) is
    // the active form; the older Lesser Hex is suppressed — its form shows
    // only until the Hex lands, then stays hidden while its buff lives.
    await engine.addBuff(hero, timedHex('Lesser Hex', { name: 'Rat', gauges: { hp: 2 }}, 1));
    await engine.addBuff(hero, hex('Hex', { name: 'Toad', gauges: { hp: 3 }}));

    expect(hero.name).toBe('Toad'); // the active transformation
    expect(hero.gauge('hp').max).toBe(3);
    expect(hero.transforms).toHaveLength(2);
    const lesser = hero.findBuff('lesser-hex')!;
    const transformed = (): Extract<GameEvent, { type: 'character:transformed' }>[] =>
      events.filter((e): e is Extract<GameEvent, { type: 'character:transformed' }> => e.type === 'character:transformed');

    // One turn passes: the Lesser Hex's countdown hits zero and the buff
    // removes itself. Its transformation is removed from the stack — even
    // though its form never showed — while the visible form is unchanged.
    await startTurn(engine);

    expect(hero.hasStatus('lesser-hex')).toBe(false);
    expect(hero.transforms).toHaveLength(1);
    expect(hero.transforms[0]!.source).toBe(hero.findBuff('hex'));
    expect(hero.transforms.some((t) => t.source === lesser)).toBe(false); // gone
    expect(hero.name).toBe('Toad'); // nothing observable changed
    expect(hero.gauge('hp').max).toBe(3);
    // The suppressed entry's pop changes nothing, so no pop is announced.
    expect(transformed().filter((e) => e.reason === 'popped')).toHaveLength(0);
    const destroyed = events.filter(
      (e): e is Extract<GameEvent, { type: 'buff:destroyed' }> => e.type === 'buff:destroyed',
    );
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]!.buff).toBe(lesser);
    expect(destroyed[0]!.reason).toBe('removed');
    // The timer is the buff's own ability, so the expiry is attributed to
    // the buff itself (the doomClock attribution).
    expect('source' in destroyed[0]! && destroyed[0]!.source).toBe(lesser);

    // With the expired entry gone, dispelling the active hex reverts to the
    // base form — the expired Rat form does NOT surface.
    await engine.removeBuff(hero, 'hex');
    expect(hero.name).toBe('Hero');
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.transforms).toHaveLength(0);
    expect(transformed().filter((e) => e.reason === 'popped')).toHaveLength(1);
    expect(transformed().filter((e) => e.reason === 'popped')[0]!.form).toEqual({ name: 'Toad', gauges: { hp: 3 } });
  });

  it('the canonical pattern — the timer lives on the transformation\'s abilities, and expiry removes the buff', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    // The buff declares only the tie — the expiration timer rides on a skill
    // the transformation grants (an ability of the form), not on the buff.
    const werewolf = buff({
      name: 'Werewolf',
      weight: 1,
      abilities: [
        transformModifier({
          name: 'Wolf Form',
          form: {
            name: 'Dire Wolf',
            gauges: { hp: 80 },
            skills: [
              skill({
                name: 'Wolf Timer',
                weight: 1,
                variables: () => ({ turnsLeft: 2 }),
                abilities: [
                  auto({
                    name: 'Time Out',
                    event: 'turn:start',
                    cast: (ctx) => {
                      const left = Number(ctx.status.vars.turnsLeft) - 1;
                      ctx.status.vars.turnsLeft = left;
                      return left <= 0 ? [removeBuff(ctx.self, 'werewolf')] : [];
                    },
                  }),
                ],
              }),
            ],
          },
        }),
      ],
    });
    await engine.addBuff(hero, werewolf);

    // No timer on the buff itself — only the tie; the countdown is in the
    // granted skill (the transformation's own ability).
    expect(hero.buffs[0]!.abilities.map((a) => a.kind)).toEqual(['transformModifier']);
    expect(hero.name).toBe('Dire Wolf');
    expect(hero.gauge('hp').max).toBe(80);
    expect(hero.findStatus('wolf-timer')).toBeDefined();

    // Turn 1: the countdown ticks (2 → 1) — the form holds.
    await startTurn(engine);
    expect(hero.findStatus('wolf-timer')!.vars.turnsLeft).toBe(1);
    expect(hero.name).toBe('Dire Wolf');
    expect(hero.hasStatus('werewolf')).toBe(true);

    // Turn 2: the countdown reaches zero — the timer removes the werewolf
    // buff, and the buff removal pops the active transformation off the
    // stack: the form reverts and the granted timer skill leaves with it.
    await startTurn(engine);
    expect(hero.hasStatus('werewolf')).toBe(false);
    expect(hero.name).toBe('Hero');
    expect(hero.gauge('hp').max).toBe(100);
    expect(hero.transforms).toHaveLength(0);
    expect(hero.findStatus('wolf-timer')).toBeUndefined();

    const destroyed = events.filter(
      (e): e is Extract<GameEvent, { type: 'buff:destroyed' }> => e.type === 'buff:destroyed',
    );
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]!.buff.id).toBe('werewolf');
    expect(destroyed[0]!.reason).toBe('removed');
    const popped = events.filter(
      (e): e is Extract<GameEvent, { type: 'character:transformed' }> =>
        e.type === 'character:transformed' && e.reason === 'popped',
    );
    expect(popped).toHaveLength(1);
    expect(popped[0]!.form.name).toBe('Dire Wolf');
    expect(popped[0]!.form.gauges?.['hp']).toBe(80);
  });
});

describe('the character:transformed:batch event', () => {
  const transformedOf = (events: GameEvent[]): Extract<GameEvent, { type: 'character:transformed' }>[] =>
    events.filter((e): e is Extract<GameEvent, { type: 'character:transformed' }> => e.type === 'character:transformed');
  const batchesOf = (events: GameEvent[]): Extract<GameEvent, { type: 'character:transformed:batch' }>[] =>
    events.filter((e): e is Extract<GameEvent, { type: 'character:transformed:batch' }> => e.type === 'character:transformed:batch');

  it('fires once per apply, after the individual events — even for a single change', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    await engine.apply([transform(hero, { name: 'Wolf', gauges: { hp: 60 }})]);

    const transformed = transformedOf(events);
    const batches = batchesOf(events);
    expect(transformed).toHaveLength(1);
    expect(batches).toHaveLength(1);
    // The batch carries exactly the apply's individual events, in order.
    expect(batches[0]!.events).toEqual(transformed);
    expect(batches[0]!.events[0]!.reason).toBe('pushed');
    expect(batches[0]!.events[0]!.form).toEqual({ name: 'Wolf', gauges: { hp: 60 } });
    // The summary is announced after the individual event.
    const types = events.map((e) => e.type);
    expect(types.indexOf('character:transformed')).toBeLessThan(types.indexOf('character:transformed:batch'));
  });

  it('a hex dispel fires the batch with the popped form', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(hero, hex('Hex', { name: 'Toad', gauges: { hp: 3 }}));
    events.length = 0; // ignore the landing's own events

    await engine.removeBuff(hero, 'hex');

    const types = events.map((e) => e.type);
    // The individual pop precedes the summary; the transform summary
    // precedes the buff summary (the pop came before the removal).
    expect(types.indexOf('character:transformed')).toBeLessThan(types.indexOf('character:transformed:batch'));
    expect(types.indexOf('character:transformed:batch')).toBeLessThan(types.indexOf('buff:destroyed:batch'));
    const batch = batchesOf(events);
    expect(batch).toHaveLength(1);
    expect(batch[0]!.events).toEqual(transformedOf(events));
    expect(batch[0]!.events[0]!.reason).toBe('popped');
    expect(batch[0]!.events[0]!.form).toEqual({ name: 'Toad', gauges: { hp: 3 } });
  });

  it('summarizes every form change of one apply, in order (a pop then a push)', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(hero, hex('Hex', { name: 'Toad', gauges: { hp: 3 }}));
    events.length = 0;

    // One apply removes the hex (a pop) and pushes a new form: one batch of
    // two, in the order the changes happened.
    await engine.apply([removeBuff(hero, 'hex'), transform(hero, { name: 'Demon', gauges: { hp: 200 }})]);

    const batches = batchesOf(events);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events).toEqual(transformedOf(events));
    expect(batches[0]!.events.map((e) => [e.reason, e.form.name])).toEqual([
      ['popped', 'Toad'],
      ['pushed', 'Demon'],
    ]);
    expect(hero.name).toBe('Demon');
    expect(hero.gauge('hp').max).toBe(200);
  });

  it('the form-stack SBA step\'s dangling-tie pop lands in the apply\'s batch', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    await engine.addBuff(hero, hex('Hex', { name: 'Toad', gauges: { hp: 3 }}));
    hero.removeStatus(hero.findBuff('hex')!); // bypass — a dangling tie
    events.length = 0;

    await engine.heal(hero.gauge('hp'), 1); // a settle runs the form-stack SBA step

    const batches = batchesOf(events);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events).toHaveLength(1);
    expect(batches[0]!.events[0]!.reason).toBe('popped');
    expect(hero.name).toBe('Hero');
  });

  it('a trigger can listen to it — "whenever one or more transformations happen"', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    const seen: number[] = [];
    await engine.addBuff(
      hero,
      buff({
        name: 'Shapeshifter',
        weight: 1,
        abilities: [
          auto({
            name: 'Second Skin',
            event: 'character:transformed:batch',
            cast: (ctx) => {
              seen.push(ctx.event.events.length);
              return [];
            },
          }),
        ],
      }),
    );

    // One change in the apply → a batch of one.
    await engine.apply([transform(hero, { name: 'Wolf' })]);
    expect(seen).toEqual([1]);

    // The hex's own landing is a single push → another batch of one.
    await engine.addBuff(hero, hex('Hex', { name: 'Toad', gauges: { hp: 3 }}));
    expect(seen).toEqual([1, 1]);

    // Removing the hex (a pop) and pushing Demon in the same apply: the
    // trigger sees the whole unit — one batch of two, not two batches.
    await engine.apply([removeBuff(hero, 'hex'), transform(hero, { name: 'Demon', gauges: { hp: 200 }})]);
    expect(seen).toEqual([1, 1, 2]);
    expect(hero.name).toBe('Demon');
  });

  it('a trigger\'s own transform gets its own batch — each apply summarizes its own changes', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    // The outer apply pushes Bear directly and adds a buff whose `buff:added`
    // trigger transforms its wearer during the drain (a nested apply).
    await engine.apply([
      transform(hero, { name: 'Bear', gauges: { hp: 120 }}),
      addBuff(hero, selfTransformingBuff('Polymorph', { name: 'Sheep', gauges: { hp: 5 }})),
    ]);

    // Two separate batches: the outer apply's own push, then the trigger's.
    const batches = batchesOf(events);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.events.map((e) => e.form.name)).toEqual(['Bear']);
    expect(batches[1]!.events.map((e) => e.form.name)).toEqual(['Sheep']);
    expect(events.map((e) => e.type).filter((t) => t.startsWith('character:transformed'))).toEqual([
      'character:transformed', // Bear — the outer apply's direct push
      'character:transformed:batch', // ...summarized at the apply's end
      'character:transformed', // Sheep — the buff:added trigger's nested apply
      'character:transformed:batch', // ...its own summary
    ]);
    expect(hero.name).toBe('Sheep'); // the trigger's form landed last
  });
});

describe('transformation state — a form that returns keeps its skill instances', () => {
  it('a form that returns after a pinning hex keeps its skill instances and vars', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    const demonCounter = skill({
      name: 'Demon Counter',
      weight: 1,
      variables: () => ({ count: 0 }),
      abilities: [
        auto({
          name: 'Tick',
          event: 'turn:start',
          cast: (ctx) => {
            const v = ctx.status.vars;
            if (typeof v.count === 'number') v.count += 1;
            return [];
          },
        }),
      ],
    });

    // The Demon is active and its counter has advanced...
    await engine.apply([transform(hero, { name: 'Demon', gauges: { hp: 200 }, skills: [demonCounter] })]);
    await startTurn(engine);
    expect(hero.findStatus('demon-counter')!.vars.count).toBe(1);
    const demonInstance = hero.findStatus('demon-counter')!;

    // ...a hex that names skills lands over it — the Demon's skills leave...
    await engine.addBuff(
      hero,
      buff({ name: 'Hex', weight: 1, abilities: [transformModifier({ name: 'Toad Form', form: { name: 'Toad', gauges: { hp: 3 }, skills: [skill({ name: 'Toad Croak', weight: 1 })] } })] }),
    );
    expect(hero.name).toBe('Toad');
    expect(hero.findStatus('demon-counter')).toBeUndefined();

    // ...and when the hex is dispelled the Demon surfaces with the SAME
    // instance — the counter kept its state, it did not reset to a fresh 0.
    await engine.removeBuff(hero, 'hex');
    expect(hero.name).toBe('Demon');
    expect(hero.findStatus('demon-counter')).toBe(demonInstance);
    expect(hero.findStatus('demon-counter')!.vars.count).toBe(1);
  });

  it('the base form\'s skills keep their vars across a transform round-trip', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      skills: [skill({ name: 'Meditate', weight: 1, variables: () => ({ charges: 0 }), abilities: [] })],
    });
    engine.registerCharacter(hero);
    const meditate = hero.findStatus('meditate')!;
    meditate.vars.charges = 3;

    // A transform that names skills replaces the base skills...
    await engine.apply([transform(hero, { name: 'Wolf', gauges: { hp: 60 }, skills: [skill({ name: 'Wolf Bite', weight: 1 })] })]);
    expect(hero.findStatus('meditate')).toBeUndefined();

    // ...and popping it returns the same base instance, charges intact.
    await engine.apply([popTransform(hero)]);
    expect(hero.name).toBe('Hero');
    expect(hero.findStatus('meditate')).toBe(meditate);
    expect(hero.findStatus('meditate')!.vars.charges).toBe(3);
  });

  it('a suppressed form that never showed surfaces with fresh skills — nothing to retain', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    const demonCounter = skill({
      name: 'Demon Counter',
      weight: 1,
      variables: () => ({ count: 0 }),
      abilities: [],
    });

    // The hex (naming skills) is active; the Demon is pushed underneath and
    // never becomes the effective form — its skills were never created.
    await engine.addBuff(
      hero,
      buff({ name: 'Hex', weight: 1, abilities: [transformModifier({ name: 'Toad Form', form: { name: 'Toad', gauges: { hp: 3 }, skills: [skill({ name: 'Toad Croak', weight: 1 })] } })] }),
    );
    await engine.apply([transform(hero, { name: 'Demon', gauges: { hp: 200 }, skills: [demonCounter] })]);
    expect(hero.name).toBe('Toad');
    expect(hero.findStatus('demon-counter')).toBeUndefined();

    // When the hex ends the Demon surfaces — with a fresh instance, since
    // it was never active and had no state to retain.
    await engine.removeBuff(hero, 'hex');
    expect(hero.name).toBe('Demon');
    expect(hero.findStatus('demon-counter')!.vars.count).toBe(0);
  });
});
