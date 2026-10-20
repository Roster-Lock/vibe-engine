# The Ability Language — prototype v0.2 (actions and triggers)

> The player-facing surface of TinyQuest (docs/GOAL.md): English-shaped text
> that compiles into the engine's content model. This document is the
> **current** grammar — deliberately small. Transformations, action
> transformers, zones, costs, controller changes and creature summons are
> **not** in this version; the grammar is shaped so they can slot in
> without breaking what is here.
>
> Implemented in `src/english/`; exercised through the Create page in the UI
> and by `test/english.test.ts`.

## What one document is

A document (what the player types in the editor) is one or more **manual
abilities** plus the **buff definitions** those abilities reference. The
simplest document:

```
Ability Sacrifice
Destroy this.
Heal all other ally characters for 25.
```

An ability is a heading line followed by **effect sentences** (each ends with
`.`). A `Buff` line declares a buff the ability adds — its definition travels
*with* the ability (deduplication into a shared library is a later milestone):

```
Ability Soul Rot
Add Frailty to target enemy character.

Buff Frailty
```

Each ability compiles to one engine `cast` (manual) ability. A sentence that
picks a target — `target …` — becomes the ability's targeting pattern; the
rest of the sentence (and any `all …`/`this …` phrases) resolve when the
ability fires. Sentences written **before any heading** form an implicit
ability named `Untitled`.

A `#` at the start of a line is a comment. Blank lines are ignored. Keywords
are case-insensitive; ability and buff names keep their case.

### Imports

Content can import a named buff from a host-provided module:

```
import Frailty from "./buffs/Frailty.buff"

Ability Venom Strike
Add Poison to target enemy character.
```

`compileDocument` does not read files. The host supplies `resolveImport(path,
name)`, keeping browser imports, sharing, and sandboxing under application
control. There are no language-level built-in buffs or characters. The same
module boundary is intended for character definitions when character creation
and summoning actions are added.

## Nouns — character phrases

Every effect that hits characters names them with one of these phrases:

| Phrase | Means | Compiles to |
| --- | --- | --- |
| `this` | Whatever is using the ability, whatever kind of thing it is | `ctx.self` |
| `target character` | The player picks one character | the ability's `targeting` |
| `target enemy character` | The player picks one enemy | `targeting: { who: 'enemy', count: 1 }` |
| `target ally character` | The player picks one ally | `targeting: { who: 'ally', count: 1 }` |
| `all characters` | Every character in play | engine `validTargets({ who: 'any' })` |
| `all enemy characters` | Every enemy of the user | `validTargets({ who: 'enemy' })` |
| `all ally characters` | Every ally, **including** the user | `validTargets({ who: 'ally' })` |
| `all other ally characters` | Every ally **except** the user | above minus `self` |
| `all characters owned by you` | Everything the user's player controls | `who: 'any'` + owner match |
| `all other characters` | Every character except the user | above minus `self` |
| `all characters owned by opponents` | Everything any opponent controls | owner match on enemy players |

Rules:

- `character` and `characters` are both accepted, and after `this` the noun
  is **optional**: `this` alone names whatever is using the ability, whatever
  kind of thing it is. A group still needs its noun — "all" does not say all
  *what*.
- **Counts are digits.** `1 or more`, not `one or more`; a spelled-out
  number gets a diagnostic naming the digit.
- An ownership clause (`owned by you` / `owned by opponents`) may follow any
  `all …` group: `all characters owned by you`, `all enemy characters owned by
  opponents`.
- Only one *kind* of `target …` sentence may appear in an ability (the engine
  gives a manual ability one targeting pattern). Repeating the same kind is
  fine — every sentence then reads the same picked character.
- `this` never takes a noun (`this character` is an error), an ownership clause or a `with` clause.
- A character phrase never starts a sentence by itself — actions come first
  (see below) except for win/lose-the-game, which is subject-first English.

### Filters: the `with` clause

A phrase may be narrowed by conditions after the noun (before or after an
`owned by` clause, at most one of each):

```
Heal all other ally characters with hp < 10 for 25.
Destroy all characters owned by you with hp <= 0.
Deal 3 damage to all enemy characters with poison.
Destroy all enemy characters with hp < 10 and thorns.
Destroy all enemy characters with (poison or thorns) and hp <= 40.
```

| Condition | Means | Compiles to |
| --- | --- | --- |
| `with hp < 10` | current HP under 10 | gauge-current comparison at cast time |
| `with hp <= 10` / `> 10` / `>= 10` / `= 10` | the other comparisons | same |
| `with mana >= 5` | current mana check | `c.mana.current` |
| `with poison` | the character currently has that buff | `c.hasStatus(<buff id>)` |

`hp` and `mana` are only the default gauge words. Gauges belong to a game, so a host
passes the ids its game declares (`CompileOptions.gauges`) and those are what `with`
and `incoming <gauge> loss` accept.

Rules:

- Conditions combine by their separators: `and` requires
  **both** sides, `or` accepts **either**. Parentheses group expressions, and
  `not` negates one expression. `and` binds tighter than `or`:
  `with poison or thorns and hp <= 40` means `poison OR (thorns AND hp <=
  40)`. There is **no limit** on how many conditions a clause carries, and
  a comma is never a joiner — it only separates a condition from its effect.
- Conditions are retained as a recursive expression tree, so grouped filters
  can be displayed unambiguously as math in the editor.
- `<buff>` in a buff condition resolves exactly like `Add <buff>` — declared
  in the document or built in (an unknown name is an error), and a buff used
  only by a filter still counts as used (no "unused" warning).
