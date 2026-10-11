/**
 * Seeding the trigger-order PRNG — commit/reveal and the helpers behind it.
 *
 * Triggered abilities don't fire in subscription order: every trigger that
 * passes its prestack filter is collected, sorted by its listener's unique id,
 * and then **shuffled** with the engine's PRNG before it runs. That shuffle
 * needs a seed, and the game wants that seed to be *fair*: no player should
 * be able to pick their contribution after seeing everyone else's.
 *
 * The ceremony this module supports is **commit/reveal**:
 *
 * 1. every player first hands over a blind **commit** — a hash of the secret
 *    string it will contribute (`commitSecret`),
 * 2. once all commits are in, each player **reveals** its secret
 *    (`verifyCommit` checks it against the commit),
 * 3. the seed is built from the revealed secrets, **sorted by player id**
 *    (`buildSeed`), so the same set of players always produces the same seed
 *    regardless of the order they revealed in.
 *
 * The resulting seed string feeds `createPrng` (a small deterministic PRNG)
 * via the engine — see `GameEngine`'s `seed` option / `setSeed`, and
 * `Game.collectSeed` for the ceremony in action.
 *
 * Note: `hashString` is FNV-1a, a fast content hash — fine for *fairness*
 * (nobody can adapt to the others' commits), not a cryptographic primitive.
 */
export interface SeedContribution {
  /** The stable id of the player contributing the secret. */
  readonly playerId: string;
  /** The player's revealed secret string. */
  readonly secret: string;
}

/** FNV-1a 32-bit — hashes a string to a 32-bit unsigned integer. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The commit a player hands over before revealing: a fixed-width hash of the
 * secret. The game collects every commit before any secret is revealed, so a
 * late player cannot adapt its secret to the others'.
 */
export function commitSecret(secret: string): string {
  return hashString(secret).toString(16).padStart(8, '0');
}

/** True when a revealed secret matches a commit handed over earlier. */
export function verifyCommit(commit: string, secret: string): boolean {
  return commitSecret(secret) === commit;
}

/**
 * Builds the game seed from every participant's revealed secret, **sorted by
 * player id** — the same players in any reveal order produce the same seed.
 */
export function buildSeed(entries: ReadonlyArray<SeedContribution>): string {
  return [...entries]
    .sort((a, b) => a.playerId.localeCompare(b.playerId))
    .map((entry) => `${entry.playerId}:${entry.secret}`)
    .join('|');
}

/**
 * A tiny deterministic PRNG (mulberry32) seeded with a 32-bit integer.
 * Same seed ⇒ same sequence — this is what makes a replayable game: the
 * same seed plus the same game state shuffles triggers identically.
 */
export function createPrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shuffles `items` in place (Fisher–Yates) using `rng` — the engine passes
 * its seeded PRNG here, so the shuffle is deterministic per seed.
 */
export function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
}

/** A fresh random seed string — used when no player provides one. */
export function createRandomSeed(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
