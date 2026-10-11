/**
 * Type-vocabulary tests: the discriminants are lowercase English words
 * (`'character'`, `'buff'`, `'skill'`) so content reads like English —
 * `source.type === 'buff'` — **and** still narrows the type, giving
 * autocomplete access to the buff's fields inside the branch.
 *
 * The type-level assertions in this file are checked by `npm run typecheck`
 * (tsconfig includes `test/**`): if a discriminant stops narrowing, the
 * annotated assignments fail to compile.
 */
import { describe, expect, it } from 'vitest';
import { expectTypeOf } from 'vitest';
import { Buff, Character, Skill, buff, skill } from '../src/games/turn-based/index.js';
import type { BuffDestroyedEvent, EventSource } from '../src/engine/events.js';
import type { Status } from '../src/engine/status/index.js';

describe('type vocabulary (lowercase discriminants)', () => {
  it('uses lowercase discriminant values at runtime', () => {
    const hero = new Character('Hero', { maxHp: 100 });
    const poison = new Buff(buff({ name: 'Poison', weight: 3 }));
    const fighter = new Skill(skill({ name: 'Fighter', weight: 1 }));

    expect(hero.type).toBe('character');
    expect(poison.type).toBe('buff');
    expect(fighter.type).toBe('skill');
  });

  it('narrows an EventSource by `type === "buff"` to a Buff', () => {
    const sources: EventSource[] = [];
    for (const source of sources) {
      if (source.type === 'buff') {
        // Narrowed to Buff: buff-only fields are visible here.
        expectTypeOf(source).toEqualTypeOf<Buff>();
        const weight: number = source.weight;
        const removable: boolean = source.removable;
        const vars: Record<string, unknown> = source.vars;
        void weight;
        void removable;
        void vars;
      } else {
        // Narrowed to Character: character-only fields are visible here.
        expectTypeOf(source).toEqualTypeOf<Character>();
        const name: string = source.name;
        const hp = source.gauge('hp');
        void name;
        void hp;
      }
    }
  });

  it('narrows a Status by `type === "buff"` / `"skill"`', () => {
    const statuses: Status[] = [];
    for (const s of statuses) {
      if (s.type === 'buff') {
        expectTypeOf(s).toEqualTypeOf<Buff>();
        const removable: boolean = s.removable;
        const stacks = s.vars;
        void removable;
        void stacks;
      } else {
        expectTypeOf(s).toEqualTypeOf<Skill>();
        const removable: boolean = s.removable; // always false for skills
        void removable;
      }
    }
  });

  it('the buff:destroyed source narrows to a Buff — the creator scenario', () => {
    // When a buff's triggered ability destroys another buff, the
    // `buff:destroyed` event's `source` is that Buff. Content sees
    // `source.type === 'buff'` and gains the buff's fields.
    const handleDestroyed = (event: { source?: EventSource }): number => {
      const source = event.source;
      if (source?.type === 'buff') {
        expectTypeOf(source).toEqualTypeOf<Buff>();
        return source.weight; // buff field, reachable after narrowing
      }
      return 0;
    };
    expect(handleDestroyed({ source: new Buff(buff({ name: 'Blow Up', weight: 2 })) })).toBe(2);
    expect(handleDestroyed({ source: new Character('Hero', { maxHp: 100 }) })).toBe(0);
    expect(handleDestroyed({})).toBe(0);
  });

  it('event versions force a presence check, then narrow the source', () => {
    // Events come in versions: a `buff:destroyed` may or may not carry a
    // `source`. `'source' in event` is the gate — after it, the source's
    // `type` narrows to the Buff with its fields.
    const handleDestroyed = (event: BuffDestroyedEvent): number => {
      if ('source' in event) {
        if (event.source.type === 'buff') {
          expectTypeOf(event.source).toEqualTypeOf<Buff>();
          return event.source.weight;
        }
        expectTypeOf(event.source).toEqualTypeOf<Character>();
        return 0;
      }
      // No source: the compiler forbids even touching `event.source` here.
      expectTypeOf(event).not.toHaveProperty('source');
      return 0;
    };
    const bomb = new Buff(buff({ name: 'Blow Up', weight: 2 }));
    const hero = new Character('Hero', { maxHp: 100 });
    const wearer = new Character('Wearer', { maxHp: 100 });
    const withSource: BuffDestroyedEvent = {
      type: 'buff:destroyed',
      character: wearer,
      buff: bomb,
      reason: 'removed',
      source: bomb,
    };
    const withoutSource: BuffDestroyedEvent = {
      type: 'buff:destroyed',
      character: wearer,
      buff: bomb,
      reason: 'wearer-destroyed',
    };
    expect(handleDestroyed(withSource)).toBe(2);
    expect(handleDestroyed(withoutSource)).toBe(0);
    void hero;
  });
});
