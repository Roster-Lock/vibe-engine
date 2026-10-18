# 20 — Secret Choices, Numbers & Dice

> Status: ✅ direction decided; implementation pending. 🔶 coin results open. **Online play assumes a trusted
> server** (§5); the peer-to-peer designs in §2 and §4 are kept as ⏳ deferred.
>
> Builds on the choice protocol in [15-zones](15-zones.md) (`src/engine/choice.ts`,
> whose header already names "everyone discards face down, then reveal" as the
> missing shape) and on the commit/reveal helpers in `src/engine/seed.ts`.

## Why this exists

Three things a card game needs that the engine cannot say today:

1. **Simultaneous hidden choices.** *"All players commit a card from their hand
   face down. When they are ready, reveal. Each player puts the card they
   committed into their garbage."* / *"All players commit a number from 1 to 6
   face down."*
2. **Choosing things that are not characters.** `SelectRequest.options` is
   `Character[]`, so a hand card (a plain `Entity`) cannot be offered, and there
   is no way to ask for a number at all.
3. **Dice.** The only randomness is the seeded trigger-order stream and
   `chance` on modifiers. There is no `roll a d20`.

The constraint behind every decision below: **the game ships as physical cards
too.** The card text *is* the rules a table follows with no software, and the
engine's job is to enforce the same procedure a table would. So the wording
teaches the procedure, and nothing is left implicit that a first-time player
would have to guess.

## 1. Wording

### Commit, not "choose in secret"

Secrecy is **not** derived from the zone. A hand is visible to its owner, yet
"everyone discards" still needs sealed answers or the last player to choose sees
the rest; and "a number from 1 to 6" has no zone. So the text says so.

An earlier draft wrote `choose … in secret`. That is the wrong word: a person can
pick something privately and still change their mind, or tell someone, and
nothing in "choose in secret" stops them. What the game needs is a
**commitment** — placed face down, final once ready, unreadable until the reveal.
So the verb carries the difference:

| Verb | Mode | Meaning |
| --- | --- | --- |
| `commit … face down` | **sealed**, simultaneous | Every named player places an answer face down at the same time. Nobody, including the engine's other effects, can read an answer until the reveal. |
| `choose …` | **open**, in turn order | Starting with the controller; each later chooser sees the earlier answers. |

```
All players commit a card from their hand face down.
When they are ready, reveal.
All players move the card they committed to their garbage.

All players commit a number from 1 to 6 face down.
When they are ready, reveal.
```

(`The player who chose the highest number draws a card` needs player-targeted
effects; it is not written yet.)

**What `commit` means.** *Choose a valid option and write the value face down so
you cannot change it.* A **vague or invalid commitment — or an attempt to change
one — loses the game for that player.** This is how a table plays it, so it is
how the engine plays it:

- A commitment is **not checked when it is placed.** Nobody at a table can tell
  that a face-down answer is invalid until it is turned over, so the engine holds
  every answer unvalidated and judges them all at the `reveal`.
- At the reveal, an answer that is **invalid** (a number outside the range, a card
  that is not in the zone, the wrong kind of answer) or **vague** (a pick that
  names nothing, or the wrong number of things) forfeits that player, as does a
  **second answer** from a player who already committed.
- The round reports the forfeits (`choice:forfeited { player, reason }`, after
  `choice:revealed`, which carries only the valid answers). The IR's `reveal`
  turns each forfeit into a `lose` for that player; the engine itself does not
  know what losing is.
- **Vague includes ambiguous.** A commitment is a *value written down*, and it
  must name exactly one option. With two creatures both called "Goblin", writing
  "Goblin" could be either, so it is vague and forfeits. Look-alikes therefore
  need **markers**: `Entity.marker` is a number or letter on the card or token,
  and `markersFor(options)` supplies "Goblin (A)" / "Goblin (B)" when nothing
  else tells them apart. A request carries its markers so a UI can show them and
  a table can put the same letter on the card. The answer form for this is
  `{ kind: 'written', text }`, resolved at the reveal (`resolveWritten`); a
  digital pick of the object itself is unambiguous by construction and is never
  vague.
- **Online and computer play choose cards by id.** Every card carries a unique
  `Entity.id` (two copies of one card have different ids). A computer or online
  client commits `pickById(card.id)`; an id names exactly one option, so it can
  never be vague, and the id is also what `markersFor` prints to tell look-alikes
  apart ("Goblin (c-17)"). A request whose options share an id is refused.
- An **open** `choose` is unchanged: its answers are made in view, validated as
  they are made, and a bad one is a content bug that throws.

`commit` is a **keyword** of the language, like `this` or `target`: a reserved
word with one defined meaning, listed in the glossary so that clicking it shows
the longer, plain-English explanation. The sentences stay verbose on purpose —
`face down` and `When they are ready` are instructions to the players, not syntax
to shorten. Common patterns can become shorter keywords later, once real cards
show which ones recur.

### The rules of the grammar

| Form | Meaning |
| --- | --- |
| `… commits … face down` | Opens a **sealed round**. `face down` is required: the words are the instruction a table follows. |
| `… chooses …` | An **open** round. It must not say `face down` — an open choice is not hidden. |
| `When they are ready` | The round closes when **the players who are committing** have all answered. Players who are not committing are never waited on — that is what "relevant players" means. `they` (or `all players`) refers back to the group just above. |
| `reveal` | Publishes every answer at once. Physically: turn the cards over / show the number. |
| `the card they committed` / `the card they chose` | The card each player picked earlier, worded by the verb that opened the round. **Legal only after `reveal`** for a sealed round. |

The old `in secret` spelling is rejected with a pointer to `commits … face down`,
not reported as a stray word.

Compile-time checks, so a card cannot be authored into a state a table could
not play:

- A `commit` with no following `When … ready, reveal` is an error (the answers
  would never open).
- `reveal` with no preceding `commit` is an error; so is a `reveal` after an open
  `choose`, where there is nothing to reveal.
- Using `the card they committed` before the `reveal` is an error.
- A `commit` with a single committer is a warning: there is no one to hide from.

### "Ready" is final

A player is *ready* when they have committed. Physically that is a card placed
face down; they may change their mind until they say ready, not after. Digitally
the answer **is** the commitment, so the two are the same event: `choice:ready`.

## 2. Engine: `select` becomes flexible, `number` is added

### `select` over any entity

`SelectRequest.options` widens from `readonly Character[]` to `readonly Entity[]`
(a `Character` is already an `Entity`), and `SelectAnswer.chosen` follows.
`validateAnswer` already compares by reference, so it needs no change beyond the
type. `pattern` and `source` stay optional and keep meaning "derived from a
targeting pattern" / "the ability's owner". This is what lets a hand card, a
deck section (scry) or a garbage card be chosen.

Visibility is the request's concern, not the options': the options are shown
**only to the chooser**, so a hand is never leaked by asking about it.

### `number`

A new request kind:

```ts
interface NumberRequest extends ChoiceRequestBase {
  readonly kind: 'number';
  readonly min: number;
  readonly max: number;       // inclusive; integers only
}
interface NumberAnswer { readonly kind: 'number'; readonly value: number }
```

`validateAnswer` checks integer and range. `autoChoose` answers `min` — the
fewest/lowest, like `select` takes the fewest.

### The sealed round

```ts
engine.askAll(requests: readonly ChoiceRequest[], opts: { sealed: boolean }): SealedRound
```

- Every request goes out **concurrently**; a chooser's `choose` resolves with
  its own answer and cannot observe any other.
