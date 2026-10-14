# examples/card-game

A two-player collectible card game — heroes, mana crystals, a board of
creatures, taunt, enters-play effects, on-death triggers, spells and
fatigue — built on tinyquest using **only the public engine API**
(`src/engine/index.ts`).

```bash
npx tsx examples/card-game/demo.ts     # a full AI vs AI match
npx vitest run test/card-game.test.ts  # the rules, as tests
```

**It is playable in the browser.** `npm run ui:dev` → **Play cards**: you
vs the AI, two players on one screen, or watch two AIs (speed + pause). The
UI drives the same `CardGame`: `HumanCardPlayer.chooseMove` suspends on a
promise the page resolves when you click, and `PacedGreedyAI` puts a beat
before each AI move so a match can be watched.

## Cards authored in English

`english.ts` is the bridge that makes the creator's cards playable: it
takes the `CompiledCard`s of a **card document** (`src/english/card.ts` —
`Card Fireball` / `Cost 4` / `Spell` / `Deal 6 damage to target enemy
character.`) and wraps the compiled engine ability in a `Card`. The effect
wrapper is thin on purpose: a card's effect *is* its engine `cast`, so
authored content runs the identical action pipeline as the catalog.

The card language names its events — `When this enters play from active
then …`, `When this dies then …` — and there is no card-only shorthand; see
`docs/creator/01-ability-language.md`.

## Entering play is a zone change

A played creature is **staged in the `active` zone and moved into `play`**
(`CardGame.#playCard`), so arriving is a real `zone:changed` with a `from`
— not a special case. That is what makes the general trigger vocabulary
work here:

- `when this enters play from active then …` — the normal cast path.
- `when this enters play from stack then …` — a card cheated past
  resolution; playing the card normally cannot reach it.
- `when this enters play then …` / `when this enters a garbage from play
  then …` / `when this leaves play then …` — the zone named, the other end
  left open.

An arrival effect that is **untargeted** compiles to that zone trigger, so
it fires however the creature arrives. One that **picks a target** stays
the card's play-time effect (`onPlay` / `arrivesFrom`), because the player
chooses the target as the card is played.

Because an authored effect can ask the controller a question mid-resolution
(`You may …`, `Repeat …`), `SpellCard.effect` and `CreatureCard.onPlay` may
return a promise, and `CardGame.#playCard` awaits them. The catalog's
hand-written effects still return plain arrays.

## The files

| File | What it is |
| --- | --- |
| `cards.ts` | The catalog. A card is data: a cost plus a stat line or an effect returning `Action[]`. |
| `combat.ts` | The board's rules as engine content — attack, taunt, summoning sickness, mana crystals, the hero. |
| `objects.ts` | The card's **form in a game**: a creature card *is* its `PermanentCard`, a spell a `SpellCardObject`. |
| `side.ts` | One player's side of the table: hero, piles, board, crystals, fatigue. |
| `game.ts` | `CardGame extends Game` — the turn loop and move execution. |
| `ai.ts` | `CardPlayer` (a `Player` with a hand) and `GreedyAI`. |
| `human.ts` | `HumanCardPlayer` (waits for the UI) and `PacedGreedyAI` (a beat per move). |
| `english.ts` | `CompiledCard` → playable `Card` (`playableCards`, `toGameCard`). |
| `index.ts` | The barrel the UI imports. |

## How a card game maps onto the engine

| Card-game concept | Engine concept |
| --- | --- |
| Hero (your life total) | A `Character`. It is the player's **only** registered character, so "my hero died" *is* `Player.isDefeated` — the win condition costs zero lines. |
| Creature on the board | A `Character` created when the card is played, with `power` as a custom **stat** and health as its **HP gauge**. |
| Mana | The hero's **mana gauge**. Content may never write a gauge's max, so each crystal is a `maxModifier` buff — max mana is *derived*. |
| Attack | A `cast` ability. Trading damage both ways is two `damage` actions in one list; heroes have no `power`, so they never strike back. |
| Taunt | A `restriction({ on: 'target' })` on everyone *else*: "I cannot be attacked while an ally taunts". `validTargets` enforces it, so an illegal attack is never even offered to the AI. |
| +2/+2 | A stacking buff carrying a `stat` (power) and a `maxModifier` (health). Remove the buff and both revert — the engine re-derives. |
| Enters-play effect | The card's `onPlay`, returning actions the moment the creature lands. |
| On-death trigger | An `auto` trigger on `character:destroyed` matching itself. A dying character's own triggers are collected before its buffs die, so this just works. |
| Board wipe (Consecration) | A spell with no `targeting`: it finds its own victims, so nothing is *targeted* and taunt does not apply. |
| Fatigue | `damage(hero, n)` through the pipeline when a draw finds the deck empty — a draw is a move, not a special case. |
| Winning | The engine's. A lethal blow resolves win/lose **before** any events — the match ends mid-ability, and `runLoop` returns the winner. |

## What the engine gave for free

Everything interesting in the match log is the action pipeline doing its job:
damage transforms, retaliation, simultaneous deaths, derived stat lines that
update the moment a buff lands or leaves, targeting legality, and a game that
ends the instant a hero falls. The card layer only deals cards and counts mana.

## What the engine is missing

The gaps this example had to paper over, worst first.

**1. Zone movement is real and complete for the card paths.** The deck,
hand, stack, `active` and garbage **are** engine zones (garbage is the
engine's own, **per-player** — a destroyed permanent and a spent spell land
in the same pile, owned by the player who controlled it), a permanent's
card and creature are **one entity**, and every step is a real
`zone:changed` through the pipeline:

