# 08 — Players, Teams, Win/Lose

> Slice 5. Who is playing, which side is which, and how a game ends.

## 1. Player

```ts
abstract class Player {
  readonly id: string;              // explicit, or a slug of the name
  readonly name: string;
  readonly team: string | undefined;// team tag; undefined = its own team
  readonly characters: readonly Character[];

  constructor(name, characters, team?, id?);   // characters = the ownership list;
                                               // stamps owner AND controller (target model)
  get isDefeated(): boolean;        // ownership-based defeat (below)
  get livingCharacters(): Character[];

  abstract decide(engine: GameEngine): Promise<Decision[]>;   // this round's moves

  commitSeed?(): string | Promise<string>;    // seed ceremony (both-or-neither)
  revealSeed?(): string | Promise<string>;
}
```

- The constructor stamps `controller` (and, in the target model, `owner`)
  onto its characters, so the engine can attribute wins and losses.
- `decide(engine)` produces the round's `Decision`s — a human, an AI, or a
  script picks them. Concrete subclasses (`ScriptedPlayer`, `RandomAI`,
  a UI-backed human player) live outside the engine core
  ([14-game-loop.md](14-game-loop.md) §4).

## 2. Ownership-based defeat (target model)

- A player owns characters for **defeat purposes** (`owner`) and plays them
  (`controller`). These are distinct: a **control swap** changes
  `controller` (and therefore which side the character fights for) but
  **never `owner`** — a stolen character keeps its original owner alive.
- **Defeat is ownership-based**: a player is defeated when every character
  they **own** with **`countsForDefeat`** is dead. Control is irrelevant to
  defeat.
- **`countsForDefeat`** per character — default `true` for player-created
  characters, `false` for summons, overridable per summon:
  - an "Avatar" summon **counts** (and can later *become* the defeat
    condition — avatar-style defeat conditions are a noted extension,
    deferred);
  - "bug" summons that spawn by the hundred do **not** count.
  Edge case: a player with zero `countsForDefeat` characters can never be
  defeated — either require at least one, or use the Avatar rule.
- **"Dead" for win/lose** = HP ≤ 0 **and** the HP→destroy rule is not
  gated — an indestructible character at 0 HP is never destroyed, and
  since the player still has it, they do **not** lose
  (destroy-gate-aware, [10-destroy.md](10-destroy.md) §2).
- A player whose characters were **destroyed** by explicit `destroy`
  actions is defeated too — `isDefeated` considers both `isDefeated`
  (HP) and `destroyed` (zone).

## 3. TeamRegistry

The engine groups players by team tag; teamless players are **their own
team** (`team ?? player` is the group key).

```ts
register(player): boolean          // false when already registered
markWon(side: string | Player): void    // validation + marker only
markLost(side: string | Player): void   // validation + marker only
resolveGameEnd(): void             // the game-over state-based action
```

- `markWon`/`markLost` validate that the team has registered players (else
  throw: `win: no registered players on team "…"`) and record a marker.
  Resolution is **deferred to the batch/apply boundary** so several teams
  can win (or lose) in the same apply.
- `resolveGameEnd` resolves the game from two independent facts:
  1. **who has won** — exactly one explicitly-won team ends the game with
     that team's players; **two or more winners at once is a draw** (no
     single side can be crowned);
  2. **who is still standing** — with no explicit winner, exactly one
     standing team wins; **when all remaining teams lose at the same time
     it is a draw**.
- **No-op while no players are registered** — a bare engine with characters
  only never ends the game (win/lose detection requires registered
  participants).

The engine throws a **`GameEndInterrupt(winners: Player[])`** — `winners`
empty means a draw — and everything stops: no destruction events, no
triggers, no further actions (win/lose-first, [09-sba-pass.md](09-sba-pass.md) §3).

## 4. `win` / `lose` actions

- `win(team)` declares a side the winner; `lose(team)` marks a side as
  lost — even if its characters are still standing. Either accepts a team
  tag or a `Player`.
- Both are **deferred markers** ([03-actions.md](03-actions.md) §2.4):
  resolution happens after every gauge batch and at the end of every
  `apply` (a single winner ends the game; two winners or zero survivors end
  it as a draw).
- **Win/lose is gated like other rules** (target model): a status can
  declare `on: 'lose'` / `on: 'win'` restrictions — "cannot lose the game",
  "cannot win the game" — the gate blocks the determination at layer 1 of
  the SBA pass, before the game ends. A named exception pierces it
  ([11-restrictions.md](11-restrictions.md)).

## 5. Countdown win/lose (target model)

A status with a counter that ticks at **round-start** (a deadline-style
pending effect, [12-pending-effects.md](12-pending-effects.md) §2) and at 0
produces a `win`/`lose` action — a curse that ticks down to a `lose`, or a
decree that ticks to `win`. These resolve at the **win/lose layer of the
SBA pass — first**. They are counterable with ordinary tools (dispel the
curse, kill the caster before the timer, survive the decree) — the timer
creates the reaction window.

## 6. Draws

The edge cases of the same resolution:

- **two teams win at the same time** (e.g. two `win` actions in one
  `apply`) — no single side can be crowned ⇒ draw;
- **all remaining teams lose at the same time** (mutual destruction in one
  batch, or `lose` actions on every team) — nobody is left ⇒ draw.

Both produce a `GameEndInterrupt` with an **empty winners array**.

## 7. Acceptance criteria (Slice 5)

1. Registering a player stamps `controller` on its characters; registering
   the players enables win/lose (characters alone never end the game).
2. A player whose every owned `countsForDefeat` character is dead is
   defeated; a summon with `countsForDefeat: false` never causes defeat.
3. A control swap moves a character to its new controller's team for
   ally/enemy purposes but does **not** change defeat attribution.
4. `win('party')` with no registered players throws; with one team
   registered it ends the game with that team's players.
5. Two `win` actions in one apply end the game as a draw (empty winners);
   `lose` on every remaining team is a draw.
6. A killing blow resolves the game **before** events: no
   `character:destroyed`, no triggers (win/lose-first).
7. An `on: 'lose'` restriction blocks a loss determination at the SBA
   layer; a named exception pierces it.
8. A countdown status that ticks to 0 with a `lose` action resolves at the
   win/lose layer, before anything else in the pass.