- Buff names inside conditions may not contain `and`, `or`, `for`, `owned`
  or `with` (they end the name).
- On a `target …` phrase the conditions become part of the targeting pattern —
  the player can only pick a character that satisfies them.
- **Sentences run as ordered steps.** A multi-sentence ability resolves one
  sentence at a time — its effects land (gauges flush, deaths resolve, queued
  triggers run) before the next sentence's targets are chosen — so later
  sentences see the earlier ones' effects:

  ```
  Add Poison to all enemy characters.
  Destroy all enemy characters with poison.   # sees the poison — the board dies
  ```

  A single-sentence ability keeps the engine's one-shot apply (the exact
  behavior of a hand-written `cast`).
- Buff references are shown with the buff's display spelling regardless of how
  they were typed — `Add toxic tentacles` previews as `Add Toxic Tentacles`.
  Buff names may be several words; in the editor, hover a buff name to see
  what it does, and Ctrl/Cmd+Click jumps to its `Buff` declaration.

## `Target … as …` — named picks

An ability may name what it picks, and ask for more than one kind:

```
Ability Life Drain
Target 1 enemy character as victim and 1 different character as benefactor.
Deal 18 damage to the victim.
Heal the benefactor for 18.
```

| Clause | Means |
| --- | --- |
| `<n> <characters> as <name>` | pick n of them, called `<name>` |
| `<n> different <characters> as <name>` | …and not any earlier binding's pick |
| `the <name>` | that binding, anywhere in the body |

Names rather than positions, because `the victim` cannot be misread the way
"the first targeted character" can — and because one ability may then ask
for several *different* things, which a single `target …` phrase cannot.

Every binding goes in **one** `Target …` sentence, joined with `and`.

Two rules worth knowing:

- **Distinctness is per ability.** If any binding says `different`, every
  pick differs. Partial distinctness across three or more bindings is not
  expressible.
- **Each binding is checked against its own filter.** The player is offered
  anything legal for *any* binding — the victim may be an enemy, the
  benefactor anyone — and a pick handed to a binding it does not satisfy is
  dropped rather than acted on. So handing an ally to `victim` above drains
  nobody.

The older single-phrase form still works: `Deal 40 damage to target enemy
character.` picks one thing and needs no name.

## `Available while …` — when an ability can be used

```
Buff Charged
Fading 0.

Ability Counterstrike
Available while this has Charged.
Deal 100 damage to target enemy character.
```

One clause per ability, taking the same conditions as `if`. Without one,
the ability is always usable.

An ability "enabled by a trigger" is written this way rather than as
something a trigger switches on: the trigger changes the board (it applies
the buff), and the condition mentions that change. Nothing has to be kept
in sync, no enabling event can be missed, and the answer is the same after
a reload or in a replay.

It also keeps a **stable binding**. The ability never leaves its owner's
kit, so one hotkey — or one gamepad button, where there are far fewer —
holds its slot the whole time and merely lights up. An ability that
appeared and disappeared would shuffle every slot around it.

A host asks `engine.canUse(owner, ability)`, which answers `usable` plus a
reason: `unavailable` (the condition does not hold), `restricted` (a
`cannot activate` restriction, naming which one), or `no-targets` — the
last being a **hint** the engine does not refuse, since an ability that
resolves its own groups legitimately has nothing to pick.

## Conditions — `If …,`

An effect may be gated by a condition, checked **immediately before that
effect runs** — so in a multi-sentence ability it sees what the earlier
sentences did:

```
If there are 2 or more enemy characters, deal 5 damage to all enemy characters.
If any enemy character has Poison, destroy all enemy characters with Poison.
If every enemy character has Poison, you win the game.
If this has hp < 10, heal this for 20.
```

| Form | True when |
| --- | --- |
| `if there are <count> <characters>` | that many exist right now |
| `if any <characters> has <condition>` | **one of them** satisfies it |
| `if every <characters> has <condition>` | **all of them** satisfy it |
| `if this has <condition>` | the ability's own owner satisfies it |

`any` and `every` are the array vocabulary on purpose — they are what the
same operation is called in code, and they make "one of them" versus "all
of them" impossible to misread.

The condition after `has` is the same grammar as a `with` clause. **A comma
ends it**, because the comma separates the condition from the effect; join
conditions with `and` / `or`:

```
If this has hp < 10 and mana > 5, heal this for 20.
```

An `If …,` clause also works inside a trigger's effect:

```
when a character is destroyed then if this has hp < 150, heal this for 5.
```

### Comparing numbers

A condition can compare two amounts — a roll, a stored name, a formula — with
`<`, `<=`, `>`, `>=` or `=`, and join comparisons with `and`:

```
If that value >= 15, deal 50 damage to this.
If that value >= 5 and that value <= 8, deal 7 damage to this.
If AttackerRoll > DefenderRoll, deal 10 damage to this.
```

There are no word forms (`is higher than`, `is 10 or more`). A count phrase
(`2 or more`, `2 to 5`) stays for counting *things* — triggers, `if there are`,
`Repeat … times`, and roll-table lines.

## `You may …` — optional effects

```
You may deal 10 damage to this.
You may if there are 3 or more enemy characters, destroy all enemy characters.
```

The controller is asked when the effect runs, and a no skips just that
effect — the rest of the ability still happens. Asked **after** any
`If …,` condition, so you are never asked about something that could not
have happened.

## `Repeat …:` — loops

```
Repeat if you choose: reveal the top card of your deck and lose 1 life.
Repeat up to 3 times: heal this for 2.
Repeat while any enemy character has Poison: deal 1 damage to all enemy characters.
Repeat up to 3 times while there are 2 or more enemy characters, if you choose:
  deal 1 damage to all enemy characters.
```