- Each answer, as it arrives, is held inside the `SealedRound` and announced
  only as `choice:ready { player }` — **no content**.
- The round resolves when every chooser is ready; `reveal()` then emits
  `choice:revealed { answers }` and makes the per-player bindings readable.
- `sealed: false` is the open sequential case: the engine expands it into
  successive single requests, exactly as the `choice.ts` header already
  describes, so nothing about today's behaviour changes.

A game whose players are all local (hot-seat) needs only the UI to hide each
pending answer. A networked game uses commit/reveal.

### Networked

With a **trusted server** (§5) the server holds each pending answer and releases
all of them at `reveal`. The server *is* the seal, so no commitment scheme is
needed and none of the hashing below applies.

The peer-to-peer alternative is ⏳ deferred, but if it is ever built it reuses
`seed.ts`: send a commit of `canonical(answer) + salt`, wait for all commits, then
reveal answer and salt and verify. Two cautions:

- **A salt is mandatory.** There are six possible answers to "1 to 6"; an
  unsalted commit is a lookup table.
- **FNV-1a is 32-bit and non-cryptographic.** It is fine for the seed ceremony's
  *fairness*, but a cheater can grind a salt that opens a 32-bit commit to a
  different answer. Peer-to-peer needs a real hash (SHA-256 via WebCrypto).

## 3. Voting

✅ built. A vote is a choice between **names**, and it comes in five kinds.

### Labelled options

A **labelled option** is a choice that is just a name — not a card, a character
or a number: `Attack` or `Retreat`; `Red`, `Green` or `Blue`; `"Hold fire"` or
`"Open fire"`. The engine gets one more request kind for it, `label` (a list of
distinct names, at least two) with a `label` answer, and it is also the answer to
"name a colour". A name is one word, or quoted when it needs spaces. Matching
is **exact**, case included (surrounding space is ignored): the options are shown
as a list to pick from, not typed, so an answer that differs in case is not one of
them — the safe rule. A name that is not on the ballot is invalid (and, in a sealed vote, loses the game — see
`commit`).

### The five kinds

| Kind | Wording | Who answers, in what order |
| --- | --- | --- |
| Commit / reveal | `All players commit Attack or Retreat face down.` then `When they are ready, reveal.` | Everyone at once; nothing is seen until the reveal. |
| The caster first | `All players choose Attack or Retreat.` | The caster, then round the table in seating order. |
| The caster last | `Ending with you, all players choose Attack or Retreat.` | Round the table in seating order, ending with the caster. |
| A random start | `Starting with a random player, all players choose Attack or Retreat.` | A die roll with one face per seat chooses who is first; then round the table. |
| Reverse order | `In reverse order, all players choose Attack or Retreat.` | The seating backwards (last seat first). **The caster's seat plays no part**, which is the "start doesn't matter" kind. |

- An open vote's order is in its opening words; **an open vote must say one**, so
  "who goes first" is never left to a table to guess. `All players choose a vote`
  is an error that lists the four.
- The random start is a **real roll** through the dice machinery (`roll:made`, a
  replaceable roller), so a physical table rolls a real die, and the result is
  announced like any other roll.
- Each voter in an open vote sees the votes already cast (`LabelRequest.prior`);
  a sealed vote shows nobody anything.
- A vote is an ordinary `choose` (`pick: { kind: 'label', options }`) with an
  optional `order`, so the commit rules apply unchanged: the answer is judged at
  the reveal and an invalid commitment forfeits.
- Everyone votes — `Each player` only.

### Reading the result

`votes for Attack` is an amount — how many votes that option got in the most
recent vote — so it works anywhere an amount does:

```
All players choose Attack or Retreat.
If votes for Attack is higher than votes for Retreat, Deal 10 damage to this character.
If votes for Attack is lower than votes for Retreat, Deal 20 damage to this character.
If votes for Attack is the same as votes for Retreat, Deal 1 damage to this character.
```

Ties are the card's to settle, with the same `is the same as` any value uses; the
engine has no tie rule. A forfeited commitment casts no vote. Compile errors:
reading a tally before any vote, for an option not on the ballot (`nobody can vote
for "Flee" — the options are "Attack" and "Retreat"`), or — for a sealed vote —
before its reveal. IR: `ValueIR.votes`. Tests: `test/vote.test.ts` (the IR, all
five kinds, the order of play) and `test/vote-english.test.ts` (the wording,
round trips, diagnostics, playing them).

One fix this needed in an earlier slice: "the controller first, then the others"
now goes **round the table** from the caster (seats A B C D with C casting asks C,
D, A, B), where it used to list the caster and then the rest from the start of the
seating.

## 4. Dice

### A roll has no chooser

Nobody is *asked to decide* anything when a roll happens. A roll is a **result
source**, not a decision, and any player may roll for any other, so there is no
`chooser` on it and no `ChoiceRequest` kind. The engine needs numbers in range
from somewhere:

```ts
type Roller = (count: number, sides: number, ctx: RollContext) => Promise<readonly number[]>;
```

It is async because one of the sources below collects entropy from the
players. That is *contributing*, not choosing: nobody picks the outcome.

### Sources

| Source | For | How the number is made |
| --- | --- | --- |
| **Seeded PRNG** | solo, hot-seat, AI-vs-AI, tests, replays | A stream derived from the game seed (`seed + ':dice'`), separate from the trigger shuffle so a roll does not shift trigger order. Deterministic, so a replay rolls the same. |
| **Server** | **online (the plan, §5)** | The server rolls with a cryptographically secure source (`crypto.getRandomValues`) whose state **never leaves the server**. Unpredictable, one message, nothing to verify. |
| **Table** | physical play | `engine.setRoller(...)` takes the result from whoever rolled the physical die. Validated to `1..sides`. |
| **Committed rounds** | online peer-to-peer (⏳ deferred) | Per roll, see below. Unpredictable until the roll happens. |

The seeded PRNG is **not safe online without a server**: the seed ceremony in `seed.ts` reveals
the seed once, after which every later number is computable by every player. A
player could simulate ahead and know the next roll before deciding a play. So
a peer-to-peer game must not use one revealed seed for dice. (A server keeps its seed private, so this does not arise there.)

### Peer-to-peer (⏳ deferred): a combined hash per roll

Every roll is its own commit/reveal round:

1. All players commit `H(salt_i ‖ secret_i)` for this roll.
2. Once all commits are in, each reveals `secret_i` and `salt_i`; reveals are
   verified against the commits.
3. The number is derived from a hash of **everything that identifies the roll**
   and **all contributions sorted by player id**:
   `H(gameId ‖ rollIndex ‖ count ‖ sides ‖ sorted secrets)`.
4. The hash output is turned into `1..sides` by **rejection sampling** (discard
   values past the largest multiple of `sides`), never a bare `% sides`, which
   biases small ranges.

Properties this buys:

- **Unpredictable.** No one knows the next number until the reveal that
  produces it, and no one can know the one after, because each roll uses fresh
  contributions.
- **Unbiasable by any single player** who commits before seeing the others': one
  honest contributor is enough for the result to be uniform.
- **Domain-separated.** The roll index and dice shape are hashed in, so a
  contribution cannot be replayed into a different roll. A *reroll* is simply the
  next roll, with fresh contributions.

**Cheaper variant: hash chains.** All players commit once, at game start, to the
end of a hash chain (`h_n = H(h_{n-1})`), and reveals the next link back for each
roll. Anyone verifies a link by hashing it forward to the committed end. That is
one message per roll instead of two round trips, with the same unpredictability.
Start with per-roll rounds (simpler to reason about) and move to chains if the
latency matters.

