/**
 * Tests for the Card Document — the card-game surface of the Ability
 * Language (`src/english/card.ts`).
 *
 * Two things are held to account here:
 *
 * 1. **Compilation** — a card's header lines become a card shape (cost,
 *    body, keywords) and its effect lines compile through the *real*
 *    ability grammar into engine content.
 * 2. **Editor behaviour** — diagnostics land on the words that caused them
 *    (spans are in the player's document, not the synthetic one), and
 *    `completeCardAt` offers the words the grammar accepts at the cursor.
 */
import { describe, expect, it } from 'vitest';
import {
  CARD_WORD_DOCS,
  compileCardDocument,
  completeCardAt,
} from '../src/english/card.js';
import { CARD_SAMPLES } from '../src/ui/creator/card-samples.js';
import { ZoneDictionary } from '../src/english/zone-dictionary.js';
import { CARD_LANGUAGE_ZONES } from '../examples/card-game/index.js';
import { emptyDictionary } from '../src/english/index.js';
import type { Diagnostic } from '../src/english/index.js';

const text = (source: string, span: { start: number; end: number }): string =>
  source.slice(span.start, span.end);

const errors = (diagnostics: readonly Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((d) => d.severity === 'error');

describe('card document — spells', () => {
  const FIREBALL = ['Card Fireball', 'Cost 4', 'Spell', 'Deal 6 damage to target enemy character.'].join('\n');

  it('compiles a spell into a costed, targeted effect', () => {
    const result = compileCardDocument(FIREBALL);
    expect(errors(result.diagnostics)).toEqual([]);
    const card = result.cards[0]!;
    expect(card.name).toBe('Fireball');
    expect(card.id).toBe('fireball');
    expect(card.cost).toBe(4);
    expect(card.kind).toBe('spell');
    expect(card.ability?.kind).toBe('manual');
    expect(card.targeting).toEqual({ who: 'enemy', count: 1 });
    expect(card.triggers).toEqual([]);
  });

  it('treats a spell that names no target as untargeted', () => {
    const result = compileCardDocument(
      ['Card Consecration', 'Cost 4', 'Spell', 'Deal 2 damage to all enemy characters.'].join('\n'),
    );
    expect(errors(result.diagnostics)).toEqual([]);
    const card = result.cards[0]!;
    expect(card.ability).toBeDefined();
    expect(card.targeting).toBeUndefined();
  });

  it('rejects a spell with an enters-play line or a keyword', () => {
    const result = compileCardDocument(
      ['Card Nonsense', 'Cost 1', 'Spell', 'Taunt.', 'When this enters play then Deal 1 damage to target enemy character.'].join('\n'),
    );
    const codes = errors(result.diagnostics).map((d) => d.code);
    expect(codes).toContain('card-spell-enters-play');
    expect(codes).toContain('card-spell-keyword');
  });

  it('rejects a spell with no effect at all', () => {
    const result = compileCardDocument(['Card Empty', 'Cost 1', 'Spell'].join('\n'));
    expect(errors(result.diagnostics).map((d) => d.code)).toContain('card-spell-empty');
  });
});

describe('card document — creatures', () => {
  it('compiles a vanilla creature with its stat line and keyword', () => {
    const result = compileCardDocument(['Card Shieldbearer', 'Cost 2', 'Creature 1/4', 'Taunt.'].join('\n'));
    expect(errors(result.diagnostics)).toEqual([]);
    const card = result.cards[0]!;
    expect(card.kind).toBe('creature');
    expect(card.power).toBe(1);
    expect(card.health).toBe(4);
    expect(card.keywords).toEqual(['taunt']);
    expect(card.ability).toBeUndefined();
    expect(card.rulesText).toBe('Taunt.');
  });

  it('compiles "When this enters play then …" into the creature’s one-shot ability', () => {
    const source = [
      'Card Elven Archer',
      'Cost 1',
      'Creature 1/1',
      'When this enters play then Deal 1 damage to target enemy character.',
    ].join('\n');
    const result = compileCardDocument(source);
    expect(errors(result.diagnostics)).toEqual([]);
    const card = result.cards[0]!;
    expect(card.ability?.kind).toBe('manual');
    expect(card.targeting).toEqual({ who: 'enemy', count: 1 });
    // It is the card's one-shot effect, not a standing trigger.
    expect(card.triggers).toEqual([]);
    expect(card.rulesText).toBe('When this enters play then Deal 1 damage to target enemy character.');
  });

  it('mixes several enters-play sentences into one ability', () => {
    const source = [
      'Card Battle Cry',
      'Cost 2',
      'Creature 2/2',
      'When this enters play then Deal 1 damage to target enemy character.',
      'When this enters play then Heal this for 2.',
    ].join('\n');
    const result = compileCardDocument(source);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.cards[0]!.ability).toBeDefined();
  });

  it('records the origin of a target-picking arrival effect', () => {
    const zones = new ZoneDictionary(['active', 'stack']);
    const source = [
      'Card Elven Archer',
      'Cost 1',
      'Creature 1/1',
      'When this enters play from active then Deal 1 damage to target enemy character.',
    ].join('\n');
    const result = compileCardDocument(source, { zones });
    expect(errors(result.diagnostics)).toEqual([]);
    const card = result.cards[0]!;
    // A target is chosen as the card is played, so it stays the card's own
    // play-time effect — with the `from` clause kept as a guard.
    expect(card.ability).toBeDefined();
    expect(card.targeting).toEqual({ who: 'enemy', count: 1 });
    expect(card.entersFrom).toBe('active');
    expect(card.triggers).toEqual([]);
  });

  it('compiles a targetless arrival as a real zone trigger', () => {
    const zones = new ZoneDictionary(['active', 'stack']);
    const source = [
      'Card Cursed Idol',
      'Cost 2',
      'Creature 2/1',
      'When this enters play from stack then Deal 2 damage to all enemy characters.',
    ].join('\n');
    const result = compileCardDocument(source, { zones });
    expect(errors(result.diagnostics)).toEqual([]);
    const card = result.cards[0]!;
    // Nothing to pick, so it fires however the creature arrives — and the
    // `from stack` guard travels with it.
    expect(card.ability).toBeUndefined();
    expect(card.entersFrom).toBeUndefined();
    expect(card.triggers).toHaveLength(1);
    expect(card.triggers[0]!.event).toBe('zone:changed');
    expect(card.ir?.triggers[0]?.zone).toEqual({ verb: 'enters', id: 'play', opposite: 'stack' });
  });

  it('rejects an origin zone the game does not declare', () => {
    const source = [
      'Card Lost',
      'Cost 1',
      'Creature 1/1',
      'When this enters play from nowhere then Deal 1 damage to target enemy character.',
    ].join('\n');
    const result = compileCardDocument(source);
    const diagnostic = result.diagnostics.find((d) => d.code === 'unknown-zone');
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.message).toContain('"play"');
  });

  it('insists an enters-play line says what happens', () => {
    const source = ['Card Mute', 'Cost 2', 'Creature 2/2', 'When this enters play'].join('\n');
    const result = compileCardDocument(source);
    expect(errors(result.diagnostics).map((d) => d.code)).toContain('card-enters-play-empty');
  });

  it('turns "When this dies then …" into a trigger on destruction', () => {
    const source = ['Card Cursed Idol', 'Cost 2', 'Creature 2/1', 'When this dies then Destroy all enemy characters.'].join('\n');
    const result = compileCardDocument(source);
    expect(errors(result.diagnostics)).toEqual([]);
    const card = result.cards[0]!;
    expect(card.triggers).toHaveLength(1);
    expect(card.triggers[0]!.event).toBe('character:destroyed');
  });

  it('points the retired card shorthand at the explicit event', () => {
    const source = ['Card Old', 'Cost 2', 'Creature 2/1', 'Deathrattle: Destroy all enemy characters.'].join('\n');
    const result = compileCardDocument(source);
    const diagnostic = result.diagnostics.find((d) => d.code === 'card-legacy-deathrattle');
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.message).toContain('When this dies then');
    expect(text(source, diagnostic!)).toBe('Deathrattle: Destroy all enemy characters.');
  });

  it('accepts a standing When trigger', () => {
    const source = [
      'Card Gurubashi Berserker',
      'Cost 5',
      'Creature 2/7',
      'When this takes damage then heal this for 1.',
    ].join('\n');
    const result = compileCardDocument(source);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.cards[0]!.triggers).toHaveLength(1);
  });

  it('insists a creature effect says *when* it happens', () => {
    const source = ['Card Confused', 'Cost 1', 'Creature 1/1', 'Deal 1 damage to target enemy character.'].join('\n');
    const result = compileCardDocument(source);
    expect(errors(result.diagnostics).map((d) => d.code)).toContain('card-creature-effect-bare');
  });

  it('requires a cost and a body on every card', () => {
    const result = compileCardDocument('Card Nameless');
    const codes = errors(result.diagnostics).map((d) => d.code);
    expect(codes).toContain('card-cost-missing');
    expect(codes).toContain('card-kind-missing');
  });
});

