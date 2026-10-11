# Handoff — continuing passive action modifiers

Read this, then continue. It is written so the next session does not have to
re-derive the design or re-litigate decisions already made.

## Where things stand

An **action modifier** is content that is a *function of an action* rather
than a thing that happens. It is split in two: a **match** (which actions)
and a **rewrite** (what changes about them).

| | |
| --- | --- |
| IR | `ModifierIR` / `ActionMatchIR` / `ActionRewriteIR` in [`src/ir/ability.ts`](../../src/ir/ability.ts) |
| Binder | `bindModifier` in [`src/ir/bind/ability.ts`](../../src/ir/bind/ability.ts) → `passiveActionModifier` |
| Grammar | `#parseModifierSentence` in [`src/english/parser.ts`](../../src/english/parser.ts); `lowerModifier` in [`src/english/lower.ts`](../../src/english/lower.ts); `modifierSummary` in `describe.ts` |
| Vocabulary | `MODIFIER_REWRITES`, `DIRECTION_WORDS`, `CHANGE_WORDS`, `GAIN_LOSS_WORDS`, `GAUGE_WORDS` in [`src/english/vocabulary.ts`](../../src/english/vocabulary.ts) |
| Tests | the `action modifiers` describe in [`test/english.test.ts`](../../test/english.test.ts) |
| Docs | "Action modifiers" in [`docs/creator/01-ability-language.md`](../creator/01-ability-language.md) |
| Entity hooks | `Character.lifeGauge` (which gauge a change aims at) and `Character.handleDamage`/`handleHeal` (how it lands, at the very end) in [`src/engine/character.ts`](../../src/engine/character.ts); [`test/gauge-landing.test.ts`](../../test/gauge-landing.test.ts) |
| Display | `src/ir/rewrite-math.ts` — a stack of `ActionRewriteIR` read back as one number or one formula; [`test/rewrite-math.test.ts`](../../test/rewrite-math.test.ts) |
| Formulas | `#expectAmount`/`#parseMath*` in `parser.ts` — a formula wherever a number is expected; see "Formulas wherever a number is expected" below |

What a creator can write today:

```
Buff Rage (stacks)
Outgoing damage is increased by 5.

Buff Berserk
Outgoing damage has a 25% chance to be multiplied by 3.

Buff Iron Hide
Incoming damage from enemy characters is capped at 50.

Buff Mana Ward
Incoming mana loss is prevented.

Buff Mana Shield
Incoming damage is redirected to mana.
```

Two sentence frames — `<subject> is <rewrite>.` and `<subject> has a <n>%
chance to be <rewrite>.` — where `<rewrite>` is one of `increased by n`,
`reduced by n`, `multiplied by n`, `doubled`, `halved`, `capped at n`,
`prevented`, `redirected to <gauge>`, and `<subject>` is:

```
outgoing|incoming damage|healing [from <characters>]
outgoing|incoming <gauge> gain|loss [from <characters>]
```