Three independent clauses, any subset, each with its own word so nothing is
inferred from position:

| Clause | Does |
| --- | --- |
| `<count> times` | how many — an ordinary **count phrase** |
| `while <condition>` | the pure gate, same conditions as `if` |
| `if you choose` | asks the controller, once the count's floor is met |

Each iteration: the cap, then the condition, then the question, then the
effect. **The condition gates the question** — a player is never asked
about an iteration that could not have happened.

### The count's lower bound is mandatory

This is what separates *"you may do this, repeatedly"* from *"do this, then
you may do it again"* — and the second is what most cards mean:

| Written | Does |
| --- | --- |
| `Repeat if you choose:` | asks first; a no means **nothing happens** |
| `Repeat 1 or more times if you choose:` | does one, **then** asks — Magic's Ad Nauseam |
| `Repeat 3 or more times if you choose:` | does three, then asks |
| `Repeat 2 to 4 times if you choose:` | does two, then asks up to four |
| `Repeat up to 3 times if you choose:` | asks from the first, at most three |
| `Repeat 2 times:` | exactly twice, no question |

The floor means the player is **not consulted** — not that the effect
applies regardless. A `while` condition still gates a mandatory iteration.

A parity (`an even number of`) is rejected here: a repeat counts
iterations, and "an even number of times" bounds nothing.

Each iteration's effect **lands before the next is decided**, so both the
condition and the player see what the previous one did.

A `repeat` with **no clause at all** is an error: it would never stop. One
bounded only by its condition gets a warning, since it ends only if the
effects turn the condition false.

## Actions (this version)

| Sentence | What it does |
| --- | --- |
| `Deal <n> damage to <chars>.` | Damage the characters' HP by `n`. |
| `Heal <chars> for <n>.` | Heal the characters by `n`. |
| `Destroy <chars>.` | Destroy the characters (engine destroy action — deferred, resolved with the batch). |
| `Add <buff> to <chars>.` | Apply a buff to each character. `<buff>` must be declared in the document or built in. |
| `Remove <buff> from <chars>.` | Remove the buff (by its id) from each character. |
| `Toggle <buff>.` | Flip the buff on the ability's owner — on becomes off, off becomes on. |
| `Toggle <buff> on <chars>.` | Flip it on each character, each by its own state. |
| `You win the game.` / `You lose the game.` | The ability user's player wins / loses. |
| `All players win the game.` / `All players lose the game.` | Every registered player wins / loses (all-at-once resolves as a draw or last-team-standing per the engine). |

`win` and `lose` are the only forms (`You win`, `All players win`). `n` is a non-negative number.

## Action modifiers

A `Buff` may change what happens to actions flowing past its wearer,
instead of making something happen:

```
Buff Rage
Outgoing damage is increased by 5.

Buff Iron Hide
Incoming damage is capped at 50.

Buff Berserk
Outgoing damage has a 25% chance to be multiplied by 3.

Buff Ward
Incoming damage is prevented.
```

**Declarative, not imperative.** A modifier is a standing rule about what
happens, not something that happens — "incoming damage is capped at 50"
holds for as long as the buff is attached, where "cap incoming damage"
would read like a one-off instruction.

Two sentence frames:

```
<subject> is <rewrite>.
<subject> has a <n>% chance to be <rewrite>.
```

`<subject>` is `outgoing|incoming damage|healing`, optionally narrowed by
`from <characters>`. **`outgoing`** is what the wearer does to something
*else* — a self-inflicted cost is not outgoing damage — and **`incoming`**
is what is done to the wearer.

**`damage` and `healing` mean the target's *life* gauge** — the gauge that
thing declared as its life, which is `hp` for a fighter. The words never
name `hp` themselves, so the same sentence keeps meaning the right thing
for anything else that has a life: a card game's planeswalker takes
"damage" on its `loyalty` without a word of the ability changing. Something
that declares no life gauge at all has nothing `damage` can claim.

Every other gauge is named outright — `<gauge> gain|loss`:

```
Buff Iron Will
Incoming mana loss is prevented.

Buff Mana Ward
Incoming mana gain is doubled.
```

`loss` is the named-gauge spelling of `damage`, `gain` of `healing` — the
same two shapes of change, aimed at one gauge you name instead of at
whatever counts as life. So a mana drain is a `mana loss`, not "damage",
and a modifier written about `damage` leaves it alone.

`from <characters>` narrows by whoever is on the *other side* of the
action from the wearer — who an outgoing action is aimed at, or who an
incoming one came from:

```
Buff Iron Hide
Incoming damage from enemy characters is reduced by 3.

Buff Predator
Outgoing damage from ally characters is increased by 5.
```

It takes the same bare group form as a trigger's subject (an adjective, an
`owned by`/`with` clause, no quantifier of its own: `from enemy characters`,
`from characters owned by you with hp < 10`). An incoming action whose
cause is not a character — a buff ticking with no caster, say — never
satisfies a `from` clause.

| `<rewrite>` | Does |
| --- | --- |
| `increased by <n>` | adds to the change's magnitude |
| `reduced by <n>` | subtracts from it |
| `multiplied by <n>` | scales it |
| `doubled` / `halved` | multiplied by 2 / by 0.5 |
| `capped at <n>` | a ceiling on the magnitude |
| `prevented` | the action lands, changing nothing |
| `redirected to <gauge>` | the realized change lands on that gauge instead, same character |

Four things worth knowing:

