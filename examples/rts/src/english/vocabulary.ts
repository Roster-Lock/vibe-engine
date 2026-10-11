/**
 * The RTS Ability Language's vocabulary — the complete word list of the
 * grammar, in one file.
 *
 * The parser accepts these words (case-insensitively), `complete.ts` offers
 * them in the editor, and `WORD_DOCS` is the hover help. Keeping all three
 * off one set of constants is what stops the usual drift where the parser
 * quietly learns a word the completion list never offers.
 */

/** Section heading words. A heading must start its own line. */
export const SECTION_WORDS = ['ability', 'buff', 'unit'] as const;

/** Header lines that configure a section before its sentences begin. */
export const HEADER_WORDS = ['targeting', 'cooldown', 'cost', 'range', 'duration'] as const;

/** Verbs that may begin an effect sentence. */
export const EFFECT_VERBS = [
  'deal',
  'heal',
  'add',
  'remove',
  'kill',
  'summon',
  'teleport',
  'push',
  'after',
  'every',
  'whenever',
  'when',
  'increase',
  'reduce',
  'cannot',
] as const;

/** Targeting modes, as they are written after `Targeting:`. */
export const TARGETING_PHRASES = [
  'no target',
  'target unit',
  'target enemy unit',
  'target ally unit',
  'target point',
] as const;

/** Allegiance adjectives inside a unit phrase. */
export const ALLEGIANCE_WORDS = ['enemy', 'ally', 'allied', 'friendly'] as const;

/** The noun of a unit phrase. */
export const UNIT_WORDS = ['unit', 'units'] as const;

/** Time nouns accepted after a number (`8 seconds`, `1 second`). */
export const TIME_WORDS = ['second', 'seconds'] as const;

/**
 * Event-bound nouns. Only meaningful inside a `whenever …` body, where the
 * event supplies them; elsewhere they are a compile error naming the event
 * that would have bound them.
 */
export const EVENT_NOUNS = ['attacker', 'victim', 'killer'] as const;

/** Stat names, longest phrase first so `attack damage` wins over `attack`. */
export const STAT_PHRASES = [
  ['movement', 'speed'],
  ['attack', 'damage'],
  ['attack', 'speed'],
  ['max', 'hp'],
  ['max', 'mana'],
  ['hp'],
  ['mana'],
  ['armor'],
] as const;

/** Comparison operators of a `with …` filter. */
export const COMPARE_OPERATORS = ['<', '<=', '>', '>=', '=', '!='] as const;

/** Words that join conditions inside a `with` clause. */
export const CONDITION_JOINERS = ['and', 'or'] as const;

/** What a `Cannot …` line on a buff can forbid. */
export const RESTRICTION_WORDS = ['move', 'attack', 'cast'] as const;

/**
 * Hover help, keyed by the word the editor's cursor is on. Every entry is
 * one sentence: the editor shows it in a tooltip, so it has to read well
 * out of context.
 */
export const WORD_DOCS: Readonly<Record<string, string>> = {
  ability: 'Starts an ability: a heading, optional header lines, then effect sentences.',
  buff: 'Starts a buff: a named status with a duration, stat modifiers, restrictions, ticks or triggers.',
  targeting: 'How the ability is aimed: no target, target unit, target enemy unit, target ally unit, or target point.',
  cooldown: 'Seconds before the ability may be cast again.',
  cost: 'Mana the caster spends on each cast.',
  range: 'How far the cast may reach. Omit it (or write 0) for a self-centered ability.',
  duration: 'How long the buff lasts. Omit it for a permanent buff.',
  deal: 'Deal damage. Armor reduces it, and it emits a damage event triggers can hear.',
  heal: 'Restore hit points, up to the unit maximum.',
  add: 'Apply a buff declared in this document to the named units.',
  remove: 'Remove a buff from the named units, if they have it.',
  kill: 'Kill outright, ignoring hit points and armor.',
  summon: 'Create new units near an anchor, on the caster’s team.',
  teleport: 'Move units instantly to an anchor, ignoring move speed.',
  push: 'Shove units away from an anchor by a distance in map units.',
  after: 'Delay: the effect after the comma runs once, later.',
  every: 'Cadence: the effect after the comma repeats on an interval.',
  whenever: 'Trigger: the effect after the comma runs each time the event happens.',
  when: 'Same as whenever.',
  within: 'Begins the radius of an area phrase: within 300 range of this unit.',
  with: 'Begins a filter: only units matching the conditions are affected.',
  other: 'Excludes the caster from an "all ally units" group.',
  target: 'The unit or point this cast was aimed at.',
  attacker: 'The unit that dealt the damage — only inside a "whenever ... takes damage" trigger.',
  victim: 'The unit that took the damage or died — only inside a trigger.',
  killer: 'The unit that landed the killing blow — only inside a "whenever ... dies" trigger.',
  cannot: 'Forbids the unit from moving, attacking or casting while the buff lasts.',
  increase: 'Raises a stat while the buff lasts. Use a % for a multiplier.',
  reduce: 'Lowers a stat while the buff lasts. Use a % for a multiplier.',
  stacks: 'Marks the buff as stacking: reapplying it adds a stack instead of only refreshing it.',
  below: 'Percentage-of-maximum comparison: hp below 50% means under half health.',
  above: 'Percentage-of-maximum comparison: hp above 50% means over half health.',
};
