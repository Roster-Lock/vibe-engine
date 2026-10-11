# 14 — The Game Loop & Hosts

> Slice 10. The top-level driver that connects the engine to whoever is
> playing, the round skeleton, initiative, and the targeting host.

## 1. The round skeleton (target model)

One round, engine-side. (The pending-effect ticks are Slice 8;
`startTurn`/`endTurn` are the hooks.)

```
ROUND R
  START (engine.startTurn):
    1. tick pending effects with tickPhase 'round-start'   (12 §3)
    2. emit 'turn:start'
  MOVES:
    3. the game asks each player to decide; the round's moves run in
       initiative order (§5)
  END (engine.endTurn):
    4. tick pending effects with tickPhase 'round-end'     (12 §3)
    5. emit 'turn:end'
```

`startTurn()` and `endTurn()` emit their event and then **drain the
trigger queue** the event queued ([06-events-triggers.md](06-events-triggers.md) §4).

## 2. `Game` and `runLoop`

```ts
abstract class Game {
  readonly players: Player[];

  constructor(players: Player[] = []);

  abstract collectUserDecisions(): Promise<Decision[]>;
  abstract runGame(decisions: Decision[]): Promise<void>;

  async collectSeed(): Promise<string | undefined>;   // the ceremony (§3)
  protected async applySeed(seed: string | undefined): Promise<void>;  // forward to engine.setSeed

  async runLoop(): Promise<Player[]>;   // the fixed loop, below
}
```

The loop is fixed:

```
applySeed(await collectSeed())          // seed the engine before round 1
while (true) {
  const decisions = await collectUserDecisions();
  await runGame(decisions);
}
```

It ends when `runGame` throws a **`GameEndInterrupt`**, and returns that
interrupt's winners (`Player[]`, empty = a draw). Any other error
propagates to the caller of `runLoop`.

Subclasses answer the two questions per round — how the players' choices
are gathered (`collectUserDecisions`) and how a round is applied
(`runGame`, usually by resolving each decision through
`engine.useAbility`). The engine core provides the abstract `Game`; a
concrete local game (players on one machine, moves in initiative order,
round cap as a draw) is a thin subclass — see §4 for the conventions.

## 3. The seed ceremony

`Game.collectSeed` runs before the first round:

1. every player implementing **both** `commitSeed` and `revealSeed`
   contributes (others are skipped; if none contribute, returns undefined
   and the engine keeps its own seed);
2. phase 1 — blind **commits** from everyone, before any secret is
   revealed;
3. phase 2 — **reveals**, each verified against its commit (a mismatch
   throws: `Seed ceremony: "<player>" revealed a secret that does not match
   its commit.`);
4. the seed is built from the revealed secrets **sorted by player id**
   ([02-seed.md](02-seed.md) §3).

`applySeed` forwards the seed to the engine (`engine.setSeed(seed)`) so the
trigger shuffle and initiative tie-breaks are seeded
([02-seed.md](02-seed.md) §4).

## 4. Decisions, the host, and the use path

**A Decision** is one player's move for a round:

```ts
interface Decision {
  character: Character;      // who acts
  ability: Ability;          // a manual ability owned by `character`
  targets: Character[];      // inside the ability's targeting pattern
}
```

**The host** answers the engine's targeting questions when a
prompt-triggered ability fires:

```ts
interface TargetingRequest {
  prompt: string;            // the ability name, for the UI
  pattern: TargetPattern;
  source: Character;
  options: Character[];      // the allowed picks (already filtered)
}
interface GameHost {
  requestTargets(request: TargetingRequest): Promise<Targeting>;
}
```

- `AutoHost` — always picks the first valid options (AI/scripts/tests).
- `QueueHost` — returns scripted answers in order (tests and demos); throws
  when the queue is empty.

**The full `useAbility` path** (`engine.useAbility(owner, ability,
{ targets })`):

1. validate: the ability is manual and owned by `owner` (else throw);
2. validate targeting: every target is inside `validTargets(ability.targeting, owner)`
   (else throw `…cannot target "…" — outside its targeting pattern` — a
   caller may treat this as a **fizzle**);
3. run `ability.cast({ self: owner, engine }, targeting)`;
4. emit `ability:used`;
5. `apply` the resulting Actions with `source = owner` — pipeline,
   batching, SBA pass, trigger drain ([03-actions.md](03-actions.md) §6).

## 5. Initiative

- Every character has a `speed` stat (default `DEFAULT_SPEED = 10`).
- A round's moves run in **descending speed order** — fastest first.
- Characters with the **same speed** are grouped and **randomized within
  the group** using the engine's seeded PRNG:

```ts
sortBySpeed(decisions, rng): Decision[]
// 1. sort descending by character.speed
// 2. group equal speeds, shuffle within each group with `rng`
// pass () => engine.random() for reproducible ties
```

Same seed + same game state ⇒ same initiative (and tie) order.

## 6. Conventions for concrete games (engine-side)

A concrete `Game` (e.g. a local battle) registers the players with the
engine before the loop — win/lose detection requires it
([08-players-teams-winlose.md](08-players-teams-winlose.md) §3) — and
follows these conventions:

- `collectUserDecisions`: `startTurn()`, then ask each player for its
  `Decision`s via `player.decide(engine)`.
- `runGame`: apply the round in initiative order via `useAbility`, catching
  the "cannot target" fizzle (a faster move may have removed a target since
  decisions were made — that move does nothing; real errors propagate);
  `endTurn()`. Win/lose is the engine's job: `useAbility`/`endTurn` throw
  the `GameEndInterrupt` as soon as one team remains.
- A round cap is a draw: after N rounds, throw `new GameEndInterrupt([])`.

## 7. Acceptance criteria (Slice 10)

1. `runLoop` repeats collect→run until a `GameEndInterrupt`; it returns the
   interrupt's winners, and an empty winners array for a draw.
2. The seed ceremony collects commits before any reveal, verifies each
   reveal, sorts by player id, and forwards the seed to the engine via
   `applySeed` — two runs with the same players and decisions produce
   identical event histories.
3. `startTurn`/`endTurn` emit their event and drain the queued triggers;
   with pending effects built, the round-start tick runs before
   `turn:start` and the round-end tick before `turn:end`.
4. `useAbility` validates ownership and targeting, emits `ability:used`,
   and applies the cast's actions through the pipeline; a fizzled move
   ("cannot target") is skippable without aborting the round.
5. `sortBySpeed` orders moves descending by speed with equal speeds
   shuffled by the supplied rng; the same seed reproduces the same order.
6. A concrete game subclass with registered players ends with winners or a
   draw; a round cap ends as a draw.
