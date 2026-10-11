/**
 * 2D vector math for the RTS map.
 *
 * Positions are plain `{ x, y }` data in map units (a Footman is ~32 units
 * across, melee range is ~90, Thunder Clap's radius is 300 — the Warcraft 3
 * scale, roughly). Every helper is pure and allocation-light: the sim calls
 * them once per unit per tick, and determinism matters more than speed, so
 * nothing here touches `Math.random` or floating-point trig beyond `sqrt`.
 */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function lengthSq(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

export function length(a: Vec2): number {
  return Math.sqrt(lengthSq(a));
}

export function distanceSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.sqrt(distanceSq(a, b));
}

/** Unit-length `a`, or `{ 0, 0 }` when `a` has no direction. */
export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  return len === 0 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len };
}

/**
 * Steps `from` toward `to` by at most `maxStep` — the movement primitive.
 * Overshoot is clamped, so a unit one pixel from its destination lands on
 * it rather than oscillating around it.
 */
export function moveToward(from: Vec2, to: Vec2, maxStep: number): Vec2 {
  const delta = sub(to, from);
  const len = length(delta);
  if (len <= maxStep || len === 0) return to;
  return add(from, scale(delta, maxStep / len));
}
