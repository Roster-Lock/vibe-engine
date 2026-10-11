/**
 * The death rules of a turn-based combat game — "a character's HP is its
 * life", expressed as ordinary `GaugeSba`s.
 *
 * These used to live in `src/engine/character.ts` and were attached by the
 * engine to every character's HP gauge. They are not engine concepts: the
 * engine's own machinery is "a rule attached to a gauge whose `then` destroys
 * the character", and that machinery does not care what the gauge is called.
 * Moving the rules here is what lets a game with mana-death, or two lethal
 * gauges, or none at all, use the engine unchanged.
 *
 * The names and reasons are kept exactly as the engine reported them
 * (`'HP Depleted'` / `hp:current-reached-minimum`), because content and tests
 * read them off `character:destroyed.reason` — they are this game's
 * vocabulary, and this game has not renamed its life.
 */
import { destroy, type GaugeSba } from '../../engine/index.js';

/**
 * "This gauge is life": when its **current** value reaches its minimum, the
 * character is destroyed. Attach it to whichever gauge the game considers
 * life.
 */
export function depletesAtZero(reason = 'hp:current-reached-minimum'): GaugeSba {
  return {
    name: 'HP Depleted',
    aspect: 'current',
    priority: 10,
    when: (gauge) => gauge.current <= gauge.min,
    then: (character) => [destroy(character)],
    reason,
  };
}

/**
 * "Collapsing is death": when this gauge's derived **max** is driven to 0 —
 * by a curse, a `maxModifier`, or a transform — the character is destroyed.
 * This is the rule that makes a max-wipe lethal rather than a no-op.
 */
export function collapsesAtZero(reason = 'hp:maximum-reached-0'): GaugeSba {
  return {
    name: 'HP Max Collapsed',
    aspect: 'max',
    priority: 10,
    when: (gauge) => gauge.max <= 0,
    then: (character) => [destroy(character)],
    reason,
  };
}

/**
 * The life gauge as a declaration: an `'hp'` gauge at `max`, carrying both
 * death rules, with the current value defaulting to full.
 *
 * ```ts
 * new Character('Bat', { gauges: [hpGauge({ max: 4 })] })
 * ```
 */
export function hpGauge(opts: {
  readonly max: number;
  readonly current?: number;
  readonly id?: string;
}): {
  id: string;
  max: number;
  current?: number;
  sbas: readonly GaugeSba[];
} {
  return {
    id: opts.id ?? 'hp',
    max: opts.max,
    ...(opts.current !== undefined ? { current: opts.current } : {}),
    sbas: [depletesAtZero(), collapsesAtZero()],
  };
}

/** A plain resource gauge — no death rules, so it can never kill its owner. */
export function manaGauge(opts: { readonly max: number; readonly current?: number }): {
  id: string;
  max: number;
  current?: number;
} {
  return {
    id: 'mana',
    max: opts.max,
    ...(opts.current !== undefined ? { current: opts.current } : {}),
  };
}