**Known weakness: the last revealer.** Whoever reveals last has seen everyone
else's secrets, so can compute the result and *withhold* their reveal if they
dislike it. That is one bit of bias per roll, and it cannot be fully removed
without heavier cryptography. The mitigation is a rule, not math: reveals happen
in a fixed order, a missing reveal after a timeout **forfeits** the player, and
the roll is then computed from the contributions that did arrive. Peer-to-peer
games accept this; a server removes it.

### Related warning: a revealed seed also breaks hidden zones

The shuffle uses the same PRNG. If every player can recompute the stream, every
player can recompute **deck order**, which defeats a `hidden` deck. Hidden zones
online are solved by the server in §5, or by the peer-to-peer scheme described
there. Recorded here because the fix for dice does not fix it.

### A roll is an action, and its result is named

```
Roll a d20. If the result is 15 or more, draw a card.
Roll 2d6. Deal damage equal to the total.
Deal damage equal to a d6 roll.        // sugar: roll once, then use the result
```

`roll` is an **Action** (`src/engine/actions.ts`), not a `ValueIR` node. A value
is evaluated wherever it appears, so `damage equal to a d6 roll` used twice would
roll twice, and replay would depend on evaluation count. As an action it rolls
once, binds `the result` (`the total`, `the highest`) in the effect's scope, and
later values read the binding. The inline form is sugar the lowering expands.

Going through the pipeline is the point:

- `roll:made { source, count, sides, results }` makes *"whenever an opponent
  rolls"* writable.
- An `ActionTransformer` on `roll` gives *reroll*, *add 1 to the result*, and
  *roll twice and keep the higher* as ordinary replacement effects — the same
  argument [15-zones](15-zones.md) makes for `move`.
- `source` records who rolled, since attribution is what those triggers read.

`flip a coin` is `roll a d2` with heads/tails labels; see Open.

### Where the vocabulary lives

In the **shared rules** (`src/english/vocabulary.ts` and the engine action
registry), not the card game's layer: most games want a die. The card game only
declares nothing here, which is the test that it belongs in the shared layer.

## 5. Online play: a trusted server

### Decision

Online games run the engine **on a trusted server**. Clients send intents
(answers, moves) and receive **views**. This makes the hardest problems cheap:

| Problem | With a server |
| --- | --- |
| Dice unpredictable | The server rolls from a secure source and never discloses its state. |
| Hidden deck (even from its owner) | The server holds the order; a client's view contains the card count and nothing else. |
| Sealed choices | The server holds answers until `reveal`. |
| A client lying about its own cards | There is nothing to lie about; the server knows the real objects. |
| A player withholding a reveal | No reveal depends on a player. A missing answer is a timeout policy, not a protocol hole. |

`ZoneDef.visibility` (`public` / `owner` / `hidden` / `custom`) is the contract a
server projects by: for each zone instance and each recipient, **members** are
sent only if the recipient may see them, **size** always. `hidden` is "even from
its owner" precisely so a view never has to trust a client.

### Built: views

`ViewProjector` (`src/engine/views.ts`) builds what **one player** may know, as plain
data. **A card you cannot see is not in your view** — only that it exists, and for an
ordered pile where.

```ts
const projector = new ViewProjector(engine, { describe });   // refs are random UUIDs by default
const engine = createEngine({ onEvent: (event) => projector.broadcast(event, send) });

projector.viewFor(player);               // zones, sizes, the cards that player can see
projector.eventFor(player, event);       // one event, redacted for one recipient
projector.resolveRef(player, ref);       // a client's "that card" → the card, if they can see it NOW
projector.resolveSlot(player, zoneKey, index);   // a card they cannot see, by place
```

