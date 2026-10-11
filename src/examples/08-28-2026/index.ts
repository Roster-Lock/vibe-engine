/**
 * 08-28-2026 — the destroy / state-based-action showcase content.
 *
 * What it shows (all of it built in the "destroy/SBA" session —
 * docs/design/02-destroy.md, 04-sba.md):
 *
 * | Piece | Where |
 * | --- | --- |
 * | direct destroy (`destroy` action, graveyard, corpse-proof targeting) | `makeLich` / `voidBolt` |
 * | board wipe (simultaneous destruction + batch events) | `makeWarlord` / `battleCry` |
 * | max-HP wipe (`hp:maximum-reached-0` destroy reason) | `makeHag` / `curseOfFrailty` |
 * | self-destruct (self-targeted `destroy`) | `makeMartyr` / `sacrifice` |
 * | death triggers + destroy `reason` (killer found in `changes` / `source`) | `gravePact` (buffs.ts) |
 * | batch triggers (`character:destroyed:batch`) | `soulHarvest` (buffs.ts) |
 * | per-death triggers (stacks) | `makeReaper` / `reap` |
 * | buff:destroyed self-trigger bombs (queued, after the wipe) | `corpseTrap` (buffs.ts) |
 * | `character:survived` triggers | `lastStand` (buffs.ts) |
 * | turn-countdown that destroys itself at zero | `doomClock` (buffs.ts) |
 * | retaliation vs the player's destroying character | `cursedShield` (buffs.ts) |
 * | retaliation vs the destroyer's creator / wearer | `bloodTether`, `leash` (buffs.ts) |
 * | per-instance self-triggers (`uid` matching; stacked copies detonate only the removed one) | `trapMine` (buffs.ts) |
 * | content SBA rules (`addStateBasedRule`) | the demo (Stage D) |
 *
 * Run the tour: `npm run example:destroy` (or
 * `npx tsx src/examples/08-28-2026/demo.ts`).
 */
export {
  makeLich,
  voidBolt,
  makeWarlord,
  battleCry,
  makeReaper,
  makeHag,
  curseOfFrailty,
  makeMartyr,
  sacrifice,
} from './characters.js';
export {
  soulHarvest,
  gravePact,
  corpseTrap,
  lastStand,
  doomClock,
  cursedShield,
  bloodTether,
  leash,
  trapMine,
} from './buffs.js';
