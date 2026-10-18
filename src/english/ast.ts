/**
 * The Ability Language's AST and shared types (docs/creator/01-ability-language.md).
 *
 * A document is a list of sections — `Ability` sections (a heading plus
 * effect sentences) and `Buff` sections (definitions the ability sentences
 * reference). Everything carries a source span so the editor can point at
 * the exact text for diagnostics, completion, and future hover help.
 */
import type { CardOrderIR, CardSelectorIR, CardSourceIR, ContestIR, ContestPlayersIR, MathExpression, PlayerListIR, RestIR, ZoneRefIR } from '../ir/index.js';

export interface Span {
  /** Absolute character offset of the first character (inclusive). */
  readonly start: number;
  /** Absolute character offset one past the last character (exclusive). */
  readonly end: number;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  readonly severity: Severity;
  readonly message: string;
  readonly start: number;
  readonly end: number;
  /** Stable code (e.g. 'unknown-buff') for tests and UI grouping. */
  readonly code: string;
}

/** A parsed document: ability sections in order, plus buff definitions. */
export interface Doc {
  readonly abilities: AbilitySection[];
  readonly buffs: BuffSection[];
  readonly imports: ImportSection[];
  /**
   * `Zone boxed` sections: statements about one of the game's zones, the way an
   * `Ability` section is about an ability. They are applied by the host at setup.
   */
  readonly zones: ZoneSection[];
  /**
   * `when … then …` sentences written outside any `Buff` — they belong to
   * no status, so the host decides which character carries them (see
   * `CompileResult.triggers`).
   */
  readonly triggers: TriggerSentence[];
  /** `Contest Rock Paper Scissors` sections — each one a function from a list of players to who won. */
  readonly contests: ContestSection[];
}

/**
 * A `Contest <name>` section: the rulebook of a game several players play.
 *
 * ```
 * Contest Rock Paper Scissors
 * Players 2.
 * All players commit Rock, Paper or Scissors face down.
 * When they are ready, reveal.
 * If all players committed the same option, it is a tie.
 * If player 1 committed Rock and player 2 committed Scissors, player 1 win and player 2 lose.
 * Otherwise player 2 win and player 1 lose.
 * ```
 *
 * It is read by the same parser as every other section — the commit and reveal are the
 * ordinary choice sentences — and what it means is a function of the players it receives:
 * `(players) => { winners, losers, isTie }`. `contest` is that function's data (the IR), present
 * once the section has no problems.
 */
export interface ContestSection {
  readonly kind: 'contest';
  span: Span;
  readonly name: string;
  readonly nameSpan: Span;
  /** `Players 2.` — how many must play. */
  playerCount?: number;
  /** The `All players commit … face down.` sentence: the names players commit between. */
  commit?: { readonly options: readonly string[]; readonly span: Span };
  /** True once `When they are ready, reveal.` has followed the commit. */
  revealed: boolean;
  rules: ContestRuleNode[];
  /** The contest as data, once the section is valid. */
  contest?: ContestIR;
}

/** One rule of a contest, with the spans a diagnostic points at. */
export type ContestRuleNode =
  | { readonly kind: 'tie'; readonly span: Span }
  | {
      readonly kind: 'when';
      readonly span: Span;
      readonly picks: readonly { readonly player: number; readonly option: string; readonly playerSpan: Span; readonly optionSpan: Span }[];
      readonly winners: readonly number[];
      readonly losers: readonly number[];
      readonly playerSpans: readonly Span[];
    }
  | {
      readonly kind: 'otherwise';
      readonly span: Span;
      readonly winners: readonly number[];
      readonly losers: readonly number[];
      readonly playerSpans: readonly Span[];
    };

/**
 * How many of the triggering things the batch must hold.
 *
 * Either a **range** (`2 to 5`, `3 or more`) or a **parity** (`an even
 * number of`) — parity is not a range, which is why it is a separate shape
 * rather than a third bound.
 */