- **Amounts apply to the magnitude of the change**, never to the resulting
  value, so "increased by 5" is five more damage without you thinking about
  signs.
- **A chain of modifiers composes as plain arithmetic, and the magnitude
  may go negative partway through.** "Reduced by 10" then "increased by
  5" on 8 damage is `8 − 10 + 5 = 3`, not 0 — the reduction overshooting
  past zero doesn't stop the later increase from counting. Only the
  *final* result is floored at zero, once, when the change actually
  reaches the character — "reduced by 50" then "increased by 5" on 10
  damage nets to −35 by the arithmetic, which still lands as 0 damage, not
  35 healing.
- **Stacking needs no arithmetic.** Every attached instance's modifier runs,
  so a buff with "+5" gives +15 at three stacks on its own.
- **A chance is rolled per action**, from the engine's seeded PRNG, so a
  replay of the same seed rolls the same. Draws come from the same stream as
  the trigger shuffle, so adding a chance modifier shifts every later draw.

Damage or healing is decided once, from how the action was declared (a
`Deal`/`Heal` sentence, say), not re-decided from the running change at
each modifier — so a reduction overshooting into negative territory
mid-chain is still seen as damage by the next modifier, not as healing.

```
Buff Mana Shield
Incoming damage is redirected to mana.
```

`redirected to <gauge>` moves the *realized* change onto a different gauge
of the same character — "incoming damage is redirected to mana" means a
hit drains mana instead of HP. A no-op when the character has no such
gauge, or when it's the gauge the action was already going to hit.
Combine with a named-gauge subject to redirect only one kind of loss
(`incoming mana loss is redirected to hp.`), rather than all incoming
damage.

Redirecting changes what the action *is* for every modifier after it: once
a hit lands on mana it is a mana loss, so a `damage` modifier further down
the stack no longer claims it, while a `mana loss` one now does. Modifiers
that already ran are unaffected — their arithmetic is in the amount that
got redirected.

A modifier belongs under a `Buff` heading: it is the attachment that
decides whose actions it rewrites.

## Moving, revealing and scrying cards

```
Move the top 3 cards from your deck to your hand.
Move a creature card from your garbage to play.
Move a random card from target opponent's hand to your stolen zone.
Move a card castable by target opponent to its owner's garbage.
Reveal all cards castable by target opponent.
Scry(you, 3).
```

`Move <cards> from <zone> to <zone>.` — **the cards**: `the top card`, `the top 3 cards`,
`the bottom card`; `a card`, `2 cards` (the caster picks); `a random card`; `all cards`;
`creature` or `spell` may go before `card`. **A zone** is `your hand`, `its owner's garbage`
(or `their`), `target opponent's hand`, `all opponents' hand`, `all players' hand`, or a
shared zone written bare (`play`, `the stack`). A custom zone takes `zone` after it.

- **Some zones only hold their owner's cards.** A hand, a deck and a garbage refuse a card
  that belongs to someone else, so you cannot move an opponent's card to your hand. Thoughtsteal
  moves it to a zone made for the purpose (`your stolen zone`): only you see it, and you may
  cast from it. When it is spent it goes to its **owner's** garbage.
- `castable by <player>` replaces `from <zone>`: everything that player could cast now,
  wherever it is.
- A card moved from the stack to `play` takes its stack object with it, so it does not
  resolve; `When this enters play from stack` fires.
- `Scry(player, X)`: the player looks at the top X cards of their deck, puts any number on the
  bottom, and puts the rest back on top in the order they choose.
- **The generic form of Scry**: `Move any number of the top 3 cards from your deck to the bottom of
  your deck and the rest on the top of your deck in the order of your choice.` `any number of`
  names a pool and you pick from it; `the top of` / `the bottom of` place the cards in an ordered
  zone; `in the order of your choice` lets you order them; `and the rest …` places the ones you did
  not pick.
- `Surveil(player, X)`: the same, but the cards not kept go to the player's garbage instead of the bottom.

## Temporary zones and piles

```
Move the top 5 cards from your deck to the temporary zone Pool.
Reveal all cards from Pool.
Target opponent separates Pool into Fact and Fiction.
You choose Fact or Fiction.
Move all cards from the chosen pile to your hand.
Move all cards from the other pile to your garbage.
```

A temporary zone is made where it is first named (`the temporary zone Pool`) and gone when the
card finishes resolving; anything still in it goes to its owner's garbage. `separates` has the
named player pick which cards make the first pile (the rest make the second). `the chosen pile` and
`the other pile` are the two piles of the last `You choose …`. "Target opponent" is one player for
the whole card.

## Counters, declared zones, and Suspend

```
Zone Suspend (per-player, public)
When your turn starts then remove a counter from all cards in this zone.
When your turn starts then cast all cards with no counters from this zone without paying their cost.

Card Ancestral Vision
{ "cost": 6, "type": "spell" }
Draw(you, 3).
Suspend: Move this to the Suspend zone with 2 counters on it.
```

- `Zone <name> (options)` **declares** a zone: `per-player` or `shared`; `public`, `owner` or
  `hidden`; `ordered`; `owner-only`. Its lines are the zone's standing rules.
- `Move this to the Suspend zone with 2 counters on it.` puts counters on a card;
  `Remove a counter from <cards> in <zone>.`; `all cards with no counters`.
- `<Name>: <sentence>` on a card is an ability the card has while it is in its owner's hand.
- `Cast <cards> from <zone> without paying their cost.` casts cards for the zone's owner.

## Rules: cards that are always in force

