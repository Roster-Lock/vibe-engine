import { describe, expect, it } from 'vitest';
import {
  Buff,
  AutoChooser,
  Character,
  ScriptedChooser,
  GameEngine,
  addBuff,
  amountOf,
  auto,
  buff,
  cast,
  damage,
  gaugeTransform,
  heal,
  isDamage,
  isHeal,
  passiveActionModifier,
  prompt,
  skill,
  wasDealtBy,
  wasTakenBy,
  type EventSource,
  type GameEvent,
  type GaugeWrite,
} from '../src/games/turn-based/index.js';
import { createEngine } from '../src/games/turn-based/index.js';
import { endTurn, startTurn } from '../src/games/round-based/index.js';
import { isAlly, isEnemy } from '../src/games/round-based/index.js';

describe('GameEngine', () => {
  it('arms skill triggers on registration', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      skills: [
        skill({
          name: 'Regeneration',
          weight: 1,
          abilities: [
            auto({
              name: 'Regen Tick',
              event: 'turn:end',
              cast: (ctx) => [heal(ctx.self.gauge('hp'), 5)],
            }),
          ],
        }),
      ],
    });
    engine.registerCharacter(hero);
    await endTurn(engine);
    expect(hero.gauge('hp').current).toBe(100); // already full
    hero.gauge('hp').current = 60;
    await endTurn(engine);
    expect(hero.gauge('hp').current).toBe(65);
  });

  it('lets a player use a manual ability', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    const fireball = cast({
      name: 'Fireball',
      targeting: { who: 'enemy' },
      cast: (ctx, targeting) => [damage(targeting.targets[0]!.gauge('hp'), 40, ctx.self)],
    });
    hero.addBuff(new Buff(buff({ name: 'Pyromancer', weight: 1, abilities: [fireball] })));

    await engine.useAbility(hero, fireball, { targets: [goblin] });
    expect(goblin.gauge('hp').current).toBe(60);
    expect(events.some((e) => e.type === 'ability:used')).toBe(true);
    expect(events.some((e) => isDamage(e) && 'target' in e && 'source' in e && e.target === goblin && e.source === hero)).toBe(true);
  });

  it('refuses to use an ability the character does not own', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    const fireball = cast({ name: 'Fireball', targeting: { who: 'enemy' }, cast: () => [] });
    await expect(engine.useAbility(hero, fireball, { targets: [goblin] })).rejects.toThrow(/does not have/i);
  });

  it('emits damage and heal events with correct amounts', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    await engine.damage(goblin.gauge('hp'), 30, hero);
    await engine.heal(goblin.gauge('hp'), 10, hero);

    // Damage and healing are derived from the netted hp gauge:changed events;
    // the survived hit also reports itself (and the batch carries it).
    expect(events.map((e) => e.type)).toEqual([
      'gauge:changed',
      'gauge:changed:batch',
      'character:survived',
      'character:survived:batch',
      'gauge:changed',
      'gauge:changed:batch',
    ]);
    const taken = events.find((e): e is GaugeWrite => isDamage(e))!;
    expect(amountOf(taken)).toBe(30);
    expect(taken.target).toBe(goblin);
    expect('source' in taken ? taken.source : undefined).toBe(hero);
    const healed = events.find((e): e is GaugeWrite => isHeal(e))!;
    expect(amountOf(healed)).toBe(10);
    expect(healed.target).toBe(goblin);
  });

  it('runs auto-triggered abilities (thorns) with a when-guard', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    const thorns = buff({
      name: 'Thorns',
      weight: 1,
      abilities: [
        auto({
          name: 'Retaliation',
          event: 'gauge:changed',
          when: (ctx) => {
            if (!('source' in ctx.event)) return false;
            const source = ctx.event.source;
            return (
              wasTakenBy(ctx.event, ctx.self) &&
              source.type === 'character' &&
              source !== ctx.self
            );
          },
          targets: (ctx) => {
            if (!('source' in ctx.event)) return [];
            const source = ctx.event.source;
            return source.type === 'character' && source !== ctx.self ? [source] : [];
          },
          cast: (ctx, targeting) => {
            const attacker = targeting?.targets[0];
            return attacker ? [damage(attacker.gauge('hp'), 10, ctx.self)] : [];
          },
        }),
      ],
    });
    await engine.addBuff(goblin, thorns);

    await engine.damage(goblin.gauge('hp'), 20, hero);
    expect(goblin.gauge('hp').current).toBe(80);
    expect(hero.gauge('hp').current).toBe(90); // thorns struck back
  });

  it('asks the host for targets on prompt-triggered abilities', async () => {
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const paladin = new Character('Paladin', { maxHp: 100, maxMana: 100, hp: 50 });
    hero.team = 'party';
    paladin.team = 'party';
    const engine = createEngine({ chooser: ScriptedChooser.selects([paladin]) });
    engine.registerCharacter(hero);
    engine.registerCharacter(paladin);

    const warCry = buff({
      name: 'War Cry',
      weight: 1,
      abilities: [
        prompt({
          name: 'Inspire',
          event: 'turn:start',
          when: (ctx) => ctx.self.gauge('hp').current > 0,
          prompt: () => ({ who: 'ally', count: 1 }),
          cast: (ctx, targeting) => [heal(targeting.targets[0]!.gauge('hp'), 20, ctx.self)],
        }),
      ],
    });
    await engine.addBuff(hero, warCry);
    await startTurn(engine);
    expect(paladin.gauge('hp').current).toBe(70);
    expect(hero.gauge('hp').current).toBe(100);
  });

  it('emits turn events', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    await startTurn(engine);
    await endTurn(engine);
    expect(events.map((e) => e.type)).toEqual(['turn:start', 'turn:end']);
  });

  it('fires buff added/removed events and disarms triggers on removal', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    const poison = buff({
      name: 'Poison',
      weight: 1,
      abilities: [
        auto({ name: 'Poison Tick', event: 'turn:end', cast: (ctx) => [damage(ctx.self.gauge('hp'), 5)] }),
      ],
    });

    await engine.addBuff(hero, poison);
    expect(hero.hasStatus('poison')).toBe(true);
    expect(events.some((e) => e.type === 'buff:added' && e.buff.id === 'poison')).toBe(true);

    await endTurn(engine);
    expect(hero.gauge('hp').current).toBe(95);

    await engine.removeBuff(hero, 'poison');
    expect(hero.hasStatus('poison')).toBe(false);
    expect(events.some((e) => e.type === 'buff:destroyed' && e.buff.id === 'poison')).toBe(true);

    await endTurn(engine);
    expect(hero.gauge('hp').current).toBe(95); // trigger disarmed
  });

  it('an aura grants a permanent mark that removal refuses to touch', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ seed: 'aura', onEvent: (e) => events.push(e) });

    // The mark: applied at runtime, never removed, still weighted — and its
    // abilities keep working even after a removal attempt.
    const blessed = buff({
      name: 'Blessed',
      weight: 2,
      removable: false,
      abilities: [
        passiveActionModifier({
          name: 'Blessed Ward',
          transform: (action, ctx) =>
            action.direction !== 'incoming'
              ? action
              : gaugeTransform((prev) => (cur, max) => Math.max(prev(cur, max), cur - 3))(action, ctx),
        }),
      ],
    });

    // The aura: a skill whose auto ability marks every ally (but itself)
    // that matches the condition — here, anyone not marked yet.
    const blessingAura = skill({
      name: 'Blessing Aura',
      weight: 1,
      abilities: [
        auto({
          name: 'Bless the Faithful',
          event: 'turn:start',
          targeting: {
            who: 'ally',
            match: (ctx, c) => c !== ctx.self && !c.hasStatus('blessed'),
          },
          cast: (ctx, targeting) =>
            targeting ? targeting.targets.map((c) => addBuff(c, blessed, ctx.self)) : [],
        }),
      ],
    });

    const paladin = new Character('Paladin', { maxHp: 100, maxMana: 100, skills: [blessingAura] });
    const squire = new Character('Squire', { maxHp: 50, maxMana: 50 });
    const goblin = new Character('Goblin', { maxHp: 50, maxMana: 50 });
    paladin.team = 'party';
    squire.team = 'party';
    goblin.team = 'monsters';
    engine.registerCharacter(paladin);
    engine.registerCharacter(squire);
    engine.registerCharacter(goblin);

    await startTurn(engine); // the aura fires
    expect(squire.hasStatus('blessed')).toBe(true);
    expect(paladin.hasStatus('blessed')).toBe(false); // self excluded
    expect(goblin.hasStatus('blessed')).toBe(false); // enemy not matched
    expect(events.some((e) => e.type === 'buff:added' && e.buff.id === 'blessed' && e.buff.removable === false)).toBe(true);

    // The mark works: incoming damage is capped at 3.
    await engine.damage(squire.gauge('hp'), 10, goblin);
    expect(squire.gauge('hp').current).toBe(47);

    // Removal is refused: the status stays, its abilities stay armed, and
    // no buff:destroyed event fires.
    await engine.removeBuff(squire, 'blessed');
    expect(squire.hasStatus('blessed')).toBe(true);
    expect(squire.statuses.map((s) => s.weight)).toEqual([2]); // still weighted
    expect(events.some((e) => e.type === 'buff:destroyed' && e.buff.id === 'blessed')).toBe(false);

    await engine.damage(squire.gauge('hp'), 10, goblin);
    expect(squire.gauge('hp').current).toBe(44); // still capped at 3

    // Ordinary buffs remain removable.
    const fragile = buff({ name: 'Fragile', weight: 1 });
    await engine.addBuff(squire, fragile);
    await engine.removeBuff(squire, 'fragile');
    expect(squire.hasStatus('fragile')).toBe(false);
  });

  it('destroying an aura takes the permanent marks it granted with it', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ seed: 'aura-cascade', onEvent: (e) => events.push(e) });

    const blessed = buff({
      name: 'Blessed',
      weight: 2,
      removable: false,
      abilities: [
        passiveActionModifier({
          name: 'Blessed Ward',
          transform: (action, ctx) =>
            action.direction !== 'incoming'
              ? action
              : gaugeTransform((prev) => (cur, max) => Math.max(prev(cur, max), cur - 3))(action, ctx),
        }),
      ],
    });
    // The aura is a *buff* (removable). Its cast applies marks without an
    // explicit source so each mark is linked back to this aura instance.
    const blessingAura = buff({
      name: 'Blessing Aura',
      weight: 1,
      abilities: [
        auto({
          name: 'Bless the Faithful',
          event: 'turn:start',
          targeting: {
            who: 'ally',
            match: (ctx, c) => c !== ctx.self && !c.hasStatus('blessed'),
          },
          cast: (ctx, targeting) =>
            targeting ? targeting.targets.map((c) => addBuff(c, blessed)) : [],
        }),
      ],
    });

    const paladin = new Character('Paladin', { maxHp: 100, maxMana: 100 });
    const squireA = new Character('Squire A', { maxHp: 50, maxMana: 50 });
    const squireB = new Character('Squire B', { maxHp: 50, maxMana: 50 });
    const goblin = new Character('Goblin', { maxHp: 60, maxMana: 60 });
    paladin.team = 'party';
    squireA.team = 'party';
    squireB.team = 'party';
    goblin.team = 'monsters';
    engine.registerCharacter(paladin);
    engine.registerCharacter(squireA);
    engine.registerCharacter(squireB);
    engine.registerCharacter(goblin);

    await engine.addBuff(paladin, blessingAura);
    await startTurn(engine); // aura fires: both squires get the mark
    expect(squireA.hasStatus('blessed')).toBe(true);
    expect(squireB.hasStatus('blessed')).toBe(true);
    const markA = squireA.findBuff('blessed')!;
    const aura = paladin.findBuff('blessing-aura')!;
    expect(markA.grantedBy).toBe(aura); // linked to the aura instance
    expect(markA.caster).toBe(paladin); // attributed to the aura's wearer

    // A dispel on the mark still bounces…
    await engine.removeBuff(squireA, 'blessed');
    expect(squireA.hasStatus('blessed')).toBe(true);

    // …but removing the aura destroys every mark it granted, on every
    // character, and fires buff:destroyed for each.
    await engine.removeBuff(paladin, 'blessing-aura');
    expect(squireA.hasStatus('blessed')).toBe(false);
    expect(squireB.hasStatus('blessed')).toBe(false);
    const removed = events.filter(
      (e): e is Extract<GameEvent, { type: 'buff:destroyed' }> =>
        e.type === 'buff:destroyed' && e.buff.id === 'blessed',
    );
    expect(removed).toHaveLength(2);
    expect(new Set(removed.map((e) => e.character))).toEqual(new Set([squireA, squireB]));
  });

  it('the aura cascade only takes permanent marks, and only its own', async () => {
    const engine = createEngine({ seed: 'aura-scope' });

    // Stackable so both auras can land a mark on the same squire.
    const blessed = buff({ name: 'Blessed', weight: 2, removable: false, stacks: true });
    const fleeting = buff({ name: 'Fleeting', weight: 3 }); // ordinary removable buff
    // Aura one fires on turn:start; aura two on turn:end — deterministic order.
    const auraOne = buff({
      name: 'Aura One',
      weight: 1,
      abilities: [
        auto({
          name: 'Bless One',
          event: 'turn:start',
          targeting: { who: 'ally', match: (ctx, c) => c !== ctx.self && !c.hasStatus('blessed') },
          cast: (ctx, targeting) =>
            targeting ? targeting.targets.flatMap((c) => [addBuff(c, blessed), addBuff(c, fleeting)]) : [],
        }),
      ],
    });
    const auraTwo = buff({
      name: 'Aura Two',
      weight: 1,
      abilities: [
        auto({
          name: 'Bless Two',
          event: 'turn:end',
          targeting: { who: 'ally', match: (ctx, c) => c !== ctx.self },
          cast: (ctx, targeting) =>
            targeting ? targeting.targets.map((c) => addBuff(c, blessed)) : [],
        }),
      ],
    });

    const paladinA = new Character('Paladin A', { maxHp: 100, maxMana: 100 });
    const paladinB = new Character('Paladin B', { maxHp: 100, maxMana: 100 });
    const squire = new Character('Squire', { maxHp: 50, maxMana: 50 });
    paladinA.team = 'party';
    paladinB.team = 'party';
    squire.team = 'party';
    engine.registerCharacter(paladinA);
    engine.registerCharacter(paladinB);
    engine.registerCharacter(squire);

    await engine.addBuff(paladinA, auraOne);
    await engine.addBuff(paladinB, auraTwo);
    await startTurn(engine); // aura one marks the squire (+ Fleeting)
    await endTurn(engine); // aura two stacks another mark on the squire
    expect(squire.buffs.filter((b) => b.id === 'blessed')).toHaveLength(2);
    expect(squire.hasStatus('fleeting')).toBe(true);

    // Remove aura one: its mark dies, but the removable buff it granted
    // stays (dispels handle those), and aura two's mark survives — each
    // mark is linked to the exact aura instance that granted it.
    await engine.removeBuff(paladinA, 'aura-one');
    expect(squire.buffs.filter((b) => b.id === 'blessed')).toHaveLength(1);
    expect(squire.findBuff('blessed')!.grantedBy).toBe(paladinB.findBuff('aura-two'));
    expect(squire.hasStatus('fleeting')).toBe(true); // removable buff untouched

    // Remove aura two: the last permanent mark dies with it.
    await engine.removeBuff(paladinB, 'aura-two');
    expect(squire.hasStatus('blessed')).toBe(false);
    expect(squire.hasStatus('fleeting')).toBe(true);
  });

  it('an aura is removed when its owner is defeated, taking its marks along', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ seed: 'aura-defeat', onEvent: (e) => events.push(e) });

    const blessed = buff({ name: 'Blessed', weight: 2, removable: false });
    const blessingAura = buff({
      name: 'Blessing Aura',
      weight: 1,
      removedOnDefeat: true,
      abilities: [
        auto({
          name: 'Bless the Faithful',
          event: 'turn:start',
          targeting: { who: 'ally', match: (ctx, c) => c !== ctx.self && !c.hasStatus('blessed') },
          cast: (ctx, targeting) =>
            targeting ? targeting.targets.map((c) => addBuff(c, blessed)) : [],
        }),
      ],
    });

    const paladin = new Character('Paladin', { maxHp: 100, maxMana: 100 });
    const squire = new Character('Squire', { maxHp: 50, maxMana: 50 });
    const goblin = new Character('Goblin', { maxHp: 60, maxMana: 60 });
    paladin.team = 'party';
    squire.team = 'party';
    goblin.team = 'monsters';
    engine.registerCharacter(paladin);
    engine.registerCharacter(squire);
    engine.registerCharacter(goblin);

    await engine.addBuff(paladin, blessingAura);
    await startTurn(engine);
    expect(squire.hasStatus('blessed')).toBe(true);

    // Killing the paladin fades the aura first; the cascade then destroys
    // its marks — all before the death is announced. Mana is the life gauge.
    await engine.damage(paladin.gauge('hp'), 100);
    expect(paladin.isDefeated).toBe(true);
    expect(paladin.hasStatus('blessing-aura')).toBe(false);
    expect(squire.hasStatus('blessed')).toBe(false);
    const removals = events.filter(
      (e): e is Extract<GameEvent, { type: 'buff:destroyed' }> => e.type === 'buff:destroyed',
    );
    expect(removals.map((e) => e.buff.id)).toEqual(['blessing-aura', 'blessed']);
    expect(events.some((e) => e.type === 'character:destroyed' && e.character === paladin)).toBe(true);
  });

  it('buffs fade on defeat by default; removedOnDefeat: false opts out', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    // removedOnDefeat now defaults to true — every buff fades with its owner.
    await engine.addBuff(hero, buff({ name: 'Fades', weight: 1 }));
    await engine.addBuff(hero, buff({ name: 'Eternal', weight: 3, removable: false }));
    await engine.addBuff(hero, buff({ name: 'Stays', weight: 2, removedOnDefeat: false }));

    await engine.damage(hero.gauge('hp'), 100);
    expect(hero.hasStatus('fades')).toBe(false);
    expect(hero.hasStatus('eternal')).toBe(false); // the default applies even to unremovable buffs
    expect(hero.hasStatus('stays')).toBe(true); // opted out — survives the owner's death
  });

  it('an explosion buff ticks up each turn and blows up on removal', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const goblin = new Character('Goblin', { maxHp: 60, maxMana: 60 });
    const hound = new Character('Hound', { maxHp: 40, maxMana: 40 });
    hero.team = 'party';
    goblin.team = 'monsters';
    hound.team = 'monsters';
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    engine.registerCharacter(hound);

    // The bomb: ticks once per turn it stays around, and when it is removed
    // (any way) it explodes — main blast on the wearer, splash on allies.
    const bomb = buff({
      name: 'Explosion',
      weight: 1,
      variables: () => ({ ticker: 0 }),
      abilities: [
        auto({
          name: 'Tick',
          event: 'turn:end',
          cast: (ctx) => {
            const vars = ctx.self.findStatus('explosion')?.vars;
            if (vars && typeof vars.ticker === 'number') vars.ticker += 1;
            return [];
          },
        }),
        auto({
          name: 'Blow Up',
          event: 'buff:destroyed',
          when: (ctx) => ctx.event.buff.id === 'explosion' && ctx.event.character === ctx.self,
          cast: (ctx) => {
            const power = 10 * Number(ctx.event.buff.vars.ticker ?? 0);
            const allies = ctx.engine.registeredCharacters.filter(
              (c) => isAlly(c, ctx.self) && c !== ctx.self,
            );
            return [
              damage(ctx.self.gauge('hp'), power, ctx.event.buff),
              ...allies.map((c) => damage(c.gauge('hp'), Math.floor(power / 2), ctx.event.buff)),
            ];
          },
        }),
      ],
    });

    // Direct removal: two turns on the goblin -> ticker 2 -> blast 20, splash 10.
    await engine.addBuff(goblin, bomb, hero);
    await startTurn(engine);
    await endTurn(engine); // ticker 1
    await startTurn(engine);
    await endTurn(engine); // ticker 2
    expect(goblin.findStatus('explosion')!.vars.ticker).toBe(2);
    await engine.removeBuff(goblin, 'explosion');
    expect(goblin.gauge('hp').current).toBe(40); // 60 - 20
    expect(hound.gauge('hp').current).toBe(30); // 40 - 10 splash

    // Defeat removal: planted again, ticks once, then the wearer dies.
    // The default removedOnDefeat fades the bomb and its removed ability fires.
    await engine.addBuff(goblin, bomb, hero);
    await startTurn(engine);
    await endTurn(engine); // ticker 1
    await engine.damage(goblin.gauge('hp'), 60); // killing blow (HP is the life gauge)
    expect(goblin.isDefeated).toBe(true);
    expect(goblin.hasStatus('explosion')).toBe(false); // faded with its owner
    expect(hound.gauge('hp').current).toBe(25); // 30 - 5 splash from the death explosion
  });

  it('a buff survives its creator\'s defeat — only the wearer\'s defeat removes it', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const goblin = new Character('Goblin', { maxHp: 60, maxMana: 60 });
    const hound = new Character('Hound', { maxHp: 40, maxMana: 40 });
    hero.team = 'party';
    goblin.team = 'monsters';
    hound.team = 'monsters';
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);
    engine.registerCharacter(hound);

    // A plain buff applied by the hero: created by `hero`, worn by `goblin`.
    const hex = buff({ name: 'Hex', weight: 1 });
    await engine.addBuff(goblin, hex, hero);
    expect(goblin.findStatus('hex')!.caster).toBe(hero);
    expect(goblin.hasStatus('hex')).toBe(true);

    // The creator is defeated -> the buff on the goblin sticks around.
    await engine.damage(hero.gauge('hp'), 100);
    expect(hero.isDefeated).toBe(true);
    expect(goblin.hasStatus('hex')).toBe(true);

    // The wearer is defeated -> the buff is removed (removedOnDefeat default).
    await engine.damage(goblin.gauge('hp'), 60);
    expect(goblin.isDefeated).toBe(true);
    expect(goblin.hasStatus('hex')).toBe(false);
  });

  it('a bomb stays armed when its creator falls, keeps ticking, then explodes with its wearer', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const goblin = new Character('Goblin', { maxHp: 60, maxMana: 60 });
    hero.team = 'party';
    goblin.team = 'monsters';
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    const bomb = buff({
      name: 'Explosion',
      weight: 1,
      variables: () => ({ ticker: 0 }),
      abilities: [
        auto({
          name: 'Tick',
          event: 'turn:end',
          cast: (ctx) => {
            const vars = ctx.self.findStatus('explosion')?.vars;
            if (vars && typeof vars.ticker === 'number') vars.ticker += 1;
            return [];
          },
        }),
        auto({
          name: 'Blow Up',
          event: 'buff:destroyed',
          when: (ctx) => ctx.event.buff.id === 'explosion' && ctx.event.character === ctx.self,
          cast: (ctx) => [damage(ctx.self.gauge('hp'), 10 * Number(ctx.event.buff.vars.ticker ?? 0), ctx.event.buff)],
        }),
      ],
    });

    await engine.addBuff(goblin, bomb, hero); // planted by the hero
    await startTurn(engine);
    await endTurn(engine); // ticker 1

    // The bomber dies: the bomb stays armed and keeps ticking.
    await engine.damage(hero.gauge('hp'), 100);
    expect(hero.isDefeated).toBe(true);
    expect(goblin.hasStatus('explosion')).toBe(true);
    expect(goblin.findStatus('explosion')!.vars.ticker).toBe(1);
    await startTurn(engine);
    await endTurn(engine); // ticker 2 — still ticking with no creator around
    expect(goblin.findStatus('explosion')!.vars.ticker).toBe(2);

    // Only the wearer's removal sets it off.
    await engine.removeBuff(goblin, 'explosion');
    expect(goblin.gauge('hp').current).toBe(40); // 60 - 20 (ticker 2)
  });

  it('fires character:destroyed once when HP crosses zero', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const goblin = new Character('Goblin', { maxHp: 20, maxMana: 20, hp: 20 });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(goblin);
    engine.registerCharacter(hero);

    await engine.damage(goblin.gauge('hp'), 10, hero); // 10 left
    await engine.damage(goblin.gauge('hp'), 10, hero); // 0 -> defeated
    await engine.damage(goblin.gauge('hp'), 5, hero); // already down: no second event

    const defeated = events.filter((e) => e.type === 'character:destroyed');
    expect(defeated.length).toBe(1);
    expect(defeated[0]!.character).toBe(goblin);
    expect(defeated[0]!.changes.map((c) => [c.from, c.to])).toEqual([[10, 0]]);
    expect(goblin.isDefeated).toBe(true);
  });

  it('carries every HP write on character:destroyed, for last-breath triggers', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const goblin = new Character('Goblin', { maxHp: 30, maxMana: 30 });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    const wolf = new Character('Wolf', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(goblin);
    engine.registerCharacter(hero);
    engine.registerCharacter(wolf);

    // Killed in one batch by two attackers, with a refill in between: the
    // changes list still shows the whole story, not just the net.
    await engine.apply([
      damage(goblin.gauge('hp'), 15, hero),
      heal(goblin.gauge('hp'), 5, hero),
      damage(goblin.gauge('hp'), 20, wolf),
    ]);

    const defeated = events.filter((e) => e.type === 'character:destroyed');
    expect(defeated).toHaveLength(1);
    expect(defeated[0]!.changes.map((c) => [c.from, c.to])).toEqual([
      [30, 15],
      [15, 20],
      [20, 0],
    ]);
    expect(
      defeated[0]!.changes
        .filter((c): c is GaugeWrite & { source: EventSource } => isDamage(c) && 'source' in c)
        .map((c) => c.source),
    ).toEqual([hero, wolf]);
    expect(goblin.isDefeated).toBe(true);
  });

  describe('character:survived', () => {
    it('fires after a survived hit, listing every HP write with its source', async () => {
      const events: GameEvent[] = [];
      const engine = createEngine({ onEvent: (e) => events.push(e) });
      const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
      const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
      const wolf = new Character('Wolf', { maxHp: 100, maxMana: 100 });
      engine.registerCharacter(goblin);
      engine.registerCharacter(hero);
      engine.registerCharacter(wolf);

      // One batch, two attackers and a refill: the netted gauge:changed only
      // carries the last source, but character:survived lists every write.
      await engine.apply([
        damage(goblin.gauge('hp'), 15, hero),
        damage(goblin.gauge('hp'), 25, wolf),
        heal(goblin.gauge('hp'), 10, hero),
      ]);

      const survived = events.filter((e) => e.type === 'character:survived');
      expect(survived).toHaveLength(1);
      expect(survived[0]!.character).toBe(goblin);
      const changes = survived[0]!.changes;
      expect(changes.map((c) => [c.from, c.to])).toEqual([
        [100, 85],
        [85, 60],
        [60, 70],
      ]);
      expect(
        changes
          .filter((c): c is GaugeWrite & { source: EventSource } => isDamage(c) && 'source' in c)
          .map((c) => c.source),
      ).toEqual([
        hero,
        wolf,
      ]);
      expect(isDamage(changes[0]!) && 'source' in changes[0]! && changes[0]!.source === hero).toBe(true);
    });

    it('fires even when damage and healing cancel to a net-zero change', async () => {
      const events: GameEvent[] = [];
      const engine = createEngine({ onEvent: (e) => events.push(e) });
      const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100, hp: 50 });
      const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
      engine.registerCharacter(goblin);
      engine.registerCharacter(hero);

      await engine.apply([damage(goblin.gauge('hp'), 10, hero), heal(goblin.gauge('hp'), 10, hero)]);

      expect(goblin.gauge('hp').current).toBe(50);
      // No net change, so no gauge:changed — but the hit still happened.
      expect(events.map((e) => e.type)).toEqual(['character:survived', 'character:survived:batch']);
      const survived = events[0]!;
      expect(survived.type === 'character:survived' && isDamage(survived.changes[0]!)).toBe(true);
    });

    it('does not fire for pure refills, kills, or hits on the already-dead', async () => {
      const events: GameEvent[] = [];
      const engine = createEngine({ onEvent: (e) => events.push(e) });
      const goblin = new Character('Goblin', { maxHp: 20, maxMana: 20 });
      const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
      engine.registerCharacter(goblin);
      engine.registerCharacter(hero);

      await engine.damage(goblin.gauge('hp'), 5, hero); // 20 -> 15: survived
      expect(events.filter((e) => e.type === 'character:survived')).toHaveLength(1);
      events.length = 0;

      await engine.heal(goblin.gauge('hp'), 5, hero); // 15 -> 20: just healed, nothing survived
      expect(events.filter((e) => e.type === 'character:survived')).toHaveLength(0);
      events.length = 0;

      await engine.damage(goblin.gauge('hp'), 20, hero); // killing blow
      expect(goblin.isDefeated).toBe(true);
      expect(events.filter((e) => e.type === 'character:survived')).toHaveLength(0);
      expect(events.some((e) => e.type === 'character:destroyed')).toBe(true);
      events.length = 0;

      await engine.damage(goblin.gauge('hp'), 5, hero); // already down: nothing new
      expect(events).toEqual([]);
    });

    it('lets a revenge trigger retaliate against every mana drainer', async () => {
      const engine = createEngine();
      const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
      const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
      const wolf = new Character('Wolf', { maxHp: 100, maxMana: 100 });
      engine.registerCharacter(goblin);
      engine.registerCharacter(hero);
      engine.registerCharacter(wolf);

      const revenge = buff({
        name: 'Vendetta',
        weight: 1,
        abilities: [
          auto({
            name: 'Revenge',
            event: 'character:survived',
            when: (ctx) =>
              ctx.event.changes.some(
                (c) => isDamage(c) && 'source' in c && c.source.type === 'character',
              ),
            targets: (ctx) =>
              ctx.event.changes
                .filter(
                  (c): c is GaugeWrite & { source: Character } =>
                    isDamage(c) && 'source' in c && c.source.type === 'character',
                )
                .map((c) => c.source),
            cast: (ctx, targeting) =>
              (targeting?.targets ?? []).map((t) => damage(t.gauge('hp'), 10, ctx.self)),
          }),
        ],
      });
      await engine.addBuff(goblin, revenge);

      await engine.apply([damage(goblin.gauge('hp'), 10, hero), damage(goblin.gauge('hp'), 5, wolf)]);

      expect(hero.gauge('hp').current).toBe(90);
      expect(wolf.gauge('hp').current).toBe(90);
    });
  });

  it('computes valid targets from teams', async () => {
    const engine = createEngine();
    const a = new Character('A', { maxHp: 10, maxMana: 10 });
    const b = new Character('B', { maxHp: 10, maxMana: 10 });
    const c = new Character('C', { maxHp: 10, maxMana: 10 });
    a.team = 'red';
    b.team = 'red';
    c.team = 'blue';
    engine.registerCharacter(a);
    engine.registerCharacter(b);
    engine.registerCharacter(c);

    expect(engine.validTargets({ who: 'self' }, a).map((x) => x.name)).toEqual(['A']);
    // "ally" includes the owner and teammates.
    expect(engine.validTargets({ who: 'ally' }, a).map((x) => x.name)).toEqual(['A', 'B']);
    expect(engine.validTargets({ who: 'enemy' }, a).map((x) => x.name)).toEqual(['C']);
    expect(engine.validTargets({ who: 'any' }, a).length).toBe(3);

    // Without teams, everyone else is an enemy.
    const solo = new Character('Solo', { maxHp: 10, maxMana: 10 });
    engine.registerCharacter(solo);
    expect(engine.validTargets({ who: 'enemy' }, solo).length).toBe(3);
  });

  it('the default chooser picks the first valid targets', async () => {
    const engine = createEngine();
    const a = new Character('A', { maxHp: 10, maxMana: 10 });
    const b = new Character('B', { maxHp: 10, maxMana: 10 });
    const c = new Character('C', { maxHp: 10, maxMana: 10 });
    engine.registerCharacter(a);
    engine.registerCharacter(b);
    engine.registerCharacter(c);
    const answer = await new AutoChooser().choose({
      kind: 'select',
      prompt: 'choose',
      chooser: undefined,
      options: engine.validTargets({ who: 'enemy' }, a),
      count: 2,
    });
    expect(answer.kind === 'select' ? answer.chosen.map((t) => t.name) : []).toEqual(['B', 'C']);
  });

  it('guards against infinite trigger loops', async () => {
    const engine = createEngine({ maxActionDepth: 8 });
    const hero = new Character('Hero', { maxHp: 1000, maxMana: 1000 });
    const goblin = new Character('Goblin', { maxHp: 1000, maxMana: 1000 });
    engine.registerCharacter(hero);
    engine.registerCharacter(goblin);

    const thorns = buff({
      name: 'Thorns',
      weight: 1,
      abilities: [
        auto({
          name: 'Retaliation',
          event: 'gauge:changed',
          when: (ctx) => {
            if (!('source' in ctx.event)) return false;
            const source = ctx.event.source;
            return (
              wasTakenBy(ctx.event, ctx.self) &&
              source.type === 'character' &&
              source !== ctx.self
            );
          },
          targets: (ctx) => {
            if (!('source' in ctx.event)) return [];
            const source = ctx.event.source;
            return source.type === 'character' && source !== ctx.self ? [source] : [];
          },
          cast: (ctx, targeting) => {
            const attacker = targeting?.targets[0];
            return attacker ? [damage(attacker.gauge('hp'), 5, ctx.self)] : [];
          },
        }),
      ],
    });
    await engine.addBuff(hero, thorns);
    await engine.addBuff(goblin, thorns);

    await expect(engine.damage(goblin.gauge('hp'), 5, hero)).rejects.toThrow(/max depth/i);
  });

  it('detects status-creation cycles: the grant is refused and the grantor blows up', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ seed: 'cycle', onEvent: (e) => events.push(e) });
    const paladin = new Character('Paladin', { maxHp: 100, maxMana: 100 });
    const squire = new Character('Squire', { maxHp: 50, maxMana: 50 });
    paladin.team = 'party';
    squire.team = 'party';
    engine.registerCharacter(paladin);
    engine.registerCharacter(squire);

    // A (the parent) grants B (the child); B tries to grant A back — a cycle.
    const buffA = buff({
      name: 'A',
      weight: 1,
      abilities: [
        auto({
          name: 'Give B',
          event: 'turn:start',
          targeting: { who: 'ally', match: (ctx, c) => c !== ctx.self && !c.hasStatus('b') },
          cast: (ctx, targeting) =>
            targeting ? targeting.targets.map((c) => addBuff(c, buffB)) : [],
        }),
      ],
    });
    const buffB = buff({
      name: 'B',
      weight: 1,
      // B explodes when removed — the in-game consequence of the cycle.
      abilities: [
        auto({
          name: 'Rebel',
          event: 'buff:added',
          when: (ctx) => ctx.event.buff.id === 'a',
          targeting: { who: 'self' },
          cast: (ctx) => [addBuff(ctx.self, buffA)], // child creating its parent
        }),
        auto({
          name: 'Blow Up',
          event: 'buff:destroyed',
          when: (ctx) => ctx.event.buff.id === 'b' && ctx.event.character === ctx.self,
          cast: (ctx) => [damage(ctx.self.gauge('hp'), 5, ctx.event.buff)],
        }),
      ],
    });

    await engine.addBuff(paladin, buffA);
    await startTurn(engine); // A grants B to the squire (B.grantedBy = A)
    expect(squire.hasStatus('b')).toBe(true);
    expect(squire.findStatus('b')!.grantedBy).toBe(paladin.findBuff('a'));

    // Adding another A triggers B's Rebel, which would grant A again — a
    // cycle (A is B's ancestor). Refused, B removed, B explodes for 5.
    await engine.addBuff(squire, buffA);
    expect(events.some((e) => e.type === 'cycle:detected' && e.grantor.id === 'b' && e.attemptedId === 'a')).toBe(true);
    expect(squire.hasStatus('b')).toBe(false); // the grantor was removed
    expect(squire.hasStatus('a')).toBe(true); // only the cyclic re-grant was refused
    expect(squire.gauge('hp').current).toBe(45); // 50 - 5 explosion from B's removed ability
  });

  it('catches a stackable self-grant as a cycle instead of hitting the depth guard', async () => {
    const events: GameEvent[] = [];
    const engine = createEngine({ onEvent: (e) => events.push(e) });
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    const loop = buff({
      name: 'Loop',
      weight: 1,
      stacks: true,
      abilities: [
        auto({
          name: 'Reapply',
          event: 'buff:added',
          when: (ctx) => ctx.event.buff.id === 'loop',
          targeting: { who: 'self' },
          cast: (ctx) => [addBuff(ctx.self, loop)],
        }),
      ],
    });

    // The first application arms the trigger; its re-application is a
    // self-cycle: refused, and the source loop is removed. No depth error.
    await engine.addBuff(hero, loop);
    expect(events.some((e) => e.type === 'cycle:detected' && e.grantor.id === 'loop' && e.attemptedId === 'loop')).toBe(true);
    expect(hero.hasStatus('loop')).toBe(false); // removed by the cycle handler
  });

  it('lets abilities react to buffs being added and removed', async () => {
    const seen: string[] = [];
    const engine = createEngine();
    const hero = new Character('Hero', {
      maxHp: 100,
      maxMana: 100,
      skills: [
        skill({
          name: 'Watcher',
          weight: 1,
          abilities: [
            auto({
              name: 'Watch Buffs Added',
              event: 'buff:added',
              cast: (ctx) => {
                seen.push(`added:${ctx.event.character.name}:${ctx.event.buff.name}`);
                return [];
              },
            }),
            auto({
              name: 'Watch Buffs Removed',
              event: 'buff:destroyed',
              cast: (ctx) => {
                seen.push(`removed:${ctx.event.character.name}:${ctx.event.buff.name}`);
                return [];
              },
            }),
          ],
        }),
      ],
    });
    engine.registerCharacter(hero);

    const rage = buff({ name: 'Rage', weight: 1, variables: () => ({ power: 2 }) });
    await engine.addBuff(hero, rage);
    await engine.removeBuff(hero, 'rage');
    expect(seen).toEqual(['added:Hero:Rage', 'removed:Hero:Rage']);
  });

  it('lets buffs grant new buffs via buff:added triggers without loops', async () => {
    const engine = createEngine();
    const hero = new Character('Hero', { maxHp: 100, maxMana: 100 });
    engine.registerCharacter(hero);

    const shield = buff({ name: 'Shield', weight: 1 });
    const aura = buff({
      name: 'Aura',
      weight: 1,
      abilities: [
        auto({
          name: 'Grant Shield',
          event: 'buff:added',
          when: (ctx) => ctx.event.buff.id === 'aura',
          cast: (ctx) => [addBuff(ctx.self, shield)],
        }),
      ],
    });
    await engine.addBuff(hero, aura);
    expect(hero.hasStatus('shield')).toBe(true);
  });
});
