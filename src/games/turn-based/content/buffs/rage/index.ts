/**
 * Rage — the one buff genuinely shared between roster fighters (the
 * Goblin's War Cry and the War Hound's Howl both apply it), so it lives in
 * the shared `buffs/` folder — one folder per buff, holding its source
 * (`index.ts`) and its SVG icon (`icon.svg`).
 *
 * Each stack makes the wearer's *outgoing damage* 5 points stronger.
 * Transformers live on abilities, so Rage grants a passive action modifier
 * that checks `action.direction` to only touch outgoing actions.
 */
import { Character, buff, passiveActionModifier } from '../../../../../engine/index.js';
import icon from './icon.svg';

export const rage = buff({
  name: 'Rage',
  icon,
  weight: 2,
  variables: () => ({ stacks: 1 }),
  abilities: [
    passiveActionModifier({
      name: 'Rage',
      transform: (action, ctx) => {
        // Only outgoing damage from a character (not a buff) to another
        // character's gauge — leave heals and the wearer's own gauge writes
        // (mana costs, self-damage) alone. Damage targets the victim's HP
        // (the life gauge), so "a hit" is an HP write on an enemy.
        if (action.direction !== 'outgoing') return action;
        if (action.type !== 'gauge' || !(ctx.source instanceof Character)) return action;
        if (ctx.engine.characterOf(action.target) === ctx.source) return action;
        const next = action.update(action.target.current, action.target.max);
        if (next >= action.target.current) return action; // not damage
        const stacks = Number(ctx.status?.vars.stacks ?? 0);
        return { ...action, update: (cur, max) => action.update(cur, max) - 5 * stacks };
      },
    }),
  ],
});
