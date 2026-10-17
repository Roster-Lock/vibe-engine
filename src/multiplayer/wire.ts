/**
 * A choice, over the wire, and a player who answers it from the other end.
 *
 * The engine asks a *player* to choose (`Player.choose`); for someone connected to a
 * `Room`, that question has to travel. Two things make it safe and simple:
 *
 * - **What is asked is redacted.** The options of a "pick a card" are cards, and the
 *   client is shown only the ones it may see; a hidden option is an anonymous placeholder.
 * - **The answer names options by position.** A client answers "the second one", never
 *   by a card id or ref, so it can pick among cards it cannot see, and there is nothing
 *   in an answer that could name a card it has no right to.
 *
 * A reply that cannot be read at all is asked again (up to three times) and then replaced
 * by the default answer, so a broken client cannot stall or crash the game. A reply that
 * *can* be read but is wrong — a number out of range — is passed on as given: the engine
 * decides what that costs (an open choice rejects it; a face-down commitment loses the game).
 */
import {
  autoChoose,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Decision,
  type Entity,
  type GameEngine,
  type Player as EnginePlayer,
  type SlotView,
  type ViewProjector,
  Player,
  type Character,
} from '../engine/index.js';
import { PromptTimeoutError } from './room.js';
import type { RoomLike } from './room-like.js';

export type WireRequest =
  | {
      readonly kind: 'select';
      readonly prompt: string;
      /** The options, in order; the answer names them by position. A hidden one is `{ hidden: true }`. */
      readonly options: readonly SlotView[];
      readonly count: number | readonly [number, number];
      /** What to write to tell look-alikes apart, aligned with `options`. */
      readonly markers?: readonly (string | undefined)[];
    }
  | { readonly kind: 'confirm'; readonly prompt: string }
  | { readonly kind: 'number'; readonly prompt: string; readonly min: number; readonly max: number }
  | {
      readonly kind: 'label';
      readonly prompt: string;
      readonly options: readonly string[];
      /** The votes already cast, for an open vote. */
      readonly prior?: readonly { readonly player: string; readonly option: string }[];
    };

export type WireAnswer =
  | { readonly kind: 'select'; readonly chosen: readonly number[] }
  | { readonly kind: 'confirm'; readonly yes: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'label'; readonly value: string }
  | { readonly kind: 'written'; readonly text: string };

/** The question, as `player` may see it. */
export function toWireRequest(projector: ViewProjector, player: EnginePlayer, request: ChoiceRequest): WireRequest {
  switch (request.kind) {
    case 'select':
      return {
        kind: 'select',
        prompt: request.prompt,
        options: request.options.map((option) => projector.viewOf(player, option)),
        count: request.count,
        ...(request.markers ? { markers: request.options.map((option) => request.markers!.get(option)) } : {}),
      };
    case 'confirm':
      return { kind: 'confirm', prompt: request.prompt };
    case 'number':
      return { kind: 'number', prompt: request.prompt, min: request.min, max: request.max };
    case 'label':
      return {
        kind: 'label',
        prompt: request.prompt,
        options: request.options,
        ...(request.prior ? { prior: request.prior.map((vote) => ({ player: vote.player.id, option: vote.option })) } : {}),
      };
  }
}

/**
 * Reads a client's reply to `request`, or `undefined` if it is not an answer to that
 * question at all (wrong shape, or a position that is not an option). Whether the answer
 * is a *good* one is the engine's to judge.
 */
export function fromWireAnswer(request: ChoiceRequest, reply: unknown): ChoiceAnswer | undefined {
  if (typeof reply !== 'object' || reply === null) return undefined;
  const wire = reply as Partial<WireAnswer> & Record<string, unknown>;
  if (wire.kind === 'written' && typeof wire.text === 'string' && (request.kind === 'select' || request.kind === 'label')) {
    return { kind: 'written', text: wire.text };
  }
  if (wire.kind !== request.kind) return undefined;
  switch (request.kind) {
    case 'select': {
      const chosen = (wire as { chosen?: unknown }).chosen;
      if (!Array.isArray(chosen)) return undefined;
      const entities: Entity[] = [];
      for (const index of chosen) {
        if (!Number.isInteger(index) || index < 0 || index >= request.options.length) return undefined;
        entities.push(request.options[index as number]!);
      }
      return { kind: 'select', chosen: entities };
    }
    case 'confirm':
      return typeof (wire as { yes?: unknown }).yes === 'boolean' ? { kind: 'confirm', yes: (wire as { yes: boolean }).yes } : undefined;
    case 'number': {
      const value = (wire as { value?: unknown }).value;
      return typeof value === 'number' && Number.isFinite(value) ? { kind: 'number', value } : undefined;
    }
    case 'label': {
      const value = (wire as { value?: unknown }).value;
      return typeof value === 'string' ? { kind: 'label', value } : undefined;
    }
  }
}

export interface RemotePlayerOptions {
  /** How long to wait for an answer before using the default one. Default: wait for ever. */
  readonly timeoutMs?: number;
  readonly team?: string;
}

/**
 * A player who is on the other end of a `Room`. Its choices go to the client as a `choose`
 * prompt and its answers come back; everything else a player does (a turn's moves) is
 * the game's to ask over the same prompt channel.
 */
export class RemotePlayer extends Player {
  readonly #room: RoomLike;
  readonly #userId: string;
  readonly #projector: ViewProjector;
  readonly #timeoutMs: number | undefined;

  constructor(
    name: string,
    characters: readonly Character[],
    room: RoomLike,
    userId: string,
    projector: ViewProjector,
    options: RemotePlayerOptions = {},
  ) {
    super(name, characters, options.team, userId);
    this.#room = room;
    this.#userId = userId;
    this.#projector = projector;
    this.#timeoutMs = options.timeoutMs;
  }

  /** A remote player's turn is driven by the game over the prompt channel, not by this. */
  async decide(_engine: GameEngine): Promise<Decision[]> {
    return [];
  }

  override async choose(request: ChoiceRequest): Promise<ChoiceAnswer> {
    const wire = toWireRequest(this.#projector, this, request);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let reply: unknown;
      try {
        reply = await this.#room.prompt(this.#userId, 'choose', wire, {
          ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
        });
      } catch (error) {
        if (error instanceof PromptTimeoutError) break;
        // The client said it could not answer; ask again, then fall back.
        if (error instanceof Error && error.name !== 'RoomClosedError') continue;
        throw error;
      }
      const answer = fromWireAnswer(request, reply);
      if (answer) return answer;
    }
    return autoChoose(request);
  }
}
