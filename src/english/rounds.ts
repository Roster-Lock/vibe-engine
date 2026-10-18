/**
 * The wording of **choice rounds** — one place, so the parser's summaries, the
 * IR → English renderer and the glossary all say the same thing
 * (docs/design/20-secret-choices-and-dice.md).
 *
 * ```
 * All players commit a card from their hand face down.
 * When they are ready, reveal.
 * All players move the card they committed to their garbage.
 * ```
 *
 * The verb carries the difference. **Commit** is sealed and simultaneous: the
 * answer is placed face down and cannot be changed or seen until the reveal.
 * **Choose** is open, in turn order, and every player sees the earlier answers.
 * (A choice made in private is not a *commitment* — a player can pick something
 * secretly and still change their mind — which is why "in secret" was not
 * enough.)
 *
 * The words are spelled out on purpose: the card text is the procedure a table
 * follows with no software, so "face down" and "when they are ready" are
 * instructions to the players, not syntax to be shortened away.
 */
import type { CardOrderIR, ContestIR, ContestPlayersIR, PlayerListIR, CardSelectorIR, CardSourceIR, RestIR, ChooseOrderIR, ChoosersIR, ZoneRefIR } from '../ir/index.js';

/** The word `they`, `you` — the pronoun that refers back to the choosers. */
export function pronounOf(players: ChoosersIR): 'you' | 'they' {
  return players === 'you' ? 'you' : 'they';
}

/** `All players`, `All opponents`, `You`. */
export function playersText(players: ChoosersIR): string {
  if (players === 'you') return 'You';
  return players === 'each' ? 'All players' : 'All opponents';
}

/** `your` / `their` — whose zone it is. */
export function possessiveOf(players: ChoosersIR): 'your' | 'their' {
  return players === 'you' ? 'your' : 'their';
}

export type ChoicePick =
  | { readonly kind: 'card'; readonly zone: string }
  | { readonly kind: 'label'; readonly options: readonly string[] }
  | { readonly kind: 'number'; readonly min: number; readonly max: number };

/**
 * `All players commit a card from their hand face down.` (sealed) /
 * `Starting with you, each player chooses a card from their hand.` (open)
 */
export function chooseText(
  players: ChoosersIR,
  pick: ChoicePick,
  secret: boolean,
  order: ChooseOrderIR = 'caster-first',
): string {
  if (pick.kind === 'label') return voteText(pick.options, secret, order);
  const what =
    pick.kind === 'card'
      ? `a card from ${possessiveOf(players)} ${pick.zone}`
      : `a number from ${pick.min} to ${pick.max}`;
  return choiceSentence(players, secret ? 'commit' : 'choose', what, secret, order, players !== 'you');
}

