/**
 * The Ability Language's vocabulary: the fixed English word set of the
 * prototype grammar (docs/creator/01-ability-language.md). The parser
 * accepts these words (case-insensitively); the completion engine and the
 * editor's hover help suggest from the same lists, so the three stay in
 * sync by construction.
 */

/** Section heading words — a heading must start its own line. */
export const SECTION_WORDS = ['ability', 'buff', 'zone', 'contest'] as const;

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
  'roll',
  'store',
  'draw',
  'scry',
  'create',
  'the',
  'target',
  'surveil',
  'cards',
  'reveal',
  'cast',
  'move',
  'starting',
  'ending',
  'in',
  'you',
  'all',
  'each',
  'when',
  'if',
  'repeat',
  ...DIRECTION_WORDS,
  ...CHANGE_WORDS,
  'available',
] as const;

/** The result-verb forms accepted after `you` / `all players`. */
export const RESULT_VERBS = ['win', 'lose'] as const;

/** Character-phrase quantifiers. */
export const QUANTIFIERS = ['this', 'target', 'all'] as const;

/** Relative-to-user adjectives allowed inside a character phrase. */
export const ADJECTIVES = ['enemy', 'ally'] as const;

/** The noun words of a character phrase. */
export const CHAR_WORDS = ['character', 'characters'] as const;

/** Ownership clause marker word. */
export const OWNED = 'owned' as const;

/** Owner words after `owned by`. */
export const OWNER_WORDS = ['you', 'opponents'] as const;

export const FOR = 'for' as const;

/** `to` / `from` / `on` end a buff reference inside `Add`/`Remove`/`Toggle`. */
export const BUFF_STOP_WORDS = ['to', 'from', 'on'] as const;

/**
 * The gauge words a `with` condition can compare (`with hp < 10`) when the host
 * names none. Gauges are a game's own, so a host passes its game's gauge ids
 * (`CompileOptions.gauges`) and these are only the fallback.
 */
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
   * so "is damaged" is `gauge:changed` plus these.
   *
   * `{ kind: 'life' }` means the triggering entity's own declared life
   * gauge, which is what "is damaged"/"is healed" watch — the same
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
    verbs: [['are', 'destroyed'], ['is', 'destroyed']],
    event: 'character:destroyed',
    batchEvent: 'character:destroyed:batch',
    doc: '`characters are destroyed` — the engine\'s destruction event. With a count phrase it listens to `character:destroyed:batch`, which fires once per batch, so "2 or more" is answerable.',
  },
  {
    verbs: [['survives']],
    event: 'character:survived',
    batchEvent: 'character:survived:batch',
    doc: '`survives` — a character took damage in a batch and lived. With a count phrase it listens to `character:survived:batch`.',
  },
  {
    verbs: [['are', 'damaged'], ['is', 'damaged']],
    event: 'gauge:changed',
    batchEvent: 'gauge:changed:batch',
    gauge: { kind: 'life' },
    change: 'damage',
    doc: '`this is damaged` — the life gauge going down. The engine has no separate damage event: damage *is* a gauge losing value. `the source` is whoever dealt it, and a self-inflicted cost does not count.',
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
    word: 'transform',
    message: 'Character transformations are out of scope for now.',
  },
  {
    word: 'controller',
    message: 'Changing a character\'s controller is not supported yet.',
  },
];