A card of `"type": "rule"` is a standing rule of the game. It has no cost and is never played. Every
player has their own copy, so "you" and `this` are the rule's owner and their hero, and every line says
when it applies:

```
Card Mana
{ "type": "rule" }
When your turn starts then {
  If this.mana.max < 10 {
    Increase mana maximum of this by 1.
  }
  Set mana of this to this.mana.max.
}

Card Summoning Sickness
{ "type": "rule" }
When a character owned by you enters play then Add Summoning Sickness to it.
```

- `When your turn starts|ends then …` runs on its owner's turns; `When a turn starts|ends then …` runs
  on every turn, for each owner.
- `When a character [owned by you] enters play then …` — `it` is the character that arrived. `it` means
  nothing outside a rule.
- Braces group several steps into one ability: `When your turn starts then { … }`. They run in order, so
  the maximum grows and then the mana refills to it. `If <condition> { … }` checks its condition once,
  for everything inside it; `If <condition>, <step>.` still guards a single sentence.
- A rule with the name of one a player already has replaces it, for that player.
- `Set <gauge> of <characters> to <amount>.` writes a gauge's current value (a number or a formula; a
  gauge's maximum is `<gauge>.max`).
- `Increase <gauge> maximum of <characters> by <amount>.` raises a gauge's maximum. The maximum is never
  written, it is derived from buffs, so each use is its own unremovable +N and the current value does not
  move. A ceiling is an `If` block around it.

## Contests: winners and losers

A contest is a function of a **list of players**: it receives them, and what comes out is who won,
who lost, or that it was a tie — `(players) => { winners, losers, isTie }`. It is stated the way a
rulebook states it:

```
Contest Rock Paper Scissors
Players 2.
All players commit Rock, Paper or Scissors face down.
When they are ready, reveal.
If all players committed the same option, it is a tie.
If player 1 committed Rock and player 2 committed Scissors, player 1 win and player 2 lose.
If player 1 committed Scissors and player 2 committed Paper, player 1 win and player 2 lose.
If player 1 committed Paper and player 2 committed Rock, player 1 win and player 2 lose.
Otherwise player 2 win and player 1 lose.

Card Showdown
{ "cost": 3, "type": "spell" }
You and target opponent play Rock Paper Scissors.
Draw(the winners, 2).
Deal 5 damage to all characters owned by the losers.
```

- **The list:** `You and target opponent play …`, `All players play …`, `All opponents play …`. "Player 1" is the
  first of the list. If the contest states a player count the list must match, or the card fails to resolve.
- **Commit/reveal:** a contest has no options declaration. Its options are the names in the ordinary
  `All players commit … face down.` sentence, which must be followed by `When they are ready, reveal.`
  (an invalid option loses the game, as with any commitment). Options are matched exactly, capitals included.
- **The rules** are read in order and the first that fits decides: a tie (`If all players committed the same option, it is a tie.` — nobody wins or loses), an
  `If player N committed X and …, player N win and player N lose.` rule, or `Otherwise …`.
  The results use the same `win` / `lose` as `You win the game.` (`draw` is left for cards.)
  A `Contest` is a section of the ordinary parser — it can sit in an ability document or a card document,
  its commit and reveal are the usual choice sentences, and a sentence above it can play it by name. A mistake
  is reported on the word that caused it.
- **After it**, `the winners` and `the losers` are the players the rules named
  (`Draw(the winners, 2).`, `… owned by the losers`).

## Choosing, committing and voting

Two verbs, and the difference is *when* the answers are seen:

```
Starting with you, each player chooses a card from their hand.            # open: round the table, each sees the earlier answers
All players commit a card from their hand face down.  # sealed: all at once
When they are ready, reveal.
All players move the card they committed to their garbage.
```

`choose` happens in the open, one player after another from the caster.
`commit` is placed face down by everyone at once and is checked at the reveal. An
open choice between names **says who goes first**, by opening with an order:

```
Starting with you, each player chooses Attack or Retreat.
Ending with you, each player chooses Attack or Retreat.
Starting with a random player, each player chooses Attack or Retreat.
In reverse order, each player chooses Attack or Retreat.
```

A choice between **names** is a vote, and `votes` counts it:

```
Starting with you, each player chooses Attack or Retreat.
If votes for Attack = the highest vote, deal 10 damage to this.
If votes for Attack > votes for Retreat, deal 5 damage to this.
Deal the lowest vote damage to this.
```

`votes for <Option>` is that option's count; `the highest vote` and `the lowest
vote` are the biggest and smallest count among the options (an option nobody chose
counts 0). Ties are the rules text's to settle: `= the highest vote` is true for the
winner **or any option tied with it**; `>` another option is a strict win. A sealed
vote can only be counted after its reveal.

**`each` is one at a time, `all` is all at once.** `Each player chooses …` goes round the
table (so it says who goes first), and `All players commit …` is everyone together. The
other sentences about every player — `All players move …`, `play`, `create`, and
`all players'` / `all opponents'` for their zones — are simultaneous, with the base
form of the verb.

## Defining a keyword

A card document can add words to the vocabulary **in the language itself**. A keyword is a name for some
lines of the language, and those lines are also its explanation — there is nothing else to write.

```
Keyword Scorch
Deal 2 damage to all enemy characters.

Card Fire
{ "cost": 1, "type": "spell" }
Scorch.
```

A keyword that takes arguments names them in an optional JSON header, and writes each one where it goes:

```
Keyword Drain
{ "parameters": ["amount"], "cardKinds": ["spell"] }
Deal amount damage to target enemy character.
Heal this for amount.

