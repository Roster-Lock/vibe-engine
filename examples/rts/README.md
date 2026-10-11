# examples/rts — a Warcraft 3–styled RTS whose abilities are written in English

A real-time skirmish — heroes, troops, mana, cooldowns, auto-attacks, areas
of effect, damage over time, summons — where **every ability and buff is
written as English sentences** and compiled into executable code before the
battle starts.

```
Ability Thunder Clap
Targeting: no target
Cooldown 9 seconds
Cost 75 mana
Deal 100 damage to all enemy units within 300 range of this unit.
Add Slowed to all enemy units within 300 range of this unit.

Buff Slowed
Duration 6 seconds
Reduce movement speed by 50%.
Reduce attack speed by 25%.
```

That text is [`src/content/abilities.rts`](src/content/abilities.rts). It is
the only place those abilities are defined — no TypeScript anywhere in this
example mentions Thunder Clap.

## Run it

```bash
npm run rts:demo                       # compile the English, fight a battle, print the log
npm run rts:demo -- --compiled         # same battle, running the generated TypeScript
npm run rts:demo -- --print "Storm Bolt"   # show one ability as IR and as TypeScript
npm run rts:codegen                    # regenerate src/generated/abilities.gen.ts
npm run rts:test                       # the suite
```

## "Converted into executable code", concretely

The compiler does not build a closure and hope. It lowers English to a JSON
**IR**, and two independent back ends consume it:

```
abilities.rts
     │  lexer.ts → parser.ts        text → AST (spans on every node)
     │  compile.ts                  AST → IR   (names resolved, context checked)
     ▼
   src/ir.ts        ← plain JSON: no closures, no engine references
     │
     ├── runtime.ts  interprets the tree
     └── codegen.ts  prints it as TypeScript → src/generated/abilities.gen.ts
```

Both back ends run against the same narrow verb set, `CastApi` — `damage`,
`heal`, `area`, `addBuff`, `after`, `every`, … — so they are comparable, and
the suite compares them: `test/generated.test.ts` fights the whole demo
battle twice, once interpreting the IR and once calling the generated
closures, and asserts the logs match **line for line**.

The generated file is committed, so `npm run typecheck` compiles it like any
other source. This is what Storm Bolt becomes:

```ts
/** `Storm Bolt` — enemy unit, 75 mana, 7s cooldown, 600 range */
export const stormBolt: CompiledAbility = {
  id: 'storm-bolt',
  name: 'Storm Bolt',
  targeting: 'enemyUnit',
  cooldown: 7,
  manaCost: 75,
  castRange: 600,
  cast(ctx: CastApi): void {
    for (const unit1 of living(ctx.target)) {
      ctx.damage(unit1, 180);
    }
    for (const unit2 of living(ctx.target)) {
      ctx.addBuff(unit2, 'stunned');
    }
  },
};
```

Buff bodies (their ticks and triggers) stay data and are interpreted; only
abilities get closures. The IR is identical either way.

## The language

A document is `Ability` and `Buff` sections. `#` starts a comment, keywords
are case-insensitive, names keep their case.

### Ability headers

| Line | Meaning | Default |
| --- | --- | --- |
| `Targeting: no target` | fires where the caster stands | this |
| `Targeting: target unit` / `target enemy unit` / `target ally unit` | aimed at one unit | |
| `Targeting: target point` | aimed at a place | |
| `Cooldown 8 seconds` | seconds between casts | `0` |
| `Cost 75 mana` | mana per cast | `0` |
| `Range 600` | how far the cast reaches | unlimited |

An ability with no header and only a `Whenever …` sentence is a **passive**.

### Nouns

