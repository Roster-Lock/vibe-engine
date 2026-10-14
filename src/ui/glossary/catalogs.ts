/**
 * The UI's glossary builders — the one place that knows which content a screen
 * should be able to explain.
 *
 * `src/english/glossary.ts` is the mechanism and knows nothing about games;
 * this file is the wiring. Each builder names the sources a particular screen
 * has, so the card table explains the card catalog's buffs and the ability
 * editor explains the document being typed.
 *
 * ## Live state
 *
 * A definition can show the **printed** value or the **current** one. The
 * editor wants the printed one (it is describing a document). A match wants the
 * current one — a minion's HP right now, not at print time — so the card table
 * passes a `define` hook that reads the live board. That hook is the seam the
 * design called "displaying a value is different from game to game".
 */
import type { Character } from '../../engine/index.js';
import {
  Glossary,
  defaultKeywords,
  type GlossaryOptions,
  type GlossaryScope,
  type PermanentDef,
  type Term,
  type TermDefiner,
  type TermFact,
  type TermRef,
} from '../../english/index.js';
import { CARD_WORD_DOCS } from '../../english/card.js';
import { BuffDictionary } from '../../english/dictionary.js';
import { ZoneDictionary } from '../../english/zone-dictionary.js';
import { poison, rage, thorns } from '../../games/turn-based/content/index.js';
import { berserkerRage, blessed } from '../../../examples/card-game/index.js';

/** The buffs any screen can name: the roster's own, plus the card catalog's. */
export function uiBuffs(): BuffDictionary {
  return new BuffDictionary([
    { name: poison.name, def: poison },
    { name: rage.name, def: rage },
    { name: thorns.name, def: thorns },
    { name: blessed.name, def: blessed },
    { name: berserkerRage.name, def: berserkerRage },
  ]);
}

/**
 * The zones a UI screen can explain: every zone the card game declares, by the
 * names content uses. `play` and `garbage` are the engine's own and are always
 * known; listing a zone again is a no-op, so this is safe across engine
 * renaming.
 */
export function uiZones(): ZoneDictionary {
  return new ZoneDictionary(['deck', 'hand', 'stack', 'active', 'discard', 'garbage', 'play']);
}

export interface UiGlossaryOptions {
  /** Extra sources beyond the shared UI set. */
  readonly extra?: Partial<GlossaryOptions>;
  /** The permanent catalog this screen can describe. */
  readonly characters?: readonly PermanentDef[];
  /** Reads live state; see the module doc. */
  readonly define?: TermDefiner;
}

/**
 * The **options** every UI screen starts from. Options rather than a built
 * `Glossary` because `GlossaryProvider` builds its own (once, memoised) — two
 * instances of the same content is exactly the kind of drift this module
 * exists to prevent.
 */
export function uiGlossaryOptions(options: UiGlossaryOptions = {}): GlossaryOptions {
  return {
    cardWords: CARD_WORD_DOCS,
    // The built-ins, so `Taunt`/`Charge` resolve as *keywords*; a host adds
    // its own with `.add(...)` and passes the registry in `extra`.
    keywords: defaultKeywords(),
    buffs: uiBuffs(),
    zones: uiZones(),
    ...(options.characters ? { characters: options.characters } : {}),
    ...(options.define ? { define: options.define } : {}),
    ...options.extra,
  };
}

/** A built glossary over the shared UI content, for non-React callers. */
export function uiGlossary(options: UiGlossaryOptions = {}): Glossary {
  return new Glossary(uiGlossaryOptions(options));
}

/* ------------------------- terms built from live state -------------------- */

/** The facts worth showing for a character that is on the board right now. */
export function liveFacts(character: Character): TermFact[] {
  const facts: TermFact[] = [];
  for (const gauge of character.gauges) {
    facts.push({ label: gauge.id.toUpperCase(), value: `${gauge.current}/${gauge.max}` });
  }
  for (const stat of ['power', 'toughness']) {
    const value = character.stat(stat);
    if (value !== undefined) facts.push({ label: stat[0]!.toUpperCase() + stat.slice(1), value: String(value) });
  }
  return facts;
}

/** The buffs a character currently wears, as one line of markdown. */
export function liveBuffs(character: Character): string {
  const names = character.statuses.filter((status) => status.type === 'buff').map((buff) => buff.name);
  if (names.length === 0) return '_No buffs._';
  return names.map((name) => `- ${name}`).join('\n');
}

/** The abilities a character currently carries, as one line of markdown. */
export function liveAbilities(character: Character): string {
  const names = character.statuses
    .filter((status) => status.type === 'skill')
    .map((skill) => skill.name)
    .filter((name) => name.length > 0);
  if (names.length === 0) return '_None._';
  return names.map((name) => `- ${name}`).join('\n');
}

/**
 * A term for a character in play — its **current** gauges, stats, buffs and
 * abilities. This is what makes "create 3 Mountain Goblins" clickable into
 * something worth reading.
 */
export function liveCharacterTerm(character: Character, ref: TermRef): Term {
  const facts = liveFacts(character);
  const statLine = facts.map((fact) => `${fact.label} ${fact.value}`).join(' · ');
  return {
    ref,
    glyph: character.name,
    summary: statLine.length > 0 ? statLine : 'A permanent in play.',
    details: [
      statLine.length > 0 ? statLine : undefined,
      '**Buffs**',
      liveBuffs(character),
      '**Abilities**',
      liveAbilities(character),
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n\n'),
    facts,
  };
}

/**
 * Looks a live character up by name across the entities a match registered —
 * the seam a page uses so a name in card text resolves to *that* minion.
 */
export function liveDefiner(characters: () => readonly Character[]): TermDefiner {
  return (ref: TermRef, _scope?: GlossaryScope, base?: Term): Term | undefined => {
    if (ref.kind !== 'character' && ref.kind !== 'permanent') return undefined;
    const wanted = ref.name.trim().toLowerCase();
    const found = characters().find((character) => character.name.trim().toLowerCase() === wanted);
    if (!found) return undefined;
    // Live state beats the printed definition, because "what does this word
    // mean" on a board means "what is this thing, now".
    return liveCharacterTerm(found, ref);
  };
}