describe('card document — sections and spans', () => {
  it('compiles several cards and keeps them separate', () => {
    const source = [
      'Card Wisp',
      'Cost 0',
      'Creature 1/1',
      '',
      'Card Fireball',
      'Cost 4',
      'Spell',
      'Deal 6 damage to target enemy character.',
    ].join('\n');
    const result = compileCardDocument(source);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.cards.map((c) => c.name)).toEqual(['Wisp', 'Fireball']);
    expect(result.cards[0]!.kind).toBe('creature');
    expect(result.cards[1]!.kind).toBe('spell');
  });

  it('points an unknown-word diagnostic at the offending word', () => {
    const source = ['Card Broken', 'Cost 1', 'Spell', 'Destroy the moon.'].join('\n');
    const result = compileCardDocument(source);
    const diagnostic = errors(result.diagnostics).find((d) => d.severity === 'error');
    expect(diagnostic).toBeDefined();
    const slice = text(source, diagnostic!);
    expect(slice.toLowerCase()).toContain('moon');
  });

  it('points a card-level diagnostic at the offending line', () => {
    const source = ['Card Broken', 'Cost 1', 'Creature three/seven'].join('\n');
    const result = compileCardDocument(source);
    const diagnostic = result.diagnostics.find((d) => d.code === 'card-unknown-line');
    expect(diagnostic).toBeDefined();
    expect(text(source, diagnostic!)).toBe('Creature three/seven');
  });

  it('points a missing-cost diagnostic at the card heading', () => {
    const source = ['Card Fireball', 'Spell', 'Deal 6 damage to target enemy character.'].join('\n');
    const result = compileCardDocument(source);
    const diagnostic = result.diagnostics.find((d) => d.code === 'card-cost-missing');
    expect(diagnostic).toBeDefined();
    expect(text(source, diagnostic!)).toBe('Card Fireball');
  });

  it('flags content that belongs to no card', () => {
    const source = ['Deal 1 damage to target enemy character.', '', 'Card Wisp', 'Cost 0', 'Creature 1/1'].join('\n');
    const result = compileCardDocument(source);
    const diagnostic = result.diagnostics.find((d) => d.code === 'card-orphan-line');
    expect(diagnostic).toBeDefined();
    expect(text(source, diagnostic!)).toBe('Deal 1 damage to target enemy character.');
  });
});

