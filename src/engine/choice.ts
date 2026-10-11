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
 * Two kinds ship here — the two that everything else needs:
 *
 * | Kind | Answer | Covers |
 * | --- | --- | --- |
 * | `select` | n of m characters | targeting, "discard two cards", "sacrifice a creature" |
 * | `confirm` | yes / no | "you **may** …", declining an optional trigger |
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

/** "Pick n of these characters." Targeting is this request. */
export interface SelectRequest extends ChoiceRequestBase {
  readonly kind: 'select';
  /** The legal picks — already filtered, so a chooser cannot pick illegally. */
  readonly options: readonly Character[];
  /** How many: an exact number, or `[min, max]`. */
  readonly count: number | readonly [number, number];
  /** The ability's owner, as context for the chooser. */
  readonly source?: Character;
  /** The pattern `options` was derived from, when there was one. */
  readonly pattern?: TargetPattern;
}

/** "Do you want to?" — the `you may` of an optional effect. */
export interface ConfirmRequest extends ChoiceRequestBase {
  readonly kind: 'confirm';
  /** The character the choice is about, when there is one. */
  readonly source?: Character;
}

export type ChoiceRequest = SelectRequest | ConfirmRequest;

export interface SelectAnswer {
  readonly kind: 'select';
  readonly chosen: readonly Character[];
}

export interface ConfirmAnswer {
  readonly kind: 'confirm';
  readonly yes: boolean;
}

/**
 * Answers are discriminated, so a `confirm` answer can never be read as a
 * `select` — the same discipline the engine's events follow (no optional
 * properties; narrow on a tag).
 */
export type ChoiceAnswer = SelectAnswer | ConfirmAnswer;

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
  if (request.kind !== answer.kind) {
    return `expected a "${request.kind}" answer, got "${answer.kind}"`;
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

  async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    const next = this.#answers.shift();
    if (!next) throw new Error(`ScriptedChooser: no more scripted answers (asked for "${request.prompt}")`);
    return next;
  }
}
