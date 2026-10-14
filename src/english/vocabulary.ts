/**
 * The Ability Language's vocabulary: the fixed English word set of the
 * prototype grammar (docs/creator/01-ability-language.md). The parser
 * accepts these words (case-insensitively); the completion engine and the
 * editor's hover help suggest from the same lists, so the three stay in
 * sync by construction.
 */

/** Section heading words — a heading must start its own line. */
export const SECTION_WORDS = ['ability', 'buff'] as const;

/** What a modifier claims: a change that loses value, or one that gains it. */
export const CHANGE_WORDS = ['damage', 'healing'] as const;

/**
 * The spelling of `CHANGE_WORDS` for a **named** gauge: `incoming mana
 * loss`, `outgoing mana gain`. `damage`/`healing` are the words for the
 * target's *life* gauge, whichever gauge that entity declares; these are
 * how any other gauge says the same two shapes of change.
 */
export const GAIN_LOSS_WORDS = ['gain', 'loss'] as const;

/** Which pipeline phase a modifier claims. */
export const DIRECTION_WORDS = ['outgoing', 'incoming'] as const;

/**
 * How a modifier sentence rewrites what it claims — the past participles
 * of `<subject> is <rewrite>.`
 *
 * Declarative because a modifier is a standing rule rather than something
 * that happens: "incoming damage **is capped at** 50" holds for as long as
 * the buff is attached.
 */
export const MODIFIER_REWRITES = [
  'increased',
  'reduced',
  'multiplied',
  'doubled',
  'halved',
  'capped',
  'prevented',
  'redirected',
] as const;

/** Words that may begin a sentence (verbs, plus the subject-first `you`/`all`). */
export const SENTENCE_STARTERS = [
  'deal',
  'heal',
  'destroy',
  'add',
  'remove',
  'toggle',
  'you',
  'all',
  'when',
  'if',
  'repeat',
  ...DIRECTION_WORDS,
  ...CHANGE_WORDS,
  'available',
] as const;

/** The result-verb forms accepted after `you` / `all players`. */
export const RESULT_VERBS = ['win', 'wins', 'lose', 'loses'] as const;

/** Character-phrase quantifiers. */
export const QUANTIFIERS = ['this', 'target', 'all'] as const;

/** Relative-to-user adjectives allowed inside a character phrase. */
export const ADJECTIVES = ['enemy', 'ally', 'allied'] as const;

/** The noun words of a character phrase. */
export const CHAR_WORDS = ['character', 'characters'] as const;

/** Ownership clause marker word. */
export const OWNED = 'owned' as const;

/** Owner words after `owned by`. */
export const OWNER_WORDS = ['you', 'opponent'] as const;

/** The words after `heal` that switch to the amount-first word order. */
export const TO = 'to' as const;
export const FOR = 'for' as const;

/** `to` / `from` / `on` end a buff reference inside `Add`/`Remove`/`Toggle`. */
export const BUFF_STOP_WORDS = ['to', 'from', 'on'] as const;

/** Gauge words a `with` condition can compare (`with hp < 10`). */
export const GAUGE_WORDS = ['hp', 'mana'] as const;

/** The comparison operators of a `with …` gauge condition. */
export const WITH_OPERATORS = ['<', '<=', '>', '>=', '='] as const;

/** Words that end a buff reference (`Add <buff> to …`, `Remove <buff> from …`). */
export const GAME_WORDS = ['the', 'game'] as const;

/** Words that separate conditions inside a `with` clause. */
export const CONDITION_SEPARATORS = ['and', 'or'] as const;

/**
 * A trigger's **event phrase** — the noun and verb that name an engine
 * event (`when 2 or more characters die then …`).
 *
 * The noun and verb together pick the event, and the *count phrase* picks
 * which version: a count means the `:batch` event, which fires once per
 * batch carrying the individual events — the only way to ask "how many?".
 * A singular subject (`when a character dies`) means the per-event one.
 *
 * Only characters are here for now. Buffs (`buffs leave`) and gauges
 * (`gauges change`) are in the specced table below but their subject is
 * not a character phrase, so filters and adjectives would not mean what
 * they appear to; they need their own noun parsing.
 */