describe('card document — declared buffs', () => {
  const source = [
    'Buff Frailty (stacks)',
    '',
    'Card Soul Rot',
    'Cost 2',
    'Spell',
    'Add Frailty to target enemy character.',
  ].join('\n');

  it('compiles a document-level Buff and resolves the card reference', () => {
    const result = compileCardDocument(source);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.buffs.map((b) => b.name)).toEqual(['Frailty']);
    expect(result.buffDefs).toHaveLength(1);
    expect(result.cards[0]!.ability).toBeDefined();
  });

  it('warns once when a declared buff is never used', () => {
    const unused = ['Buff Unused', '', 'Card Wisp', 'Cost 0', 'Creature 1/1'].join('\n');
    const result = compileCardDocument(unused);
    const warnings = result.diagnostics.filter((d) => d.code === 'unused-buff');
    expect(warnings).toHaveLength(1);
    expect(text(unused, warnings[0]!)).toBe('Unused');
  });

  it('counts a buff used from another buff’s body as used', () => {
    const chained = [
      'Buff Inner',
      '',
      'Buff Outer',
      'When this takes damage then add Inner to this.',
      '',
      'Card Wisp',
      'Cost 0',
      'Creature 1/1',
    ].join('\n');
    const result = compileCardDocument(chained);
    const unusedNames = result.diagnostics
      .filter((d) => d.code === 'unused-buff')
      .map((d) => text(chained, d));
    // `Outer` is never added by anything, so it *is* unused; `Inner` is,
    // because `Outer`'s body names it.
    expect(unusedNames).toEqual(['Outer']);
  });
});

