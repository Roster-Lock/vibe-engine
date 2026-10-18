/**
 * StatusManager — owns a character's status list.
 *
 * The list holds buffs *and* skills, sorted by weight ascending. All the
 * heavy lifting lives here: the direction-aware insertion, add/remove with
 * their rules (non-stackable duplicates, `removable`), and the queries the
 * engine and content need. The Character delegates every status operation
 * to its `statusManager` instead of touching the list itself.
 */
import type { Ability } from '../ability/index.js';
import { Buff } from './buff.js';
import { Skill } from './skill.js';
import type { Status } from './types.js';

export class StatusManager {
  /** Buffs and skills together, sorted by weight ascending. */
  readonly #statuses: Status[] = [];

  /** Buffs and skills, sorted by weight ascending. */
  get statuses(): readonly Status[] {
    return this.#statuses;
  }

  /** Only the buffs (runtime statuses — removable or not). */
  get buffs(): Buff[] {
    return this.#statuses.filter((s): s is Buff => s.type === 'buff');
  }

  /** Only the skills (permanent statuses given at character creation). */
  get skills(): Skill[] {
    return this.#statuses.filter((s): s is Skill => s.type === 'skill');
  }

  /** Every ability currently granted by buffs and skills, in status order. */
  get abilities(): Ability[] {
    return this.#statuses.flatMap((s) => [...s.abilities]);
  }

  /** True when the character currently has a status with this id. */
  hasStatus(id: string): boolean {
    return this.#statuses.some((s) => s.id === id);
  }

  /** Finds a status (buff or skill) by id. */
  findStatus(id: string): Status | undefined {
    return this.#statuses.find((s) => s.id === id);
  }

  /**
   * Finds a buff by kind id, or by **exact instance** (its `uid` — so with
   * stacked copies of the same buff, the specific instance is found, not
   * just the first of its kind).
   */
  findBuff(buff: Buff | string): Buff | undefined {
    return typeof buff === 'string'
      ? this.buffs.find((b) => b.id === buff)
      : this.buffs.find((b) => b.uid === buff.uid);
  }

  /**
   * Adds a buff instance to the sorted list. Every add is its own instance —
   * there is no stacking rule, because the order instances were added in can
   * matter (`+1, x2, +1` is not `+1, +1, x2`).
   */
  addBuff(buff: Buff): boolean {
    this.insert(buff);
    return true;
  }

  /**
   * Removes a **removable** buff from the list — by kind id, or by exact
   * instance (its `uid`; with stacked copies, exactly that instance is
   * removed). Returns the removed buff. Buffs declared `removable: false` —
   * and skills — are never removed: the call is a no-op returning
   * `undefined`.
   */
  removeBuff(buff: Buff | string): Buff | undefined {
    const found = this.findBuff(buff);
    if (!found || !found.removable) return undefined;
    const index = this.#statuses.indexOf(found);
    if (index !== -1) this.#statuses.splice(index, 1);
    return found;
  }

  /**
   * Removes a status **by instance**, regardless of `removable`. This is the
   * engine's cascade path: when a status that granted permanent marks is
   * removed, those marks are destroyed with it. Content should call
   * `removeBuff` instead — it respects `removable`.
   */
  removeStatus(status: Status): boolean {
    const index = this.#statuses.indexOf(status);
    if (index === -1) return false;
    this.#statuses.splice(index, 1);
    return true;
  }

  /**
   * Inserts a status keeping the list sorted by weight ascending (the
   * lightest weight sits at the outside — the front of the list — and the
   * heaviest at the inside — the back). Among equal weights the status's
   * **declared `direction`** decides where it lands — a property of the
   * buff, never derived from who cast it:
   *
   * - a status declared `direction: 'out to in'` is inserted at the **front
   *   of its weight group** — before same-weight `'in to out'`/direction-less
   *   statuses, and before other same-weight `'out to in'` statuses (the
   *   newest lands first). It therefore sits on the outside of its weight
   *   group no matter when it was cast;
   * - everything else — `direction: 'in to out'`, or no direction — keeps
   *   the stable position **after** same-weight statuses (toward the inside
   *   of the group).
   *
   * The net transform order is therefore deterministic: weight first, then
   * "out to in before in to out" for ties — never cast timing alone. Among
   * equal-weight `'out to in'` statuses the newest lands first; among
   * `'in to out'`/direction-less ones, insertion order.
   */
  insert(status: Status): void {
    if (status.direction === 'out to in') {
      // Front of the weight group, newest first: scan from the top and
      // insert before the first same-weight-or-heavier status.
      let index = 0;
      for (; index < this.#statuses.length; index++) {
        const s = this.#statuses[index]!;
        if (s.weight >= status.weight) break;
      }
      if (index === this.#statuses.length) {
        this.#statuses.push(status);
      } else {
        this.#statuses.splice(index, 0, status);
      }
    } else {
      // Stable: after all same-weight statuses — scan from the end for the
      // last one with weight <= this one, then insert after it.
      let index = this.#statuses.length - 1;
      for (; index >= 0; index--) {
        const s = this.#statuses[index]!;
        if (s.weight <= status.weight) break;
      }
      if (index === -1) {
        this.#statuses.unshift(status);
      } else {
        this.#statuses.splice(index + 1, 0, status);
      }
    }
  }
}
