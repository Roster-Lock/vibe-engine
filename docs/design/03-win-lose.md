# 03 — Win/Lose, Teams, Ownership

> Status: ✅ decided.

## Decisions

- ✅ **Teams live on Players, not characters.** `TeamRegistry` groups players
  by team tag (existing mechanism). A player's characters belong to the team
  *through the player*; `Character.team` is removed. A control swap moves a
  character to its new controller's team implicitly — there is no separate
  team assignment to keep in sync.
- ✅ **Defeat is ownership-based.** A player is defeated when every character
  they **own** with `countsForDefeat` is dead. Control is irrelevant to
  defeat — a stolen character keeps its original owner alive, even though it
  fights for the thief.
- ✅ **`countsForDefeat` per character** — default `true` for player-created
  characters, `false` for summons, overridable per summon:
  - an "Avatar" summon **counts** (and can later *become* the defeat
    condition, see below);
  - "bug" summons that spawn by the hundred do **not** count.
  Edge case: a player with zero `countsForDefeat` characters can never be
  defeated — either require at least one, or use the Avatar rule.
- ✅ **Countdown win/lose effects** — statuses with a counter that ticks at
  **round-start** (the deadline rule for countdown-style pending effects,
  see 10-pending-effects; this supersedes the earlier "ticks on `turn:end`"
  note) and at 0 produce a `win`/`lose` action — e.g. a curse that ticks
  down to a `lose` action, or a decree that ticks to `win`. These resolve
  at the **win/lose layer of the SBA pass — first** (see 04-sba). They are
  counterable with ordinary tools (dispel the curse, kill the caster before
  the timer, survive the decree) — the timer creates the reaction window.
  (The *examples* of content-registered SBAs are the buff-count / mana-sum
  rules in 04-sba; countdown effects are pending effects, not SBAs.)
- ✅ **Draws** (existing behavior, preserved): two teams win at once ⇒ draw;
  all remaining teams lose at once ⇒ draw.
- ✅ **Game-end resolution runs before destruction and before death
  triggers** (confirmed — see 02-destroy). This also means a countdown
  `win`/`lose` and a killing blow in the same batch resolve together at the
  win/lose layer, before anything else happens.
- ✅ **The win/lose check is destroy-gate aware.** "Dead for win/lose" =
  the state would trigger a registered `GaugeSba` destroy rule **and** the
  destroy is not gated — an indestructible character at the rule condition
  is never destroyed, and since the player still has it, they do **not**
  lose (see 02-destroy). The dead predicate consults the same rule registry
  as the destroy phase, so defeat and destruction never disagree. With the
  built-in rules (HP ≤ 0), that is: HP ≤ 0 and the HP→destroy rule
  not gated.
- ✅ **Win/lose is gated like other rules.** A status can declare simple
  `on: 'lose'` / `on: 'win'` restrictions (see 11-restrictions): "cannot
  lose the game", "cannot win the game" — the gate blocks the determination
  at layer 1, before the game ends. A named exception pierces it.
- ⏳ **Last breath ("if you would lose, prevent that loss instead") is a
  replacement effect, not a gate** — deferred, see
  [12-replacement-effects.md](12-replacement-effects.md). The decided rule
  for replacement chains: each replacement effect emits **at most once per
  chain**.

## Noted extension (deferred)

- 🔶 **Avatar-style defeat conditions**: a summon that *becomes* the owner's
  defeat condition — the initial characters stop counting once the Avatar is
  summoned, and the game is lost when the Avatar dies. Likely a
  player-level `defeatCondition` override; parked until content needs it.

## Engine implications

- `player.ts`: `isDefeated` = every owned `countsForDefeat` character is
  dead (uses post-write mana for the check, since win/lose runs before the
  destroy phase — see 02-destroy).
- `teams.ts`: mostly unchanged (already groups players by team tag); the
  defeat derivation reads ownership + `countsForDefeat`.
- `engine.ts`: `isAlly`/`isEnemy` derive from controllers and player teams.
- Pending effects / statuses: countdown statuses tick on `turn:end`.
