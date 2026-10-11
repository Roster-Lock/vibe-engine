/**
 * transformModifier — the declarative **tie between a buff and a
 * transformation** (docs/spec/04-character-status.md §6, docs/design/01-entities.md
 * "Transform stack").
 *
 * A buff carrying a `transformModifier` declares a form: while the buff is
 * attached, the wearer's form *is* that form — the engine pushes it keyed
 * by the buff instance when the buff lands, and pops it (reverting the
 * form) when the buff is removed — dispelled, dying with its wearer, or
 * taken by the cascade. This is "the hex holds": the tied form **pins** the
 * character above any other transformations pushed while the buff is
 * active — an opponent can push "Demon form" on a hexed hero, but the hex's
 * form stays until the hex ends, at which point the Demon surfaces.
 *
 * ```ts
 * const hex = buff({
 *   name: 'Hex',
 *   weight: 1,
 *   abilities: [transformModifier({ name: 'Toad Form', form: { name: 'Toad', gauges: { hp: 3 }} })],
 * });
 * ```
 *
 * Like `maxModifier`, it is a declarative status-level piece the engine
 * reads straight off the status list — it never produces Actions. The
 * `popTransform` action is **refused** while a tie is live (the hex
 * holds); the tie ends only when its buff is removed.
 */
import type { TransformForm } from '../actions.js';
import { deriveId } from './types.js';

/** A buff-to-form tie: while the owning status is attached, the form holds. */
export interface TransformModifierAbility {
  readonly kind: 'transformModifier';
  readonly id: string;
  readonly name: string;
  /** Short human-readable description of what the tie does. */
  readonly description?: string;
  /** The form the wearer takes while the owning status is attached. */
  readonly form: TransformForm;
}

export interface TransformModifierDef {
  readonly id?: string;
  readonly name: string;
  /** Short human-readable description of what the tie does. */
  readonly description?: string;
  /** The form the wearer takes while the owning status is attached. */
  readonly form: TransformForm;
}

/**
 * A transformModifier ability: while its status is attached, the wearer's
 * form is `form` — pushed on attach, popped (reverting) on removal.
 */
export function transformModifier(def: TransformModifierDef): TransformModifierAbility {
  return {
    kind: 'transformModifier',
    id: def.id ?? deriveId(def.name, 'ability'),
    name: def.name,
    ...(def.description ? { description: def.description } : {}),
    form: def.form,
  };
}
