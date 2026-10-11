# examples/card-game

A two-player collectible card game — heroes, mana crystals, a board of
creatures, taunt, battlecries, deathrattles, spells and fatigue — built on
tinyquest using **only the public engine API** (`src/engine/index.ts`).

```bash
npx tsx examples/card-game/demo.ts     # a full AI vs AI match
npx vitest run test/card-game.test.ts  # the rules, as tests
```

| File | What it is |
| --- | --- |
| `cards.ts` | The catalog. A card is data: a cost plus a stat line or an effect returning `Action[]`. |
| `combat.ts` | The board's rules as engine content — attack, taunt, summoning sickness, mana crystals, the hero. |
| `zones.ts` | Deck / hand / discard. **Card-layer only** — see "What the engine is missing". |
| `side.ts` | One player's side of the table: hero, piles, board, crystals, fatigue. |
| `game.ts` | `CardGame extends Game` — the turn loop and move execution. |
| `ai.ts` | `CardPlayer` (a `Player` with a hand) and `GreedyAI`. |

## How a card game maps onto the engine

| Card-game concept | Engine concept |
| --- | --- |
| Hero (your life total) | A `Character`. It is the player's **only** registered character, so "my hero died" *is* `Player.isDefeated` — the win condition costs zero lines. |
| Creature on the board | A `Character` created when the card is played, with `power` as a custom **stat** and health as its **HP gauge**. |
| Mana | The hero's **mana gauge**. Content may never write a gauge's max, so each crystal is a `maxModifier` buff — max mana is *derived*. |
| Attack | A `cast` ability. Trading damage both ways is two `damage` actions in one list; heroes have no `power`, so they never strike back. |
| Taunt | A `restriction({ on: 'target' })` on everyone *else*: "I cannot be attacked while an ally taunts". `validTargets` enforces it, so an illegal attack is never even offered to the AI. |
| +2/+2 | A stacking buff carrying a `stat` (power) and a `maxModifier` (health). Remove the buff and both revert — the engine re-derives. |
| Battlecry | The card's `onPlay`, returning actions the moment the creature lands. |
| Deathrattle | An `auto` trigger on `character:destroyed` matching itself. A dying character's own triggers are collected before its buffs die, so this just works. |
| Board wipe (Consecration) | A spell with no `targeting`: it finds its own victims, so nothing is *targeted* and taunt does not apply. |
| Fatigue | `damage(hero, n)` queued by the card layer when the deck runs dry. |
| Winning | The engine's. A lethal blow resolves win/lose **before** any events — the match ends mid-ability, and `runLoop` returns the winner. |

## What the engine gave for free

Everything interesting in the match log is the action pipeline doing its job:
damage transforms, retaliation, simultaneous deaths, derived stat lines that
update the moment a buff lands or leaves, targeting legality, and a game that
ends the instant a hero falls. The card layer only deals cards and counts mana.

## What the engine is missing

The gaps this example had to paper over, worst first.

**1. Zones only exist for characters, and only two of them.** The engine owns
`play` and `graveyard`, both `Set<Character>`. A card game has a deck, a hand,
a discard pile, an exile pile, and *temporary* piles conjured mid-effect. So
`zones.ts` exists, and everything in it is invisible to the engine:

- there is no `move(object, from, to)` **Action**, so a pile change cannot be
  intercepted by an `ActionTransformer` — the natural home for "if a card
  would go to your graveyard, exile it instead";
- a pile change emits no event, so nothing can trigger off it;
- the objects in those piles are `Card`s, not engine entities, so nothing
  else in the engine can see or reason about them.

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

**5. Card-layer effects are not actions.** Loot Hoarder's deathrattle draws a
card by calling `side.draw(1)` as a side effect and returning `[]`. It cannot
be transformed, replaced, or triggered off.

**6. Turns are global.** `turn:start` / `turn:end` belong to the table, not to
a player, so "at the start of *your* turn" has to be filtered by hand.

**7. The vocabulary is closed.** `Action` is a fixed union dispatched by
`switch` in half a dozen places in `engine.ts`, and `DeclaredFn`'s node kinds
are a fixed union in `execution/declared-fn/index.ts`. A game cannot add a
noun without editing the engine.

## The turn loop, and why it fights the base class

`Game`'s loop is round-based: *every* player decides, then the round resolves.
A card turn is not like that — one player acts, and each move is chosen only
after seeing what the last one did. `CardGame` reads the split as **upkeep →
main phase**: `collectUserDecisions` runs the active side's crystal/wake/draw
step and returns no decisions, and `runGame` asks that side for one move at a
time. `CardPlayer.decide()` is therefore dead code, and `chooseMove()` is the
real interface.