export type CountPhrase =
  | {
      readonly kind: 'range';
      readonly span: Span;
      readonly min: number;
      /** `null` for an open top (`3 or more`). */
      readonly max: number | null;
      /** The phrase as written, for diagnostics and previews. */
      readonly text: string;
    }
  | {
      readonly kind: 'parity';
      readonly span: Span;
      readonly parity: 'even' | 'odd';
      readonly text: string;
    };

/**
 * `when <count> <subject> <verb> then <effect>.`
 *
 * A **count phrase** makes it a batch trigger — it listens to the engine's
 * `:batch` event, which fires once per batch carrying the individual
 * events, so a count is answerable. A singular subject (`when a character
 * dies`) is the per-event trigger instead.
 *
 * The subject is an ordinary character phrase, so adjectives, `owned by`
 * and `with …` filters all apply to the **triggering** characters: they
 * filter which of the batch's events count before the count is checked.
 */
export interface TriggerSentence {
  readonly kind: 'trigger';
  readonly span: Span;
  /** The engine event type this listens to. */
  readonly event: string;
  readonly mode: 'single' | 'batch';
  /**
   * For a gauge event: which gauge, and which direction. A named id, or
   * `{ kind: 'life' }` for the triggering entity's own life gauge —
   * what `is damaged`/`is healed` watch (see `EventPhrase.gauge`).
   */
  readonly gauge?: string | { readonly kind: 'life' };
  readonly change?: 'damage' | 'heal';
  /**
   * For a **zone movement** (`zone:changed`): which zone the phrase names,
   * and which end of the move that is.
   *
   * `when this enters play from active` — the entity is arriving in `play`,
   * having come from `active`. A `leaves` phrase names the origin instead
   * (`when this leaves play`). The opposite end is optional: without it the
   * trigger fires no matter where the entity came from or went.
   */
  readonly zone?: ZonePhrase;
  /** Absent for a singular trigger, which has no count to check. */
  readonly count: CountPhrase | undefined;
  /** The triggering characters — the adjectives and filters. */
  readonly subject: CharsPhrase;
  /** Span of the noun+verb, for hover help. */
  readonly eventSpan: Span;
  /** What happens. */
  readonly effects: Sentence[];
}

/** The `enters <zone> [from <zone>]` / `leaves <zone> [to <zone>]` phrase. */
export interface ZonePhrase {
  /** `enters` matches the destination; `leaves` matches the origin. */
  readonly verb: 'enters' | 'leaves';
  /** The zone the phrase names (`play`), in the host's canonical spelling. */
  readonly id: string;
  /** The optional other end — `from <zone>` / `to <zone>`. */
  readonly opposite?: string;
  /** Span of the whole phrase, for hover help. */
  readonly span: Span;
}

/**
 * `Zone boxed` followed by statements about that zone, in which **"this zone"** is
 * the zone the heading names:
 *
 * ```
 * Zone boxed
 * Cards in this zone have Open Present for all opponents.
 * ```
 *
 * For a per-player zone it covers every player's instance, and "you" / "each
 * opponent" are relative to *that instance's owner*; a shared zone has no owner, so
 * only "each player" makes sense there.
 */
export interface ZoneSection {
  readonly kind: 'zone';
  readonly span: Span;
  /** The zone's canonical name (resolved against the host's zones). */
  readonly zone: string;
  readonly nameSpan: Span;
  sentences: Sentence[];
}

export interface ImportSection {
  readonly kind: 'import';
  readonly span: Span;
  readonly name: string;
  readonly nameSpan: Span;
  readonly path: string;
  readonly pathSpan: Span;
}