```
deck → hand → stack → active → (garbage, for a spell | play, for a permanent)
```

So `engine.zones.zoneOf(card)` answers at every point, a draw is a move
content can answer, and casting is not a special case.

**Casting stops on the stack.** Casting puts the card on the stack and hands
priority around (`CardStack.runPriority`): every player may answer before
the top object resolves — the stack is **LIFO, always** (one array, `push` to
add, `pop` to resolve, and the top-first `objects` view is a copy; pinned by
`test/stack-lifo.test.ts`) — and an answer must be an **instant** — the symbol
from `speed.ts`, which marks a card or an activated ability. `FIREBALL`
carries it. The play-time half is `CardPlayer.takePriority` (the AI answers
with its instants, a human gets the respond bar), and the whole thing is
held to account by `test/card-game-priority.test.ts`, which asserts LIFO: a
response resolves before the spell it answered.

**Triggered abilities are respondable to as well.** The engine is pointed
at `CardStack.scheduler()`, so a trigger no longer runs when it fires — it is
queued and put on the stack at the next priority window (rule 603.3).
Everyone may answer a death trigger before it draws its card, or an
enters-play trigger before it sweeps the board. Because a trigger now waits,
anything that can raise one outside the stack — an attack, a hero power, a
turn boundary — has to open that window itself, which is `settleTriggers()`.

**Simultaneous triggers are ordered the way Magic orders them.** When several
abilities trigger at once, each player puts *their own* on the stack in the
order they choose, the active player first and then each other player in turn
order (rule 603.3b) — so the last player to stack resolves first. A player
with two or more triggers is asked (`TriggerOrderer.orderTriggers`): a human
gets a bar in the card table listing their triggers, clicking them into
order, and the AI keeps the table order. Ordering is an **input**, so the
deterministic default — the order the abilities were registered — is what an
AI or a replay gets. An answer that drops or duplicates a trigger throws
rather than silently losing a game action (`test/trigger-order.test.ts`).

What is still open:

- **Attacks and the hero power are immediate.** They are combat, not
  spells, so they skip the stack — and are not respondable. What they
  *trigger* is respondable, because the window is opened around them.

**2. There is no `summon` action.** A creature entering play is
`new Character(...)` + `engine.registerCharacter(...)` from the card layer —
outside the pipeline, with no `character:summoned` event, so "whenever a
creature enters play" cannot be written as content. (Designed in
`docs/design/01-entities.md`, not built.)

**3. The host protocol only picks characters.** `GameHost.requestTargets`
returns `Targeting { targets: Character[] }`. It cannot express "split these
five cards into two piles", "put these in an order", or "pick a card in your
hand" — the shapes a card game asks for constantly.

**4. `validTargets` builds its `AttemptContext` without the `ability`.** A
restriction therefore cannot ask "is this attempt an attack?". Taunt works by
comparing `ctx.pattern` against a shared `ATTACK_PATTERN` object.

**5. Card-layer effects are not actions.** Loot Hoarder's on-death trigger draws a
card by calling `side.draw(1)` as a side effect and returning `[]`. It cannot
be transformed, replaced, or triggered off.

**6. Turns are global.** `turn:start` / `turn:end` belong to the table, not to
a player, so "at the start of *your* turn" has to be filtered by hand.

**7. The vocabulary is closed.** `Action` is a fixed union dispatched by
`switch` in half a dozen places in `engine.ts`, and `DeclaredFn`'s node kinds
are a fixed union in `execution/declared-fn/index.ts`. A game cannot add a
noun without editing the engine.

## Game rules are data

The start of a turn is not a procedure with an untap step, an upkeep step and
a draw step written into the loop. It is a **rule set**
(`src/games/cards/rules.ts`, the game's own rules in `rules.ts`):

```ts
{ id: 'draw',
  name: 'At the start of a turn, the turn owner draws a card.',
  at: 'turn:start', affects: 'turn-owner',
  actions: [{ kind: 'draw', count: 1 }] }
```

`collectUserDecisions` applies the `turn:start` rules and nothing else. The
point is not the indirection — it is that the rules are **content**:

- **a UI can list them** (the card table has a *Game rules* panel), so a
  player reads the game instead of inferring it;
- **content can change them**: `game.rules.add(…)` replaces a rule with the
  same id, so "draw two instead" is one draw rule and not two; `remove(id)`
  takes one away. A rule the host does not understand fails loudly rather
  than being skipped. `test/card-game-rules.test.ts` drives all three.

The vocabulary is the game's (`gain-crystal`, `refill-mana`, `wake-creatures`,
`draw`) — a Magic-alike would have a land drop instead. Attaching it to the
**ability language** ("when a revealed card says …") is the next step; the
mechanism it needs is this one.

## The turn loop, and why it fights the base class

`Game`'s loop is round-based: *every* player decides, then the round resolves.
A card turn is not like that — one player acts, and each move is chosen only
after seeing what the last one did. `CardGame` reads the split as **upkeep →
main phase**: `collectUserDecisions` applies the `turn:start` rules and
returns no decisions, and `runGame` asks that side for one move at a time. `CardPlayer.decide()` is therefore dead code, and `chooseMove()` is the
real interface.

A card game asks a player **two** questions, and they are different enough to
be different methods:

| Question | Method | Answers with |
| --- | --- | --- |
| What do you do on your turn? | `chooseMove` | a `Move` — play a card, attack, end |
| Someone cast something — do you answer? | `takePriority` | `PASS`, or a **spell** to put on the stack |

Neither is a `Decision`; the engine's round-based protocol does not fit
either, which is why this example drives its own loop.