| Phrase | Means |
| --- | --- |
| `this unit` | the caster — or, inside a buff, the unit carrying it |
| `the target` | the unit this cast was aimed at |
| `the target point` | the place it was aimed at (a unit target's position counts) |
| `the attacker` / `the victim` / `the killer` | only inside a matching `Whenever …` |
| `all [other] [enemy\|ally] units within <n> range of <anchor>` | an area; `other` excludes the caster |

An anchor is `this unit`, `the target`, `the target point`, or an event noun.

### Filters

Any noun may be narrowed with `with …`:

```
Heal all ally units within 400 range of this unit with hp below 60% for 60.
Kill the target with hp below 15%.
Deal 10 damage to all enemy units within 300 range of this unit with (poisoned or slowed) and hp < 100.
```

Conditions are `<stat> <op> <n>`, `<stat> below|above <n>%` (a share of that
unit's own maximum), or a bare buff name. `and` binds tighter than `or`;
`not` and parentheses work; a comma reads as `and`. Stats are `hp`,
`max hp`, `mana`, `max mana`, `attack damage`, `movement speed`, `armor`.

### Effects

| Sentence | Does |
| --- | --- |
| `Deal 100 damage to <units>.` | damage, reduced by armor |
| `Deal damage equal to 30% of this unit's attack damage to <units>.` | a scaling amount |
| `Heal <units> for 200.` | heal, capped at maximum |
| `Add <Buff> to <units>.` / `Remove <Buff> from <units>.` | apply or strip a buff |
| `Kill <units>.` | kill outright |
| `Summon 2 Skeleton Warrior near <anchor>.` | create units on the caster's team |
| `Teleport <units> to <anchor>.` | blink |
| `Push <units> back 130 units.` | knock away from the caster (or `from <anchor>`) |
| `After 2 seconds, <effect>.` | delay |
| `Every 1 second for 12 seconds, <effect>.` | a cadence |
| `Whenever <event>, <effect>.` | a trigger |

Two effects may share a sentence with `and`. Events are `this unit takes
damage`, `dies`, `attacks`, `kills a unit`, `casts an ability`.

### Buffs

```
Buff Poisoned (stacks)
Duration 8 seconds
Every 1 second, deal 4 damage to this unit.
```

Plus `Increase`/`Reduce <stat> by <n>[%]` and `Cannot move|attack|cast.`
Percentages from different buffs **add** rather than compound: two 50% slows
stop a unit. A buff's cadence is bounded by its `Duration`, so it takes no
`for … seconds`.

## What the creator gets wrong, and what they're told

Diagnostics carry an exact source span, a stable code, and a suggestion —
the editor affordances the parent project's language has
(`docs/creator/01-ability-language.md`), for the same reason: this text is
meant to be typed by a player, not by a programmer.

```
Deal 10 damage to the attacker.
                  ^^^^^^^^^^^^  "the attacker" only exists inside a "Whenever …" trigger

Whenever this unit casts an ability, deal 10 damage to the attacker.
                                                       ^^^^^^^^^^^^  this event binds no units

Targeting: target point
Deal 10 damage to the target.
                  ^^^^^^^^^^  "Rain" targets a point, not a unit — say "the target point"

Add Frailty to this unit.
    ^^^^^^^  unknown buff "Frailty" — known buffs: Stunned, Slowed, Poisoned
```

A bad sentence costs one diagnostic and the rest of the document still
compiles and still runs — a half-written ability should not stop you
pressing play.

## Layout

| Path | |
| --- | --- |
| `src/ir.ts` | the IR — the pivot everything else is on either side of |
| `src/english/lexer.ts` `parser.ts` `ast.ts` `vocabulary.ts` | text → AST |
| `src/english/compile.ts` | AST → IR, name resolution, context checks |
| `src/english/runtime.ts` | `CastApi`, the interpreter, trigger dispatch |
| `src/english/codegen.ts` | IR → TypeScript |
| `src/sim/world.ts` | the tick loop and every state-changing verb |
| `src/sim/unit.ts` | units, derived stats, buff instances |
| `src/sim/ai.ts` | the default behavior, incl. how it aims unknown abilities |
| `src/content/abilities.rts` | **the ability document** |
| `src/content/units.ts` | stat lines; references abilities by id only |
| `src/generated/abilities.gen.ts` | committed output of `npm run rts:codegen` |

## How it relates to the rest of the repo

This example does **not** use `src/engine/`. That engine is turn-based — a
gauge/stack/state-based-action model for a card-and-hero game — and an RTS
needs positions, movement and a real-time clock, which are not things to
bolt on. What it reuses is the part that transfers: the architecture of
`src/english/` (a span-accurate lexer/parser, an error-tolerant grammar, a
data IR as the compilation target) and the engine's central discipline, that
**every state change goes through a verb that emits an event** — which is
the only reason a buff like Thorns can exist without the damage code ever
having heard of it.

It is also a second data point for the goal in `docs/GOAL.md`: the IR here
is JSON with no engine references, which makes it simultaneously the
compilation target, the thing an editor introspects, and the share format.

## Known limits

- The AI is a heuristic, not a player: it reads the compiled IR to decide
  whether an ability wants enemies or a hurt ally, and aims area spells at
  the biggest clump. It has no notion of retreating, focus-firing or saving
  a cooldown.
- No pathfinding — units walk straight at each other and shove overlaps
  apart. There is no terrain.
- `Whenever` only listens to `this unit`. A map-wide listener is a
  deliberate error, not an oversight.
- Buff bodies are interpreted rather than generated (see above).
- There is no editor yet. The pieces an editor needs — spans, stable
  diagnostic codes, `WORD_DOCS` hover text, a single `vocabulary.ts` — are
  in place, but nothing consumes them.
