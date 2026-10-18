/**
 * Buffs showcasing the destroy / state-based-action work
 * (docs/design/02-destroy.md, 04-sba.md):
 *
 * - **soulHarvest** — listens to `character:destroyed:batch`: the
 *   "whenever one or more characters die" primitive. Fires **once per
 *   wipe** (not once per death) and sees every victim.
 * - **gravePact** — listens to its wearer's own `character:destroyed`: a
 *   death trigger that reads the destroy **reason** to find the killer:
 *   `hp:current-reached-minimum` → the drainers in `changes`;
 *   `direct-action` → the `source`; `hp:maximum-reached-0` → no killer.
 * - **corpseTrap** — a buff:destroyed self-trigger bomb: when the buff ends (its
 *   wearer is destroyed, dispelled, …), it deals damage to every standing
 *   enemy. During a wipe this fires inside the destroy phase, one nested
 *   apply per trap.
 * - **lastStand** — listens to `character:survived`: when the wearer
 *   survives a hit at low HP, it pulls itself together.
 * - **doomClock** — a countdown that ticks at every `turn:start` and
 *   destroys itself when it reaches zero.
 * - **cursedShield** — a `buff:destroyed` self-trigger that retaliates
 *   against the **player's character** that destroyed it (a dispel by a
 *   skill or direct action).
 * - **bloodTether** / **leash** — retaliate against the destroying buff's
 *   **creator** (`caster`) / **wearer** (`target`) when a buff's action
 *   destroys them.
 * - **trapMine** — the per-instance self-trigger: a stackable bomb whose
 *   `buff:destroyed` filter matches its own `uid`
 *   (`ctx.event.buff.uid === ctx.status.uid`), so removing **one** stacked
 *   copy detonates only that copy.
 */
import { auto, buff, damage, heal, isDamage, removeBuff } from '../../games/turn-based/index.js';
import type { Character, GaugeWrite } from '../../games/turn-based/index.js';

/**
 * Soul Harvest — whenever one or more characters die, the wearer heals
 * 5 per victim. One batch event per wipe, so a board wipe heals once.
 */
export const soulHarvest = buff({
  name: 'Soul Harvest',
  weight: 1,
  abilities: [
    auto({
      name: 'Harvest',
      event: 'character:destroyed:batch',
      cast: (ctx) => [heal(ctx.self.gauge('hp'), 5 * ctx.event.events.length)],
    }),
  ],
});

/**
 * Grave Pact — when the wearer is destroyed, their killer takes 15 damage.
 *
 * The killer is found from the destroy reason:
 * - `hp:current-reached-minimum` — the batch's HP writes (`changes`)
 *   name the drainers (`isDamage`);
 * - `direct-action` — `source` is the destroyer;
 * - `hp:maximum-reached-0` — a max-HP wipe; nobody to curse.
 *
 * Note: this is a *death trigger* — it only runs when the death does not
 * end the game (win/lose resolves first; see docs/design/02-destroy.md).
 * It does **not** need `removedOnDefeat: false`: the destroy phase collects
 * the death's triggers before cleaning up on-defeat buffs, so a buff that
 * dies with its wearer still hears the death (the same-batch principle).
 */
export const gravePact = buff({
  name: 'Grave Pact',
  weight: 1,
  abilities: [
    auto({
      name: 'Final Curse',
      event: 'character:destroyed',
      when: (ctx) => ctx.event.character === ctx.self,
      cast: (ctx) => {
        const event = ctx.event;
        const killers: Character[] =
          event.reason === 'hp:current-reached-minimum'
            ? event.changes
                .filter((c): c is GaugeWrite & { source: Character } =>
                  isDamage(c) && 'source' in c && c.source.type === 'character',
                )
                .map((c) => c.source)
            : event.reason === 'direct-action' && 'source' in event && event.source.type === 'character'
              ? [event.source]
              : [];
        return killers.map((killer) => damage(killer.gauge('hp'), 15, ctx.self));
      },
    }),
  ],
});

