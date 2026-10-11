# 02 — Seed & Determinism

> Slice 0. The one source of randomness, and the ceremony that makes it fair.

## 1. Why

Triggered abilities don't fire in subscription order, and equal-speed
characters don't act in a defined order. Where the engine must pick an
order, it uses a **seeded PRNG** — so *same seed + same game state ⇒ same
sequence of events*. The seed is the replay key: two runs with the same
seed and the same decisions must produce identical histories.

The only randomness in the whole engine flows through this module. Nothing
else calls `Math.random` except `createRandomSeed` itself.

## 2. The primitives

```ts
hashString(input: string): number      // FNV-1a 32-bit content hash
createPrng(seed: number): () => number // mulberry32 — deterministic float stream in [0, 1)
shuffle<T>(items: T[], rng: () => number): void  // in-place Fisher–Yates
createRandomSeed(): string             // fresh random seed string
```

- **`hashString`** is FNV-1a: fast, stable across platforms, fine for
  *fairness* (nobody can adapt to the others' commits) — not a cryptographic
  primitive.
- **`createPrng`** is mulberry32: same seed ⇒ same sequence. This is the
  determinism guarantee — the engine seeds it once from `hashString(seed)`.
- **`shuffle`** is Fisher–Yates using the supplied `rng`, so the shuffle is
  deterministic per seed and reproducible.

## 3. The commit/reveal ceremony

The game wants the seed to be **fair**: no player should be able to pick
its contribution after seeing everyone else's. The ceremony:

1. Every player that implements both `commitSeed()` and `revealSeed()`
   first hands over a **blind commit** — a fixed-width hash of the secret
   it will contribute.
2. Once all commits are in, each player **reveals** its secret; the engine
   verifies each reveal against its commit and throws if they mismatch.
3. The seed is built from the revealed secrets **sorted by player id**, so
   the same set of players produces the same seed regardless of reveal
   order.

```ts
interface SeedContribution {
  playerId: string;
  secret: string;
}

commitSecret(secret: string): string      // hashString(secret).toString(16).padStart(8, '0')
verifyCommit(commit: string, secret: string): boolean  // commitSecret(secret) === commit
buildSeed(entries: SeedContribution[]): string  // id-sorted, "id:secret" joined by '|'
```

Players advertise the hooks on the `Player` class
([08-players-teams-winlose.md](08-players-teams-winlose.md)); the ceremony
driver lives on `Game` ([14-game-loop.md](14-game-loop.md) §3).

## 4. Engine integration

```ts
const engine = new GameEngine({ seed });  // default: createRandomSeed()
engine.seed;                              // the active seed string
engine.setSeed(seed);                     // re-seed the PRNG (called by the game before round 1)
engine.random();                          // one draw from the seeded stream
```

- The PRNG stream has exactly **two consumers**, in a fixed order per unit,
  so a seed pins the whole game:
  1. **trigger-order shuffles** — each `enqueue` shuffles its prepare stack
     ([06-events-triggers.md](06-events-triggers.md) §4);
  2. **initiative tie-breaks** — each round's equal-speed groups are
     shuffled ([14-game-loop.md](14-game-loop.md) §5).
- Anything else that wants a "random" choice (an AI, a test) should draw
  from `engine.random()` so the game stays replayable.

## 5. Rules

- **The seed is game state.** It is set once before the first round (from
  `EngineOptions.seed` or the ceremony) and does not change mid-game.
- **Ticking and resolution consume no RNG.** Pending-effect resolution
  order, buff cascades, and all rule checks are pure functions of state
  ([12-pending-effects.md](12-pending-effects.md) §3).
- **No defined order, only reproducibility.** The spec does not say which
  of two simultaneous triggers fires first — it says the choice is
  deterministic per seed.

## 6. Acceptance criteria (Slice 0)

1. `createPrng(42)` produces the same 10 numbers across two calls; two
   different seeds produce different streams.
2. `shuffle` with a seeded rng is reproducible: same items + same seed ⇒
   same output order; the shuffle is a permutation (no element lost or
   duplicated).
3. `hashString` is deterministic; `commitSecret('x')` is 8 hex chars;
   `verifyCommit(commitSecret(s), s)` is true and
   `verifyCommit(commitSecret(s), s + '!')` is false.
4. `buildSeed` returns the same string for the same contributions in any
   reveal order (sorted by player id).
5. Two engines created with the same seed, fed the same actions, produce
   identical trigger order (test by observing event sequences).
6. `engine.random()` draws differ after `setSeed` with a different seed and
   are identical after `setSeed` with the same seed.