export interface EventPhrase {
  /**
   * Plural and singular forms, each a sequence of words — `['die']`,
   * `['dies']`, `['take', 'damage']`, `['takes', 'damage']`. A sequence
   * because the engine's vocabulary is not all single verbs.
   */
  readonly verbs: readonly (readonly string[])[];
  /** Fires once per matching event. */
  readonly event: string;
  /** Fires once per batch, carrying the individual events. */
  readonly batchEvent: string;
  /**
   * For a gauge event: which gauge and which direction the phrase means.
   * The engine has no "was damaged" event — damage is a gauge going down —
   * so "takes damage" is `gauge:changed` plus these.
   *
   * `{ kind: 'life' }` means the triggering entity's own declared life
   * gauge, which is what "takes damage"/"is healed" watch — the same
   * selector the effect and modifier sides use, so "damage" means one
   * thing everywhere (see `ActionMatchIR.gauge`).
   */
  readonly gauge?: string | { readonly kind: 'life' };
  readonly change?: 'damage' | 'heal';
  /** Hover help for the verb. */
  readonly doc: string;
}

export const EVENT_PHRASES: readonly EventPhrase[] = [
  {
    verbs: [['die'], ['dies']],
    event: 'character:destroyed',
    batchEvent: 'character:destroyed:batch',
    doc: '`characters die` — the engine\'s destruction event. With a count phrase it listens to `character:destroyed:batch`, which fires once per batch, so "2 or more" is answerable.',
  },
  {
    verbs: [['survive'], ['survives']],
    event: 'character:survived',
    batchEvent: 'character:survived:batch',
    doc: '`characters survive` — a character took damage in a batch and lived. With a count phrase it listens to `character:survived:batch`.',
  },
  {
    verbs: [['take', 'damage'], ['takes', 'damage']],
    event: 'gauge:changed',
    batchEvent: 'gauge:changed:batch',
    gauge: { kind: 'life' },
    change: 'damage',
    doc: '`this takes damage` — the life gauge going down. The engine has no separate damage event: damage *is* a gauge losing value. `the source` is whoever dealt it, and a self-inflicted cost does not count.',
  },
  {
    verbs: [['are', 'healed'], ['is', 'healed']],
    event: 'gauge:changed',
    batchEvent: 'gauge:changed:batch',
    gauge: { kind: 'life' },
    change: 'heal',
    doc: '`this is healed` — the life gauge going up. `the source` is whoever healed it.',
  },
];

/** The verb phrases any event accepts, as written, for completion and diagnostics. */
export const EVENT_VERBS: readonly string[] = EVENT_PHRASES.flatMap((phrase) =>
  phrase.verbs.map((words) => words.join(' ')),
);

/** `the source` — whoever caused the triggering event. */
export const EVENT_NOUNS = ['source'] as const;

/** `then` introduces a trigger's effect. */
export const THEN = 'then' as const;

/**
 * The **batch-event count** vocabulary (the events milestone; see
 * docs/creator/01-ability-language.md, "Kept in mind: events and batch
 * triggers"). The engine's `:batch` events fire once per batch — the
 * "when one or more characters die" primitive — and a count phrase
 * says how many the batch must hold before the trigger fires:
 *
 * - `1 or more` — the default (any batch event, even a single one);
 * - `<n> or more` — the batch held n or more;
 * - `<n> to <m>` — the batch held n through m (inclusive);
 * - `<n> or less` — the batch held n or fewer (1..n in practice: a batch
 *   event only fires when the batch held at least one).
 *
 * The parser recognizes these phrases inside "when … then …"
 * sentences so the editor gives a targeted "next milestone" diagnostic
 * instead of a raw syntax error; the same words carry hover help in
 * WORD_DOCS.
 */
export const BATCH_EVENT_COUNT_WORDS = ['more', 'less'] as const;

/**
 * Spelled-out numbers, mapped to the digits the grammar wants.
 *
 * Counts are **digits** (`1 or more`), so these are not accepted — they are
 * here so a spelled-out number gets a diagnostic naming the digit instead
 * of a confusing syntax error.
 */
export const NUMBER_WORDS: Readonly<Record<string, string>> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};

/** Words that may follow a count: `3 **or** more`, `2 **to** 5`. */
export const COUNT_JOINERS = ['or', 'to'] as const;

/**
 * Future vocabulary the editor recognizes so it can say "next milestone"
 * instead of guessing at a raw syntax error. Each maps to a diagnostic
 * hint (see parser.ts).
 */
export interface FutureWord {
  readonly word: string;
  readonly message: string;
}

export const FUTURE_WORDS: readonly FutureWord[] = [
  {
    word: 'creature',
    message: 'Creatures ("spirit wolf") are not supported yet — summoning needs an engine summon action.',
  },
  {
    word: 'transform',
    message: 'Character transformations are out of scope for now.',
  },
  {
    word: 'controller',
    message: 'Changing a character\'s controller is not supported yet.',
  },
  {
    word: 'summon',
    message: 'Summoning creatures is not supported yet — it needs an engine summon action.',
  },
];

