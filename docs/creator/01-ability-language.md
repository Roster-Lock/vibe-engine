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
Destroy this character.
Heal all other ally characters for 25.
```

An ability is a heading line followed by **effect sentences** (each ends with
`.`). A `Buff` line declares a buff the ability adds — its definition travels
*with* the ability (deduplication into a shared library is a later milestone):

```
Ability Soul Rot
Buff Frailty (stacks)
Add Frailty to target enemy character.
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
| `this` | Whatever is using the ability — `this character` is the longer spelling | `ctx.self` |
| `target character` | The player picks one character | the ability's `targeting` |
| `target enemy character` | The player picks one enemy | `targeting: { who: 'enemy', count: 1 }` |
| `target ally character` | The player picks one ally | `targeting: { who: 'ally', count: 1 }` |
| `all characters` | Every character in play | engine `validTargets({ who: 'any' })` |
| `all enemy characters` | Every enemy of the user | `validTargets({ who: 'enemy' })` |
| `all ally characters` | Every ally, **including** the user | `validTargets({ who: 'ally' })` |
| `all other ally characters` | Every ally **except** the user | above minus `self` |
| `all characters owned by you` | Everything the user's player controls | `who: 'any'` + owner match |
| `all characters owned by the opponent` | Everything the enemy player controls | owner match on enemy players |

Rules:

- `character` and `characters` are both accepted, and after `this` the noun
  is **optional**: `this` alone names whatever is using the ability, whatever
  kind of thing it is. A group still needs its noun — "all" does not say all
  *what*.
- **Counts are digits.** `1 or more`, not `one or more`; a spelled-out
  number gets a diagnostic naming the digit.
- An ownership clause (`owned by you` / `owned by the opponent`) may follow any
  `all …` group: `all characters owned by you`, `all enemy characters owned by
  the opponent`.
- Only one *kind* of `target …` sentence may appear in an ability (the engine
  gives a manual ability one targeting pattern). Repeating the same kind is
  fine — every sentence then reads the same picked character.
- `this character` may not take an ownership or `with` clause.
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

Rules:

- Conditions combine by their separators: `and` (or a comma) requires
  **both** sides, `or` accepts **either**. Parentheses group expressions, and
  `not` negates one expression. `and` binds tighter than `or`:
  `with poison or thorns and hp <= 40` means `poison OR (thorns AND hp <=
  40)`. There is **no limit** on how many conditions a clause carries, and
  an Oxford comma (`poison, thorns, and hp <= 40` — or `, or hp <= 40`) is
  accepted.
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
Buff Charged (until end of turn)

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

The condition after `has` is the same grammar as a `with` clause, with one
difference: **a comma ends it** rather than meaning `and`, because the
comma separates the condition from the effect. Write `and` out:

```
If this has hp < 10 and mana > 5, heal this for 20.
```

An `If …,` clause also works inside a trigger's effect:

```
when a character dies then if this has hp < 150, heal this for 5.
```

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
| `Heal <n> to <chars>.` | Same — amount-first word order also accepted. |
| `Destroy <chars>.` | Destroy the characters (engine destroy action — deferred, resolved with the batch). |
| `Add <buff> to <chars>.` | Apply a buff to each character. `<buff>` must be declared in the document or built in. |
| `Remove <buff> from <chars>.` | Remove the buff (by its id) from each character. |
| `Toggle <buff>.` | Flip the buff on the ability's owner — on becomes off, off becomes on. |
| `Toggle <buff> on <chars>.` | Flip it on each character, each by its own state. |
| `You win the game.` / `You lose the game.` | The ability user's player wins / loses. |
| `All players win the game.` / `All players lose the game.` | Every registered player wins / loses (all-at-once resolves as a draw or last-team-standing per the engine). |

`win(s)` / `lose(s)` are accepted interchangeably (no subject–verb agreement
checking in the prototype). `n` is a non-negative number.

## Action modifiers

A `Buff` may change what happens to actions flowing past its wearer,
instead of making something happen:

