/**
 * Thorns ("goblin thorn mail") — striking back at whoever damages the
 * wearer. Used by the interactive demo, where the goblin wears it.
 *
 * This folder is the whole buff: its source (`index.ts`) and its SVG icon
 * (`icon.svg`).
 *
 * It listens to `gauge:changed` (there are no damage events) and uses the
 * event helpers: the wearer must have *taken* the damage, and the source
 * must be a character other than the wearer — a buff source (like a poison
 * tick) has no one to hit back. The retaliation carries no explicit
 * source, so the engine attributes it to this buff — the combat log reads
 * "takes 8 damage from Thorns".
 */
import { auto, buff, damage, wasTakenBy } from '../../../index.js';
import icon from './icon.svg';

export const thorns = buff({
  name: 'Thorns',
  icon,
  weight: 2,
  abilities: [
    auto({
      name: 'Retaliation',
      event: 'gauge:changed',
      when: (ctx) => {
        if (!('source' in ctx.event)) return false;
        const source = ctx.event.source;
        return (
          wasTakenBy(ctx.event, ctx.self) &&
          source.type === 'character' &&
          source !== ctx.self
        );
      },
      targets: (ctx) => {
        if (!('source' in ctx.event)) return [];
        const source = ctx.event.source;
        return source.type === 'character' && source !== ctx.self ? [source] : [];
      },
      cast: (ctx, targeting) =>
        targeting?.targets[0] ? [damage(targeting.targets[0].gauge('hp'), 8)] : [],
    }),
  ],
});