- **A zone is sent with its size, always.** Its cards are sent only if
  `engine.canSee(player, card)` (the zone's rule, or a live grant). Every player has an
  instance of every per-player zone in the view, empty or not, so a client gets the
  structure.
- **Refs.** A card you can see has a random **ref**, stable for the whole game and the
  same for every viewer. A card you cannot see has **no ref at all**: a ref that
  survived a shuffle would let a player who once saw a card follow it through the
  shuffle, which physically they could not. Refs are checked on use — a ref for a
  card you no longer see resolves to nothing — so a stale or forged ref cannot reach
  a hidden card.
- **Ordered vs unordered.** In an ordered pile a hidden card keeps its place as an
  anonymous placeholder (the top of a deck is still the top). In an unordered zone —
  a hand — the cards you cannot see are only **counted** (`hiddenCount`); their
  internal order is not sent, since it would say when each was drawn. A card shown to
  you by a grant appears in its place, and disappears again when the grant ends.
- **Events** are redacted by the same rule: any card in one that the recipient cannot
  see is anonymous, any player is an id, any zone its key; everything is plain data.
  A card leaving a zone the recipient *could* see keeps its ref in the event (a
  Goblin bounced to a hidden hand is still *that* Goblin to them); a card that was
  already hidden never gets one. The deliberate exception is `choice:revealed`, which
  turns the committed cards face up for everyone.
- **A game adds to a card's view** with `describe` (cost, text…); characters get
  their gauges and controller by default.
- **Tests:** `test/views.test.ts` (24). The ones that matter scan the JSON that would
  go over the wire: an opponent's views and events never contain the names of cards
  they cannot see, through a whole commit / reveal round, until the reveal.
- **Not built:** per-event sequence numbers for resync (a reconnecting user is sent a
  whole fresh view instead, which cannot get out of step).

### Built: the transport

`src/multiplayer/` — a `Room` on the server and `createClient` on the other end, both
speaking `MessageBridge` (`src/util/MessageBridge`) over the socket (tests:
`test/transport.test.ts`, 46; `test/cloudflare.test.ts`, 33; `npm run example:online`).

- **Authentication is separate, and the server asks.** Whatever signs players in decides
  whose token is whose. The client is *handed* a token and answers the room's `auth`
  request with it (`bridge.onRequest('auth', () => authToken)`); the server's `Room` is
  built with `Record<userId, { authToken, gameInit }>` and, for each new socket, does
  `const authToken = await bridge.sendRequest('auth', {})`, finds the user holding that
  token, and otherwise `ws.close(4001, 'Bad User')`. The room never issues, stores beyond
  that table, or sends back a token, and `gameInit` stays server-side.
- **A wrong answer gets nothing.** A token nobody holds, an empty or oversized one, a
  non-string, a message that is not a bridge message, or silence for `authTimeoutMs`
  closes the socket. Every wrong token gets the same `Bad User`, comparison is
  constant-time across all users, and until the token is accepted a socket is sent only
  the question and everything it says except the answer is dropped. Two users cannot
  share a token.
- **One live socket per user, and a dropped user can come back.** A second connection
  with the same token replaces the first (closed `4002`); prompts the room was still
  waiting on are sent again on reconnect, together with a fresh view.
- **What travels** (bridge paths, `protocol.ts`). Server to client: `auth` and `prompt`
  (requests), `welcome`, `view` (the whole game as that user may see it), `event`
  (redacted for them), `error` (events). Client to server: the answers, and `intent`
  requests (named, handled by `room.onIntent`, which learns who sent it). Prompts are how
  the engine's choice protocol crosses the wire: a `RemotePlayer`'s `choose` becomes a
  `choose` prompt whose options the client sees redacted, and the client answers by the
  **position** of the option it picks — it can pick among cards it cannot see and never
  names a card it has no right to. An unreadable reply is asked again (three times), then
  the default answer stands in; a readable but wrong one is passed on, so the engine
  decides what it costs (an open choice rejects it; a face-down commitment loses the game).
- **`attachGame`** sends each connecting user a view, then each engine event as that
  user's own redacted copy (the engine gained `observe` for this). A user who was away
  gets a fresh view instead of a replay.
- **Tested end to end:** a commit / reveal round played between two clients over
  in-memory sockets, with the other client's wire scanned — it is never sent a card it
  may not see until the reveal, and no token ever crosses it. Plus a mid-prompt
  disconnect and reconnect, and a client that answers nonsense.
- **`CloudflareRoom`** (`cloudflare.ts`) — the same room as a plain class that a Durable
  Object can forward to, without being one. It is woken by a new websocket (`accept` /
  `fetch`), a message (`webSocketMessage`), a disconnect (`webSocketClose` /
  `webSocketError`) and a timer (`alarm`), and assumes it can be thrown away between any
  two: users, pending prompts, timers and the game's own `save`/`read` state live in
  `ctx.storage`; who is connected comes from `ctx.getWebSockets()` and each socket's
  attachment (which also carries a mid-authentication socket's `auth` request id); timers
  are multiplexed onto the single platform alarm. A bridge's pending requests are
  memory-only, so prompts are matched to answers by the stored table, and the answer lands
  in `onReply` (registered on every wake). `prompt()` — a promise — is offered for the
  time the object stays awake. Tested with fakes that evict and rebuild it between events.
- **Not built:** rate-limiting failed token attempts per address (the room does not know
  addresses), a request/response shape for a card game's *moves* (they would ride the same
  prompt channel — the card game's `chooseMove` has no remote version yet), and TLS/origin
  checks, which belong to whatever terminates the connection.

### Custom visibility

`public` / `owner` / `hidden` cannot say "everyone **but** the owner can see
this" (a card worn on your forehead, a face-down card its owner may not look at)
or "the targeted player may look at this".

The zone does not learn what a teammate or an opponent is. Instead there is one
more value, `'custom'`, and the viewers are **a plain list of players created by
keywords**:

```ts
type ZoneVisibility = 'public' | 'owner' | 'hidden' | 'custom';
```

A `'custom'` zone shows its members to exactly the players on its **viewer
list**; until a keyword gives it one, the list is empty and it behaves like
`hidden`. The declaration stays data and names no roles, so it can travel in
shared content. The list is state, set while the game runs:

```ts
zone.viewers: readonly Player[]                      // custom zones only
engine.setViewers(zone, players)                     // replaces the zone's list
engine.showTo(entity, players, { until? })           // one card, see below
```

Both take a real `Player[]`. The *keywords* are what build it, from whatever the
card or rule text says:

```
Players other than its owner can see cards in this zone.   // all but the owner
Target player can see the cards in your hand.              // one named player
```

Wording is left to the slice that adds it. Resolving "players other than its
owner" is the keyword's job (it walks the player list), so teams, free-for-all
and any later relation work without the zone changing.

**Two scopes, one type.** A zone's viewer list is standing: it applies to every
member for as long as it is set. `showTo` is the same list on **one entity**, for
"look at target player's hand" and "reveal this card": the grant

- **ends when the entity changes zone** (the usual new-object rule), or at the end
  of the resolution if the effect says so — never later;
- is **announced without content**: `visibility:granted { count, viewers }`, so the
  table knows a look happened, as it would physically, but not what was seen.

**Seeing once vs. seeing while it is yours.** Both are wanted, and they are
different lifetimes of the same grant:

| Wanted | Grant | Meaning |
| --- | --- | --- |
| Look once, then it is hidden again | `until: 'resolution'` | The grantee sees it for this effect only. They have *learned* it, but cannot re-view it afterwards. |
| Treated as **in their hand** | `until: 'zone-change'` (the default) | They may look at any time, and — if `'cast'` is also granted — cast it. Ends when the card leaves the zone. |

"Considered in their hand" is a standing `see` (and usually `cast`) grant, not a
zone move: the card stays where it is, owned by its owner, and the grantee simply
holds the same permissions a hand would give them (§6).

A recipient sees a member if the zone's rule allows it (`public`, `owner`, or on
the viewer list) **or** the entity carries a grant for them. Size is always
visible.

Required changes on the server path:

- The seed must come from a **secure source** and stay server-side.
  `createRandomSeed()` uses `Math.random` and is for local play only.
- Per-recipient projection also covers *events*: a `zone:changed` for a card
  entering a hidden zone must not name the card to players who cannot see it.
- Sealed-round answers are held server-side and are not broadcast as they arrive.

### Peer-to-peer hidden zones (⏳ deferred; protocol core built)

Kept because it is the only way to host a game without a server, and the design
below is sound as a base. It is **not** the plan.

**The scheme** (as proposed):

1. Each card in a deck gets an **id**; duplicates get different ids. Only the
   owner knows the `id → card` dictionary.
2. To shuffle, an opponent takes the ids, orders them by a permutation only they
   know, and for each card publishes `H(id ‖ r)` with a **unique random `r`** per
   card. The opponent stores `(position → id, r)`.
3. When the owner is to see a card (a draw, a scry), the opponent reveals the `id`
   and `r` for that position. The owner checks `H(id ‖ r)` equals the published
   hash at that position, then looks the id up in the dictionary.

Knowledge is split by design: the owner knows *what* each id is but not *where*
it is; the opponent knows *where* each id is but not *what* it is. Neither can
learn a card without the other. The shuffler cannot stack the deck (they do not
know values) and cannot lie later (the hashes bind them).

**What it needs added** (found by walking the scheme through):

- **The owner commits to the deck up front, and opens it at the end.** Only the
  owner knows `id → card`, so without a commitment they could claim a drawn id is
  any card. Publish a Merkle root over `H(s ‖ card)` per physical card, where `s`
  is a per-card secret (see *remapping*). A played card reveals its leaf and
  proof. At game end the owner opens every `s`, and the table checks deck
  legality (size, copy limits) and that every claim made during the game matches.
- **Every shuffle is auditable.** A shuffle is a numbered **epoch**: the shuffler
  publishes the list of `H(id ‖ r)` for that epoch, and the owner has published
  `H(id)` for the ids in play. At game end the shuffler opens each epoch (the
  permutation and every `r`), and anyone recomputes it: the opened ids must be
  exactly the owner's committed set with **no repeats and no strangers**, each
  published hash must equal `H(id ‖ r)`, and every id revealed during the game
  must sit at the position the epoch says. Every message is signed by its sender
  and logged in an append-only transcript, so a failed audit points at a person.
  This detects cheating rather than preventing it; a bad reveal is still caught
  at once, because the owner checks each reveal against the published hash.
- **Non-collusion is stated to everyone.** Security rests on the owner and the
  shuffler not pooling what they know. Who shuffles whose deck is fixed in the
  lobby and shown to **all** players before the game starts. With three or more
  players a *chain* of shufflers is used (each hashing the previous hash with its
  own `r`), which means a reveal needs every shuffler to answer.
- **Remapping hides what moved.** Left alone, scry leaks: the shuffler sees id 7
  go to the bottom and learns "that one was bad". Instead, whenever the owner
  moves a card between hidden positions, the **owner re-identifies it**:
  - Each card has a secret `s`; its id in generation `k` is `id_k = H(s ‖ k)`.
    Without `s`, the shuffler cannot link `id_k` to `id_{k+1}`.
  - The upfront commitment already covers `s`, so renaming needs **no new
    upload**, and the audit can derive every generation.
  - To scry 3, the owner receives `X1..X3`, retires them, and submits the three
    fresh ids as an **unordered set** split into "top, in this order" and
    "bottom". The shuffler places them but cannot tell which retired id each came
    from. They still learn that one of the three was bottomed, and the count, but
    not which. The same applies to a hand card put back on the library and to
    hidden-to-hidden `reposition` / `arrange` generally.
  - What still leaks, by design: that a look happened, how many cards, and the
    positions involved. A server leaks none of it.
- **Availability.** Every draw needs the shuffler to answer. A withheld reveal
  stalls the game, so the same forfeit-on-timeout rule as committed dice applies.
- **Primitives.** SHA-256 and ≥128-bit random values; the existing 32-bit FNV is
  not suitable.

**Built: the protocol core** (`src/p2p/`, tested in `test/p2p.test.ts`, 27 tests).
It is the scheme above with the additions made explicit, as a library with **no
networking, no signatures, and no connection to the engine's zones yet**:

- `OwnerDeck` — the owner commits to the deck with a Merkle root over
  `H('leaf', s, card)`; names each card by `H('id', s, generation)`; publishes
  `H('idhash', id)` before handing ids over; looks an id up (the only one who can);
  **renames** looked-at cards to their next generation, returning the new ids in random
  order; proves a card with a Merkle claim; and opens the whole deck at the end.
- `Shuffler` — shuffles the ids with unbiased randomness, publishes
  `H('slot', id, r)` with a fresh salt per slot, reveals `(id, r)` for a draw or a peek,
  and `rearrange`s after a scry (the looked-at slots leave; the renamed ids go on top
  and bottom). `verifyReveal` is the owner's check.
- `Transcript` — an append-only **hash chain** of what was published. It shows the log is
  intact, not who wrote an entry: a real deployment signs each entry.
- `audit` — at the end, both sides open everything and it is recomputed: the log's
  chain holds; the shuffler opened exactly what it published and each opening is
  honest; no id is used twice; the owner's opened deck matches the Merkle root; the ids
  on the table are *exactly* the ids the deck produces (no stranger added, none
  dropped); they match the hashes the owner published; and every claim made in play was
  true.
- **What play catches, and what only the audit does.** A bad reveal is caught at once.
  A stranger id, a duplicated or dropped card, a false claim, an edited log, and a
  deck that is not the one committed to are caught at the audit — each has a test.
- **Not built:** the committed dice rounds (§4), signatures, the shuffler-chain for three
  or more players, any networking, and wiring this to `Zone`/`ViewProjector`. The
  cryptography has **not been reviewed**; do not put money or a ranked ladder on it
  without that.

Everything the engine already declares (`hidden` visibility, `peek`, `arrange`,
`shuffleIn`) is the *interface*; this scheme would be a different implementation
behind it, which is why deferring it costs nothing now.

## 6. Who may act on a card: grants

### Two cases that shaped it

**Gonti.** *Exile the top card of an opponent's library; you may cast it.* The card
sits in an exile zone that belongs to the opponent. **You** may cast it, and a
second effect can let a *different* player cast the same card on different terms
("until end of turn" vs. "for as long as it remains exiled").

**The Boxed Present.** A zone of wrapped cards nobody has seen. Each card in it
has an ability it never printed — **Open Present** — which a player may use. Its
effect is: *reveal this card; it is cast if possible; otherwise move it to its
owner's garbage.*

### What the second case settles

1. **Casting starts with a reveal, never before one.** The stack is public, so a
   card must be revealed to be put on it. Casting is therefore not a permission that
   skips looking: it is an action whose first step makes the card visible. (An
   earlier draft said "permission to cast implies permission to see". That was
   wrong, and is gone: a capability implies nothing unless the game declares a
   link, and for casting no link is wanted — the reveal is part of the cast.)
2. **A card has the abilities it was printed with, plus whatever its current zone or
   an effect gives it.** The Boxed Present zone gives *every card in it* "Open
   Present"; Gonti's effect gives the exiled card "Cast this card" to one player.
   Neither ability is on the card, and neither can be inferred from it. This is the
   important detail: **abilities are granted to cards by zones and by effects.**
3. **"If possible" is part of the ability's effect**, not a precondition. The player
   cannot know whether a hidden card is castable (its cost, a legal target), so
   they open it and the game finds out: cast it if it can be, otherwise the
   fallback.

### What a grant is

A **grant** is `(card, players, what, source, lifetime)`: these players hold this
*thing* on this card, because this source said so, until this ends. The *thing* is
one of two kinds:

| Kind | What it is | Status |
| --- | --- | --- |
| A **capability** | A name the game declares (`'cast'`, `'see'`). The engine remembers who holds it and reads none of them; the game's rules ask `mayAct(player, card, 'cast')`. `'see'` is the one the engine understands, and `showTo` is `grant(…, 'see')`. | ✅ built |
| An **ability** | A real ability — a body of effects — the card now has, usable by those players: *Open Present*, *Cast this card*. | ✅ built (see below) |

They are the same record with a different payload. A capability is the cheap form
for "may the player do the built-in thing" (cast a card from exile); an ability is
the general form for "the card can now do *this*" (open a present).

### Built: capabilities

```ts
engine.declareCapability('cast');                 // the game says what exists
engine.declareCapability('inspect', { implies: ['see'] });   // optional link
engine.grant(card, players, 'cast', { source, until });
engine.mayAct(player, card, 'cast');              // the rule's question
engine.showTo(card, players, { until });          // grant(…, 'see')
engine.revokeGrants(source);                      // ends exactly that source's grants
```

- **Lifetimes:** `'zone-change'` (default — while the card stays where it is, since
  it is a new object when it moves), `'resolution'` (inside `engine.resolution`),
  `'turn-end'` ("this turn"), `'manual'` (until `end()`).
- **Several grants are a union**; each remembers its `source`, so ending one effect
  leaves another effect's permission on the same card untouched.
- **A capability implies nothing by default.** `{ implies: [...] }` is a game's
  option, ends together with its parent, and is no longer used for casting.
- **Announced without the card:** `grant:added` / `grant:removed { capability,
  players, count }` — the table learns that someone may now do something, not to
  which card.
- Tests: `test/grants.test.ts` (15), and `test/visibility.test.ts` for `showTo`.

### Built: abilities granted to cards

```ts
// A zone gives every card in it an ability, to the players it names.
// Standing state set while the game runs, like the viewer list — the zone's
// declaration stays plain data.
engine.setZoneAbilities(boxedZone, [openPresent], [bo, cy]);

// An effect gives one card an ability for a lifetime.
engine.grantAbility(card, openPresent, [bo], { until: 'turn-end', source });

engine.abilitiesFor(player, card);                 // what they may use on it now
await engine.useCardAbility(player, card, openPresent);
```

- **Where it comes from.** A zone's list applies to each member while it is there:
  a card that enters has it, one that leaves does not, and the list can change
  mid-game. An effect's grant is the same record as any other grant (`source`,
  `until`, `revokeGrants`), so a zone's ability and an effect's are a union and an
  ability given by both is still one ability.