describe('card document — completion', () => {
  it('offers Card and Buff at the top of an empty document', () => {
    const labels = completeCardAt('', 0).map((s) => s.label);
    expect(labels).toContain('Card');
    expect(labels).toContain('Buff');
  });

  it('offers cost and body on a fresh line inside a card', () => {
    const source = 'Card Fireball\n';
    const labels = completeCardAt(source, source.length).map((s) => s.label);
    expect(labels).toContain('Cost');
    expect(labels).toContain('Creature');
    expect(labels).toContain('Spell');
  });

  it('offers creature words once the card is a creature', () => {
    const source = 'Card Ogre\nCost 6\nCreature 6/7\n';
    const labels = completeCardAt(source, source.length).map((s) => s.label);
    expect(labels).toContain('Taunt.');
    expect(labels).toContain('Charge.');
    expect(labels).toContain('When');
    expect(labels).not.toContain('Spell');
  });

  it('offers sentences — not creature words — once the card is a spell', () => {
    const source = 'Card Fireball\nCost 4\nSpell\n';
    const labels = completeCardAt(source, source.length).map((s) => s.label);
    expect(labels).toContain('Deal');
    expect(labels).toContain('Destroy');
    expect(labels).not.toContain('When');
  });

  it('delegates a spell effect sentence to the ability grammar', () => {
    const source = ['Card Fireball', 'Cost 4', 'Spell', 'Deal 6 '].join('\n');
    const labels = completeCardAt(source, source.length).map((s) => s.label);
    expect(labels).toContain('damage');
  });

  it('delegates an enters-play body to the ability grammar', () => {
    const source = ['Card Archer', 'Cost 1', 'Creature 1/1', 'When this enters play then Deal 1 damage '].join('\n');
    const labels = completeCardAt(source, source.length).map((s) => s.label);
    expect(labels).toContain('to');
  });

  it('offers "then" once an enters-play event is complete', () => {
    const source = ['Card Archer', 'Cost 1', 'Creature 1/1', 'When this enters play '].join('\n');
    const labels = completeCardAt(source, source.length).map((s) => s.label);
    expect(labels).toContain('then');
  });

  it('delegates an on-death body to the ability grammar', () => {
    const source = ['Card Idol', 'Cost 2', 'Creature 2/1', 'When this dies then Deal 2 '].join('\n');
    const labels = completeCardAt(source, source.length).map((s) => s.label);
    expect(labels).toContain('damage');
  });

  it('completes inside a Buff section with the ability grammar', () => {
    const source = 'Buff Frailty\n';
    const labels = completeCardAt(source, source.length).map((s) => s.label);
    expect(labels).toContain('Deal');
  });

  it('offers whole event phrases on a trigger line', () => {
    const source = ['Card Idol', 'Cost 2', 'Creature 2/1', 'When '].join('\n');
    const labels = completeCardAt(source, source.length).map((s) => s.label);
    expect(labels).toContain('this enters play');
    expect(labels).toContain('this takes damage');
    expect(labels).toContain('this dies');
  });

  it('offers the game’s zones after "from" on an arrival line', () => {
    const source = ['Card Archer', 'Cost 1', 'Creature 1/1', 'When this enters play from '].join('\n');
    const labels = completeCardAt(source, source.length, emptyDictionary(), CARD_LANGUAGE_ZONES).map((s) => s.label);
    expect(labels).toContain('active');
    expect(labels).toContain('stack');
  });

  it('offers the document’s declared buffs after Add', () => {
    const source = [
      'Buff Frailty',
      '',
      'Card Soul Rot',
      'Cost 2',
      'Spell',
      'Add ',
    ].join('\n');
    const labels = completeCardAt(source, source.length).map((s) => s.label);
    expect(labels).toContain('Frailty');
  });

  it('offers nothing inside a card’s name', () => {
    const source = 'Card Fir';
    expect(completeCardAt(source, source.length)).toEqual([]);
  });

  it('documents the card words for hover', () => {
    expect(CARD_WORD_DOCS['enters']).toContain('enters play');
    expect(CARD_WORD_DOCS['dies']).toContain('dies');
  });
});

describe('card document — the creator’s samples', () => {
  for (const sample of CARD_SAMPLES) {
    it(`compiles “${sample.title}” with no errors`, () => {
      // Compiled exactly as the creator does, with the card game's zones.
      const result = compileCardDocument(sample.doc, { zones: CARD_LANGUAGE_ZONES });
      expect(errors(result.diagnostics)).toEqual([]);
      expect(result.cards.length).toBeGreaterThan(0);
    });
  }
});
