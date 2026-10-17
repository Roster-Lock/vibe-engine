/**
 * Finding which user a token belongs to — shared by every kind of room.
 *
 * Every user is compared, with no early exit and no short-circuit on length, so how long
 * a guess takes says nothing about how close it was or which user it nearly matched.
 */

/** The users a room holds, by id. Only the token matters here. */
export type TokenTable = Readonly<Record<string, { readonly authToken: string }>>;

const encoder = new TextEncoder();

/** Compares two strings in time that depends on their lengths, not on where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The id of the user who holds `token`, or `null`. Anything that is not a plausible token is `null`. */
export function findUser(users: TokenTable, token: unknown, maxLength = 1024): string | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > maxLength) return null;
  let found: string | null = null;
  for (const [userId, user] of Object.entries(users)) {
    if (safeEqual(token, user.authToken)) found = userId;
  }
  return found;
}

/** Throws if `token` is unusable or already belongs to another user. */
export function assertFreshToken(users: TokenTable, userId: string, token: unknown): asserts token is string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`Room: ${userId} needs a non-empty auth token`);
  }
  for (const [other, existing] of Object.entries(users)) {
    if (safeEqual(existing.authToken, token)) {
      throw new Error(`Room: ${userId} and ${other} have the same auth token — each user needs their own`);
    }
  }
}