export interface AbilitySection {
  readonly kind: 'ability';
  readonly span: Span;
  readonly name: string;
  /** Span of the ability's name text. */
  readonly nameSpan: Span;
  readonly sentences: Sentence[];
  /**
   * `Target 1 character as victim and 1 different character as benefactor.`
   *
   * Named picks, so the body says `the victim` rather than counting
   * positions — and so one ability may ask for several *different* things,
   * which a single `target …` phrase cannot.
   */
  targets?: TargetBinding[];
  /**
   * `Available while <condition>.` — when the ability can be used.
   *
   * Written as a condition rather than something a trigger switches on,
   * so the ability keeps a stable place in its owner's kit (one hotkey,
   * one gamepad button) and merely lights up when the condition holds.
   */
  available?: IfClause;
}

export interface BuffSection {
  readonly kind: 'buff';
  readonly span: Span;
  readonly name: string;
  readonly nameSpan: Span;
  /** The buff's weight (`BuffDef.weight`), set by the `Weight <n>.` keyword line. Defaults to 1. */
  weight: number;
  /** Where the `Weight` line is, once written. */
  weightSpan?: Span;
  /** The `Fading <n>.` keyword line: the counters each instance starts with. Absent means permanent. */
  fading?: number;
  /** Sentences (triggers / effects) defined on the buff. */
  readonly sentences: Sentence[];
  /** `when … then …` triggers the buff grants while it is attached. */
  readonly triggers: TriggerSentence[];
  /** `Increase outgoing damage by 5.` — what the buff changes about actions. */
  readonly modifiers: ModifierSentence[];
}

/** One clause of a `Target …` sentence. */
export interface TargetBinding {
  readonly span: Span;
  readonly name: string;
  readonly nameSpan: Span;
  readonly count: number;
  /** `1 different character` — must not be an earlier binding's pick. */
  readonly distinct: boolean;
  /**
   * The shape of the pick. Only `who`, `owner` and `withClause` matter —
   * the quantifier is always the group form.
   */
  readonly chars: CharsPhrase;
}

/* ----------------------------- modifiers ------------------------------ */

/**
 * A modifier sentence inside a `Buff` — it never happens, it changes what
 * happens:
 *
 * ```
 * Outgoing damage is increased by 5.
 * Incoming damage is capped at 50.
 * Outgoing damage has a 25% chance to be multiplied by 3.
 * Incoming healing is prevented.
 * ```
 *
 * **Declarative, not imperative.** A modifier is a standing rule about
 * what happens, not something that happens — "incoming damage is capped at
 * 50" is true for as long as the buff is attached, where "cap incoming
 * damage" reads like a one-off instruction.
 *
 * `outgoing` is what the owner does to something else; `incoming` is what
 * is done to the owner. Amounts apply to the **magnitude** of the change,
 * so "increased by 5" is five more damage without the author ever thinking
 * about signs.
 */
export interface ModifierSentence {
  readonly kind: 'modifier';
  readonly span: Span;
  readonly direction: 'outgoing' | 'incoming' | undefined;
  readonly change: 'damage' | 'heal';
  /**
   * `incoming mana loss` / `outgoing hp gain` — names the gauge rather than
   * leaving `damage`/`healing` to match any. Unset when the subject was
   * written the HP-generic way (`damage`/`healing`).
   */
  readonly gauge?: string;
  /**
   * `from enemy characters` — narrows to who is on the other side of the
   * matched action: who an outgoing action is aimed at, or who an incoming
   * one came from. Always the bare group form (no `this`/`target`
   * quantifier) — same shape as a trigger's subject.
   */
  readonly target?: CharsPhrase;
  readonly rewrite:
    | { readonly kind: 'amount'; readonly op: 'add' | 'subtract' | 'multiply'; readonly by: MathExpression }
    | { readonly kind: 'cap'; readonly at: MathExpression }
    | { readonly kind: 'prevent' }
    | { readonly kind: 'redirect'; readonly gauge: string };
  /** `has a 25% chance to be …` — the rewrite is rolled per action. */
  readonly chance?: MathExpression;
}

/* ------------------------------- guards ------------------------------- */

