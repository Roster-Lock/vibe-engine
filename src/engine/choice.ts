/**
 * The **choice protocol** — how the engine asks a player to decide
 * something in the middle of resolving an effect
 * (docs/design/15-zones.md).
 *
 * This replaces `GameHost.requestTargets`, which could ask exactly one
 * question ("pick some characters") and, more importantly, had **no notion
 * of who was being asked**. A single host answering for everybody cannot
 * express "an *opponent* separates these into two piles", and cannot route
 * a question to the right client in multiplayer.
 *
 * Two things follow from that:
 *
 * - **The chooser is a field on the request.** It changes *within* one
 *   resolution — Fact or Fiction asks an opponent to partition and then
 *   the controller to pick a pile — so it can never be a property of the
 *   engine, the object, or the session.
 * - **The method belongs on `Player`.** The chooser *is* a player, so
 *   `Player.choose` is the whole protocol; there is no intermediary
 *   interface to name. A remote player's `choose` goes over the wire, a
 *   scripted one answers from a list, and the base class answers
 *   automatically (`autoChoose`).
 *
 * The kinds that ship:
 *
 * | Kind | Answer | Covers |
 * | --- | --- | --- |
 * | `label` | one of a list of names | a vote: "Attack or Retreat"; "name a colour" |
 * | `select` | n of m entities | targeting, "discard two cards", "sacrifice a creature" |
 * | `confirm` | yes / no | "you **may** …", declining an optional trigger |
 * | `number` | a whole number in a range | "choose a number from 1 to 6", a bid, "choose X" |
 *
 * `partition`, `order` and `distribute` are the remaining kinds in the
 * design; they are additions to this union, not changes to it.
 *
 * **Sequential rounds are engine-driven.** When several players must each
 * choose and each may see the earlier answers, legality depends on state
 * only the engine knows (after A sacrifices, B's options differ). So the
 * engine expands such a round into successive single requests, recomputing
 * `options` before each — a host never sees a "sequential round". The one
 * shape that genuinely needs a batch is the simultaneous hidden choice
 * ("everyone discards face down, then reveal"), which is not here yet; the
 * commit/reveal machinery it should reuse already exists in `seed.ts`.
 */
import type { TargetPattern } from './ability/index.js';
import type { Character } from './character.js';
import type { Player } from './player.js';
import type { Entity } from './zone.js';

/** Fields every request carries. */
interface ChoiceRequestBase {
  /** What is being decided, for a UI to show. Usually the ability's name. */
  readonly prompt: string;
  /**
   * Who decides. `undefined` only when nothing owns the decision — an
   * unowned character's ability, which has no player to ask; the engine
   * then falls back to its configured host.
   */
  readonly chooser: Player | undefined;
}

/**
 * "Pick n of these." Targeting is this request — and so is "discard a card",
 * "choose a card from your hand", or looking at a deck section and picking.
 *
 * The options are **entities**, not only characters: a hand card is an `Entity`
 * with no gauges, and a choice must be able to offer it. A `Character` is an
 * `Entity`, so targeting is unchanged. The options are shown only to the
 * `chooser`, so asking about a hidden zone does not reveal it to anyone else.
 */
export interface SelectRequest extends ChoiceRequestBase {
  readonly kind: 'select';
  /** The legal picks — already filtered, so a chooser cannot pick illegally. */
  readonly options: readonly Entity[];
  /** How many: an exact number, or `[min, max]`. */
  readonly count: number | readonly [number, number];
  /** The ability's owner, as context for the chooser. */
  readonly source?: Character;
  /** The pattern `options` was derived from, when there was one. */
  readonly pattern?: TargetPattern;
  /**
   * What to write to name each option (`markersFor`). Set where look-alikes are
   * possible — two creatures both called "Goblin" — so a chooser can tell them
   * apart on the page, and so a table puts the same letter on the card.
   */
  readonly markers?: ReadonlyMap<Entity, string>;
}

/** "Do you want to?" — the `you may` of an optional effect. */
export interface ConfirmRequest extends ChoiceRequestBase {
  readonly kind: 'confirm';
  /** The character the choice is about, when there is one. */
  readonly source?: Character;
}

