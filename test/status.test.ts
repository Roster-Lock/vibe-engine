import { describe, expect, it } from 'vitest';
import { Buff, Character, Skill, StatusManager, buff, skill } from '../src/games/turn-based/index.js';

describe('buffs and skills', () => {
  it('creates fresh variables per buff instance', () => {
    const poison = buff({
      name: 'Poison',
      weight: 3,
      variables: () => ({ stacks: 1 }),
    });
    const a = new Buff(poison);
    const b = new Buff(poison);
    expect(a.vars).toEqual({ stacks: 1 });
    expect(b.vars).toEqual({ stacks: 1 });
    a.vars.stacks = 5;
    expect(b.vars.stacks).toBe(1);
  });

  it('derives an id from the name when omitted', () => {
    const def = buff({ name: 'Iron Hide', weight: 1 });
    expect(new Buff(def).id).toBe('iron-hide');
  });

  it('gives every status instance a unique uid (the per-instance id)', () => {
    const def = buff({ name: 'Poison', weight: 1 });
    const a = new Buff(def);
    const b = new Buff(def);
    // Same kind id, different instance ids.
    expect(a.id).toBe('poison');
    expect(b.id).toBe('poison');
    expect(a.uid).not.toBe(b.uid);
    expect(a.uid).toMatch(/^buff-\d+$/);

    // Skills get their own uids too.
    const hero = new Character('Hero', {
      maxHp: 100,
      skills: [skill({ name: 'Fighter', weight: 1 })],
    });
    expect(hero.skills[0]!.uid).toMatch(/^skill-\d+$/);
  });

  it('removes by instance exactly that instance, not the first of its kind', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    const multi = buff({ name: 'Stacks', weight: 1 });
    const a = new Buff(multi);
    const b = new Buff(multi);
    hero.addBuff(a);
    hero.addBuff(b);
    expect(hero.buffs).toEqual([a, b]);

    expect(hero.removeBuff(b)).toBe(b); // the exact instance comes off…
    expect(hero.buffs).toEqual([a]); // …and the sibling stays
  });

  it('buffs are removable, skills are not', () => {
    expect(new Buff(buff({ name: 'B', weight: 1 })).removable).toBe(true);
    expect(new Skill(skill({ name: 'S', weight: 1 })).removable).toBe(false);
  });

  it('buffs can opt out of removal and keep their weight', () => {
    const mark = buff({ name: 'Aura Mark', weight: 2, removable: false });
    const hero = new Character('Hero', { maxHp: 100 });
    const instance = new Buff(mark);
    expect(instance.removable).toBe(false);
    expect(instance.weight).toBe(2);
    expect(hero.addBuff(instance)).toBe(true);
    expect(hero.buffs).toContain(instance); // still a buff…
    expect(hero.skills).not.toContain(instance); // …not masquerading as a skill
    expect(hero.findStatus('aura-mark')).toBe(instance);
  });

  it('never removes unremovable buffs — by id or by instance', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    const mark = new Buff(buff({ name: 'Mark', weight: 1, removable: false }));
    hero.addBuff(mark);
    expect(hero.removeBuff(mark)).toBeUndefined();
    expect(hero.removeBuff('mark')).toBeUndefined();
    expect(hero.hasStatus('mark')).toBe(true);
    expect(hero.statuses).toHaveLength(1);
  });

  it('sorts unremovable buffs by weight with everything else', () => {
    const hero = new Character('Hero', {
      maxHp: 100,
      skills: [skill({ name: 'Fighter', weight: 5 })],
    });
    hero.addBuff(new Buff(buff({ name: 'Mark', weight: 1, removable: false })));
    hero.addBuff(new Buff(buff({ name: 'Temp', weight: 3 })));
    expect(hero.statuses.map((s) => [s.name, s.weight])).toEqual([
      ['Mark', 1],
      ['Temp', 3],
      ['Fighter', 5],
    ]);
  });

  it('records the status that granted a mark (grantedBy)', () => {
    const aura = new Buff(buff({ name: 'Aura', weight: 1 }));
    const mark = new Buff(buff({ name: 'Mark', weight: 2, removable: false }), { grantedBy: aura });
    expect(mark.grantedBy).toBe(aura);
    expect(new Buff(buff({ name: 'Plain', weight: 1 })).grantedBy).toBeUndefined();
    expect(new Skill(skill({ name: 'S', weight: 1 })).grantedBy).toBeUndefined();
  });

  it('removedOnDefeat defaults to true and can be opted out', () => {
    expect(new Buff(buff({ name: 'Plain', weight: 1 })).removedOnDefeat).toBe(true);
    expect(new Buff(buff({ name: 'Survivor', weight: 1, removedOnDefeat: false })).removedOnDefeat).toBe(false);
  });

  it('sorts the status list by weight ascending', () => {
    const hero = new Character('Hero', {
      maxHp: 100,
      skills: [skill({ name: 'Slow Skill', weight: 5 })],
    });
    hero.addBuff(new Buff(buff({ name: 'Fast Buff', weight: 1 })));
    hero.addBuff(new Buff(buff({ name: 'Mid Buff', weight: 3 })));
    expect(hero.statuses.map((s) => s.weight)).toEqual([1, 3, 5]);
    expect(hero.statuses.map((s) => s.name)).toEqual(['Fast Buff', 'Mid Buff', 'Slow Skill']);
  });

  it('keeps equal weights in insertion order', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    const a = buff({ name: 'First', weight: 2 });
    const b = buff({ name: 'Second', weight: 2 });
    hero.addBuff(new Buff(a));
    hero.addBuff(new Buff(b));
    expect(hero.statuses.map((s) => s.name)).toEqual(['First', 'Second']);
  });

  it('inserts a direction: out to in status before same-weight in to out/direction-less ones, regardless of who cast it', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    const goblin = new Character('Goblin', { maxHp: 100 });
    // The direction is DECLARED on the buff — not derived from the caster:
    // a self-cast buff can be 'in to out' and an enemy-cast buff 'out to in'.
    hero.addBuff(new Buff(buff({ name: 'Pump up', weight: 1, direction: 'out to in' }), { caster: hero, target: hero }));
    hero.addBuff(new Buff(buff({ name: 'Terror', weight: 1, direction: 'in to out' }), { caster: goblin, target: hero }));
    expect(hero.statuses.map((s) => s.name)).toEqual(['Pump up', 'Terror']);

    // Cast order reversed — and both cast BY THE WEARER — same result:
    // the declaration decides, never the caster.
    const hero2 = new Character('Hero', { maxHp: 100 });
    hero2.addBuff(new Buff(buff({ name: 'Terror', weight: 1, direction: 'in to out' }), { caster: hero2, target: hero2 }));
    hero2.addBuff(new Buff(buff({ name: 'Pump up', weight: 1, direction: 'out to in' }), { caster: hero2, target: hero2 }));
    expect(hero2.statuses.map((s) => s.name)).toEqual(['Pump up', 'Terror']);
  });

  it('weight still sorts ahead of direction — an in to out buff with a heavier weight lands after a lighter out to in one', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    hero.addBuff(new Buff(buff({ name: 'Pump up', weight: 1, direction: 'out to in' })));
    hero.addBuff(new Buff(buff({ name: 'Terror', weight: 3, direction: 'in to out' })));
    expect(hero.statuses.map((s) => s.name)).toEqual(['Pump up', 'Terror']);
  });

  it('in to out statuses of equal weight keep their cast order', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    hero.addBuff(new Buff(buff({ name: 'First', weight: 2, direction: 'in to out' })));
    hero.addBuff(new Buff(buff({ name: 'Second', weight: 2, direction: 'in to out' })));
    expect(hero.statuses.map((s) => s.name)).toEqual(['First', 'Second']);
  });

  it('out to in statuses of equal weight stack newest-first', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    hero.addBuff(new Buff(buff({ name: 'First', weight: 2, direction: 'out to in' })));
    hero.addBuff(new Buff(buff({ name: 'Second', weight: 2, direction: 'out to in' })));
    expect(hero.statuses.map((s) => s.name)).toEqual(['Second', 'First']);
  });

  it('every add of a buff is its own instance', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    const multi = buff({ name: 'Multi', weight: 1 });
    expect(hero.addBuff(new Buff(multi))).toBe(true);
    expect(hero.addBuff(new Buff(multi))).toBe(true);
    expect(hero.buffs.length).toBe(2);
  });

  it('only removes buffs, never skills', () => {
    const hero = new Character('Hero', {
      maxHp: 100,
      skills: [skill({ name: 'Permanent', weight: 1 })],
    });
    const temp = new Buff(buff({ name: 'Temp', weight: 2 }));
    hero.addBuff(temp);
    expect(hero.removeBuff('temp')).toBe(temp);
    expect(hero.removeBuff('permanent')).toBeUndefined();
    expect(hero.skills.length).toBe(1);
  });

  it('each character clones its own skill instance', () => {
    const shared = skill({ name: 'Shared', weight: 1, variables: () => ({ hits: 0 }) });
    const a = new Character('A', { maxHp: 100, skills: [shared] });
    const b = new Character('B', { maxHp: 100, skills: [shared] });
    const aSkill = a.skills[0]!;
    const bSkill = b.skills[0]!;
    expect(aSkill).not.toBe(bSkill);
    aSkill.vars.hits = 9;
    expect(bSkill.vars.hits).toBe(0);
  });
});

describe('StatusManager — the status list owner a Character delegates to', () => {
  it('owns a standalone list with the same ordering rules as the character', () => {
    const manager = new StatusManager();
    manager.addBuff(new Buff(buff({ name: 'Pump up', weight: 1, direction: 'out to in' })));
    manager.addBuff(new Buff(buff({ name: 'Terror', weight: 1 })));
    manager.addBuff(new Buff(buff({ name: 'Slow', weight: 3 })));
    expect(manager.statuses.map((s) => s.name)).toEqual(['Pump up', 'Terror', 'Slow']);
    expect(manager.buffs.map((b) => b.name)).toEqual(['Pump up', 'Terror', 'Slow']);
    expect(manager.hasStatus('slow')).toBe(true);
    expect(manager.findStatus('terror')?.name).toBe('Terror');
  });

  it('is the object a character delegates to — the same instances appear in both views', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    const rage = new Buff(buff({ name: 'Rage', weight: 2 }));
    expect(hero.addBuff(rage)).toBe(true);
    expect(hero.statuses[0]).toBe(rage);
    expect(hero.statusManager.statuses[0]).toBe(rage);
    expect(hero.removeBuff('rage')).toBe(rage);
    expect(hero.statusManager.statuses).toHaveLength(0);
  });
});