/**
 * Corpse Trap — a `buff:destroyed` self-listening trigger bomb. When this
 * buff ends (the wearer is destroyed and `removedOnDefeat` kills it, or it
 * is dispelled), it deals 12 damage to every standing enemy. During a wipe
 * the traps fire at the drain — after the `character:destroyed` events.
 */
export const corpseTrap = buff({
  name: 'Corpse Trap',
  weight: 1,
  abilities: [
    auto({
      name: 'Detonate',
      event: 'buff:destroyed',
      // Self-listening by **instance** (the dying buff is this trigger's own
      // status): only the removed copy detonates, never a sibling copy.
      when: (ctx) => ctx.event.buff.uid === ctx.status.uid,
      cast: (ctx) =>
        ctx.engine
          .validTargets({ who: 'enemy' }, ctx.self)
          .filter((enemy) => !enemy.isDefeated)
          .map((enemy) => damage(enemy.gauge('hp'), 12, ctx.event.buff)),
    }),
  ],
});

/**
 * Last Stand — a `character:survived` trigger: when the wearer survives a
 * hit at under 30% HP, it pulls itself together. (The event fires after
 * the batch settles, so `hp.current` is the post-hit value. Survival is
 * judged on HP — the life gauge — so "low" means low HP.)
 */
export const lastStand = buff({
  name: 'Last Stand',
  weight: 1,
  abilities: [
    auto({
      name: 'Clench',
      event: 'character:survived',
      when: (ctx) =>
        ctx.event.character === ctx.self && ctx.self.gauge('hp').current < ctx.self.gauge('hp').max * 0.3,
      cast: (ctx) => [heal(ctx.self.gauge('hp'), 10)],
    }),
  ],
});

/**
 * Doom Clock — a countdown that ticks down at every `turn:start` and
 * **destroys itself when it reaches zero**. Applied with `ticks: N` (the
 * default is 3) it survives N−1 full rounds and expires at the **Nth** turn
 * start. Not stackable — one clock per wearer.
 *
 * Expiry is a plain `removeBuff`, so it announces a `buff:destroyed` with
 * `reason: 'removed'` and the clock itself as the source (a buff's own
 * trigger is attributed to the buff — see the trigger stack). A
 * buff:destroyed self-trigger on the same buff would fire at that point,
 * which is the composition for a **delayed bomb**: countdown + a
 * `corpseTrap`-style payload.
 */
export const doomClock = buff({
  name: 'Doom Clock',
  weight: 1,
  variables: () => ({ ticks: 3 }),
  abilities: [
    auto({
      name: 'Tick',
      event: 'turn:start',
      when: (ctx) => ctx.self.hasStatus('doom-clock'),
      cast: (ctx) => {
        const clock = ctx.self.findStatus('doom-clock');
        if (!clock) return [];
        const remaining = Number(clock.vars.ticks) - 1;
        if (remaining > 0) {
          clock.vars.ticks = remaining;
          return [];
        }
        // Reached zero — destroy self. The removal is attributed to the
        // clock itself (see the header note), so a *global* `buff:destroyed`
        // observer sees "removed by a buff's action". Self-listening
        // retaliation buffs (below) are per-instance and unaffected.
        return [removeBuff(ctx.self, 'doom-clock')];
      },
    }),
  ],
});

/**
 * Cursed Shield — when a **player's character** destroys this buff — a
 * dispel by a skill or direct action: `buff:destroyed` with
 * `reason: 'removed'` and a `Character` source — that character takes 12
 * damage. Removals with no source (`reason: 'wearer-destroyed'`) or by a
 * buff's action (a `Buff` source) do **not** trigger it: the shield only
 * bites the hand that dispelled it.
 *
 * The retaliation damage's source is the shield itself, so the log reads
 * "Hero takes 12 damage from Cursed Shield" (the same attribution
 * `corpseTrap` uses).
 */
