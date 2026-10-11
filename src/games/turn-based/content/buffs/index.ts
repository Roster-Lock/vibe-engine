/**
 * All buffs, one folder each (mirroring `characters/`): each folder holds
 * its source (`index.ts`) and its SVG icon (`icon.svg`). The example's
 * `index.ts` does `export * from './buffs/index.js'`, so consumers just
 * import the buff they need from there.
 */
export { rage } from './rage/index.js';
export { poison } from './poison/index.js';
export { thorns } from './thorns/index.js';