- **Who may use it.** The players named when it was set or granted. The zone's
  owner is not special: in the Boxed Present test the owner may *not* open her own
  present unless she is named.
- **What `this` is.** `AbilityContext.host` is the card the ability belongs to;
  `self` is the first living character of the player using it. An ability that a
  character carries has no `host`, and using "this card" in one is an error that
  says so.
- **Three effects act on the host:**
  - `Reveal this card.` — shows it to every player (a `showTo`, so it lasts while
    the card stays put).
  - `Cast this card if you can.` / `Cast this card if you can, otherwise move it to
    its owner's garbage.` — *can* is the game's answer (`setEngineCast`, or
    `BindOptions.cast`): a game reports whether it cast, and does nothing to a card
    it could not. The card game's `tryCast` says it can when the cost is affordable
    and, if the card picks a target, there is a legal one, which the caster chooses
    as for a cast from the hand. Casting puts the card on the stack, which is how
    it is revealed.
  - `Move this card to its owner's garbage.` — the owner of the pile the card is
    in, not whoever is using the ability.
- **The Boxed Present** is therefore ordinary content:

  ```
  Ability Open Present
  Reveal this card.
  Cast this card if you can, otherwise move it to its owner's garbage.
  ```

  attached with `setZoneAbilities`. Tests: `test/card-abilities.test.ts` (19 — the
  zone and effect forms, the order *reveal then cast*, owner-not-opener fallback,
  who may use it, the language) and, in the real game,
  `test/card-game-english.test.ts` (a wrapped Wisp is paid for and lands; a
  too-expensive Giant goes to its owner's garbage; a Bolt asks for its target).
- **Said in the language.** A zone is given an ability by a sentence, an effect
  that runs when the ability containing it does:

  ```
  Cards in your boxed zone have Open Present for all opponents.
  ```

  - *Whose zone:* `your`, `all players'`, `all opponents'`, or `the` for a shared
    one. A per-player zone has an instance per player, so this says which.
  - *Which ability:* a sibling in the same document, by name (any order). A name
    that is not there is an error that lists the abilities that are, or the one you
    probably meant.
  - *Who may use it:* `for you`, `for all players`, `for all opponents`; without
    `for`, anyone. The zone's owner is not special.
  - It **adds** to what the zone already gives, and giving the same ability again
    replaces who may use *that* ability (`addZoneAbility`). The word `zone` is
    optional to read and always written back.
  - *When it runs* is the host's choice — the sentence is an effect, so it sits in
    an ability the game casts at setup, or in a trigger — which is what "set while
    the game runs, like a viewer list" meant. A `Zone` section that does it by
    declaration was left out on purpose.
- **As a move of the turn.** The card game has `Move { kind: 'use', card, ability,
  targets }`, offered by `game.cardAbilities(player)` (every ability a card has been
  given that the player may use now). The game checks the offer, and the log says
  `uses Open Present on a card in boxed` — **never the card's name**, since it may
  be face down; once it is cast the log names it, because by then it is public. The
  greedy AI opens what it is given, once per card, after spending its mana. Tests:
  `test/card-game-english.test.ts` (the turn, the log, a refused move, the AI) and
  `test/card-abilities.test.ts` (the sentence: its parts, who gets what, adding vs
  replacing, a shared zone, every error).
- **Said in the zone's own words — a `Zone` section.** "Cards in this zone" needs a
  zone to be *this*, so the sentence lives under a heading naming one:

  ```
  Zone boxed
  Cards in this zone have Open Present for all opponents.
  ```

  - `Zone <name>` takes a zone from the game's zone list; the only statement it holds
    is `Cards in this zone have <ability> [for <players>].` Anything else in it, and
    "this zone" anywhere outside one, is an error that says why.
  - For a **per-player** zone it covers every player's instance, and "you" / "each
    opponent" are relative to *that instance's owner*: the example lets all players'
    opponents open their wrapped cards. A **shared** zone has no owner, so only
    `for all players` is meaningful there — `for you` is an error when it is applied.
  - It is **applied by the host**: `compiled.zones[i].apply(engine)` once the game's
    zones and players exist (the zone name goes through the same aliases as every
    other). Applying it twice sets the same state. This keeps "the zone's declaration
    is data; the standing state is set while the game runs".
  - The explicit form, `Cards in your boxed zone have Open Present for all opponents.`,
    remains for an effect that happens *during* the game (a spell that wraps the
    cards in your boxed zone) rather than at setup.
  - Written `Cards`, not `Card's`: the possessive would read as one card's zone.
- **Still not done:** a control for the move in the React UI (its selection type is
  its own and does not break), and a zone-level wording for *removing* an ability
  — `setZoneAbilities(zone, [], [])` does it from code. (Discussed under "Removing" below.)

### Removing abilities

Three different things, which want different answers:

1. **Taking away what a zone gave** — ✅ built. `engine.removeZoneAbility(zone,
   ability)` and the sentence `Cards in this zone no longer have Open Present.` (also
   `Cards in your boxed zone no longer have …`, which takes no `for`: it removes the
   ability for everyone it was given to). It leaves the zone's other abilities alone
   and does **not** touch an ability a card was *granted* — that has its own lifetime
   and source. A zone's abilities are matched by `id`, not by object, so a document
   compiled again (a reload) replaces the stale ability instead of sitting beside it.
2. **Ending what an effect granted** — ✅ already done. A grant ends by its lifetime
   (`zone-change`, `resolution`, `turn-end`) or by `revokeGrants(source)`, and several
   effects' grants on one card are independent.
3. **Taking away what a card *printed*** — not built. ("It loses all abilities.") A
   different and much bigger feature: the engine would have to *suppress* an ability
   the card owns rather than remove a grant, and decide how suppression layers with
   grants and with other suppressions. Magic needs an ordering system (layers) for
   exactly this. Nothing here prevents it later, but it is not a small extension of
   grants, and no card needs it yet.

### Where the card is, and who owns it

The card stays in the zone it was put in and keeps its **owner** (whose pile it
came from and who it returns to). Permission has nothing to do with ownership: the
caster is not the owner and does not become one. This also fits the
zone-per-purpose decision in `zones.ts`: a purpose-specific zone holds the card, and
the grant says who may use it. "When a card leaves that zone" stays a precise
trigger.

### Peer-to-peer and server

- **Server:** projection only. Granting `'cast'` needs no secrecy; the reveal that
  begins a cast is a `showTo`, so it adds the card to every player's view.
- **Peer-to-peer:** revealing another player's card needs **two** reveals, not
  one. The shuffler opens the id (as for a draw), and the card's **owner** must open
  the `id → card` leaf to the table, because only the owner knows what the id is.
  Casting from a hidden zone therefore costs those two reveals at the moment of
  opening, which is exactly when the card has to become public anyway.

## 7. Gas: a budget for runaway loops

✅ built (`src/engine/gas.ts`). A card game lets players write rules that trigger
other rules; most stop, some do not. The engine already capped how *deep* a chain of
applies may go, but a loop does not have to go deep: two triggers per trigger is wide,
and a `Σ` over a million terms is one node. What they share is that they **do a lot of
work**, so that is what is counted.

### How it works

- **Every unit of work spends gas.** Running an action (1), firing a trigger (2),
  running an effect of an ability (1), going round a loop — a `Repeat`, a pass of
  state-based rules (1), asking a player something (1), and each node of a formula
  evaluated (1). The prices can be changed (`gas: { costs }`).
- **A scope has a budget.** A *scope* is one unit of work — one player's move, one
  ability, one top-level `apply`. The default budget is **10,000** per scope. Measured
  over full AI-vs-AI games the busiest single scope used 17, so this is hundreds of
  times above real play and low enough that a runaway loop is stopped in milliseconds.
- **Scopes nest by sharing.** A trigger fired during a move is part of that move's
  work and spends the move's budget. A scope started outside any other gets a **fresh**
  budget, so a long game is never starved by an earlier turn. `engine.metered(label,
  fn)` opens one; the engine's entry points (`apply`, `useAbility`, `useCardAbility`)
  already do, and the card game wraps each move.
- **Out of gas** throws `OutOfGasError`, which says where and what was running — the
  repeating tail of the work, so the cycle is visible:
  `Out of gas in "apply": used 501 of 500 … Most recent work: effect:gauge,
  action:gauge, trigger:When this takes damage, deal 1 damage to this character., …`.
  It is announced once as `gas:exhausted` however many scopes it unwinds through.
- **A mandatory loop is a draw.** `Game.runLoop` ends a game whose play ran out of gas
  with no winner, as Magic's rules end a loop nobody can stop. Nothing else about the
  game is touched.
- **Off** with `gas: false`. `engine.gas.peak` is the most any scope has spent, for
  tuning the limit against real games.

### What it catches that the depth cap does not

Tested in `test/gas.test.ts`, each with the depth cap set absurdly high so only gas can
stop it: a trigger that triggers itself; two triggers that each start two more (2^depth
work, stopped in moments); a `Repeat` whose condition never turns false; a formula that
sums a million terms, stopped inside the sum; and a card-game match in which every
spell is one of those, which ends as a draw with `gas:exhausted`.

### The compiler's part

Gas is the backstop; the compiler says so earlier where it can. A `Repeat` with no end
is already an error. A trigger that **sets itself off again** — "when this takes damage
then deal damage to this character", or to *all* characters, which includes it; and the
same for healing — is a `trigger-loop` warning with the fix ("aim it at the source
character, or add a condition"). It is deliberately conservative: it recognises only a
trigger on "this" whose effect lands on "this" in the same direction, and never flags
retaliation at the source. A loop between two different characters (two thorns hitting
each other) cannot be seen statically, and is what gas is for.

## Implementation plan

Each slice leaves the suite green, in this order (dice reuse the shape of the
first two, so they come last):

1. **`select` over `Entity`** — ✅ built. Widened the types; a hand card is an option.
2. **`number` kind** — ✅ built. Request, answer, validation, `autoChoose`.
3. **Sealed round** — ✅ built. `askAll`, `choice:ready` / `choice:revealed` /
   `choice:forfeited`, hidden until reveal, judged at the reveal, and the
   open-sequential expansion unchanged.
4. **Choice rounds in the IR** — ✅ built. `EffectIR` gains `choose` (players,
   `secret`, a card-or-number `pick`), `reveal` and `moveChosen`; the binder runs
   them against `askAll` / `revealRound`; `validateRounds` (`src/ir/rounds.ts`)
   enforces the compile-time rules on the IR, so JSON documents are held to them
   too, and binding throws on an error. Tests: `test/choice-rounds.test.ts`.
4b. **English** — ✅ built. Three sentences, with the wording in one place
   (`src/english/rounds.ts`) so the parser's summaries and the IR renderer cannot
   drift:
   `All players commit a card from their hand face down.` (or `a number from 1
   to 6`, `You commit …`, `All opponents commit …`; the open form is `chooses`,
   with no `face down`), `When they are ready, reveal.` (`When all players are
   ready, reveal.` is read too), and `Each player puts the card they committed
   into their garbage.` (`chose` after an open choice). "The card they committed"
   always means the most recent choice, so the text needs no names. `commit` and
   the words around it are in the glossary.
   The compiler reports the table-procedure problems as diagnostics on the
   offending sentence (code `choice-round`), then binds with
   `allowUnsoundRounds` so a half-written card still previews. Tests:
   `test/choice-rounds-english.test.ts`. Not yet written in English: using the
   chosen *number* ("the player who chose the highest number …"), which needs
   player-targeted effects like `draws a card`.
5. **Roller + `roll` action** — ✅ built. `engine.roll(count, sides)` applies a
   `RollAction` through the pipeline; the numbers come from a `Roller` (async,
   replaceable with `setRoller` / the `roller` option) that defaults to a seeded
   stream of its own (`seed + ':dice'`), so a roll never shifts the trigger
   shuffle. Every answer is checked to be `count` whole numbers in `1..sides`.
   `roll:made { count, sides, results, source }` announces it. A roll carries
   `adjust` functions (`(results, reroll) => results`), which is how "add 1" and
   "reroll if low" are written as ordinary modifiers; a transformer adds to the
   list rather than replacing it. IR: `EffectIR.roll`, and `ValueIR.rolled`
   (`total` / `highest` / `lowest`) reads the latest roll of the resolution, 0
   before any. Tests: `test/dice.test.ts`. A runnable walk-through is `npm run example:rounds`
   (`src/examples/rounds-and-dice.ts`).
6. **English** — ✅ built. `Roll a d20.` / `Roll 2d6.` (the `d` is glued to its
   numbers). The outcome is read with **`that`**: `that value` (`that value` and
   `that value` mean the same; for one die it is the die), `that highest die`,
   `that lowest die` — anywhere an amount goes, and in a formula as `roll.total`.
   `That` is **always the most recent roll**. There is deliberately no `the
   total`: with several rolls it would not say which, and a second word for the
   same thing makes autocomplete confusing. Writing it gets an error that says
   what to write instead.

   To use an earlier roll, **store it**: `Store that value as AttackerRoll.` keeps
   a number under a name (letters only) for the rest of the ability, and the name
   goes wherever an amount goes: `Deal AttackerRoll damage to …`, or inside a
   formula, `(AttackerRoll * 2)`. The value is taken when stored, so a later roll
   does not change it. A name is stored once, may not be a word the language
   already owns (`count`, `total`, `roll`, …), and must be stored before it is
   read — each is a compile error pointing at the sentence. IR: `EffectIR.store`
   and `ValueIR.variable`; `MATH_ROOTS` is the list of names the language owns,
   so any other bare name in a formula is a variable.

6c. **Roll tables** — ✅ built. Conditions on a roll are written as a **table**, a
   result per line, in the Deck of Many Things shape (chosen from four options:
   plain result lines, `On`-lines, a table header, or `If`-sentences):

   ```
   Ability Deck of Many Things
   Roll a d20.
     1: Deal 25 damage to this character.
     2 to 5: Deal 5 damage to this character.
     6 to 19: Heal this character for 3.
     20: Draw(you, 2). Heal this character for 10.
   ```

   - A line is `<result>:` where the result is `N`, `N to M`, `N or more`,
     `N or less`, or `Otherwise`, then one or more sentences on that line. The
     lines sit directly under the `Roll` and are keyed on its total (for one die,
     the die).
   - The roll is **read once**; the first line it falls in runs. That is the
     reason for a dedicated node (`EffectIR.table`, in the same step as the
     `roll`) rather than `If that value is …` sentences: a line that rolls again
     would change what every later `If` read. Tested: result 1 rolls a 20 and the
     `20` line does not then run.
   - **A result no line covers does nothing** (chosen over making it an error).
     `Otherwise:` is the explicit catch-all, last and once.
   - Errors, each pointing at the line: a result the dice cannot make (`a d20
     never rolls 25 — it rolls 1 to 20`); two lines covering the same result
     (`"10 to 20" and "1 to 10" both cover 10`), because first-match would hide a
     typo; `Otherwise` out of place; a line trying to `target` (the pick is made
     before anything resolves — pick above the roll with `Target 1 character as
     Victim.`); a name used before it is stored; an empty line.
   - A roll inside a line has no table of its own.
   - Renders back as one line per result and round-trips exactly. Tests:
     `test/roll-table.test.ts`.
   - A one-off condition on a single sentence is covered by 6d below.
6d. **`If <value> is <test>`** — ✅ built. A condition on a number, so a roll (or a
   stored value) can gate one sentence without a table:

   ```
   If that value is 15 or more, Deal 50 damage to this character.
   If AttackerRoll is higher than DefenderRoll, Deal 10 damage to target enemy character.
   Repeat up to 10 times while that value is 3 or less: Roll a d6.
   ```

   - The value is any amount: `that value`, a stored name, or a formula.
   - The tests: `N` (equal), `N to M`, `N or more`, `N or less`; or a comparison
     with another amount — `higher than`, `lower than`, `the same as`.
   - It lowers to the **ordinary comparison predicate** the IR already has (`=`,
     `>=` and `<=` joined by `and`, `>`, `<`), so no new IR and JSON documents use
     it as is. It works wherever an `If` does: a sentence, a table line, a
     `Repeat … while`, and `Available while`.
   - It is *tried*, not assumed: `If the board is full, …` is not a value
     condition (`the` is not an amount), so it keeps the message that lists every
     shape the `if` accepts.
   - Names used in a condition are checked like any other (`"Missing" has not
     been stored`). Tests: `test/dice.test.ts`.
6b. **`draw(player, count)`** — ✅ built. One function of a player and a number
   (`src/games/cards/draw.ts`): move `count` cards from the top of the player's
   library to their hand, each a real move (so "when you draw" is answerable).
   What happens at the edges is the game's to say: `onEmpty` (Hearthstone's
   fatigue) and `maxHand` / `overflow` (the burn). The card game's `Side.draw` is
   now exactly this function with those two rules. In the language it is
   `Draw(you, 2).` / `Draw(all players, 1).` / `Draw(all opponents, 3).` — the
   count is any amount (`Draw(you, that value).`, `Draw(all opponents, Pages).`).
   IR: `EffectIR.draw`. Which `draw` runs: the host's (`BindOptions.draw`), else
   the one the game registered for its engine (`setEngineDraw` — a document is
   compiled once and played on many engines, so it asks the engine it runs on),
   else a plain draw over the aliased `library` and `hand`. Tests:
   `test/draw.test.ts`, and `test/card-game-english.test.ts` plays an authored
   spell through the real game, burn and all.
7. **Server roller** — secure source, state never leaves the server.
8. **Custom visibility** — ✅ engine built; the language is not. `ZoneVisibility`
   gains `'custom'`; a custom zone shows its cards to exactly `zone.viewers` (a real
   `Player[]`, empty until `engine.setViewers(zone, players)` sets it, replacing
   rather than adding). `engine.showTo(card, players, { until })` shows one card on
   top of its zone's rule, with the three lifetimes of §5: `'zone-change'` (the
   default — while it stays where it is), `'resolution'` (a one-time look, ended by
   `engine.resolution(fn)` even if `fn` throws) and `'manual'` (`grant.end()`).
   Grants stack as a union, so ending one leaves the others; a move within the
   same zone does not end one, a move to another zone does. `engine.canSee(player,
   card)` is the question a view is built from (the zone's rule or a live grant) and
   `engine.visibleMembers(zone, player)` the projection. `visibility:granted` /
   `visibility:revoked` announce a look **without the card**. Tests:
   `test/visibility.test.ts`. What is left of this slice is the wording that
   *builds* a list ("players other than its owner can see …"), which waits on a
   decision about how a zone and a player set are written in the language.
9. **Grants** — ✅ built. Capabilities (`declareCapability`, `grant`, `mayAct`,
   `revokeGrants`, four lifetimes, union and per-source revocation, `grant:added` /
   `grant:removed`, `showTo` as `grant(…, 'see')`) and abilities granted to cards
   (`setZoneAbilities`, `grantAbility`, `abilitiesFor`, `useCardAbility`, the three
   "this card" effects and their English), so the Boxed Present works end to end
   (§6).
10. **Server views** — ✅ built: `ViewProjector` (§5). The transport is not.
11. **Gas** — ✅ built (§7): the meter, the scopes, `OutOfGasError`, `gas:exhausted`,
   the draw on a stuck game, and the `trigger-loop` warning.
12. ⏳ **Peer-to-peer** — the hidden-zone protocol core is built (§5, `src/p2p/`);
   committed dice rounds (§4), signatures, the shuffler chain for 3+ players and the
   engine wiring are not, and it is not a priority: online play runs on a server.

## Tests (planned)

- Grants: a `'cast'` grant also lets the grantee see a face-down card, and ends
  that sight with it; a `'see'` grant never lets anyone cast; a card exiled from an opponent's library is castable by the grantee and
  not by the owner; a second effect granting another player does not disturb the
  first; ending one source removes only its grants; the default lifetime ends on
  leaving the zone; an empty grant set changes nothing about casting from hand;
  `mayAct` is false for a capability nobody granted.

- A sealed round: no answer is observable before the last chooser is ready;
  `choice:ready` carries no content; after `reveal` every binding resolves.
- Non-choosers are never waited on.
- A hand card is a valid `select` option; an illegal pick is rejected.
- `number`: non-integer, below `min`, above `max` are all rejected.
- Dice: same seed, same results; a roll does not change the trigger shuffle; a
  `roll` transformer can reroll; a table roller's out-of-range result throws.
- Committed rolls: the result changes if any one contribution changes; a reveal
  that does not match its commit is rejected; reveal order does not change the
  result; two rolls in a row differ and neither is derivable from the first; the
  same contributions under a different roll index give a different number;
  rejection sampling shows no modulo bias over many samples of a d6.
- Compile checks: each of the four errors above, with a message that says what to
  write instead.

## Open

- 🔶 **Coin results** — heads/tails. Labelled options (§3) now exist, so a coin can be a d2 whose faces are labels; to do later.
- 🔶 **Abstainers and timeouts** — a player who never becomes ready. Physical
  play resolves this socially; digital play needs a policy (auto-answer with
  `autoChoose`?). Parked until a networked client exists.
- 🔶 **Terms of a grant** — "spend mana as though it were any type", "you may
  cast it without paying". These modify the cost, not the permission, and belong
  with costs (deferred in the README). A grant may carry an opaque `terms` value
  for that slice to read; not designed here.
- 🔶 **Viewer lists: snapshot or live?** "Players other than its owner" resolves
  to a list when the keyword runs. If a player later leaves or the table changes,
  the list is stale unless the keyword is re-run. Snapshot is the simpler default;
  a live (re-evaluated) list is possible if a card needs it.
- 🔶 **Remote card-game moves** — the card game's `chooseMove` over the prompt channel,
  per-event sequence numbers for resync, and per-address rate limits on failed tokens
  (§5). The projection and the transport are built.
- 🔶 **Suppressing a printed ability** — "it loses all abilities" (§6, item 3). Needs a
  layering rule; no card needs it yet.
- ⏳ **Peer-to-peer** (deferred; hidden-zone core built in `src/p2p/`, using SHA-256):
  signing keys for the transcript, the last-revealer forfeit policy for committed dice
  (§4), the shuffler chain for three or more players, whether a third party may
  spot-check a shuffle mid-game rather than only at the end, and a cryptographic
  review before it carries anything that matters (§4, §5).
