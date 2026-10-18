/**
 * Poison — every stack ticks 5 HP damage (life — poison can kill) to its
 * wearer at the start of each round. Because each application is its own
 * buff instance with its own triggered ability, N stacks simply means N
 * ticks.
 *
 * This folder is the whole buff: its source (`index.ts`) and its SVG icon
 * (`icon.svg`). The tick carries no explicit source, so the engine
 * attributes the damage to this buff — the combat log reads "takes 5
 * damage from Poison".
 */
import { auto, buff, damage } from '../../../../../engine/index.js';
import icon from './icon.svg';

export const poison = buff({
  name: 'Poison',
  icon,
  weight: 1,
  abilities: [
    auto({
      name: 'Poison Tick',
      event: 'turn:start',
      targets: (ctx) => [ctx.self],
      cast: (ctx, targeting) =>
        targeting?.targets[0] ? [damage(targeting.targets[0].gauge('hp'), 5)] : [],
    }),
  ],
});