Card Siphon
{ "cost": 1, "type": "spell" }
Drain(6).
```

- **Meaning:** `Drain(6).` means the lines, with `amount` replaced by `6`. The card prints the keyword, not what it
  means, and the lines join the card's own — so every rule about a card's effects (a spell has no `When` trigger, a
  creature's one-shot effect needs its event) applies to them. On hover a player reads the lines themselves.
- **Header (optional):** `parameters` — names written in the lines where each argument goes — and `cardKinds`
  (`"spell"` and/or `"creature"`). By default a keyword whose lines start with `When` is for creatures and any other
  is for spells. There is deliberately no `summary`: the English is the explanation.
- **Checked once, where it is defined:** the lines are compiled with every parameter standing for `1`, and a mistake
  is reported on the line with the keyword named. A keyword is one word and cannot reuse a built-in name.
- **What it cannot be:** a keyword is text, so it can only say what sentences can say. `Weight` and `Fading` stay built
  in because they set properties of a buff (they are not sentences).

## Creatures that effects make

```
Creature Giant Golem
{ "type": "creature", "creatureConfig": { "power": 6, "health": 6 } }
Taunt.

Card Golem Gambit
{ "cost": 3, "type": "spell" }
You and target opponent play Rock Paper Scissors.
The winners create a Giant Golem.
```

`Creature <name> <power>/<health>` defines a creature that is not a card: it has no cost and is
never in a deck. Its lines are a creature's (keywords, `When this is destroyed then …`, the entry
exceptions). `Create a Giant Golem.` (or `The winners create …`, `All players create …`) makes a
new one in play under each named player's control, and it arrives like any creature, so the rules for
entering play (summoning sickness) apply.

## Declaring a buff

```
Buff <Name>
Weight 2.
Fading 2.
When the turn starts then deal 3 damage to this.
```

A buff heading is just its name. Its properties are **keyword lines** under it:

| Keyword | Means |
| --- | --- |
| `Weight <n>.` | status sort weight (defaults to `1`) |
| `Fading <n>.` | each instance starts with `n` counters; every turn end removes one, and an instance that cannot is destroyed |

There is no `stacks` option: **every `Add` is its own instance**, and the
order they were added in is kept — `(+1)(x2)(+1)` is not `(+1)(+1)(x2)`.

`Fading` is not an engine concept: it lowers to an ordinary triggered
ability on the buff. At each turn end the instance removes a counter, and
**if it cannot remove one, it is destroyed** — so `Fading 0.` goes at the
first turn end, and `Fading 1.` waits a full turn first. Each instance fades
on its own counters.

A declared buff compiles to an engine `BuffDef`. A buff with **sentences of
its own** carries them as triggered abilities — one trigger per event the
sentences fire on:

```
Buff Regeneration
When a turn starts then heal this for 5.
```

Accepted prefixes today are `When a turn starts then` and `When the turn
ends,`. A buff sentence with **no** prefix is an error. Richer payloads
("when it expires…", stat rewriting) arrive with the full trigger
milestone.
The language has no built-in buffs or characters. A host may supply content
through an import resolver or an explicit dictionary.

## Math expressions

A formula may stand anywhere a plain number is expected — a bare number is
just the trivial case of the same grammar:

```
Deal (this.hp / 10) damage to target enemy character.
Heal target ally character for (2 + 3).
Incoming damage is reduced by (1 + 2).
Outgoing damage has a (this.mana / 2)% chance to be doubled.
Destroy all enemy characters with hp < (this.hp / 2).
```

Numeric formulas use a small safe expression language: property access,
array indexing, arithmetic, and the sigma sum operator.

There is **no `%` operator**: `%` is reserved for percent, which card text
needs far more often, and a `%` meaning remainder would be misread as a
percentage every time. Parity — the only thing remainder served — is
written as words (`an even number of …`).

```
Σ(i = 0 to events.length - 1, events[i].damage) + heroes[1].power * 2
```

`Σ(values)` remains a shorthand for a numeric array, while the explicit form
binds the current index and makes the bounds visible:
`Σ(i = 0 to events.length - 1, events[i].damage)`. The editor renders this as
bounded LaTeX; the source remains ordinary Unicode text so it is easy to edit
and share.

A formula reads `this` as the ability's owner — every gauge by id (`this.hp`,
`this.mana`, and any custom gauge — its current value), a gauge's maximum and minimum as
`this.hp.max` / `this.hp.min`, and `this.speed`. `%`-wrapped values (`doubled`, custom named
stats) aren't reachable yet — only what's listed above.

A property-access dot needs **no space on either side** (`this.hp`, not
`this . hp` or `this.hp .mana`) — that's what tells it apart from the period
ending the sentence it's inside.

## Triggers — `when … then …`

A trigger watches for something happening and fires. One sentence:

```
when <count>? <subject> <verb> then <effect>.
```

```
when 2 or more enemy characters are destroyed then deal 5 damage to all enemy characters.
when a character is destroyed then deal 3 damage to all ally characters.
when this survives then heal this for 5.
when characters owned by opponents with hp < 10 survives then Add Mark to all enemy characters.
```

### The subject is an ordinary character phrase

Everything the noun phrases above can say, a trigger's subject can say —
adjectives, `owned by`, and `with …` filters all apply to the
**triggering** characters, deciding which of them count:

```
when 2 or more enemy characters owned by opponents with hp < 10 are destroyed then …
      └ count ┘ └──────────────── subject ────────────────────┘ └verb┘