/** One choice sentence; an open choice by a non-default order opens with it (`In reverse order, each player chooses …`). A ballot always does. */
function choiceSentence(
  players: ChoosersIR,
  action: string,
  what: string,
  secret: boolean,
  order: ChooseOrderIR,
  alwaysOrdered = false,
): string {
  // One at a time is `Each player chooses`; all at once is `All players commit`.
  const who = secret || players === 'you' ? playersText(players) : players === 'each' ? 'Each player' : 'Each opponent';
  const verb = !secret && players !== 'you' ? `${action}s` : action;
  const body = `${who} ${verb} ${what}${secret ? ' face down' : ''}.`;
  if (secret || (order === 'caster-first' && !alwaysOrdered)) return body;
  return `${VOTE_OPENING[order]}, ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
}

/* -------------------------------- votes -------------------------------- */

/** A label as written: bare when it is one word, quoted otherwise. */
export function labelText(label: string): string {
  return /^[A-Za-z']+$/.test(label) ? label : `"${label}"`;
}

/** `Attack or Retreat`, `Red, Green or Blue`. */
export function labelList(options: readonly string[]): string {
  const labels = options.map(labelText);
  if (labels.length <= 2) return labels.join(' or ');
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/** The opening words of an open choice, by who goes first. */
export const VOTE_OPENING: Readonly<Record<ChooseOrderIR, string>> = {
  'caster-first': 'Starting with you',
  'caster-last': 'Ending with you',
  random: 'Starting with a random player',
  reverse: 'In reverse order',
};

/**
 * A choice between names — the ballot of a vote — in the wording of its kind:
 *
 * ```
 * All players commit Attack or Retreat face down.                 (sealed: all at once)
 * Starting with you, each player chooses Attack or Retreat.        (open: round the table, caster first)
 * Ending with you, each player chooses Attack or Retreat.          (caster last)
 * Starting with a random player, each player chooses …             (random start)
 * In reverse order, each player chooses …                          (the seating backwards)
 * ```
 *
 * `votes for Attack` then counts the choices.
 */
export function voteText(options: readonly string[], secret: boolean, order: ChooseOrderIR): string {
  return choiceSentence('each', secret ? 'commit' : 'choose', labelList(options), secret, order, true);
}

/** `votes for Attack` — how many votes an option got. */
export function votesPhrase(option: string): string {
  return `votes for ${labelText(option)}`;
}

/** `committed` after a sealed round, `chose` after an open one. */
export function pastVerb(secret: boolean): 'committed' | 'chose' {
  return secret ? 'committed' : 'chose';
}

/** The reveal step. `they` points back at whoever just chose. */
export const REVEAL_TEXT = 'When they are ready, reveal.';

/** `All players move the card they committed to their garbage.` */
export function moveChosenText(players: ChoosersIR, zone: string, secret: boolean): string {
  return (
    `${playersText(players)} move the card ${pronounOf(players)} ${pastVerb(secret)} ` +
    `to ${possessiveOf(players)} ${zone}.`
  );
}

/* ------------------------------- dice -------------------------------- */

/** The stat of a roll a phrase can read. */
export type RollStat = 'total' | 'highest' | 'lowest';

/** `Roll a d20.` for one die, `Roll 2d6.` for several. */
export function rollText(count: number, sides: number): string {
  return count === 1 ? `Roll a d${sides}.` : `Roll ${count}d${sides}.`;
}

/**
 * The words for a roll's outcome in an amount: `that value` (the sum; for one die
 * it is the die), `that highest die`, `that lowest
 * die`. **`that`** always means the most recent roll — there is no `the`, so a
 * reader never has to wonder which of several rolls is meant. To keep an earlier
 * roll, store it: "Store that value as AttackerRoll." and use the name.
 */
export function rollPhrase(stat: RollStat): string {
  return stat === 'total' ? 'that value' : `that ${stat} die`;
}

/** The stat a word after `that` names — `value`, `highest`, `lowest`. */
export function rollStatOf(word: string): RollStat | undefined {
  if (word === 'value') return 'total';
  if (word === 'highest' || word === 'lowest') return word;
  return undefined;
}

/* ----------------------- abilities a zone gives ----------------------- */

/**
 * `Cards in your boxed zone have Open Present for all opponents.` The word `zone`
 * is always written (it is optional to read): "your hand zone", "the stack zone".
 */
export function zoneAbilityText(
  owners: ChoosersIR | 'shared' | 'this',
  zone: string,
  abilityName: string,
  users: ChoosersIR,
  remove = false,
): string {
  // Taking an ability away is for everyone it was given to, so there is no `for`.
  if (remove) {
    const where = owners === 'this' ? 'this' : zoneOwnerWords(owners, zone);
    return `Cards in ${where} zone no longer have ${abilityName}.`;
  }
  // Inside a `Zone` section the zone is the section's, so it is not written again.
  if (owners === 'this') return `Cards in this zone have ${abilityName} for ${playerArgument(users)}.`;
  return `Cards in ${zoneOwnerWords(owners, zone)} zone have ${abilityName} for ${playerArgument(users)}.`;
}

/** `your boxed`, `all players' boxed`, `the stack` — whose zone, and which. */
function zoneOwnerWords(owners: ChoosersIR | 'shared' | 'this', zone: string): string {
  const whose =
    owners === 'you' ? 'your' : owners === 'each' ? "all players'" : owners === 'opponents' ? "all opponents'" : 'the';
  return `${whose} ${zone}`;
}

/* ------------------------------ this card ------------------------------ */

/** `Reveal this card.` */
export const REVEAL_CARD_TEXT = 'Reveal this.';

/** `Move this card to its owner's garbage.` */
export function moveCardText(
  zone: string,
  article?: 'the',
  counters?: { readonly count: number; readonly kind?: string },
): string {
  const where = article === 'the' ? `the ${zone} zone` : `its owner's ${zone}`;
  const kind = counters?.kind ? `${counters.kind} ` : '';
  const with_ = counters ? ` with ${counters.count} ${kind}counter${counters.count === 1 ? '' : 's'} on it` : '';
  return `Move this to ${where}${with_}.`;
}

/** `Remove a counter from all cards in this zone.` */
export function removeCountersText(count: number, counterKind: string | undefined, select: CardSelectorIR, from: ZoneRefIR): string {
  const kind = counterKind ? `${counterKind} ` : '';
  const amount = count === 1 ? `a ${kind}counter` : `${count} ${kind}counters`;
  return `Remove ${amount} from ${cardSelectorText(select)} in ${zoneRefText(from)}.`;
}

/** `Cast all cards with no counters from this zone without paying their cost.` */
export function castCardsText(select: CardSelectorIR, from: ZoneRefIR, free?: true): string {
  return `Cast ${cardSelectorText(select)} from ${zoneRefText(from)}${free ? ' without paying their cost' : ''}.`;
}

/** `the top 3 cards` / `a random creature card` / `all cards` — the cards a move takes. */
export function cardSelectorText(select: CardSelectorIR): string {
  const base = cardSelectorBase(select);
  return select.counters === 'none' ? `${base} with no counters` : base;
}

function cardSelectorBase(select: CardSelectorIR): string {
  if (select.any) {
    const kind = select.cardKind ? `${select.cardKind} ` : '';
    if (select.how === 'top' || select.how === 'bottom') {
      return `any number of the ${select.how} ${select.count === 1 ? '' : `${select.count} `}${kind}card${select.count === 1 ? '' : 's'}`;
    }
    return `any number of ${kind}cards`;
  }
  const kind = select.cardKind ? `${select.cardKind} ` : '';
  const noun = `${kind}card${select.count === 1 && select.how !== 'all' ? '' : 's'}`;
  switch (select.how) {
    case 'top':
    case 'bottom':
      return select.count === 1 ? `the ${select.how} ${kind}card` : `the ${select.how} ${select.count} ${noun}`;
    case 'choose':
      return select.count === 1 ? `a ${kind}card` : `${select.count} ${noun}`;
    case 'random':
      return select.count === 1 ? `a random ${kind}card` : `${select.count} random ${noun}`;
    case 'all':
      return `all ${noun}`;
  }
}

/** Zones that read as nouns on their own; any other is written with "zone" after it ("your stolen zone"). */
const NOUN_ZONES = new Set(['hand', 'deck', 'library', 'garbage', 'play', 'stack', 'active', 'revealed']);

/** `your hand` / `its owner's garbage` / `target opponent's hand` / `all opponents' hand` / `the play`. */
export function zoneRefText(ref: ZoneRefIR): string {
  const zone = NOUN_ZONES.has(ref.zone) || ref.whose === 'temporary' ? ref.zone : `${ref.zone} zone`;
  const where = ref.position ? `the ${ref.position} of ` : '';
  return where + zoneRefBase(ref, zone);
}

function zoneRefBase(ref: ZoneRefIR, zone: string): string {
  switch (ref.whose) {
    case 'this':
      return 'this zone';
    case 'temporary':
      return ref.zone === '@chosen' ? 'the chosen pile' : ref.zone === '@other' ? 'the other pile' : `the temporary zone ${ref.zone}`;
    case 'you':
      return `your ${zone}`;
    case 'owner':
      return `its owner's ${zone}`;
    case 'opponent':
      return `target opponent's ${zone}`;
    case 'opponents':
      return `all opponents' ${zone}`;
    case 'each':
      return `all players' ${zone}`;
    case 'shared':
      return zone === 'play' ? 'play' : `the ${zone}`;
  }
}

/** `from your hand` — or, for a source that is not a zone, `castable by target opponent`. */
function sourceText(from: CardSourceIR): string {
  if ('castableBy' in from) {
    const who = { you: 'you', opponent: 'target opponent', opponents: 'all opponents', each: 'all players' }[from.castableBy];
    return `castable by ${who}`;
  }
  return `from ${zoneRefText(from)}`;
}

/** `Move the top 3 cards from your library to your hand.` / `Move a card castable by target opponent to its owner's garbage.` */
export function moveCardsText(
  select: CardSelectorIR,
  from: CardSourceIR,
  to: ZoneRefIR,
  order?: CardOrderIR,
  rest?: RestIR,
): string {
  const choice = (o?: CardOrderIR): string => (o === 'chosen' ? ' in the order of your choice' : '');
  const tail = rest ? ` and the rest on ${zoneRefText(rest.to)}${choice(rest.order)}` : '';
  return `Move ${cardSelectorText(select)} ${sourceText(from)} to ${zoneRefText(to)}${choice(order)}${tail}.`;
}

/** `Target opponent separates Pool into Fact and Fiction.` */
export function splitText(chooser: 'you' | 'opponent', from: ZoneRefIR, into: readonly [string, string]): string {
  const who = chooser === 'you' ? 'You separate' : 'Target opponent separates';
  const pool = from.whose === 'temporary' ? from.zone : zoneRefText(from);
  return `${who} ${pool} into ${into[0]} and ${into[1]}.`;
}

/** `You choose Fact or Fiction.` */
export function choosePileText(options: readonly [string, string]): string {
  return `You choose ${options[0]} or ${options[1]}.`;
}

/** `Reveal all cards castable by target opponent.` / `Reveal the top 2 cards from your deck.` */
export function revealCardsText(select: CardSelectorIR, from: CardSourceIR): string {
  return `Reveal ${cardSelectorText(select)} ${sourceText(from)}.`;
}

/**
 * `Cast this card if you can.` / `Cast this card if you can, otherwise move it to
 * its owner's garbage.`
 */
export function castCardText(otherwiseZone?: string): string {
  return otherwiseZone === undefined
    ? 'Cast this if you can.'
    : `Cast this if you can, otherwise move it to its owner's ${otherwiseZone}.`;
}

/* --------------------------- variables & draw ------------------------- */

/** `Store that value as AttackerRoll.` */
export function storeText(valueText: string, name: string): string {
  return `Store ${valueText} as ${name}.`;
}

/** `you`, `all players`, `all opponents` — the player argument of `Draw`. */
export function playerArgument(players: ChoosersIR | 'winners' | 'losers'): string {
  return players === 'you'
    ? 'you'
    : players === 'each'
      ? 'all players'
      : players === 'winners'
        ? 'the winners'
        : players === 'losers'
          ? 'the losers'
          : 'all opponents';
}

/** `you`, `opponents`, `the winners`, `the losers` — after "owned by". */
export function ownerWords(owner: 'you' | 'opponent' | 'winners' | 'losers'): string {
  return owner === 'you' ? 'you' : owner === 'opponent' ? 'opponents' : `the ${owner}`;
}

/** `player 1 win and player 2 lose` — the players a rule names, winners then losers. */
function outcomeText(winners: readonly number[], losers: readonly number[]): string {
  return [...winners.map((player) => `player ${player} win`), ...losers.map((player) => `player ${player} lose`)].join(' and ');
}

/**
 * A contest as the section that defines it — one line per statement, the same words the
 * parser reads (a ballot of names is just the sealed `commit` sentence).
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
 */
export function contestLines(contest: ContestIR): string[] {
  return [
    `Contest ${contest.name}`,
    ...(contest.playerCount !== undefined ? [`Players ${contest.playerCount}.`] : []),
    voteText(contest.options, true, 'caster-first'),
    REVEAL_TEXT,
    ...contest.rules.map((rule) => {
      if (rule.kind === 'tie') return 'If all players committed the same option, it is a tie.';
      if (rule.kind === 'otherwise') return `Otherwise ${outcomeText(rule.winners, rule.losers)}.`;
      const picks = rule.picks.map((pick) => `player ${pick.player} committed ${labelText(pick.option)}`).join(' and ');
      return `If ${picks}, ${outcomeText(rule.winners, rule.losers)}.`;
    }),
  ];
}

/** `Create a Giant Golem.` / `The winners create a Giant Golem.` */
export function createText(players: PlayerListIR, creature: string): string {
  const article = /^[aeiou]/i.test(creature) ? 'an' : 'a';
  if (players === 'you') return `Create ${article} ${creature}.`;
  const who =
    players === 'winners'
      ? 'The winners create'
      : players === 'losers'
        ? 'The losers create'
        : players === 'each'
          ? 'All players create'
          : 'All opponents create';
  return `${who} ${article} ${creature}.`;
}

/** `All players play Rock Paper Scissors.` / `You and target opponent play Rock Paper Scissors.` */
export function playText(players: ContestPlayersIR, contest: ContestIR): string {
  const who =
    players === 'you'
      ? 'You play'
      : players === 'each'
        ? 'All players play'
        : players === 'you-and-opponent'
          ? 'You and target opponent play'
          : 'All opponents play';
  return `${who} ${contest.name}.`;
}

/** `Draw(you, 2).` — draw(player, count). */
export function scryText(countText: string, players: PlayerListIR, surveil = false): string {
  return `${surveil ? 'Surveil' : 'Scry'}(${playerArgument(players)}, ${countText}).`;
}

export function drawText(countText: string, players: PlayerListIR): string {
  return `Draw(${playerArgument(players)}, ${countText}).`;
}