/**
 * The `If …,` clause in front of an effect — a condition checked right
 * before that effect runs, so in a multi-sentence ability it sees the
 * earlier sentences' results.
 *
 * Three readings, one grammar:
 *
 * ```
 * If there are 2 or more enemy characters, deal 5 damage to this.
 * If any enemy character has Poison, destroy all enemy characters with Poison.
 * If this has hp < 10, heal this for 20.
 * ```
 *
 * `any` and `every` are the array vocabulary deliberately — they are what
 * the same operation is called in code, and they make the difference
 * between "one of them" and "all of them" impossible to misread.
 */
export type IfClause =
  /** `there are <count> <subject>` — how many of them exist right now. */
  | {
      readonly kind: 'count';
      readonly span: Span;
      readonly count: CountPhrase;
      readonly subject: CharsPhrase;
    }
  /** `any`/`every` `<subject>` `has <condition>`. */
  | {
      readonly kind: 'any' | 'every';
      readonly span: Span;
      readonly subject: CharsPhrase;
      readonly condition: BooleanCondition;
    }
  /**
   * `<value> <op> <value> [and …]` — a condition on numbers: `that value >= 10`,
   * `AttackerRoll > DefenderRoll`, `that value >= 2 and that value <= 5`. Each
   * side is any amount (a roll, a stored name, a formula).
   */
  | {
      readonly kind: 'value';
      readonly span: Span;
      readonly comparisons: readonly ValueComparison[];
    };

/** One `<value> <op> <value>` comparison of a value condition; several are joined by `and`. */
export interface ValueComparison {
  readonly span: Span;
  readonly value: MathExpression;
  readonly op: WithOperator;
  readonly other: MathExpression;
}

/**
 * `Repeat [up to <n> times] [while <condition>] [if you choose]: <effect>.`
 *
 * Three independent clauses, any subset, each with its own word so nothing
 * is inferred from position: `while` is the condition, `if you choose` is
 * the prompt, `up to <n> times` is the cap. The condition is checked before
 * the prompt, so a player is never asked about an iteration that could not
 * have happened.
 */
export interface RepeatClause {
  readonly span: Span;
  readonly condition: IfClause | undefined;
  readonly confirm: boolean;
  /** Iterations that happen without asking — the mandatory floor. */
  readonly min: number;
  readonly max: number | undefined;
  /** The count phrase as written, for the preview. */
  readonly countText: string | undefined;
}

/* ------------------------------ sentences ----------------------------- */

export type Sentence =
  | DealSentence
  | HealSentence
  | DestroySentence
  | AddBuffSentence
  | RemoveBuffSentence
  | ToggleBuffSentence
  | RollSentence
  | ZoneAbilitySentence
  | RevealCardSentence
  | CastCardSentence
  | MoveCardSentence
  | MoveCardsSentence
  | RevealCardsSentence
  | SplitSentence
  | RemoveCountersSentence
  | PlaySentence
  | CreateSentence
  | CastCardsSentence
  | ChoosePileSentence
  | StoreSentence
  | DrawSentence
  | ScrySentence
  | ChooseSentence
  | RevealSentence
  | MoveChosenSentence
  | ResultSentence;