`damage`/`healing` claim the target's **life gauge** (`ActionMatchIR.gauge`
= `{ kind: 'life' }`); naming one (`mana gain`/`mana loss`) claims that
gauge instead. `from <characters>` narrows by whoever is on the *other
side* of the action from the wearer (bare group form, no quantifier —
same shape as a trigger's subject: adjective, `owned by`, `with`).

## The gaps, with evidence

**1. `ActionMatchIR.target` has no grammar.** ~~Done~~ — `from
<characters>` now lowers to `ActionMatchIR.target` (`ModifierSentence.target`
in the AST, a bare `CharsPhrase` like a trigger's subject — see
`#parseModifierSentence` / `lowerModifier` / `modifierSummary`).

Fixing the grammar surfaced a real bug in `bindModifier`'s existing
`targetCheck` wiring, worth flagging since the field was believed to
already work: it always checked the action's **victim** —
`characterOf(action.target)` — against the predicate. For an `outgoing`
match that is correct (the victim is whoever the wearer is hitting). For
an `incoming` match it is not: the victim *is* the owner (an incoming
action's gauge write lands on the character whose own transformers are
running), so checking the victim there tests "is the wearer its own
enemy" — always false. `bindModifier` now resolves a separate `other` —
the victim for `outgoing`, the action's source resolved to a `Character`
for `incoming` (`undefined`, and so never matching, when the source is a
buff with no caster, e.g. a poison tick) — and checks the predicate
against that instead. See the `from` tests in the `action modifiers`
describe block, including the buff-sourced-action one, for the behaviour
this fixed.

**2. `ActionMatchIR.gauge` has no grammar either.** ~~Done~~ — a named
gauge now has its own change words: `<gauge> gain|loss`
(`GAIN_LOSS_WORDS` in `vocabulary.ts`), the generic-gauge spelling of
`damage`/`healing` (`loss` ↔ `damage`, `gain` ↔ `heal`). Naming one
(`incoming mana loss is prevented.`) sets both `change` and `gauge` on the
match. The binder's existing `match.gauge && action.target.id !==
match.gauge` check needed no fix at the time — unlike gap 1, it reads the
gauge actually being written, which is the same gauge regardless of
direction (no owner/victim split to get wrong); it has since grown a
second form for the life gauge (see the revised decision below).
Composes with `from`: `incoming mana loss from enemy characters is
prevented.` parses and lowers both.

**3. Redirect.** ~~Unbuilt~~ — done. `{ kind: 'redirect', gauge: string }`
on `ActionRewriteIR`, grammar word `redirected to <gauge>`
(`GAUGE_WORDS` again, same as a named-gauge subject). `bindModifier`
doesn't call the engine's `redirectGauge` — it can't: that primitive is
built on `replaceAction`, which matches on the **raw, pre-pipeline**
action, where `bindModifier` is already deep into per-modifier match
checks (direction, gauge, change, target, chance) by the time it knows
whether *this* modifier redirects. So it builds the replacement action
by hand instead — same shape `redirectGauge`'s own `build` function
produces (same gauge, same captured `delta`, same re-stamped `intent`),
checked for exact equivalence against a hand-built `redirectGauge` buff
in `test/english.test.ts`. The `from(target)` gauge in `redirectGauge`'s
signature has no equivalent here: the IR's "from" is whatever the match
already filtered to (`match.gauge` — a named gauge, or the life-gauge
form), and redirect's own field is only the destination. The engine's `Character`
to redirect *within* is the gauge's actual owner (`victim` in
`bindModifier`'s existing naming) — not `owner`, which for an `outgoing`
match is the actor, a different character than whoever's gauge is being
written. A no-op (passes the action through untouched) when the
character has no gauge by that id, or when it's the same gauge the
action already targets. `src/ir/rewrite-math.ts` treats it as the one
non-arithmetic step that doesn't even floor to zero: the magnitude is
untouched (only *where it lands* changes), so it's invisible in the
merged equation and shows up only in the step list, as `redirected to
<gauge>`.

**4. Replacement is unbuilt.** `replaceAction(match, build)` likewise
unreferenced by the IR. It is the general "prevent the old action, emit a
new one" primitive — *"if it would die, exile it instead"*. Bigger than
redirect, and it interacts with zones.

**5. Modifiers only see `gauge` actions.** `bindModifier` returns early for
anything else, so buffs, moves and destroys pass through untouched. Opening
this up means deciding what "magnitude" means for a non-numeric action —
probably that only `prevent` and replacement apply.

## Decisions already made — do not relitigate

- **Rewrites operate on the change's *magnitude*, never the resulting
  value.** "Increased by 5" is five more damage whichever way the gauge
  moves, so authors never touch signs, and two modifiers compose instead of
  fighting over whose subtraction wins. The magnitude is read by evaluating
  the action's own `update` against the gauge's real values and rescaling,
  so an amount computed *from* the gauge rescales rather than being
  flattened.
- **The magnitude may go negative mid-chain; only the final, settled
  result is floored at zero, once.** *(Revised this session — the
  original wording here said "magnitudes never go below zero" per step;
  that turned out to be the wrong place for the floor.)* "Reduced by 10"
  then "increased by 5" on 8 damage is `8 − 10 + 5 = 3`. Flooring after
  **every** step instead (the old behaviour) makes a chain order-sensitive
  in a way the magnitude isn't supposed to be: once a step floors to
  exactly zero, a later `add`/`multiply`/`cap` can't tell that from a
  genuinely zero-magnitude action, so it never revives — "reduced by 10"
  then "increased by 5" on 8 damage gave 0, not 3. The one floor lives in
  `GameEngine#applyGaugeBatch` (`src/engine/engine.ts`), exactly where the
  fully-composed change reaches the gauge, clamped against the action's
  `intent` so a damage action still can never net out as a heal — "reduced
  by 50" then "increased by 5" on 10 damage nets to −35 by the pure
  arithmetic, which the floor still catches as 0 damage. `bindModifier`
  itself (`src/ir/bind/ability.ts`) does no clamping at all any more.
- **Damage-or-healing is decided from the action's `intent`, fixed at
  creation — not from the signed delta at this point in the chain.**
  *(Also revised this session, and for the same reason: once the floor
  moved to settle-once, the live delta's sign stops being a reliable
  signal, because an earlier rewrite overshooting past zero flips it.)* A
  modifier scoped to `incoming damage` still applies to an action that has
  *currently* overshot into looking like a heal, because `intent` doesn't
  move even though the running change does. An intent-less raw gauge write
  (no `damage`/`heal` sugar) has no such anchor and falls back to the live
  sign, same as before — this case is unaffected.
- **"Damage" is the *life gauge*, not every gauge — and it means that in
  every corner of the language.** *(Revised after gap 3 — the original
  decision had `damage`/`healing` claim a loss/gain on any gauge at
  all.)* The word had drifted into meaning `'hp'` in **four** places,
  three of which failed silently on anything whose life is elsewhere;
  all four now share one selector (`string | { kind: 'life' }`) and one
  resolver (`gaugeIdOf` in `bind/ability.ts`):
  1. a modifier subject (`ActionMatchIR.gauge`) — the first one fixed;
  2. `Deal`/`Heal` effects (`EffectIR.gauge`) — wrote a literal `'hp'`,
     so `Deal 5 damage` did **nothing** — no diagnostic — to anything
     whose declared life gauge is not `hp`;
  3. the trigger event phrase (`TriggerIR.gauge`, `EVENT_PHRASES`) —
     `when this takes damage` never fired for the same reason;
  4. the `declared-fn` escape hatch's gauge action, whose omitted gauge
     defaulted to `'hp'`; now the target's life gauge, and loud (it
     throws, matching that layer's `findGauge`) when there is none.

  `lifeGauge` answers "which gauge does the pipeline *aim* at", and a
  permanent type can answer it either way — declared in the def, or
  `override get lifeGauge()` on a subclass (both verified). What it does
  **not** decide is how the change finally lands; that is
  `Character.handleDamage`, below.
- **How a change *lands* is the entity's own business, asked once at the
  very end — `Character.handleDamage` and `Character.handleHeal`.** A
  permanent type overrides them to resolve a change its own way (a ward
  gauge soaking the first points of damage; healing past full spilling
  into that ward instead of being lost) and returns the writes to apply,
  or `undefined` for the default. Both take a `GaugeLanding` and return
  `GaugeLandingWrite[]` — named for the moment rather than for damage,
  since both sides share them. (`GaugeWrite` was taken: it is a public
  `gauge:changed` event shape in `events.ts`.) It is called from `#applyGaugeBatch`, at the same
  write point as the `intent` floor — so what it sees has already been
  through every passive modifier, the restrictions gate and that floor,
  and what it returns is applied **as-is**: no transformers, no gate, no
  second `handleDamage`. That is the point of asking there rather than
  earlier, and it is what separates it from a `redirect` modifier, whose
  rewrite *does* keep flowing through whatever comes after it.
  Writes it sends to a gauge the batch never aimed at are registered for
  the netted events, so they report as real `gauge:changed` changes.
  Only `damage` and `heal` intents are routed, each to its own hook; plain
  gauge movement (`'other'`/`'set'`) is never routed. The gauge's own
  `[min, max]` clamp still applies to every write a hook returns, so an
  overflow rule does not have to avoid overfilling — only decide where the
  spill goes. Tests:
  [`test/gauge-landing.test.ts`](../../test/gauge-landing.test.ts).

  **Known consequence, not yet decided:** routing damage off the life
  gauge means the life gauge never changes, so `when this takes damage`
  does not fire — a ward that soaks a hit whole reads as "no damage
  happened". A `redirect` modifier already behaves the same way for the
  same reason, so the two are at least consistent, but whether an
  absorbed hit *should* count as damage having been dealt is a game
  question nobody has answered yet. There is also no way to catch the
  ward gauge's own change in the language — the trigger vocabulary has
  only `die`/`survive`/`takes damage`/`is healed`, all life-gauge or
  destruction shaped.

  The declarative effect path *skips* an entity with no such gauge rather
  than throwing — an effect can legitimately span a mixed group — while
  the hand-written `declared-fn` path throws. That split is deliberate.

  The modifier match resolves per action against the **victim's** own
  `Character.lifeGauge` — the victim's, not the actor's, even for an
  `outgoing` match, since "damage you deal" is damage to the thing you
  hit and which gauge counts as its life is its question. Deliberately
  *not* the literal id `'hp'`: the engine puts no meaning on any gauge id
  (`Character.gauge`'s own doc), so hard-coding one would be the language
  inventing a concept the engine refuses to have — and the point is that
  one word keeps working as more entity kinds arrive, a card game's
  planeswalker taking "damage" on its `loyalty` with no sentence
  changing. A thing that declares no life gauge has nothing
  `damage`/`healing` can claim. Everything else is named outright
  (`mana loss`). What this gives up: "a loss on *any* gauge" is no longer
  spellable in English, only in hand-written IR (omit `gauge`). A generic
  word for the non-life gauges — "magic" was floated — was considered and
  deferred, not rejected.
- **`outgoing` excludes the owner's own gauges.** "Damage you deal" does
  not catch a self-inflicted cost. Same rule as `the source character`
  excluding its own owner.
- **Stacking needs no arithmetic.** The engine runs *every* attached
  instance's modifier, so a `(stacks)` buff with "+5" is +15 at three
  stacks. There is no per-stack multiplier to write. (The hand-written
  `rage` carries a `vars.stacks` that turns out to be unnecessary.)
- **Declarative, not imperative.** A modifier is a standing rule, so
  "incoming damage **is capped at** 50" — not "cap incoming damage". The
  imperative form was shipped and then deliberately removed; do not bring
  it back as a synonym.
- **One phrasing per concept.** This project has repeatedly rejected two
  spellings whose difference is invisible to a reader.
- **A chance is rolled per action**, after everything else matched, from the
  engine's seeded PRNG. It shares the stream with the trigger shuffle; that
  is accepted and documented, not a bug to fix.

## The standard this work is held to

The Rage test is the pattern: compile the English, run it on the same board
as the hand-written `passiveActionModifier` in
[`src/examples/08-27-2026/buffs/rage/index.ts`](../../src/examples/08-27-2026/buffs/rage/index.ts),
and assert the HP totals are **identical** at one stack and at three. Any
new modifier capability should get an equivalence or behaviour test of that
kind rather than a lowering-shape test alone.

Also: `npx tsc --noEmit -p tsconfig.json`, `npm run build` and
`npx vitest run` must all be clean. 855 tests pass as of this handoff
(745 at the start of this session, plus gaps 1 through 3, the
magnitude/intent revision, the new `rewrite-math` suite, and the
formula-grammar work — the jump is larger than that alone accounts for
because an unrelated concurrent refactor landed mid-session:
`win`/`lose`/`isAlly`/`isEnemy` and turn/round handling moved out of the
core engine into `src/games/round-based`, with its own added test
coverage. Unrelated to this work; noted only so the count isn't
confusing).

## Reading a stack of modifiers back as one equation

`src/ir/rewrite-math.ts` takes an ordered list of `ActionRewriteIR` (the
rewrites several stacked modifiers contribute to the *same* matched
action) and reads it back two ways instead of N English sentences:

- `rewriteChainToLatex(chain)` — one LaTeX formula, e.g. `reduced by 10`
  then `increased by 5` renders as `\max\left(0, x - 10 + 5\right)`.
  `foldRewriteChain` merges a run of `add`/`subtract` into one net `add`
  first (safe now that nothing floors mid-chain — see the revised
  decision above), and a run of `multiply` into one, preferring a small
  fraction over a decimal (`×3` then `×0.5` renders `\frac{3}{2}`, not
  `1.5`). `cap` renders as `\min`; `prevent` collapses everything before
  it to a flat `0`. Pass `{ settled: false }` to see the pure arithmetic
  with no outer floor.
- `rewriteChainSteps(chain)` — the original, unfolded entries as a plain
  list (`['−10', '+5']`), the trace back to what each modifier actually
  wrote, as opposed to the merged net result above.

`applyRewriteChain`/`settle` are the reference arithmetic both of those
are checked against, and are checked themselves against the real engine
in `test/rewrite-math.test.ts` — not just against each other, since the
whole point of this module exists because a plausible-looking merge was
*wrong* at exactly the input that matters most (see the revised decision
above). This is **display only** — nothing calls it from `bindModifier`
or anywhere else in the engine. Not yet done, and worth asking the user
about before starting:

- **Where this surfaces.** No editor UI exists for it yet — right now
  it's a tested utility with no caller. Wiring "show me this character's
  current incoming-damage formula" means gathering the actual stack of
  `ModifierIR` matching a given shape (direction/change/gauge/target) off
  a live character, which this module deliberately doesn't do.

## Formulas wherever a number is expected

~~Authoring by equation~~ — done, this session, for the six slots backed
by `ValueIR` (everywhere else a number is really a compile-time buff
declaration — `weight <n>`, `for <n> turns` — with no `ValueIR` behind it
at all, and was explicitly left out of scope): `Deal <n> damage`, `Heal
… for <n>`, a modifier's `increased/reduced/multiplied by <n>` and `capped
at <n>`, a modifier's `<n>%` chance, and a `with <gauge> <op> <n>`
comparison. A bare number is just the trivial case of the same grammar —
there's no separate "formula mode" to opt into:

```
Deal (this.hp / 10) damage to target enemy character.
Incoming damage is reduced by (1 + 2).
Destroy all enemy characters with hp < (this.hp / 2).
```

What this touched, and why:

- **A native sub-parser, not a text re-lex.** `#expectAmount`/`#parseMath*`
  in `parser.ts` mirror `parseMathExpression`'s grammar
  (`src/ir/math-expression.ts`) exactly — same precedence, same
  `MathExpression` output — but run over this parser's own token stream
  instead of re-tokenizing a text span. `parseMathExpression` expects to
  own the whole input (`parser.expect('eof')`); embedded in a sentence,
  a formula has to stop cleanly at whatever follows (`damage`, the
  sentence's own `.`, `%`) without knowing that boundary up front, which
  only works parsed natively against the real token stream.
- **The AST fields this touched became `MathExpression`, not `number |
  MathExpression`.** `DealSentence.amount`, `HealSentence.amount`,
  `GaugeCondition.value`, `ModifierSentence.chance`, and the `amount`
  rewrite's `by` / `cap`'s `at` — a bare number is `{kind:'number',
  value}`, the trivial case of the same type, not a separate branch to
  keep handling everywhere downstream. `lower.ts`'s `amount()` maps that
  trivial case to `ValueIR.const` (unchanged IR shape, so every existing
  lowering-shape test kept passing untouched) and anything richer to
  `ValueIR.expr`.
- **A property-access dot needs zero whitespace on both sides
  (`this.hp`, not `this . hp`) to be told apart from the sentence's own
  ending period** — `self.hp.` (property access, then the sentence ends)
  is syntactically identical to a dot that's just the period, one token
  lookahead. Adjacency (checked via token offsets, not `atLineStart`,
  which breaks when a line holds two sentences) is what resolves it; see
  `#parseMathPrimary`'s path-continuation loop and the regression test
  named for it in `test/english.test.ts`.
- **`Heal <n> to <characters>` vs. `Heal <characters> for <n>` is a
  genuine ambiguity a bare-identifier formula can't cross.** A formula
  starting with a word (`this.hp` with no parens) looks exactly like a
  chars-phrase quantifier at that position, so the amount-first word
  order only fires when the next token is a number, `(`, or `Σ`/`∑` — a
  bare-identifier formula needs the `for <n>` order instead, or
  parens. Documented as a real, permanent constraint, not a bug to fix.
- **`this.hp` needed a binder-side fix, not just grammar.** The formula
  context's `self` key (pre-existing, but never reachable or tested
  before this) is renamed to **`this`** — the word the rest of the
  grammar already uses for the ability's own owner — and, more
  importantly, now maps the `Character` to a **plain object of its
  gauges** (`this.hp`, `this.mana`, any custom gauge, each gauge's max
  under `<id>Max`, plus `this.speed`) rather than passing the `Character`
  instance straight through. `Character` has no `.hp` property any more
  (post-refactor, gauges are `.gauges`/`.gauge(id)` only — see the
  `Character.gauge(id)` note elsewhere in this file), so without this,
  `this.hp` in a formula would have silently resolved to `undefined` and
  thrown at cast time. `subjects`/`sources` (the event-bound arrays) and
  `ctx.subject` (the candidate a group filter is testing, exposed as
  `subject`) go through the same translation. Named stats
  (`Character.stat(name)`) aren't reachable from a formula at all yet —
  that needs a call-expression node in `MathExpression` itself, which is
  a bigger, separate change to shared infrastructure (`declared-fn` also
  depends on that type) that nothing here asked for.
- **No new vocabulary, no new diagnostics beyond the parser's own.** A
  malformed formula reports through the same `#fail`/`#failHere` path
  every other construct in this grammar uses — no special-cased error
  messages were added.

## Suggested order

1. ~~**`from <characters>` on the subject** → `ActionMatchIR.target`.~~ Done.
2. ~~**A gauge in the subject** (`incoming mana loss`) → `ActionMatchIR.gauge`.~~
   Done.
3. ~~**Redirect** as a new rewrite kind, over `redirectGauge`.~~ Done.
4. **Replacement**, and only then non-gauge actions. Next up — bigger than
   redirect (see gap 4 above: it interacts with zones), and `replaceAction`
   itself (unlike `redirectGauge`) may be directly reusable from
   `bindModifier` rather than needing a hand-built replacement action —
   worth checking before assuming otherwise, the way redirect turned out
   to need one.

Note for whoever picks up replacement: this file's own paths may
have drifted by the time you read it. A large, unrelated refactor was
landing concurrently with gaps 1 and 2 — `win`/`lose`/`isAlly`/`isEnemy`
and turn/round handling moved out of the core engine into
`src/games/round-based`, `Character.hp`/`.mana` convenience accessors
became `Character.gauge(id)`, and the example buffs moved from
`src/examples/08-27-2026/buffs/…` to
`src/games/turn-based/content/buffs/…`. Re-check paths and APIs against
the current tree rather than trusting old references here or in git
history.

## Unrelated, but queued behind this

Gauge-qualified effects (`Deal 18 mana damage`, `Restore 5 mana`) are a
prerequisite for referencing a realized amount — the planned spelling is
**`the net amount`** ("net" because the engine already nets a batch's
writes), with an open question about whether an *overkill* amount needs its
own name alongside it.