/**
 * "Pick a whole number from `min` to `max`." A bid, a secret 1–6, "choose X".
 *
 * There is nothing to point at, so unlike `select` there are no options: the
 * range *is* the legal set. Integers only — a game that wants halves asks for
 * double and divides, rather than every validator learning about floats.
 */
export interface NumberRequest extends ChoiceRequestBase {
  readonly kind: 'number';
  /** Inclusive lower bound. */
  readonly min: number;
  /** Inclusive upper bound. */
  readonly max: number;
}

/**
 * "Pick one of these names." A **labelled option**: a choice that is just a
 * name, not a card, a character or a number — "Attack or Retreat", "Red, Green
 * or Blue". A vote is a round of these.
 *
 * `prior` is what the voters before this one chose, in order, for an *open*
 * vote — each voter sees the votes already cast. A sealed vote has none: nobody
 * sees anything until the reveal.
 */
export interface LabelRequest extends ChoiceRequestBase {
  readonly kind: 'label';
  /** The names on offer, in the order written. Distinct, at least two. */
  readonly options: readonly string[];
  readonly prior?: readonly { readonly player: Player; readonly option: string }[];
}

export type ChoiceRequest = SelectRequest | ConfirmRequest | NumberRequest | LabelRequest;

export interface SelectAnswer {
  readonly kind: 'select';
  readonly chosen: readonly Entity[];
}

/**
 * **A value written down** — the answer as a table gives it: a name or marker on
 * a slip of paper, not a pointer to an object. It is how a commitment to "the
 * Goblin" is recorded, and it is why the answer can be **vague**: the text must
 * pick out exactly one option, and "Goblin" with two goblins in play picks out
 * two. Accepted for a `select` request; resolved by `resolveWritten`.
 */
export interface WrittenAnswer {
  readonly kind: 'written';
  readonly text: string;
}

/**
 * **Markers for a list of options** — the text a player writes to name each one.
 *
 * An option is its `marker` (or, failing that, its name). When two options would
 * be written the same — two creatures named "Goblin" — neither can be named by
 * that alone, so the duplicates are told apart with a letter in option order:
 * "Goblin (A)", "Goblin (B)". A UI shows these beside the options; a table puts
 * the letter on the card. Options with a unique marker keep it unchanged.
 */
