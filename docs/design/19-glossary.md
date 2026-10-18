# 19 — The Glossary: click a word, see what it means

> **Status:** ✅ built — `src/english/glossary.ts`, `src/ui/glossary/`, wired into
> both battle pages, the card table and both editors. Keyword registration is
> built, and **`Discover` executes** through the engine
> (`Entity.attributes`, `Engine.reveal`, `DiscoverAction`, `EffectIR.discover`).
> What is still open is the English sentence for it and the table UI for the
> choice — see "Discover" below.

## The problem

A player who does not understand a word should be able to select it and be
told. The engine had the *definitions* — about a hundred vocabulary words, the
card words, buff descriptions, zone names, character defs — but they were
scattered across six modules, and every surface re-implemented "which word is
under the cursor, and what does it mean?" for itself:

| Where | How it answered |
| --- | --- |
| `WORD_DOCS` + `wordDoc()` | a flat record of ~90 one-liners |
| `CARD_WORD_DOCS` + `cardWordDoc()` | a second record, consulted first |
| `buffReferenceInfo` + `describeBuffReference` | a span-accurate parse, then markdown |
| `describeEngineBuff` | markdown from a `BuffDef` |
| the ability editor's hover | buff first, then `wordDoc` |
| the card editor's hover | *another* scan for declared buffs, then `cardWordDoc` |
| the completion engine | a third path, generating docs for buffs and zones |
| the game UI | `title="Taunt — must be attacked first"`, **hard-coded in JSX** |

Two costs followed. A new keyword had to be found in five places (a union type,
a regex in the card line classifier, two record entries, a Monaco token list,
and a hard-coded JSX label), and missing one produced a keyword that
autocompleted but would not compile, or compiled but could not be explained.
And the *game* — the surface a player is actually looking at — had no clickable
terms at all.

## The decision: three layers, split by who owns them

The insight is that "display a value" and "select a word" are game-specific, but
**showing a definition is not** — so the split is not between displaying and
selecting, it is:

| Layer | Game-specific? | Where |
| --- | --- | --- |
| **Definition** — a `TermRef` resolves to a `Term` | yes | `src/english/glossary.ts`, as *sources* |
| **Detection** — which words in this text are terms | yes | `annotate`, as data |
| **Interaction** — hover, click, the panel | no | `src/ui/glossary/` |

Both game-specific halves are **data**, not interfaces a game must implement:

- **Definition** is a list of named *sources* — `words`, `cardWords`,
  `keywords`, `buffs`, `zones`, `characters`, plus any custom source — merged
  into one lookup. A game adds meaning by adding a source.
- **Detection** is either a **scan** (prose: card rules text, a log line) or
  **declared spans** (`givens`: a buff badge, a minion token, a token an effect
  created). One function takes both and arbitrates: a declared span always beats
  a scan of the same range, because the caller knows more than a word matcher
  can.

So a surface does exactly two things: build a glossary from its content, and
render text through it. Everything else is shared.

### Source order is the whole precedence rule

The same word is often defined twice at different resolutions: `taunt` is both a
card keyword and, generically, a word; `hp` is both a gauge word and something a
buff's rules text mentions. Sources are ordered, and **a later source wins the
same key**:

```
cardWords → words → keywords → buffs → zones → characters → custom → (define hook)
```

There is no "richer wins" heuristic, no per-kind priority table. `cardWords`
comes before `words` so that a card-shaped reading (`cost`) can override the
generic one, and `keywords` after both, because `Taunt` is a keyword before it is
a word. Adding a source cannot break an existing tooltip, because it can only
displace a key it actually defines.

The `define` hook runs **last, on every resolution** — including a reference
that already resolved. That is the seam for live state: a match wants a minion's
HP *now*, not as printed, so the card table passes a hook that reads the board.

### Function words are resolvable but not marked up

A card face where every "the" and "to" is a link is noise (`BASIC_WORDS`). They
still resolve — a script asking about `the` gets an answer, and `scanAll: true`
marks them — but a scan is quiet about them by default.

## What was built

**`src/english/glossary.ts`** — `TermRef`, `Term`, `TermSeed`, `GlossarySource`,
`Glossary` (merge, `resolveText`, `define`, `annotate`, `vocabulary`),
`KeywordRegistry`, `BUILTIN_KEYWORDS`, `BASIC_WORDS`, `PermanentDef`.

