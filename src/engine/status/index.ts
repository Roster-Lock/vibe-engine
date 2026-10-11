/**
 * Statuses — the buffs and skills that sit on a character's status list,
 * and the StatusManager that owns that list (the Character delegates to
 * it instead of handling statuses directly).
 */
export {
  type StatusBase,
  type Status,
  type Statuses,
  type StatusDef,
  type StatusDirection,
  type BuffDef,
  type SkillDef,
} from './types.js';
export { Buff, buff } from './buff.js';
export { Skill, skill } from './skill.js';
export { StatusManager } from './manager.js';