export function markersFor(options: readonly Entity[]): Map<Entity, string> {
  const base = (entity: Entity): string => entity.marker ?? entity.name;
  const counts = new Map<string, number>();
  for (const option of options) counts.set(base(option), (counts.get(base(option)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const markers = new Map<Entity, string>();
  for (const option of options) {
    const label = base(option);
    if ((counts.get(label) ?? 0) < 2) {
      markers.set(option, label);
      continue;
    }
    const index = seen.get(label) ?? 0;
    seen.set(label, index + 1);
    // An id is the surest marker: it is already unique and already on the card.
    markers.set(option, `${label} (${option.id ?? String.fromCharCode(65 + (index % 26))})`);
  }
  return markers;
}

/**
 * The answer a computer or online client gives for a card: the card's id. No
 * markers or names are involved, so it cannot be vague.
 */
export function pickById(id: string): WrittenAnswer {
  return { kind: 'written', text: id };
}

/** The ids that appear more than once among these options — a request that must be refused. */
export function duplicateIds(options: readonly Entity[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const option of options) {
    if (option.id === undefined) continue;
    if (seen.has(option.id)) dupes.add(option.id);
    seen.add(option.id);
  }
  return [...dupes];
}

/**
 * Resolves a written value to the label it names: the **same text exactly**,
 * ignoring only surrounding space. Options are shown as a list to pick from, not
 * typed, so an answer that differs in case is not one of them — matching case is
 * the safe rule. A label that matches nothing is invalid; labels in a request are
 * distinct, so one can never be vague.
 */
export function resolveLabel(options: readonly string[], text: string): { readonly value: string } | { readonly problem: string } {
  const wanted = text.trim();
  if (wanted === '') return { problem: 'wrote nothing' };
  const found = options.find((option) => option === wanted);
  if (found !== undefined) return { value: found };
  return { problem: `wrote "${text}", which is not one of ${options.map((option) => `"${option}"`).join(', ')}` };
}

/**
 * Resolves a written value to the option it names, or says why it does not.
 *
 * The full marker ("Goblin (B)") names one option exactly. A bare name that
 * several options share ("Goblin") is **vague** — it could be either — and a
 * name that matches nothing is **invalid**. Both are the commit's penalty
 * cases; this only reports which. Matching is **exact** (case included), ignoring
 * only surrounding space: options are picked from a list, not typed.
 */
export function resolveWritten(
  options: readonly Entity[],
  text: string,
): { readonly chosen: readonly Entity[] } | { readonly problem: string } {
  const wanted = text.trim();
  if (wanted === '') return { problem: 'wrote nothing' };
  // A card's id names exactly one option, so it is tried first and is never vague.
  const byId = options.filter((option) => option.id !== undefined && option.id === text.trim());
  if (byId.length === 1) return { chosen: byId };
  const markers = markersFor(options);
  const exact = options.filter((option) => markers.get(option)! === wanted);
  if (exact.length === 1) return { chosen: exact };
  const byName = options.filter(
    (option) => option.name === wanted || option.marker === wanted,
  );
  if (byName.length === 1) return { chosen: byName };
  if (byName.length > 1) {
    const choices = byName.map((option) => `"${markers.get(option)}"`).join(' or ');
    return { problem: `wrote "${text}", which could be ${byName.length} different options (${choices}) — vague` };
  }
  return { problem: `wrote "${text}", which is not one of the options` };
}

/**
 * The characters in a `select` answer — what a targeting caller wants. A
 * targeting request only ever offered characters, and `validateAnswer` rejects
 * anything outside the options, so this drops nothing for such a request.
 */
export function chosenCharacters(answer: ChoiceAnswer): Character[] {
  return answer.kind === 'select'
    ? answer.chosen.filter((entity): entity is Character => entity.type === 'character')
    : [];
}

export interface ConfirmAnswer {
  readonly kind: 'confirm';
  readonly yes: boolean;
}

export interface NumberAnswer {
  readonly kind: 'number';
  readonly value: number;
}

export interface LabelAnswer {
  readonly kind: 'label';
  readonly value: string;
}

/**
 * Answers are discriminated, so a `confirm` answer can never be read as a
 * `select` — the same discipline the engine's events follow (no optional
 * properties; narrow on a tag).
 */
export type ChoiceAnswer = SelectAnswer | ConfirmAnswer | NumberAnswer | LabelAnswer | WrittenAnswer;

/** Anything that can answer a choice. `Player` implements it. */
export interface Chooser {
  choose(request: ChoiceRequest): Promise<ChoiceAnswer>;
}

/** A request's count as an inclusive `[min, max]` pair. */
export function countRange(count: number | readonly [number, number]): [number, number] {
  return typeof count === 'number' ? [count, count] : [count[0], count[1]];
}

/**
 * The automatic answer: take the fewest characters the request allows, and
 * say **yes** to a confirm.
 *
 * Yes is the right default for a confirm because declining would make
 * every optional effect silently never happen — a default that hides
 * content is worse than one that fires it. An AI that should sometimes
 * decline overrides `choose`.
 */
export function autoChoose(request: ChoiceRequest): ChoiceAnswer {
  if (request.kind === 'confirm') return { kind: 'confirm', yes: true };
  // The lowest legal number, as `select` takes the fewest: a default that
  // asks for nothing extra of the game.
  if (request.kind === 'number') return { kind: 'number', value: request.min };
  if (request.kind === 'label') return { kind: 'label', value: request.options[0]! };
  const [min] = countRange(request.count);
  return { kind: 'select', chosen: request.options.slice(0, min) };
}

/**
 * Checks an answer against its request. Returns a problem description, or
 * `undefined` when the answer is good.
 *
 * Validation lives here rather than in each caller so every path — a
 * player, a scripted chooser, a remote client — is held to the same rules.
 * A chooser that answers outside the offered options is a bug, and loudly
 * so: it is the one place a client could try to cheat.
 */
export function validateAnswer(request: ChoiceRequest, answer: ChoiceAnswer): string | undefined {
  // A written value is judged by what it names, then held to the same rules as
  // a pick of that option would be.
  if (request.kind === 'select' && answer.kind === 'written') {
    const resolved = resolveWritten(request.options, answer.text);
    if ('problem' in resolved) return resolved.problem;
    return validateAnswer(request, { kind: 'select', chosen: resolved.chosen });
  }
  if (request.kind === 'label' && answer.kind === 'written') {
    const resolved = resolveLabel(request.options, answer.text);
    return 'problem' in resolved ? resolved.problem : undefined;
  }
  if (request.kind === 'label' && answer.kind === 'label') {
    return request.options.includes(answer.value)
      ? undefined
      : `"${answer.value}" is not one of ${request.options.map((option) => `"${option}"`).join(', ')}`;
  }
  if (request.kind !== answer.kind) {
    return `expected a "${request.kind}" answer, got "${answer.kind}"`;
  }
  if (request.kind === 'number' && answer.kind === 'number') {
    if (!Number.isInteger(answer.value)) return `expected a whole number, got ${answer.value}`;
    if (answer.value < request.min || answer.value > request.max) {
      return `expected a number from ${request.min} to ${request.max}, got ${answer.value}`;
    }
    return undefined;
  }
  if (request.kind !== 'select' || answer.kind !== 'select') return undefined;

  const illegal = answer.chosen.filter((candidate) => !request.options.includes(candidate));
  if (illegal.length > 0) {
    return (
      'the chooser returned targets outside its targeting pattern: ' +
      illegal.map((candidate) => `"${candidate.name}"`).join(', ')
    );
  }
  const unique = new Set(answer.chosen);
  if (unique.size !== answer.chosen.length && request.pattern?.allowDuplicates !== true) {
    return 'the chooser picked the same character more than once';
  }
  const [min, max] = countRange(request.count);
  if (answer.chosen.length > max) {
    return `expected at most ${max} target(s), got ${answer.chosen.length}`;
  }
  // Fewer than `min` is only legal when there were not enough options to
  // reach it — "choose 2" with one legal target picks the one.
  const floor = Math.min(min, request.options.length);
  if (answer.chosen.length < floor) {
    return `expected at least ${floor} target(s), got ${answer.chosen.length}`;
  }
  return undefined;
}

/**
 * **A simultaneous round of choices** — every named player answers on their own,
 * and no answer can be read until the round is *revealed*.
 *
 * This is the "everyone commits face down, then reveal" shape
 * (docs/design/20-secret-choices-and-dice.md). The round holds each answer as it
 * arrives; the engine announces only that a player is **ready** (never what they
 * chose), and opens the round with `GameEngine.revealRound`. Until then,
 * `answerOf` and `answers` throw — a card that reads "the card they committed"
 * before the reveal is a content bug, and failing loudly is how it is found.
 *
 * ## A commitment is judged at the reveal, not when it is placed
 *
 * *Commit* means: choose a valid option and write the value face down, so it
 * cannot be changed. At a table nobody learns that a face-down answer is vague
 * or invalid until it is turned over, so neither does the engine — answers are
 * **not validated as they arrive**. At the reveal each one is checked against
 * its request; one that is invalid (or vague: a pick that names nothing, or the
 * wrong number of things) **forfeits** that player, as does an attempt to
 * change a commitment already placed. The round reports who forfeited and why;
 * what a forfeit *costs* (losing the game) is the caller's rule, not the round's.
 *
 * Only the players with a request are in the round, so only they are waited on.
 */
export class SealedRound {
  readonly choosers: readonly Player[];
  readonly #requests = new Map<Player, ChoiceRequest>();
  readonly #answers = new Map<Player, ChoiceAnswer>();
  readonly #forfeits = new Map<Player, string>();
  #revealed = false;

  constructor(requests: readonly ChoiceRequest[]) {
    const choosers: Player[] = [];
    for (const request of requests) {
      if (!request.chooser) continue;
      choosers.push(request.chooser);
      this.#requests.set(request.chooser, request);
    }
    this.choosers = choosers;
  }

  /** True once every chooser has answered. */
  get ready(): boolean {
    return this.choosers.every((player) => this.#answers.has(player) || this.#forfeits.has(player));
  }

  get revealed(): boolean {
    return this.#revealed;
  }

  /**
   * @internal — the engine records an answer the moment it arrives, unchecked.
   * A second answer from the same player is an attempt to change a commitment.
   */
  _commit(player: Player, answer: ChoiceAnswer): void {
    if (this.#answers.has(player)) {
      this.#forfeits.set(player, 'tried to change a commitment after placing it');
      return;
    }
    this.#answers.set(player, answer);
  }

  /**
   * @internal — opens the round and judges every commitment. Returns the players
   * who forfeited, each with the reason, so the caller can announce and punish.
   */
  _open(): readonly { readonly player: Player; readonly reason: string }[] {
    if (!this.ready) throw new Error('SealedRound: cannot reveal before every chooser is ready');
    for (const [player, answer] of this.#answers) {
      if (this.#forfeits.has(player)) continue;
      const request = this.#requests.get(player);
      if (request && request.kind === 'label' && answer.kind === 'written') {
        const resolved = resolveLabel(request.options, answer.text);
        if ('problem' in resolved) {
          this.#forfeits.set(player, `placed an invalid commitment — ${resolved.problem}`);
          continue;
        }
        this.#answers.set(player, { kind: 'label', value: resolved.value });
      }
      if (request && request.kind === 'select' && answer.kind === 'written') {
        // The value written down, turned over: it must name exactly one option.
        const resolved = resolveWritten(request.options, answer.text);
        if ('problem' in resolved) {
          this.#forfeits.set(player, `placed an invalid commitment — ${resolved.problem}`);
          continue;
        }
        this.#answers.set(player, { kind: 'select', chosen: resolved.chosen });
      }
      const settled = this.#answers.get(player)!;
      const problem = request ? validateAnswer(request, settled) : undefined;
      if (problem) this.#forfeits.set(player, `placed an invalid commitment: ${problem}`);
    }
    this.#revealed = true;
    return this.forfeited;
  }

  /** Who forfeited and why. Throws before the reveal, like the answers. */
  get forfeited(): readonly { readonly player: Player; readonly reason: string }[] {
    if (!this.#revealed) throw new Error('SealedRound: forfeits are sealed until the round is revealed');
    return this.choosers
      .filter((player) => this.#forfeits.has(player))
      .map((player) => ({ player, reason: this.#forfeits.get(player)! }));
  }

  /** One chooser's answer. Throws before the reveal, for a non-chooser, and for a forfeit. */
  answerOf(player: Player): ChoiceAnswer {
    if (!this.#revealed) throw new Error('SealedRound: answers are sealed until the round is revealed');
    const reason = this.#forfeits.get(player);
    if (reason) throw new Error(`SealedRound: ${player.name} has no valid answer — they ${reason}`);
    const answer = this.#answers.get(player);
    if (!answer) throw new Error(`SealedRound: ${player.name} was not part of this round`);
    return answer;
  }

  /**
   * Every valid answer, in the order the choosers were listed. A player who
   * forfeited has none and is left out. Throws before the reveal.
   */
  get answers(): readonly { readonly player: Player; readonly answer: ChoiceAnswer }[] {
    if (!this.#revealed) throw new Error('SealedRound: answers are sealed until the round is revealed');
    return this.choosers
      .filter((player) => !this.#forfeits.has(player))
      .map((player) => ({ player, answer: this.answerOf(player) }));
  }
}

/** A chooser that answers automatically — the engine's default. */
export class AutoChooser implements Chooser {
  async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    return autoChoose(request);
  }
}

/** A chooser that answers from a scripted list — the test/demo stand-in. */
export class ScriptedChooser implements Chooser {
  readonly #answers: ChoiceAnswer[];

  constructor(...answers: ChoiceAnswer[]) {
    this.#answers = [...answers];
  }

  /** Scripts a `select` answer. */
  static selects(...picks: readonly Character[][]): ScriptedChooser {
    return new ScriptedChooser(...picks.map((chosen): ChoiceAnswer => ({ kind: 'select', chosen })));
  }

  /** Scripts `number` answers. */
  static numbers(...values: readonly number[]): ScriptedChooser {
    return new ScriptedChooser(...values.map((value): ChoiceAnswer => ({ kind: 'number', value })));
  }

  async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    const next = this.#answers.shift();
    if (!next) throw new Error(`ScriptedChooser: no more scripted answers (asked for "${request.prompt}")`);
    return next;
  }
}
