# 18 — Two surfaces, one document: English text and Blockly blocks over the IR

> **Status:** ⏸ **parked.** Both halves were built and verified; the Blockly
> half was then **removed from the tree** — a second editor plus Blockly's
> ~1 MB of JavaScript was more than the project wanted to carry for a direction
> it was unsure about. This doc is now the *design record* for rebuilding it,
> including the two traps that cost real time (the dropdown rewrite, the
> targeting gap).
>
> What was **kept** is the IR → English half: `src/english/render.ts` and
> `test/render.test.ts`, which add no dependency and are useful on their own —
> they are what makes a document readable, and what a card ⇄ text codec would
> sit on. The *evidence* below still holds, and the size conclusion stands
> without Blockly: **a card is 98 B of English against 607 B of a workspace**,
> and English is today the only *complete* shareable artifact for a card (a
> compiled card holds engine closures, and `DocumentIR` is the ability fragment,
> so a card's `Cost` and stat line do not survive a trip through it).
> Extends [docs/GOAL.md](../GOAL.md) (the creator surface, the IR as share
> format) and the language spec
> [docs/creator/01-ability-language.md](../creator/01-ability-language.md).

## The idea

> *"Can we integrate both English and Blockly? English/Blockly gets converted
> to IR, and IR can be converted back to English/Blockly depending on what the
> user would prefer to see."*

One document, several views. A player who thinks in sentences writes English;
a player who thinks in pieces drags blocks; a player who wants the raw form
reads the IR. All three are the same document, and any of them compiles,
saves, shares and plays identically.

This doc decides **what the pivot is**, reports what has been **measured**,
and lays out the block surface, the sync rules and the invariants that keep
the surfaces from drifting apart.

## What the pipeline already is

The three layers exist and the seams are in the right places:

```
  text ──parse──► AST ──lower──► DocumentIR ──bind──► engine content
  parser.ts      ast.ts  lower.ts   src/ir/    src/ir/bind
```

- `src/english/describe.ts` already renders content **back** to English —
  `effectSummary`, `triggerSummary`, `modifierSummary`, `charsToString`,
  `conditionToLatex`. It is what the preview pane, an ability's generated
  `description`, and the battle log are built from.
- `examples/rts/src/english/codegen.ts` already proves the shape "IR → a
  second surface" inside this repo (`npm run rts:codegen`, committed output
  the project's own `tsc` checks).

So the pieces for "IR → English" are mostly present. What is missing is that
**`describe.ts` is a summary, not a printer**:

| Finding (measured) | Consequence |
| --- | --- |
| `effectSummary` and `modifierSummary` are already an exact fixpoint: re-parsing the summary yields the identical AST | the printing logic is largely written, it just is not a printer yet |
| `triggerSummary` writes `When …, <effect>.` with a comma, but the grammar requires `when … then …` — the rendered trigger **does not re-parse** | triggers need their own print path |
| The lexer has no comment token (kinds are `word`, `number`, `punct`, `eof`); `Doc` has no comment node | comments cannot survive a text → blocks → text trip |
| Nothing in the repo consumes `DocumentIR` to produce text | the direction to build |

### The second surface already exists

`src/english/card.ts` (in the working tree, not yet committed) is a **Card
Document** surface — `Card Fireball` / `Cost 4` / `Spell`, `Creature 1/4`,
`Taunt.`, `Battlecry: …` — and its header says the thing this doc argues:

> *Every effect line is handed to the real Ability Language compiler
> (`compileDocument`), so a card's effect **is** an engine `cast` ability — the
> same code path, the same diagnostics, the same IR.*

Three things follow, and one of them corrects this doc's own wording:

1. **The IR pivot is already the working pattern here.** A second surface was
   added without a second checker, a second set of diagnostics or a second
   binder. A Blockly surface is the same move with a visual syntax instead of
   a line-oriented one.
2. **`DocumentIR` is the *ability* fragment, not the whole document.** A
   `CompiledCard` carries `cost`, `kind`, `power`/`health` and `keywords`
   *outside* the IR, because the ability IR has no slot for them. So "the IR
   is canonical" must be read **per surface family**: a card document needs a
   card document IR that embeds ability IRs, exactly as `CompiledCard` wraps a
   `DocumentIR` today. Blocks for the card surface then get cost, creature-stat
   and keyword blocks too — a canvas wider than the sentence grammar, again.
3. **The span-mapping mechanism already exists in miniature.** That module owns
   *"a line map that translates the compiler's spans back into the player's
   document so squiggles land on the words that caused them."* Blocks need
   exactly that, one level over: diagnostic span → IR path → block id. The
   problem is not new to this repo, only the target is.

## The pivot: the IR, with one rule

**Decision: the `DocumentIR` is the canonical document.** English text and the
Blockly workspace are both *views* rendered from it, and both are *codecs*
back into it:

```
   English text ──parse──► AST ──lower──►┐
                                         ▼
   Blockly workspace ──fromBlocks──►  [  IR  ] ──bind──► engine content
                     ◄──toBlocks────     │
                                         └── render ──► English text
```

Why the IR and not the AST:

1. **The IR is already the share format** (docs/GOAL.md: *"the language and the
   share format are the same problem"*). Editing the thing you export means
   one model to validate, version and reason about — not two that must agree.
2. **The IR is a superset of what English can say, and the blocks should not
   be capped the same way.** GOAL.md priority 3 is *"a canvas, not a form"*:
   blocks can expose the whole IR (`set`, named gauges, multi-effect steps,
   `count` as an amount) where the sentence templates cannot. A block surface
   that can only re-say the sentences would be a second spelling, not a canvas.
3. **One canonicalizer.** Any surface may be lossy *in presentation*; only the
   IR is the truth, so there is exactly one place where two documents are equal
   or not — which is what makes sync, undo and import/export tractable.

The one rule that makes an IR pivot pleasant instead of infuriating:

> **A surface that is being edited is authoritative; a surface that is merely
> shown is rendered from the IR — and only when the IR changed since that
> surface was last in sync.**

Concretely the editor keeps `{ ir, revision, text, textRevision, workspace,
workspaceRevision }`. Typing in English recompiles to a new IR and bumps
`revision`; switching to Blocks rebuilds the workspace *only if*
`workspaceRevision < revision`. Editing blocks bumps `revision`; switching
back to English re-renders the text *only if* `textRevision < revision`.
A pure view switch therefore touches nothing: the author's exact wording, and
their comments, survive. Normalization happens only where the author changed
the document in a different surface — which is what a formatter is for, and
which the UI can say out loud once ("the block view reformatted this
document").

## Evidence: IR → English is exact for the whole current surface

A prototype of `lower.ts`'s inverse (`renderDocument(ir)`) was written and run
against 12 hand-built documents covering every construct, plus the **40** valid
`Ability`/`Buff` documents embedded in `test/english.test.ts` (the RTS example
is a separate dialect with its own IR and its own codegen, so it is not part of
this corpus).

```
12/12 hand-built documents: IR → English → IR canonically identical
40/40 test-suite documents: IR → English → IR canonically identical
 0 unsupported nodes across 52 documents
```

The corpus covers every effect (`Deal`, `Heal`, `Destroy`, `Add`, `Remove`,
`Toggle`, `You/All players win|lose`), every query (`this`, `target …`,
`the <binding>`, `the source character`, `all [other] [ally|enemy] characters
owned by … with …`), every predicate (`compare`, `and`, `or`, `not`,
`hasBuff`, `relation`, `parity`, count ranges `2 to 5` / `3 or more` /
`3 or less`), `If …,` guards (all three readings), `You may …`, every `Repeat …`
clause combination, named `Target … as …` bindings, `Available while …`,
`when … then …` triggers in both scopes, all modifier forms, buff options
(`stacks`, `weight`, `for n turns`, `until end of turn`) and `import`.

What the round trip does **not** reproduce, exhaustively:

| Difference | Kind | Handling |
| --- | --- | --- |
| `# comments` | real user content | lost today; keep the text when it is in sync (the rule above), warn once on the first block edit that drops them, and add comment trivia in a later slice (see Open questions) |
| bare `this` vs `this character` | presentation only — the IR has one node `{kind:'self'}`, and the parser rejects `this` with a `with …` clause, so nothing rides on it | the renderer picks one spelling per sentence frame (`this character` for an effect, `Toggle X.` for a toggle); the only visible effect is the derived `description` string |
| `description` and a trigger's/modifier's generated `name` | **derived** strings, recomputed by `lower` | not canonical; regenerate, never diff |

Places where the IR legitimately says more than English — where the English
view must show *something* rather than drop the content (`render` should
return `{ text, gaps }` and the UI a visibly marked placeholder):

- `gauge` with `op: 'set'`, or a **named** gauge (`'mana'`) — English has only
  `Deal`/`Heal` on the life gauge;
- `ValueIR` that is not a `MathExpression`: `count(query)`, `gauge(of)`;
- a `StepIR` holding several effects (an ability step resolves one sentence at
  a time, so splitting it would change semantics);
- `PredicateIR.always`, `compare` of two `ValueIR`s, `relation` in places the
  sentence grammar has no frame for;
- `TargetingIR.count` as a `[min, max]` tuple.

These are exactly the constructs that justify a block surface, which is why
they are a feature of the plan and a footnote of the renderer.

## The block surface

Blocks mirror the **IR's grammar**, one block type per IR node, and Blockly's
typed connections do the type-checking:

| IR | Block | Connections |
| --- | --- | --- |
| `DocumentIR` | workspace root | — |
| `AbilityIR` / `BuffIR` / `TriggerIR` / `ModifierIR` | `ability_definition`, `buff_definition`, `trigger`, `modifier` | statement chains |
| `TargetBindingIR` | `target_binding` | statement, inside an ability |
| `StepIR` | `step` (optional / repeat inputs) | `Statement` |
| `EffectIR` | `deal`, `heal`, `destroy`, `add_buff`, `remove_buff`, `toggle_buff`, `result` | `Statement`, with `Query`/`Value` inputs |
| `EntityQueryIR` | `self`, `picked`, `bound`, `event_source`, `all` | output `Query` |
| `PredicateIR` | `compare`, `and`/`or` (mutator, n-ary), `not`, `parity`, `any`/`every`, `has_buff`, `relation` | output `Predicate` |
| `ValueIR` | `const`, `count_of`, `gauge_of`, `formula` (a text field parsed by `parseMathExpression`) | output `Value` |
| `ActionMatchIR` / `ActionRewriteIR` | `match` / `rewrite` family | inputs on `modifier` |

Why this is worth a dependency rather than a bespoke React editor:

- **Connection checks are GOAL.md priority 2 made visual.** `setOutput`/
  `setCheck` refuse a `Value` where a `Predicate` belongs — the same
  discipline the English grammar enforces with diagnostics and the engine
  enforces with types, now enforced by the drag itself.
- **Fields become discovery.** `has_buff` and `bound` are dropdowns built from
  the document's own `Buff` declarations and `Target … as …` names — the same
  data `BuffDictionary` and `DefinitionIndex` already compute for Monaco's
  autocomplete.
- **Rendering, drag, zoom, keyboard, serialization and undo come free**, and
  blocks are already a familiar surface to the audience GOAL.md targets.

What the Blockly documentation confirms (checked against
[docs.blockly.com](https://docs.blockly.com/) and `blockly@13.3.0`, which ships
its own `index.d.ts`):

- **Definitions.** JSON block definitions are the recommended form
  (`Blockly.common.defineBlocksWithJsonArray([…])`, or
  `createBlockDefinitionsFromJsonArray` + `defineBlocks`; `block.jsonInit`
  to mix). The docs are explicit that JSON **cannot** define mutators or
  validators — those are JavaScript, usually as extensions.
- **Variable-arity inputs** (`and`/`or`, `all` with several clauses) are the
  documented mutator case: `saveExtraState`/`loadExtraState` for the JSON
  system (which writes an `extraState` property), with `compose`/`decompose`/
  `saveConnections` for the built-in gear UI — or the `@blockly/block-plus-minus`
  plugin. Notably, a shape that changes from a **dropdown** needs no mutator at
  all; a field validator will do. Both idioms fit our nodes.
- **Serialization.** `Blockly.serialization.workspaces.save(workspace)` /
  `.load(state, workspace)`; JSON is the recommended format (XML is iceboxed).
  The deserialization order is documented, block attributes include `x`, `y`,
  `collapsed`, `disabled` and `data`, and comments are block **icons**.
  Anything else (e.g. workspace-level state) needs
  `Blockly.serialization.registry.register(name, { save, load, clear, priority })`
  — which is exactly the hook we would use if a document-level annotation ever
  needs to ride the workspace.
- **Change events.** `workspace.addChangeListener(fn)` with
  `event.type === Blockly.Events.BLOCK_CHANGE`, `event.element`,
  `event.oldValue`/`newValue`; blocks also take `setOnChange`. The docs warn in
  as many words that a listener can *"cascade or loop back"* — and Google's
  **mirror demo keeps two workspaces in sync through events**, which is
  precisely our text ↔ blocks loop, so the known-hard part has a published
  prior art to copy rather than invent.

All four questions were answered while building slice 2, three of them by
experiment rather than by reading:

- **Headless works.** `new Blockly.Workspace()` under vitest builds, serializes
  and reloads blocks with no DOM and no jsdom — so the block tests run in the
  ordinary suite. Only `Blockly.inject` (the SVG editor) needs a document.
- **Programmatic loads are silent.** `Blockly.Events.disable()`/`enable()` exist
  and wrap the load in `src/blocks/index.ts`, which is what breaks the
  render → change-event → re-render loop at the source. Change events also carry
  `isUiEvent`, so selection and viewport changes are filtered out before they
  are mistaken for edits.
- **Media needs shipping.** Blockly builds the URLs of its sounds, cursors and
  trash icon at runtime, so Vite cannot see them as imports and left them out of
  the bundle. A small `blockly-media` plugin in `src/ui/vite.config.ts` serves
  and copies the package's `media/` directory, and `Blockly.inject` is told
  where it is.

### One trap worth writing down

**A `field_dropdown` rewrites a value that is not among its options to its first
option.** An event the vocabulary has no verb for (`turn:start`, or a game's own
event) was therefore silently turning into a character death the first time a
document went through a real workspace — the pure-JSON codec was happy, because
only Blockly's field validation does this. The fix is two-part: the dropdown
carries an explicit "an event with no verb" option, and the block has
`EVENT_ID`/`MODE`/`GAUGE`/`CHANGE` fields to hold the real thing. Both are
load-bearing, and `test/blocks.test.ts` round-trips a custom event through a real
workspace so it cannot regress.

The general lesson: **a JSON codec test does not test the editor.** The
round-trip has to run through `load`/`save` for the traps in Blockly's own
field and connection validation to show up.

### What a workspace cannot say

`fromBlocks` is **total**: every state yields a document and nothing throws —
including a state that is not a workspace state at all. But *produces a
document* is weaker than *means what you built*, and the difference is the
whole of this section. Each row is a test in `test/blocks.test.ts`.

| Case | What happens |
| --- | --- |
| A block attached to nothing (a half-dragged effect) | dropped, with an issue naming it — a block no section contains has no position in a document |
| A sentence with an unplugged noun | the whole effect is dropped, never half-invented; a step can end up empty |
| A targeting range no pick can satisfy (at least 5, at most 2) | kept faithfully in the IR **and** flagged |
| A **disabled** block | reported, not skipped — the IR has no notion of disabled, and Blockly's own generators *do* skip, so either silent reading would be a trap |
| A **block comment** | lost: the IR has no comment slot, the same reason a `#` comment does not survive |
| Canvas layout | ignored by design; sections are read in the workspace's block-list order, so dragging blocks around is not how a document is reordered |

And the boundary that matters most: **a codec is not a checker.** `fromBlocks`
produces structurally valid IR and nothing more — an undeclared buff name passes
straight through and would bind to a no-op. The semantic checks live in
`compile.ts` and run on the **text** surface, which is exactly why the editor
renders a block edit to English and compiles *that* rather than binding the IR
directly. Calling `fromBlocks` + `bindDocument` yourself means inheriting the
silence; going through the language means the same diagnostics as if the
document had been typed.

## Invariants (what was tested, not asserted)

Held by the **kept** half, today:

1. `parse(render(ir))` reports **no syntax diagnostics** — the renderer's
   output is always valid English, *even when it has gaps*, because an
   unspellable construct becomes a `#` note rather than malformed prose.
   ✅ `test/render.test.ts`, "always produces text that parses".
2. `canonical(lower(parse(render(ir)))) === canonical(ir)` — the text view is
   faithful. ✅ `test/render.test.ts`, over `test/fixtures/documents.ts` (one
   every-construct document plus the Create page's own samples).
3. `render(lower(parse(render(ir)))) === render(ir)` — repeated renders do not
   drift. ✅ `test/render.test.ts`, "is a fixpoint".
4. `english → IR → blocks → IR → english` is stable, through the codec *and*
   through a real headless workspace. ✅ Held while `src/blocks/` existed
   (`test/blocks.test.ts`); its tests went with the code. **A rebuild must
   restore this one first**, because it is the claim the whole two-surface idea
   rests on.

Held by the removed half, and therefore asserted again only when it is rebuilt:

5. The block surface is a **superset**: a named gauge, `set`, a multi-effect
   step, a targeting range and an event with no verb all survived a round trip.
6. The canvas is **typed**: Blockly refused a number where a condition belongs.
7. **Behavioural equivalence** was never done: an ability compiled from a
   document and from its block-built twin should produce the identical arena
   outcome via `buildArena`/`runArena` — the standard `test/ir.test.ts` and the
   RTS example's `test/equivalence.test.ts` hold themselves to. Comparing the IR
   structurally was strong, but it was never the same claim.

## What was built, and what it cost

1. ✅🤍 **`src/english/render.ts`** — `renderDocument(ir) → { text, gaps }`, the
   inverse of `lower.ts`, `GAP_MARKER` and all. No new dependency. **Kept** —
   this is the half that makes a document readable, and the text half of any
   future block editor.
2. 🗑️ **`src/blocks/`** — `spec.ts` (block names, connection checks, the event
   table built from `EVENT_PHRASES`, the Blockly JSON state types and their
   default-aware readers), `definitions.ts` (38 block types), `toBlocks.ts`,
   `fromBlocks.ts` and `index.ts` (the only file that imported Blockly; the
   codec itself was pure JSON). **Removed.** It round-tripped every document
   through a real headless workspace, but it needed `blockly@13` and a bundle
   that grew to 5.5 MB — a second editor inside a page that already loads
   Monaco. A tarball of the removed code was left at
   `/tmp/tinyquest-blockly-removed.tgz` on the machine that removed it, which is
   a convenience and not a guarantee; the design below is the real record.
3. 🗑️ **Create page** — an English / Blocks / IR switch with the revision rule
   above. **Reverted.**

The size measurements that decided it (comments stripped, so the comparison is
content against content):

```
CARDS (9 samples)            ABILITY DOCUMENTS (10)
  english        98 B          english        85 B
  IR            352 B  3.6x    IR            450 B  5.3x
  blocks        607 B  6.2x    blocks        933 B 10.9x
  minus x/y/id  460 B          minus x/y/id  683 B
  editor state = 24%           editor state = 27%
```

Roughly a quarter of a workspace is block ids and cursor positions, and it costs
six to eleven times the English. For a *card* — the thing that has to fit in a
record and travel between players — that is the whole argument.

Deliberately not done, and still not done: comment trivia (the open question
below), buff-name dropdowns fed by the document's own `Buff` lines, per-block
diagnostics, a shared undo stack across surfaces, and behavioural equivalence
(invariant 7). A rebuild should start with the two traps above and the table of
what a workspace cannot say.

## Open questions

- **Comments.** The lexer drops them and the IR has no place for them. Options:
  (a) text-only, lost on a block edit, warned; (b) comment trivia on `Doc`
  re-emitted by the printer and mapped to Blockly's native block comments;
  (c) a `note` block. (a) is the first slice; (b) is the right destination.
- **Where the palette's vocabulary comes from.** Answered: hand-written block
  JSON in `src/blocks/definitions.ts`, with the one generated piece being the
  trigger's event dropdown, which is built from `EVENT_PHRASES` so the two
  surfaces cannot disagree about an event's name. The follow-up is feeding the
  **buff-name fields** from the document's own `Buff` lines and imports (the
  data `BuffDictionary` and `DefinitionIndex` already compute for Monaco's
  autocomplete) — a dropdown field populated per document, which is exactly the
  case Blockly's docs say needs JavaScript rather than a JSON definition.
- **Two undo stacks.** Blockly and Monaco each own one. A single pivot-level
  undo (snapshot the IR) is probably the answer, which means intercepting both.
- **Does the English view stay editable in block-first documents?** Today: a
  block edit is rendered to English and handed to the editor, so the English
  view stays editable *and* authoritative for anything the sentence grammar can
  say. A document using `set` or a named gauge renders with `gaps`, and the text
  is deliberately left untouched rather than rewritten with the gaps commented
  in — the honest half-answer. The full answer is an IR-first pipeline where the
  right pane binds `readDocument(workspace).ir` directly and the English view
  becomes a pure view for those documents.
- **Bundle cost.** Measured: `npm run ui:build` now emits a 5.5 MB chunk
  (1.46 MB gzipped) against a page that already loads Monaco. That is a build
  warning, not a break — but Blockly is a good candidate for a lazy chunk
  loaded when the Blocks view is first opened.