```

Three subject shapes:

| Written | Fires | Means |
| --- | --- | --- |
| `<count> characters` | once per **batch** | the counted group |
| `a character` | once per event | any one character |
| `this` | once per event | the ability's own owner |

### Count phrases

A count phrase makes it a **batch** trigger: it listens to the engine's
`:batch` event, which fires once per batch carrying the individual events —
which is the only way a count is answerable at all.

| Count phrase | Means |
| --- | --- |
| `1 or more` (or a bare plural) | any batch — fires even for a single event |
| `<n> or more` | the batch held `n` or more |
| `<n> to <m>` | `n` through `m`, inclusive |
| `<n> or less` | `n` or fewer (1..n in practice: a batch of zero never fires) |
| `an even number of` / `an odd number of` | a **parity**, not a range |

**Written order is not evaluation order.** The subject's filter runs first,
per triggering character; the count then gates the *filtered* set. So "when
2 or more enemy characters are destroyed" does not fire when two characters died but
only one was an enemy.

### Event verbs

| Verb | Event | Singular |
| --- | --- | --- |
| `are destroyed` | `character:destroyed:batch` | `is destroyed` |
| `survives` | `character:survived` (`:batch` with a count) — took damage and lived | (same word) |
| `is damaged` | `gauge:changed` on the life gauge, downward | (same words) |
| `are healed` | `gauge:changed` on the life gauge, upward | `is healed` |

Damage is **not its own event** in this engine — it is the life gauge
losing value (see `src/engine/events.ts`) — so `is damaged` is a gauge
event plus a direction. Nothing else about it is special.

As with `Deal`/`Heal` and a `damage`/`healing` modifier, the gauge is read
from the triggering entity's own declaration, so `is damaged` fires on
`hp` for a fighter and on `loyalty` for something that declares that as
its life. A loss on any *other* gauge is not damage and does not fire it.

### Zone movement — `enters` / `leaves`

The engine's **zones** are game data (`src/engine/zone.ts`,
`docs/design/15-zones.md`): the engine ships `play` and `garbage`, and a
game declares its own — a deck, a hand, a stack, the `active` slot a card
resolves in. Movement between zones is one event (`zone:changed`, with an
optional `from`), and the language names both ends:

```
when <count>? <subject> enters <zone> [from <zone>] then <effect>.
when <count>? <subject> leaves <zone> [to <zone>]   then <effect>.
```

| Written | Matches |
| --- | --- |
| `enters play` | arriving in `play`, **whatever** it came from — including a first placement, which has no `from` |
| `enters play from active` | arriving in `play` from `active` (a card that resolved normally) |
| `enters play from stack` | arriving in `play` straight off the stack — a card cheated past resolution |
| `leaves play` | leaving `play`, **whatever** the destination |
| `leaves play to garbage` | leaving `play` for the garbage — what dying *is* |

Without the `from`/`to`, the trigger fires no matter what the other end
was; that is the game-agnostic half, and it is why "enters play" does not
require a game to name its paths. An article is allowed
(`enters a garbage`). `enters` and `leaves` are the only forms, for a
single subject and a counted one alike (`2 or more characters enters play`).

Zone names come from the **host**, exactly like buff names: the editor is
handed a `ZoneDictionary` (`src/english/zone-dictionary.ts`) with the
engine's zones always known, so `enters nowhere` is an `unknown-zone`
diagnostic listing the ones that exist, and completion offers them after
`enters`/`leaves` and after `from`/`to`.

A zone phrase lowers to the engine's ordinary `zone:changed` trigger, so it
needs no new event and composes with everything else a trigger does —
counts, filters, `the source` (empty here: a move's cause is not in the
event), and `:batch` gating.

Two related readings are worth keeping distinct:

- `when this is destroyed` is `character:destroyed` — "destroyed by the rules".
- `when this enters a garbage from play` is the same *mechanical* move,
  expressed in zones. A discard from hand reaches the garbage without
  dying, and a bounce leaves play without dying; the zone phrasing can say
  all three precisely, while `is destroyed` says only the first.

### `the source`

Inside a trigger, `the source` is whoever caused the event: the character
that dealt the damage, applied the buff, moved the card.

```
Buff Thorns
when this is damaged then deal 8 damage to the source.
```

It is deliberately generic rather than `the attacker` — the same word works
for every event, and a second noun meaning the same thing for one event
kind would be a distinction with nothing behind it.

`the source` takes no noun, like `this`: it is always the **character** that
caused the event (`the source character` is an error, and a buff as a cause is
not nameable yet).

It resolves to **nobody** when nothing caused the event (a plain gauge
write), when the cause was not a character (a buff's own ability), or when
the cause was the trigger's **own owner** — a self-inflicted cost
retaliating against itself is never what content means. An effect aimed at
nobody is a no-op, not an error.

`buffs leave` and `gauges change` are specced but not implemented: their
subject is not a character phrase, so filters and adjectives would not mean
what they appear to.

### Where a trigger lives

- **Inside a `Buff`** — the buff grants it while attached, so its owner is
  whoever wears the buff. This is the usual place.
- **Outside any section** — it belongs to no status, so it travels in
  `CompileResult.triggers` and the **host** decides which character carries
  it.

A `Buff` may also use the turn prefix on an ordinary effect sentence:

```
Buff Regeneration
When a turn starts then heal this for 5.
```

### Mind the loop

A trigger whose effect re-causes its own event fires again:

```
when a character survives then deal 1 damage to all enemy characters.
```

Damaging an enemy makes it survive (`survives`), which triggers again. The engine's
depth guard stops it, but as an error — not a feature. Effects that write
no gauge (`Add …`) cannot loop this way.

## Card documents

The same language has a second document kind for the card game: sections
headed `Card <name>` instead of `Ability <name>`. A card is a header (its data),
and its effect lines (raw text):

```
Card Fireball
{ "cost": 4, "type": "spell" }
Deal 6 damage to target enemy character.
```

```
Card Elven Archer
{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 1 } }
When this enters play then Deal 1 damage to target enemy character.
```

A card is a heading followed by a **header** and then its effect lines. The header is a
JSON object — the card's *data* — and everything after it is raw text in the language:

| Header field | Means |
| --- | --- |
| `"cost": <n>` | The mana the card costs. Required on a card. |
| `"type": "spell" \| "creature"` | Required. |
| `"creatureConfig": { "power": <n>, "health": <n> }` | Required for a creature, not allowed on a spell. Settings that belong to a kind of permanent live under a key of their own, so other kinds can add theirs. |

The object may be on one line or spread over several. An unknown field, a missing `cost`
or `type`, or a malformed object is reported on the key that caused it.

A `Creature <name>` definition — a token that effects make, like `Giant Golem` — takes the
same header without a `cost`:

```
Creature Giant Golem
{ "type": "creature", "creatureConfig": { "power": 6, "health": 6 } }
Taunt.
```

| Effect line | Means |
| --- | --- |
| plain sentences (on a spell) | The spell's effect, exactly like an ability body. `target …` becomes the card's targeting; a sentence with no `target` phrase finds its own victims. |
| `Taunt.` / `Charge.` | A keyword. Creatures only. |
| `When this enters play [from <zone>] then <effect>` | The creature's arrival effect. A **target-picking** effect is chosen as the card is played; one that picks nothing is a real zone trigger. |
| `When this is destroyed then <effect>` | A trigger on the creature's own destruction. |
| `When … then …` | Any other standing trigger (`When this is damaged then …`, `When this enters a garbage from play then …`). |

**Events are named, not nicknamed.** There is no `Battlecry:`/`Deathrattle:`
shorthand: a card says *when* something happens with the same `When … then …`
grammar an ability document uses. A document still using the old shorthand
gets a targeted diagnostic naming the explicit sentence to write instead.

**Arriving in play, precisely.** The card layer stages a creature in the
`active` zone and *moves* it into `play`, so `When this enters play from
active` is a real transition and not an assumption. What the arrival effect
compiles to depends on one thing — whether it picks a target:

- **It picks a target** (`… then Deal 1 damage to target enemy character.`):
  the target is chosen by the player as the card is played, so this stays
  the card's play-time effect and `from active` is a guard on it. An effect
  written `from stack` therefore never fires on the normal cast — nothing
  can cheat a target choice in yet.
- **It picks nothing** (`… then Deal 2 damage to all enemy characters.`):
  it compiles to an ordinary `zone:changed` trigger, so it fires however
  the creature arrives — played, summoned, or cheated from the stack if
  the effect demands `from stack`.

**The turn a creature enters play.** A standing game rule says a creature cannot act — use an
ability or attack — the turn it enters play, however it arrived (cast, cheated in, revived).
A creature card can state exceptions:

| Line | Lets it … |
| --- | --- |
| `This can act the turn it enters play.` | do anything |
| `This can attack the turn it enters play.` | attack (as `Charge.` does) |
| `This can use <Ability> the turn it enters play.` | use that ability |
| `This can use any ability the turn it enters play.` | use any ability other than attacking (`This can any ability …` is read the same) |
| `Creatures you own can act / attack the turn they enter play.` | the same, for every creature you own, while this is in play |

`Buff` sections are still document-level and shared by every card, so a
card's `Add <buff>` resolves against them.

Compilation **delegates**: each effect line is compiled by the ordinary
ability grammar, so a card's effect is a real engine `cast` ability with
the same diagnostics and the same IR. `src/english/card.ts` owns only the
card-shaped parts — the header lines, the sectioning, and a line map that
moves the compiler's spans back onto the player's document (so a squiggle
lands on the word that caused it, not on a synthetic line). Completion does
the same: header lines offer card words, and every effect line is completed
by `completeAt`.

## Diagnostics and completion

- **Grammar errors** (unknown verb, missing `.`, a `number` where a phrase
  belongs, …) are reported with the exact span of the offending text.
- **Semantic errors**: unknown buff names (with the known names offered),
  duplicate host/document buff declarations, more than one kind of `target …`
  sentence, a sentence outside any ability after sections have started.
- **Warnings**: a declared buff never referenced by the ability.
- **Completion** is vocabulary-driven and position-aware: section starters
  (`Ability`, `Buff`) where a heading may begin, verbs at sentence starts,
  quantifier/ownership words inside character phrases, and supplied/document
  buff names after `Add` / `Remove`.

## Out of scope (this version)

- `Change controller`, `summon`/creatures, gauge writes other than HP damage /
  healing, percentages, `unless`/`except` conditions, restrictions, costs,
  and action transformers. Transforms and summons produce targeted
  diagnostics so the editor never guesses silently.
- **Zone movement as a verb.** `enters`/`leaves` *watch* a move; nothing in
  the language yet *makes* one (no "move this to the garbage", "return
  target character from the garbage"). The engine has `move` as an action
  (`engine.moveTo`), so the remaining work is a sentence, not a mechanism.
- Trigger gaps: non-character subjects (`buffs leave`, `gauges change`),
  more event verbs (`attacks`), several effects after one `then`, target
  choice *inside* a trigger (a trigger's effect is auto-targeted, so
  `then deal 1 damage to target enemy character` has nothing to pick), and
  `you may` (an optional trigger).