```
Buff Rage (stacks)
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
  so a `(stacks)` buff with "+5" gives +15 at three stacks on its own.
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

## Declaring a buff

```
Buff <Name> [(<options>)]
Buff Frailty (stacks)
Buff Venom (weight 2, stacks)
Buff Curse of Frailty
```

Options (comma separated):

| Option | Means |
| --- | --- |
| `stacks` | more than one instance may be attached |
| `weight <n>` | status sort weight (defaults to `1`) |
| `until end of turn` | the buff removes itself when the turn ends |
| `for <n> turns` | it removes itself after that many turn-ends |

A duration is not an engine concept: it lowers to an ordinary triggered
ability on the buff that takes the buff off. Each **instance** expires on
its own, so every stack of a duration buff goes at the same turn's end
rather than one stack per turn. A declared buff compiles to an engine `BuffDef`. A buff with **sentences of
its own** carries them as triggered abilities — one trigger per event the
sentences fire on:

```
Buff Regeneration
When the turn starts, heal this character for 5.
```

Accepted prefixes today are `When the turn starts,` and `When the turn
ends,`. A buff sentence with **no** prefix defaults to `turn:start` —
write the prefix explicitly rather than relying on that. Richer payloads
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
Outgoing damage has a (10 * stacks)% chance to be doubled.
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
`this.mana`, and any custom gauge), each gauge's maximum under `<id>Max`
(`this.hpMax`), and `this.speed`. `%`-wrapped values (`doubled`, custom named
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
when 2 or more enemy characters die then deal 5 damage to all enemy characters.
when a character dies then deal 3 damage to all ally characters.
when this survives then heal this for 5.
when characters owned by the opponent with hp < 10 survive then Add Mark to all enemy characters.
```

### The subject is an ordinary character phrase

Everything the noun phrases above can say, a trigger's subject can say —
adjectives, `owned by`, and `with …` filters all apply to the
**triggering** characters, deciding which of them count:

```
when 2 or more enemy characters owned by the opponent with hp < 10 die then …
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
2 or more enemy characters die" does not fire when two characters died but
only one was an enemy.

### Event verbs

| Verb | Event | Singular |
| --- | --- | --- |
| `die` | `character:destroyed:batch` | `dies` |
| `survive` | `character:survived:batch` — took damage in a batch and lived | `survives` |
| `take damage` | `gauge:changed` on the life gauge, downward | `takes damage` |
| `are healed` | `gauge:changed` on the life gauge, upward | `is healed` |

Damage is **not its own event** in this engine — it is the life gauge
losing value (see `src/engine/events.ts`) — so `takes damage` is a gauge
event plus a direction. Nothing else about it is special.

As with `Deal`/`Heal` and a `damage`/`healing` modifier, the gauge is read
from the triggering entity's own declaration, so `takes damage` fires on
`hp` for a fighter and on `loyalty` for something that declares that as
its life. A loss on any *other* gauge is not damage and does not fire it.

### `the source`

Inside a trigger, `the source` is whoever caused the event: the character
that dealt the damage, applied the buff, moved the card.

```
Buff Thorns
when this takes damage then deal 8 damage to the source.
```

It is deliberately generic rather than `the attacker` — the same word works
for every event, and a second noun meaning the same thing for one event
kind would be a distinction with nothing behind it.

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

A `Buff` may also use the turn prefix on an ordinary effect sentence, which
is the older spelling and still works:

```
Buff Regeneration
When the turn starts, heal this character for 5.
```

### Mind the loop

A trigger whose effect re-causes its own event fires again:

```
when a character survives then deal 1 damage to all enemy characters.
```

Damaging an enemy makes it survive, which triggers again. The engine's
depth guard stops it, but as an error — not a feature. Effects that write
no gauge (`Add …`) cannot loop this way.

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
  zones (draw/discard/bounce), and action transformers. Transforms and
  summons produce targeted diagnostics so the editor never guesses
  silently.
- Trigger gaps: non-character subjects (`buffs leave`, `gauges change`),
  more event verbs (`takes damage`, `attacks`), several effects after one
  `then`, and `you may` (an optional trigger).