/** `Deal 5 damage to all enemy characters.` */
export interface DealSentence {
  readonly kind: 'deal';
  readonly span: Span;
  /** A literal `5` or a formula like `(this.hp / 2)` — see "Math expressions". */
  readonly amount: MathExpression;
  readonly amountSpan: Span;
  readonly chars: CharsPhrase;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `Heal all ally characters for 25.` (or the amount-first word order). */
export interface HealSentence {
  readonly kind: 'heal';
  readonly span: Span;
  /** A literal `5` or a formula like `(this.hp / 2)` — see "Math expressions". */
  readonly amount: MathExpression;
  readonly amountSpan: Span;
  readonly chars: CharsPhrase;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `Destroy this character.` */
export interface DestroySentence {
  readonly kind: 'destroy';
  readonly span: Span;
  readonly chars: CharsPhrase;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `Add Poison to target enemy character.` — `<buff>` must resolve. */
export interface AddBuffSentence {
  readonly kind: 'addBuff';
  readonly span: Span;
  readonly buffName: string;
  readonly buffSpan: Span;
  readonly chars: CharsPhrase;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `Remove Poison from all characters.` */
export interface RemoveBuffSentence {
  readonly kind: 'removeBuff';
  readonly span: Span;
  readonly buffName: string;
  readonly buffSpan: Span;
  readonly chars: CharsPhrase;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/**
 * `Toggle Immolation Aura.` / `Toggle Poison on target enemy character.`
 *
 * Flips the buff — on becomes off and off becomes on — deciding once from
 * the state before anything applies. With no `on …` it flips it on the
 * ability's own owner, which is the usual case.
 */
export interface ToggleBuffSentence {
  readonly kind: 'toggleBuff';
  readonly span: Span;
  readonly buffName: string;
  readonly buffSpan: Span;
  readonly chars: CharsPhrase;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/**
 * `Cards in your boxed zone have Open Present for all opponents.` — gives every
 * card in a zone an ability it never printed, for the players named. The ability
 * is one of the document's own, named as written; whose zone, and who may use it,
 * are spelled out so nothing is left to a reader to guess. Without `for …` anyone
 * may.
 */
export interface ZoneAbilitySentence {
  readonly kind: 'zoneAbility';
  readonly span: Span;
  readonly zone: string;
  readonly zoneSpan: Span;
  /**
   * Whose instance of the zone: `your`, `all players'`, `all opponents'`, `the` (a
   * shared zone), or `this` — the zone a `Zone` section is about (then `zone` is
   * empty until the section fills it in).
   */
  readonly owners: 'you' | 'each' | 'opponents' | 'shared' | 'this';
  /** The ability's name as written (resolved against the document's abilities). */
  readonly ability: string;
  readonly abilitySpan: Span;
  readonly users: 'you' | 'each' | 'opponents';
  /** `no longer have` — takes the ability away from the zone's cards instead. */
  readonly remove?: true;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/**
 * `Reveal this card.` — show the card an ability belongs to. "This card" is the
 * card a zone or an effect gave the ability to (a Boxed Present's *Open Present*),
 * not a character.
 */
export interface RevealCardSentence {
  readonly kind: 'revealCard';
  readonly span: Span;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/**
 * `Cast this card if you can.` / `Cast this card if you can, otherwise move it to
 * its owner's garbage.` — whether it can be cast is the game's to say, and casting
 * reveals it. The fallback is a zone of the card's owner.
 */
export interface CastCardSentence {
  readonly kind: 'castCard';
  readonly span: Span;
  readonly otherwise?: { readonly zone: string; readonly zoneSpan: Span };
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `The winners create a Giant Golem.` */
export interface CreateSentence {
  readonly kind: 'create';
  readonly span: Span;
  readonly players: PlayerListIR;
  readonly creature: string;
  readonly guard?: IfClause;
  readonly optional?: boolean;
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `All players play Rock Paper Scissors.` */
export interface PlaySentence {
  readonly kind: 'play';
  readonly span: Span;
  readonly players: ContestPlayersIR;
  readonly contest: ContestIR;
  readonly guard?: IfClause;
  readonly optional?: boolean;
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `Remove a counter from all cards in this zone.` */
export interface RemoveCountersSentence {
  readonly kind: 'removeCounters';
  readonly span: Span;
  readonly count: number;
  readonly counterKind?: string;
  readonly select: CardSelectorIR;
  readonly from: ZoneRefIR;
  readonly guard?: IfClause;
  readonly optional?: boolean;
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `Cast all cards with no counters from this zone without paying their cost.` */
export interface CastCardsSentence {
  readonly kind: 'castCards';
  readonly span: Span;
  readonly select: CardSelectorIR;
  readonly from: ZoneRefIR;
  readonly free?: true;
  readonly guard?: IfClause;
  readonly optional?: boolean;
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `Target opponent separates Pool into Fact and Fiction.` */
export interface SplitSentence {
  readonly kind: 'split';
  readonly span: Span;
  readonly chooser: 'you' | 'opponent';
  readonly from: ZoneRefIR;
  readonly into: readonly [string, string];
  readonly guard?: IfClause;
  readonly optional?: boolean;
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `You choose Fact or Fiction.` */
export interface ChoosePileSentence {
  readonly kind: 'choosePile';
  readonly span: Span;
  readonly options: readonly [string, string];
  readonly guard?: IfClause;
  readonly optional?: boolean;
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `Reveal all cards castable by target opponent.` */
export interface RevealCardsSentence {
  readonly kind: 'revealCards';
  readonly span: Span;
  readonly select: CardSelectorIR;
  readonly selectSpan: Span;
  readonly from: CardSourceIR;
  readonly fromSpan: Span;
  readonly guard?: IfClause;
  readonly optional?: boolean;
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `Move the top 3 cards from your library to your hand.` */
export interface MoveCardsSentence {
  readonly kind: 'moveCards';
  readonly span: Span;
  readonly select: CardSelectorIR;
  readonly selectSpan: Span;
  readonly from: CardSourceIR;
  readonly fromSpan: Span;
  readonly to: ZoneRefIR;
  readonly toSpan: Span;
  readonly order?: CardOrderIR;
  readonly rest?: RestIR;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `Move this card to its owner's garbage.` */
export interface MoveCardSentence {
  readonly kind: 'moveCard';
  readonly span: Span;
  readonly zone: string;
  readonly zoneSpan: Span;
  readonly article?: 'the';
  readonly counters?: { readonly count: number; readonly kind?: string };
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/**
 * `Roll a d20.` / `Roll 2d6.` — rolls dice; later sentences read the outcome as
 * `the total`, `the highest die` or `the lowest die`
 * (docs/design/20-secret-choices-and-dice.md).
 */
export interface RollSentence {
  readonly kind: 'roll';
  readonly span: Span;
  readonly count: number;
  readonly sides: number;
  /**
   * The result lines under the roll, one per line, in the Deck of Many Things
   * shape. Each line covers a result (or a range) and holds its own sentences:
   *
   * ```
   * Roll a d20.
   *   1: Destroy this character.
   *   2 to 5: Deal 5 damage to this character.
   *   20: Draw(you, 2).
   * ```
   */
  readonly table?: readonly TableRow[];
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/**
 * One result line of a roll table: `2 to 5: Deal 5 damage to this character.`
 * The range is inclusive; `max: null` is open ("15 or more"), and `otherwise`
 * covers whatever no other line does. A line may hold several sentences.
 */
export interface TableRow {
  readonly span: Span;
  /** The header as written (`2 to 5`, `15 or more`, `Otherwise`), for diagnostics. */
  readonly text: string;
  readonly min: number;
  readonly max: number | null;
  readonly otherwise: boolean;
  readonly sentences: readonly Sentence[];
}

/**
 * `Store that value as AttackerRoll.` — keeps a value under a name for the rest
 * of the ability, so it survives a later roll. Read it back by writing the name
 * where an amount goes.
 */
export interface StoreSentence {
  readonly kind: 'store';
  readonly span: Span;
  /** The value kept: `that value`, a number, or a formula. */
  readonly value: MathExpression;
  readonly name: string;
  readonly nameSpan: Span;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/**
 * `Scry(you, 3).` — `scry(player, count)`: look at that many cards from the top of the
 * player's library; they put any number on the bottom and the rest back on top, in the
 * order they choose.
 */
export interface ScrySentence {
  readonly kind: 'scry';
  /** `Surveil(…)`: the cards not kept on top go to the garbage, not the bottom. */
  readonly surveil?: true;
  readonly span: Span;
  readonly count: MathExpression;
  readonly players: PlayerListIR;
  readonly guard?: IfClause;
  readonly optional?: boolean;
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/**
 * `Draw(you, 2).` — `draw(player, count)`: move that many cards from the top of
 * the player's library to their hand.
 */
export interface DrawSentence {
  readonly kind: 'draw';
  readonly span: Span;
  readonly count: MathExpression;
  readonly players: PlayerListIR;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/**
 * `All players commit a card from their hand face down.` /
 * `Starting with you, each player chooses a number from 1 to 6.`
 *
 * Opens a choice round (docs/design/20-secret-choices-and-dice.md). **Commit**
 * is sealed: every player answers without seeing the others, face down. **Choose**
 * is open: the players answer in turn order.
 */
export interface ChooseSentence {
  readonly kind: 'choose';
  readonly span: Span;
  /** `'each'` — every player; `'opponents'` — `Each opponent`; `'you'`. */
  readonly players: 'you' | 'each' | 'opponents';
  readonly playersSpan: Span;
  readonly pick:
    | { readonly kind: 'card'; readonly zone: string; readonly zoneSpan: Span }
    | { readonly kind: 'number'; readonly min: number; readonly max: number }
    /** `a vote for Attack or Retreat` — a list of names (labelled options). */
    | { readonly kind: 'label'; readonly options: readonly string[] };
  /**
   * For an open vote, who goes first: `Starting with you` (caster-first),
   * `Ending with you` (caster-last), `Starting with a random player` (random),
   * `In reverse order` (reverse). Absent on every other choice.
   */
  readonly order?: 'caster-first' | 'caster-last' | 'random' | 'reverse';
  /** The verb was `commit` (sealed, face down) rather than `choose` (open). */
  readonly secret: boolean;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `When they are ready, reveal.` — opens a sealed round. */
export interface RevealSentence {
  readonly kind: 'reveal';
  readonly span: Span;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/** `All players move the card they chose to their garbage.` */
export interface MoveChosenSentence {
  readonly kind: 'moveChosen';
  readonly span: Span;
  readonly players: 'you' | 'each' | 'opponents';
  readonly playersSpan: Span;
  /** `committed` was written (rather than `chose`) — echoed back in summaries. */
  readonly committed: boolean;
  /** The zone each chooser's card goes to (canonical spelling). */
  readonly zone: string;
  readonly zoneSpan: Span;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/**
 * `You lose the game.` / `All players win the game.` — the subject-first
 * word order, the one place a noun starts a sentence (see the doc).
 */
export interface ResultSentence {
  readonly kind: 'result';
  readonly span: Span;
  /** `'you'` — the ability user's player; `'allPlayers'` — every player. */
  readonly players: 'you' | 'allPlayers';
  readonly playersSpan: Span;
  readonly win: boolean;
  /** An `If …,` clause gating this effect. */
  readonly guard?: IfClause;
  /** `You may …` — the controller is asked before this effect runs. */
  readonly optional?: boolean;
  /** `Repeat …:` — this effect runs more than once. */
  readonly repeat?: RepeatClause;
  readonly event?: string;
}

/* ---------------------------- char phrases ---------------------------- */

/** Who a sentence acts on — see the docs' noun table. */
export type Quantifier =
  | 'this'
  | 'target'
  | 'all'
  /**
   * `the source` / `the source buff` — whatever caused the
   * triggering event. Only meaningful inside a trigger; elsewhere it
   * resolves to nobody, so the effect is a no-op rather than an error.
   *
   * The **kind is required**, because an event's cause is a union: a
   * character, a buff, and one day a player. Without it, a card would
   * silently ignore every cause it could not act on.
   */
  | 'source'
  /** `the victim` — one of the ability's named picks. */
  | 'bound';
/** Relative-to-user adjective on a group. */
export type Who = 'ally' | 'enemy';
/** The owner filter of a group: the user's player, or their opponent's. */
export type Owner = 'you' | 'opponent' | 'winners' | 'losers';

/* --------------------------- the "with" clause ------------------------- */

/** Comparison operators of a gauge condition. */
export type WithOperator = '<' | '<=' | '>' | '>=' | '=';

/** `with hp < 10` — a gauge-current comparison. */
export interface GaugeCondition {
  readonly kind: 'gauge';
  readonly span: Span;
  readonly gauge: string;
  readonly gaugeSpan: Span;
  readonly op: WithOperator;
  readonly opSpan: Span;
  /** A literal `10` or a formula — see "Math expressions". */
  readonly value: MathExpression;
  readonly valueSpan: Span;
}

/** `with poison` — the character currently has that buff. */
export interface BuffCondition {
  readonly kind: 'buff';
  readonly span: Span;
  readonly buffName: string;
  readonly buffSpan: Span;
}

export type WithCondition = GaugeCondition | BuffCondition;

export type BooleanCondition =
  | WithCondition
  | { readonly kind: 'and' | 'or'; readonly left: BooleanCondition; readonly right: BooleanCondition; readonly span: Span }
  | { readonly kind: 'not'; readonly expression: BooleanCondition; readonly span: Span };

/** How two consecutive conditions combine (`and` > `or` in precedence). */
export type ConditionJoiner = 'and' | 'or';

/**
 * A `with …` filter on a character phrase. Conditions combine by their
 * joiners: `and` binds tighter than `or` — `with poison or thorns and hp
 * <= 40` means `poison OR (thorns AND hp <= 40)`. Commas act as `and`.
 */
export interface WithClause {
  readonly kind: 'with';
  readonly span: Span;
  readonly conditions: WithCondition[];
  /** One joiner between consecutive conditions (`conditions.length - 1`). */
  readonly joiners: readonly ConditionJoiner[];
  /** Recursive form used when parentheses are present. */
  readonly expression: BooleanCondition;
}

export interface CharsPhrase {
  readonly kind: 'chars';
  readonly span: Span;
  readonly quantifier: Quantifier;
  /**
   * True for a bare `this` — no noun written.
   *
   * `this` names the ability's own owner whatever kind of thing it is, so
   * the noun is optional there and `this character` is the longer spelling
   * of the same phrase. A group (`all …`, `target …`) still needs its noun:
   * "all" alone does not say all *what*.
   */
  readonly bare?: boolean;
  /** `all other …` — excludes the user themselves. */
  readonly other: boolean;
  readonly who: Who | undefined;
  readonly owner: Owner | undefined;
  /** `with hp < 10` etc. — extra conditions every character must satisfy. */
  readonly withClause: WithClause | undefined;
  /** For `the source <kind>` — which kind of cause the card answers. */
  readonly sourceType?: 'character' | 'buff';
  /** For `the <name>` — which of the ability's named picks. */
  readonly name?: string;
}

/* ------------------------------ sections ------------------------------ */

export const SECTION_KINDS = ['ability', 'buff'] as const;

export function sentenceStartSpan(sentence: Sentence): Span {
  switch (sentence.kind) {
    case 'deal':
    case 'heal':
    case 'destroy':
    case 'addBuff':
    case 'removeBuff':
    case 'toggleBuff':
    case 'roll':
    case 'store':
    case 'draw':
    case 'scry':
    case 'revealCard':
    case 'castCard':
    case 'moveCard':
    case 'moveCards':
    case 'revealCards':
    case 'split':
    case 'removeCounters':
    case 'play':
    case 'create':
    case 'castCards':
    case 'choosePile':
    case 'zoneAbility':
    case 'choose':
    case 'reveal':
    case 'moveChosen':
    case 'result':
      return { start: sentence.span.start, end: sentence.span.start + 1 };
  }
}

/**
 * A sentence and every sentence nested inside it (a roll table's result lines),
 * in reading order. Walkers that must see *every* sentence — buff references,
 * stored names — use this instead of assuming a sentence list is flat.
 */
export function withNested(sentence: Sentence): Sentence[] {
  if (sentence.kind !== 'roll' || !sentence.table) return [sentence];
  return [sentence, ...sentence.table.flatMap((row) => row.sentences.flatMap(withNested))];
}