/** Hover documentation for the words in play, keyed by lowercase word. */
export const WORD_DOCS: Readonly<Record<string, string>> = {
  ability: 'Starts an ability section. The name on the same line becomes the ability the player activates.',
  buff: 'Declares a buff definition that this ability can `Add`. Buff payloads (ticks, triggers) arrive with the events milestone.',
  deal: '`Deal <n> damage to <characters>.` — damages the characters\' HP.',
  heal: '`Heal <characters> for <n>.` — heals the characters.',
  destroy: '`Destroy <characters>.` — destroys the characters (resolved with the batch, like the engine\'s destroy action).',
  add: '`Add <buff> to <characters>.` — applies the buff to each character.',
  remove: '`Remove <buff> from <characters>.` — removes the buff (by id) from each character.',
  you: 'The player who controls the character using the ability. Also the owner filter: "characters owned by you".',
  all: 'Every one of a group: `all characters`, `all enemy characters`, `all characters owned by you`. At a sentence start: `All players lose the game.`',
  win: '`You win the game.` / `All players win the game.`',
  lose: '`You lose the game.` / `All players lose the game.`',
  target: '`target character` — the player picks one character when the ability is used. The engine turns this into the ability\'s targeting pattern.',
  this: '`this` — whatever is using the ability, whatever kind of thing it is (a character, a card).',
  other: '`all other …` — the group without the user themselves.',
  enemy: 'Enemies of the user (engine `isEnemy`).',
  ally: 'Allies of the user (engine `isAlly` — includes the user themselves).',
  character: 'A character phrase noun.',
  characters: 'A character phrase noun.',
  owned: '`owned by …` narrows a group by its controller.',
  with: '`with …` filters the group — "with hp < 10" (low HP) or "with poison" (has the buff). Conditions combine with "and".',
  hp: 'The characters\' HP gauge — `with hp < 10` means current HP under 10. Also names a modifier\'s gauge: `incoming hp loss`.',
  mana: 'The characters\' mana gauge — `with mana > 5`. Also names a modifier\'s gauge: `incoming mana loss is prevented.`',
  and: 'Separates conditions inside a `with` clause — "with hp < 10 and poison". `and` binds tighter than `or`.',
  or: 'Separates alternative conditions inside a `with` clause — "with poison or hp < 10". `and` binds tighter than `or`.',
  opponent: '`owned by opponents` — characters controlled by any opponent. Also `All opponents commit …` — every player but you.',
  opponents: '`owned by opponents` — characters controlled by any opponent.',
  to: 'Preposition: `deal … to`, `add <buff> to`, `redirected to <gauge>`. Also the count range "2 to 5".',
  from: 'Preposition: `remove <buff> from`. Also narrows a modifier\'s subject by the other side of the action — `incoming damage from enemy characters is reduced by 3.`',
  for: '`Heal <characters> for <n>.`',
  the: '`… the game.`',
  game: '`You lose the game.` — the engine\'s win/lose actions.',
  players: '`All players …` — every registered player (a simultaneous all-lose resolves as a draw, per the engine).',
  fading: 'Buff option: `fading <n>` — each instance starts with n counters; every turn end removes one, and an instance that cannot is destroyed. `fading 0` goes at the first turn end, `fading 1` waits a full turn.',
  weight: 'Buff keyword line: `Weight <n>.` — the status sort weight (defaults to 1).',

  // Trigger vocabulary (EVENT_PHRASES + the count words).
  when: '`when <count> <characters> <verb> then <effect>.` — a trigger. A count phrase ("2 or more") listens to the batch event, which fires once per batch, so the count is answerable; "when a character dies" fires once per death. Also the turn prefix inside a Buff: "When a turn starts then …".',
  then: 'Opens a trigger\'s effect: `when 2 or more characters are destroyed then deal 5 damage to all enemy characters.`',
  more: '"<n> or more" — a count floor: "when 3 or more characters are destroyed then …".',
  less: '"<n> or less" — a count cap. A batch only fires when it held at least one, so this is 1..n in practice.',
  destroyed: '"characters are destroyed" — `character:destroyed:batch`, once per batch. Singular: "when a character is destroyed".',
  die: 'A single die of a roll: `that highest die`, `that lowest die`.',
  survives: '"when a character survives" — it took damage and lived (`character:survived`). With a count phrase it listens to `character:survived:batch`, once per batch: "when 2 or more enemy characters survives". One verb form, whatever the subject.',
  enters: '`when <subject> enters <zone> [from <zone>] then …` — a zone movement. The zone names a place the game declares (the engine ships `play` and `garbage`). Without `from`, it fires wherever the entity came from.',
  leaves: '`when <subject> leaves <zone> [to <zone>] then …` — a zone movement out of a zone. Without `to`, it fires whatever the destination.',
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
  roll: '`Roll a d20.` / `Roll 2d6.` — rolls the dice once. Put a **result per line** under it for a table: `1: …`, `2 to 5: …`, `15 or more: …`, `Otherwise: …` — the roll is read once and the first line it falls in runs; a result with no line does nothing. Later sentences read the outcome as `that value` (the sum; for one die, the die), `that highest die` or `that lowest die`: "Roll 2d6. Deal that value damage to target enemy character." `That` is always the **most recent** roll; to keep an earlier one, store it: "Store that value as AttackerRoll." A roll is announced, so effects can respond to it.',
  otherwise: '`Otherwise: <effect>` — the last line of a roll table: what happens for every result no other line covers.',
  vote: 'The count of a choice between names. `Starting with you, each player chooses Attack or Retreat.` (open, round the table — begin with `Ending with you,`, `Starting with a random player,` or `In reverse order,` to change who goes first) or `All players commit Attack or Retreat face down.` (sealed, then reveal). Read the result with `votes for Attack`, `the highest vote` or `the lowest vote`: `If votes for Attack = the highest vote, …` is true for the winner or a tie for it; `>` is a strict win.',
  votes: '`votes for Attack` — how many votes that option got in the latest vote. Use it anywhere an amount goes: `If votes for Attack > votes for Retreat, …`. A sealed vote can only be counted after its reveal.',
  starting: '`All players choose …` — the caster votes first, then round the table. `Starting with a random player, …` rolls a die with a face per seat to choose who is first.',
  ending: '`Ending with you, each player chooses …` — round the table, with the caster voting last.',
  reverse: '`In reverse order, each player chooses …` — the seating backwards (last seat first); the caster\'s seat plays no part.',
  random: '`Starting with a random player, …` — a die roll with one face per seat decides who votes first; a table rolls a real die.',
  cast: '`Cast this if you can, otherwise move it to its owner\'s garbage.` — starts casting the card the ability belongs to. Whether it can be cast (cost, targets) is the game\'s to say; casting reveals the card by putting it on the stack, and if it cannot be cast the fallback happens instead.',
  card: '`Card <name>` starts a card section. Inside an ability a card was given, `this` is that card: `Reveal this.`, `Cast this if you can.`, `Move this to its owner\'s garbage.`',
  move: '`Move this to its owner\'s garbage.` — puts the card into a zone of its **owner** (whoever\'s pile it came from), not of whoever is using the ability.',
  cards: '`Cards in your boxed zone have Open Present for all opponents.` — gives every card in a zone an ability it never printed. Say whose zone (`your`, `each player\'s`, `each opponent\'s`, or `the` for a shared one), name an ability from this document, and say who may use it (`for you`, `for all players`, `for all opponents`; without `for` anyone may). The ability is on the cards only while they are in the zone.',
  have: '`Cards in your boxed zone have Open Present.` — the zone gives its cards that ability, for as long as they are there. `Cards in this zone no longer have Open Present.` takes it away again, from everyone it was given to.',
  longer: '`Cards in this zone no longer have Open Present.` — removes an ability a zone gave its cards.',
  as: 'Names something for later: `Target 1 character as Victim.` names a pick; `Store that value as AttackerRoll.` names a stored value.',
  that: '`that value` / `that highest die` — the **most recent** roll of the ability. There is no "the total": to use an earlier roll, store it with `Store that value as <Name>.` and write the name.',
  value: '`that value` — the total of the most recent roll (for one die, the die).',
  highest: '`that highest die` — the largest single die of the most recent roll.',
  lowest: '`that lowest die` — the smallest single die of the most recent roll.',
  store: '`Store that value as AttackerRoll.` — keeps a value under a name for the rest of the ability, so a later roll does not overwrite it. Write the name wherever an amount goes: `Deal AttackerRoll damage to …`. A name is stored once.',
  draw: '`Draw(you, 2).` — `draw(player, count)`: move that many cards from the top of the player\'s library to the player\'s hand. The player comes first: `you`, `each player` or `each opponent`; then the number. If the library runs out, the game decides what happens (some games hurt the player).',
  choose: '`repeat if you choose:` — asks the controller before each iteration. Also `Starting with you, each player chooses a card from their hand.` — an **open** choice: the players answer one at a time in turn order and each sees the earlier answers. For a hidden, simultaneous choice, use `commit`.',
  commit: '`All players commit a card from their hand face down.` — **choose a valid option and write the value face down so you cannot change it.** A **sealed** choice: every player places their answer at the same time, and nobody can see or change anyone\'s answer until the reveal. A vague or invalid commitment — an option that does not exist, one that names nothing, or one that could mean two things, like "Goblin" when two goblins are in play — or any attempt to change it **loses you the game**, found out when it is revealed. Give look-alikes a marker ("Goblin (A)") so each can be written down exactly. Use `choose` when the answers are made in the open.',
  committed: '`the card they committed` — the card every player placed face down, usable only after `When they are ready, reveal.`',
  face: 'Part of `face down`: a commitment is placed face down, so nobody can see it until the reveal.',
  down: 'Part of `face down`.',
  reveal: '`When they are ready, reveal.` — turns every committed answer face up at once, and is when each one is checked: a vague or invalid commitment loses that player the game. Required after a `commit`; there is nothing to reveal after a `choose`. Also `Reveal this.` — shows the card an ability belongs to.',
  ready: '`When they are ready, reveal.` — a player is ready when they have committed. Only the players who are committing are waited on; anyone else is not.',
  player: '`All players choose …` — see `each`.',
  they: '`When they are ready` / `the card they committed` — the players who just chose or committed, and no one else.',
  chose: '`the card they chose` — the card every player picked in an open `choose`.',
  their: '`from their hand` / `to their garbage` — a player\'s own zone. Written `your` for `You`.',
  your: '`from your hand` / `to your garbage` — see `their`.',
  times: 'Part of "up to <n> times".',
  up: 'Part of "up to <n> times".',
  of: 'Part of `an even number of`.',
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
  damaged: '`this is damaged` — the life gauge going down. Damage is not its own event in this engine; it is a gauge losing value. Plural: `are damaged`.',
  healed: '`this is healed` — an HP gauge going up.',
  source: '`the source` / `the source buff` — whatever caused the triggering event. The **kind is required**: an event\'s cause may be a character or a buff, and a card has to say which it answers, or it would silently ignore the other. Empty when nothing caused it, when the cause was the other kind, or when the cause was the trigger\'s own owner.',
};