export const cursedShield = buff({
  name: 'Cursed Shield',
  weight: 1,
  abilities: [
    auto({
      name: 'Shield Backlash',
      event: 'buff:destroyed',
      when: (ctx) =>
        ctx.event.buff.uid === ctx.status.uid &&
        ctx.event.reason === 'removed' &&
        'source' in ctx.event &&
        ctx.event.source.type === 'character',
      cast: (ctx) => {
        if (!('source' in ctx.event)) return [];
        const destroyer = ctx.event.source;
        if (destroyer.type !== 'character' || !ctx.engine.isInPlay(destroyer)) return [];
        return [damage(destroyer.gauge('hp'), 12, ctx.event.buff)];
      },
    }),
  ],
});

/**
 * Blood Tether — when a **buff's action** destroys this buff (a `Buff`
 * source: another buff/aura's ability dispelling it, or the removal
 * cascade's grantor), the destroyer's **creator** — the character that
 * created the destroying buff (`event.source.caster`) — takes 12 damage.
 *
 * `reason: 'wearer-destroyed'` (the tether dies with its own wearer) and
 * character-driven removals never trigger it. When the destroying buff has
 * no creator (applied with no source) — or the creator is already in the
 * graveyard when the queued trigger runs — the backlash fizzles.
 */
export const bloodTether = buff({
  name: 'Blood Tether',
  weight: 1,
  abilities: [
    auto({
      name: 'Tether Backlash',
      event: 'buff:destroyed',
      when: (ctx) =>
        ctx.event.buff.uid === ctx.status.uid &&
        ctx.event.reason === 'removed' &&
        'source' in ctx.event &&
        ctx.event.source.type === 'buff',
      cast: (ctx) => {
        if (!('source' in ctx.event)) return [];
        const destroyer = ctx.event.source;
        if (destroyer.type !== 'buff') return [];
        const creator = destroyer.caster;
        return creator && ctx.engine.isInPlay(creator) ? [damage(creator.gauge('hp'), 12, ctx.event.buff)] : [];
      },
    }),
  ],
});

/**
 * Leash — the sibling of Blood Tether, but the backlash lands on the
 * destroying buff's **wearer** (`event.source.target`) instead of its
 * creator: when a buff's action destroys this buff, the character wearing
 * the destroying buff takes 12 damage. Same filters and fizzle rules as
 * Blood Tether.
 */
export const leash = buff({
  name: 'Leash',
  weight: 1,
  abilities: [
    auto({
      name: 'Leash Backlash',
      event: 'buff:destroyed',
      when: (ctx) =>
        ctx.event.buff.uid === ctx.status.uid &&
        ctx.event.reason === 'removed' &&
        'source' in ctx.event &&
        ctx.event.source.type === 'buff',
      cast: (ctx) => {
        if (!('source' in ctx.event)) return [];
        const destroyer = ctx.event.source;
        if (destroyer.type !== 'buff') return [];
        const wearer = destroyer.target;
        return wearer && ctx.engine.isInPlay(wearer) ? [damage(wearer.gauge('hp'), 12, ctx.event.buff)] : [];
      },
    }),
  ],
});

/**
 * Trap Mine — a **stackable** bomb whose `buff:destroyed` self-trigger is
 * matched **per instance**: `ctx.event.buff.uid === ctx.status.uid`. The
 * trigger context exposes the owning status, so when one of several stacked
 * copies is removed, only that copy detonates — the others stay armed.
 *
 * (The coarser id-based filter — `ctx.event.buff.id === 'trap-mine'` — would
 * detonate *every* copy on the character whenever any one is removed: one
 * trigger per copy, all matching the same removal event. Fine for
 * non-stackable bombs like `corpseTrap`; wrong for stacks.)
 */
export const trapMine = buff({
  name: 'Trap Mine',
  weight: 1,
  abilities: [
    auto({
      name: 'Detonate',
      event: 'buff:destroyed',
      when: (ctx) => ctx.event.buff.uid === ctx.status.uid,
      cast: (ctx) => [damage(ctx.self.gauge('hp'), 10, ctx.event.buff)],
    }),
  ],
});