`Term` carries `summary` (one line: the hover, the badge) separately from
`details` (markdown: the click panel), plus `facts` for the numbers worth
showing prominently. A buff with three triggers should not be a wall of text the
moment a cursor crosses it, and a player who wants the wall can ask.

**`src/ui/glossary/`** — `GlossaryProvider` + `useTermPanel`, `Gloss` (prose →
selectable terms), `Term` (one word), `TermPanel` (the definition), a small
markdown renderer, and `catalogs.ts` (the UI's own source set).

**A panel, not a tooltip.** The user's choice, and the reasoning holds up: a
definition refers to other words — "discover" mentions a library and a mana cost
— and those are selectable too. A panel that stays open and keeps a trail makes
that chain navigable, where a tooltip that vanishes on mouse-out turns it into a
sequence of unrelated popups.

**Wired into:** the card table's printed rules text and its minions (a minion's
name opens *that* minion's current gauges, buffs and abilities), the card table's
play-by-play, the buff chips and character names on both battle pages, and the
combat log. A term inside something already clickable stops the click, so
selecting a word can never play a card or start an attack by accident.

**The editors** now share one `glossaryAt()` lookup (the two hovers used to
disagree about buffs), and the document being typed is itself a **source** — a
`Buff Frailty` heading declares a term the sentences below refer to,
found by a text scan so it works while the body is still half-written.

## Recursion — a definition is glossed too

"Recursively" turns out to need almost nothing new, which is the test of whether
the design was right: the panel renders its own text through **the same
`annotate` the card text uses**. A term inside a definition is a term like any
other, so selecting it pushes the next definition, and the mechanism is one code
path rather than two.

Three things that were *not* free:

- **The panel had to become connected.** It used to take a `Term` as a prop and
  render its details as plain markdown, so a definition's words were inert. It
  now reads the trail and the resolution functions from the context, and the
  provider renders it inside its own view of that context (outside the provider
  wrapping `children`, so a page cannot shadow it).
- **A chain needed to be a place, not a stack.** With recursion, a walk two or
  three terms deep makes "back" ambiguous — back to where? The panel now shows
  the **trail as breadcrumbs**, each an ordinary jump to that step, because
  keeping the whole history is what makes depth usable rather than a one-way
  trip.
- **Prose about terms is the densest possible text to annotate.** The first
  render of a summary made **"HP"** clickable — correct, and if unchecked it is
  the thin end of a wedge where every common word in every definition is a link
  and the sentence stops being readable. So a scan has a floor:
  `minAnnotatedLength` (default **2**), which keeps real short terms (`hp`,
  `xp`) and drops single letters.

A definition that names itself (`Discover` saying "discover") is a **dead link,
not an infinite one**: `open` already treats re-selecting the current term as a
no-op, so the trail cannot grow a cycle.

### Where recursion does *not* reach yet

The **Monaco hover** still shows a definition as markdown text, which cannot
contain a clickable term — hovers are not interactive in that editor. The panel
is the recursive surface; making the hover chain too would mean the hover opening
a panel, which is a different interaction than the one the panel was chosen for.

## Registered keywords

`KeywordDef` is the one place a gameplay keyword is declared: its name, its
one-line summary, its details, its aliases, which card kinds it may appear on,
and whether the game implements it.

- A registered keyword is a **legal card line**, completes in the editor, is
  printed on the card, and is explained on hover — all from the one
  registration.
- `handled: false` marks a keyword the card layer may *name* but must not
  *grant*, so a mechanic can be written and saved before it works.
- `parse` is the seam for behaviour: it turns the words after the keyword
  (`Discover(2)`) into ordinary sentences, which would then compile through the
  ordinary pipeline — same diagnostics, same IR, same `cast`. **Not yet called**
  by the compiler; see below.
- `Taunt` and `Charge` became the first two registry entries, and the
  `CARD_WORD_DOCS` entries for them are now *derived* from the registry rather
  than restated.

### The cycle that forced the split

The first cut had `glossary.ts` import `CARD_WORD_DOCS` from `card.ts`, which
imports the registry from `glossary.ts`. That is a module cycle, and it fails at
load time (`Cannot read properties of undefined (reading 'taunt')`) — the
registry's initialiser reads the record before `card.ts` has finished
evaluating.

The fix is a rule worth keeping: **`glossary.ts` imports nothing that imports
it.** The keyword *wording* lives in the registry; `card.ts` derives its docs
from there; and the card vocabulary reaches the glossary as a **caller-supplied
source** (`src/ui/glossary/catalogs.ts` passes `CARD_WORD_DOCS`). The
cheap-looking `import` was the trap; the source list was already the right seam.

## Discover — the mechanic, built

The user asked for "discover" (Magic's mechanic, generalised to any cost system)
as a *function keyword*, and the first finding was that the **engine had no
reveal primitive at all**: a move was the only way anything left a deck, so
every look was also a take.

### The design call: an Action, not a bind-time loop

The obvious home for a new effect was `effectActions` in `src/ir/bind/`. That
function is **pure** — `EffectIR` in, `Action[]` out — and Discover is neither
pure nor one action: it reveals, **asks the player mid-resolution**, and moves
cards. It is five sub-behaviours (repeat, reveal, test the revealed card, offer a
choice, bottom-and-shuffle), and four of them are side effects.

Those are exactly the properties of an **action handler**, which may be async and
reaches `ctx.engine.ask` — the same route "you may …" already takes. So:

- `DiscoverAction` is a built-in entry in `ActionMap`;
- the binder turns `EffectIR.discover` into that one action (still pure, still
  one node in the share format);
- `GameEngine.#discover` runs the loop, where asking is allowed.

It is a **built-in** rather than a game's own action because the mechanic is
generic: it reads zones and an entity's declared facts, both of which the engine
already has. What is game-specific is only the numbers content passes.

### The temporary zone — why the reveal is a *move*

The first cut peeked at the top of the library (`Engine.reveal`) and never moved
anything. That is subtly wrong, and the correction is the interesting part:

- a peek changes nothing, so it announces **no `zone:changed`** and no trigger
  can see that a card was revealed. "When a card is revealed, …" is a question a
  game should be able to ask, and a peek makes it unanswerable;
- the handler then had to *remember* which cards it had looked at, in a local
  list, to bottom them at the end.

So the loop **moves** each looked-at card into a **temporary holding zone**
(`REVEALED`, declared by the card game, `group: 'resolving'` — the same family as
`active` and `stack`). Each reveal is a real move with a real event, the card is
visibly nowhere-in-particular for the rest of the resolution, and "the rest" is
simply that zone's members when the reveal ends. A card removed mid-reveal by a
trigger is not in it, so it cannot be bottomed by accident.

The cost is honest and worth stating: the holding zone **must be empty when a
reveal begins**, or it will swallow whatever was left there. `discover()` rejects
a `revealed` that is the same zone as `from`/`to`, which is the one aliasing
mistake that would make the loop incoherent.

### The primitives

1. **`Engine.reveal(zoneId, owner?)`** — peek the top of an ordered zone
   *without moving it*, for content that genuinely only looks ("look at the top
   card"). Announces nothing, because nothing changed zone. Refuses an unordered
   zone rather than inventing a "top". The discover loop deliberately does **not**
   use this; it moves.
2. **`Engine.shuffleZone(zoneId, owner?)`** — the seeded shuffle, public,
   because "the rest in a random order" is the effect's own business.
3. **`Entity.attributes`** — *any* numeric fact a game declares (`cost`, a
   `land` flag, a crew rating), read by name. `Character` carries it too, so a
   permanent can be filtered the same way. This is what lets a generic effect
   filter an entity the engine knows nothing about, and an absent name reads
   **0** rather than throwing — content shared between games should narrow, not
   break.
4. **`ValueIR.attribute`** — the content-reachable reader, so "deal damage equal
   to this card's cost" needs no new effect kind.
5. **`DiscoverAction.skip`** — a map of facts that *pass a card over* ("or a
   land"). A land has no cost worth comparing, so a cost ceiling alone cannot
   exclude it without also excluding every free card.
6. **`EffectIR.discover`** with `{ count, maxCost, skip?, from, revealed, to,
   rest }`, where `count` and `maxCost` are ordinary `ValueIR` (so "discover this
   card's power" is the same node as "discover 2").
7. **Zone names in the IR are abstract** — `library`, `board` — and the host
   maps them (`BindOptions.aliases`). The IR is the share format, so a document
   has to mean the same thing in a game whose library is called `deck` and one
   that calls it `pile`. The engine names no game's zones.
8. **A `skip` predicate compiles to facts, not a closure.** `land = 1` becomes
   `{ land: 1 }`, and the loop compares that against a card's declared
   attributes — so the engine still does not know what a land is. A predicate it
   cannot reduce this way (anything needing board context, which a revealed card
   cannot be tested against) is **dropped** rather than guessed at, and the
   ceiling still governs.

### Three bugs the tests caught, kept here as warnings

- **A loop over `reveal` re-examined one card.** A declined card went to the
  *bottom of the same zone*, so the next `reveal` returned it again — the loop
  looked at one card `count` times. This is the bug that pushed the design to a
  holding zone: once the card leaves the library, the loop cannot re-see it.
- **The scope was not bound inside an effect loop.** `ValueIR.attribute` (and a
  bare `gauge`) reads "the entity in scope", and `effectActions` never set it, so
  the amount silently read **0**. The amount is now evaluated per entity with
  that entity as the subject — a latent bug in the existing `gauge` path too.
- **`ActionBase` is a declared-keys invariant**, not assignability: every action
  must *declare* `direction` and `bypasses` even where optional
  (`DeclaresActionBase`). A new action that omits them fails to compile, which is
  exactly the check doing its job.

### Still open (M3b)

**The table UI for a reveal choice**: what a client may see of a hidden card (a
deck is `visibility: 'hidden'`, so showing its cost to a player is a real rules
question), how the offer is presented, and what an AI picks. The mechanic is
complete and headless-testable; presenting it is design work.

### Not yet wired

`Discover(2).` is a **registered keyword** (M2) — writable, printed, explained on
hover — but `KeywordDef.parse` is not yet called by the card compiler, so the
English line does not lower to `EffectIR.discover` yet. The IR node is reachable
today from JSON directly, which is what the share format needs; the English
surface is a parser/AST/lower/render pass, deliberately not smuggled in beside
the mechanic.

## What is deliberately *not* here

- **A second index of content.** `src/english/definitions.ts` already indexes
  characters, buffs and skills across files. The glossary consumes definitions;
  it does not replace that index, and buffs/characters resolve through it rather
  than through a parallel implementation.
- **A markdown library.** The renderer handles the subset the definitions
  already use (`**bold**`, `` `code` ``, `_italic_`, `> quote`, `- list`).
  Adding a dependency for `**bold**` would be the tail wagging the dog.
- **A DOM test environment.** The suite renders the React layer with
  `react-dom/server`, which is enough to prove that a term becomes a selectable
  element and that the rest of the text is preserved. Effects do not run, so the
  panel is asserted in its initial, collapsed state — which is what a player sees
  first anyway.

## Tests

| File | Holds to account |
| --- | --- |
| `test/glossary.test.ts` (34) | Resolving from every source; precedence; `annotate` (longest match, word boundaries, no overlaps, givens beat the scan); canonical names vs. glyphs |
| `test/keywords.test.ts` (15) | A keyword registered once is a legal line, completes, is explained, and is not granted when `handled: false`; wrong card kind; argument rejection |
| `test/glossary-ui.test.tsx` (14) | `Gloss` marks terms and keeps the prose; givens win; unknown names stay plain text; the panel reveals details on demand; the UI catalog knows the real keywords, buffs and zones |
| `test/discover.test.ts` (22) | The mechanic against the engine action: the reveal is an announced `zone:changed` (a peek would fire nothing), the holding zone ends empty, first-match-not-best, the offer is asked, declines bottom and continue, `count` is a cap, a skipped land is passed over, an absent cost reads 0, nothing is lost |
| `test/discover-ir.test.ts` (9) | The same mechanic from **JSON alone**: survives a round trip, resolves abstract zone names through the host's aliases, reads dynamic values, compiles a `skip` predicate to facts (and drops one it cannot reduce), and `ValueIR.attribute` per entity with an absent name reading 0 |