/** Hover documentation for the words in play, keyed by lowercase word. */
export const WORD_DOCS: Readonly<Record<string, string>> = {
  ability: 'Starts an ability section. The name on the same line becomes the ability the player activates.',
  buff: 'Declares a buff definition that this ability can `Add`. Buff payloads (ticks, triggers) arrive with the events milestone.',
  deal: '`Deal <n> damage to <characters>.` — damages the characters\' HP.',
  heal: '`Heal <characters> for <n>.` (or `Heal <n> to <characters>`) — heals the characters.',
  destroy: '`Destroy <characters>.` — destroys the characters (resolved with the batch, like the engine\'s destroy action).',
  add: '`Add <buff> to <characters>.` — applies the buff to each character.',
  remove: '`Remove <buff> from <characters>.` — removes the buff (by id) from each character.',
  you: 'The player who controls the character using the ability. Also the owner filter: "characters owned by you".',
  all: 'Every one of a group: `all characters`, `all enemy characters`, `all characters owned by you`. At a sentence start: `All players lose the game.`',
  win: '`You win the game.` / `All players win the game.`',
  lose: '`You lose the game.` / `All players lose the game.`',
  wins: 'Same as `win`.',
  loses: 'Same as `lose`.',
  target: '`target character` — the player picks one character when the ability is used. The engine turns this into the ability\'s targeting pattern.',
  this: '`this` — whatever is using the ability, whatever kind of thing it is (a character, a card). `this character` is the longer spelling of the same phrase.',
  other: '`all other …` — the group without the user themselves.',
  enemy: 'Enemies of the user (engine `isEnemy`).',
  ally: 'Allies of the user (engine `isAlly` — includes the user themselves).',
  allied: 'Same as `ally`.',
  character: 'A character phrase noun.',
  characters: 'A character phrase noun.',
  owned: '`owned by …` narrows a group by its controller.',
  with: '`with …` filters the group — "with hp < 10" (low HP) or "with poison" (has the buff). Conditions combine with "and".',
  hp: 'The characters\' HP gauge — `with hp < 10` means current HP under 10. Also names a modifier\'s gauge: `incoming hp loss`.',
  mana: 'The characters\' mana gauge — `with mana > 5`. Also names a modifier\'s gauge: `incoming mana loss is prevented.`',
  and: 'Separates conditions inside a `with` clause — "with hp < 10 and poison". `and` binds tighter than `or`.',
  or: 'Separates alternative conditions inside a `with` clause — "with poison or hp < 10". `and` binds tighter than `or`.',
  opponent: '`owned by the opponent` — characters controlled by the enemy player.',
  to: 'Preposition: `deal … to`, `add <buff> to`, `heal <n> to`, `redirected to <gauge>`. Also the count range "2 to 5".',
  from: 'Preposition: `remove <buff> from`. Also narrows a modifier\'s subject by the other side of the action — `incoming damage from enemy characters is reduced by 3.`',
  for: '`Heal <characters> for <n>.`',
  the: '`… the game.`',
  game: '`You lose the game.` — the engine\'s win/lose actions.',
  players: '`All players …` — every registered player (a simultaneous all-lose resolves as a draw, per the engine).',
  stacks: 'Buff option: the buff may stack.',
  weight: 'Buff option: `weight <n>` — the status sort weight (defaults to 1).',

  // Trigger vocabulary (EVENT_PHRASES + the count words).
  when: '`when <count> <characters> <verb> then <effect>.` — a trigger. A count phrase ("2 or more") listens to the batch event, which fires once per batch, so the count is answerable; "when a character dies" fires once per death. Also the turn prefix inside a Buff: "When the turn starts, …".',
  then: 'Opens a trigger\'s effect: `when 2 or more characters die then deal 5 damage to all enemy characters.`',
  one: 'Counts are written as digits — "1 or more", not "one or more".',
  more: '"<n> or more" — a count floor: "when 3 or more characters die then …".',
  less: '"<n> or less" — a count cap. A batch only fires when it held at least one, so this is 1..n in practice.',
  die: '"characters die" — `character:destroyed:batch`, once per batch. Singular: "when a character dies".',
  survive: '"characters survive" — `character:survived:batch`: they took damage in a batch and lived. Singular: "when a character survives".',
  dies: 'Singular form of `die` — "when a character dies then …" fires once per death.',
  survives: 'Singular form of `survive` — fires once per surviving character.',
  enters: '`when <subject> enters <zone> [from <zone>] then …` — a zone movement. The zone names a place the game declares (the engine ships `play` and `graveyard`). Without `from`, it fires wherever the entity came from.',
  enter: 'Plural form of `enters` — "when 2 or more characters enter play then …".',
  leaves: '`when <subject> leaves <zone> [to <zone>] then …` — a zone movement out of a zone. Without `to`, it fires whatever the destination.',
  leave: 'Plural form of `leaves`.',
  if: '`If <condition>, <effect>.` — runs the effect only when the condition holds. Three readings: "if there are 2 or more …", "if any … has …", "if every … has …", "if this has …".',
  there: '`if there are <count> <characters>, …` — how many of them exist right now.',
  are: '`if there are …` — see `if`.',
  any: '`if any <characters> has <condition>, …` — true when **one of them** satisfies it. The array vocabulary, deliberately.',
  every: '`if every <characters> has <condition>, …` — true when **all of them** satisfy it.',
  even: '`an even number of <characters>` — a parity count. Written as words because `%` is reserved for percent.',
  odd: '`an odd number of <characters>` — a parity count.',
  number: 'Part of "an even number of" / "an odd number of".',
  may: '`You may <effect>.` — the controller is asked when the effect runs; a no skips it. Asked **after** any `If …,` condition, so you are never asked about something that could not happen.',
  repeat: '`Repeat [up to <n> times] [while <condition>] [if you choose]: <effect>.` — any subset of the three clauses. The condition is checked before the prompt, so you are never asked about an iteration that could not happen.',
  while: '`repeat while <condition>:` — the pure gate on each iteration.',
  choose: '`repeat if you choose:` — asks the controller before each iteration.',
  times: 'Part of "up to <n> times".',
  up: 'Part of "up to <n> times".',
  until: 'Buff option: `until end of turn` — the buff removes itself when the turn ends.',
  turns: 'Buff option: `for <n> turns` — the buff removes itself after that many turn-ends.',
  turn: 'Part of `until end of turn`.',
  end: 'Part of `until end of turn`.',
  of: 'Part of `until end of turn` / `an even number of`.',
  increased: '`Outgoing damage is increased by 5.` — adds to the **magnitude** of a matching change. On a stacking buff, every stack applies.',
  reduced: '`Incoming damage is reduced by 3.` — subtracts from the magnitude, never below zero.',
  multiplied: '`Outgoing damage is multiplied by 3.` — scales the magnitude.',
  doubled: '`Outgoing damage is doubled.` — multiplied by 2.',
  halved: '`Incoming damage is halved.` — multiplied by 0.5.',
  capped: '`Incoming damage is capped at 50.` — a ceiling on the magnitude.',
  prevented: '`Incoming damage is prevented.` — the action lands and changes nothing.',
  redirected: '`Incoming damage is redirected to mana.` — the realized change lands on a different gauge of the same character instead. A no-op if the character has no such gauge, or it\'s the same one the action already targets.',
  chance: '`Outgoing damage has a 25% chance to be multiplied by 3.` — rolled per action from the seeded PRNG, so a replay rolls the same.',
  is: '`<subject> is <rewrite>.` — the modifier sentence frame.',
  has: 'Introduces an `if any|every|this … has …` condition, or a modifier\'s `has a <n>% chance to be …`.',
  outgoing: 'What the buff\'s wearer does to something **else** — a self-inflicted cost is not outgoing damage.',
  incoming: 'What is done **to** the wearer.',
  healing: 'A change that gains value, as opposed to `damage`.',
  gain: '`Incoming mana gain is doubled.` — the generic, named-gauge spelling of `healing`. Must follow a gauge word ("hp"/"mana").',
  loss: '`Incoming mana loss is prevented.` — the generic, named-gauge spelling of `damage`. Must follow a gauge word ("hp"/"mana").',
  available: '`Available while <condition>.` — when the ability can be used. Written as a condition, not a switch, so the ability keeps a stable place in its owner\'s kit and merely lights up.',
  toggle: '`Toggle <buff>.` — flips the buff on the ability\'s owner: on becomes off, off becomes on. `Toggle <buff> on <characters>.` flips it on a group instead. The on/off state lives in the buff, so there is none kept anywhere else.',
  on: '`Toggle <buff> on <characters>.`',
  takes: '`this takes damage` — an HP gauge going down. Damage is not its own event in this engine; it is a gauge losing value.',
  take: 'Plural of `takes` — `characters take damage`.',
  healed: '`this is healed` — an HP gauge going up.',
  source: '`the source character` / `the source buff` — whatever caused the triggering event. The **kind is required**: an event\'s cause may be a character or a buff, and a card has to say which it answers, or it would silently ignore the other. Empty when nothing caused it, when the cause was the other kind, or when the cause was the trigger\'s own owner.',
};