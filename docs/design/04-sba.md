# 04 — State-Based Actions & Layers

> Status: ✅ direction decided. Layer 3/4 simplification 🔶 awaiting
> confirmation; SBA registry shape 🔶.

## The distinction

- **State-based actions (SBAs) perform changes** — destroy a character at
  HP ≤ 0, expire a timer, resolve the game, run content-registered rules.
- **Rules gate changes** — restrictions ("cannot be X if Y", see
  11-restrictions). SBAs run in the pass below; rules are consulted at
  gates (targeting, destroy, the action pipeline, win/lose).

## The pass (resolution order)

**Precondition: gauge writes land first** (netted per gauge — the engine's
existing batch behavior). The pass then reads *post-write* state:

1. **Win/lose** — game-end resolution, first. Judges from post-write HP:
   **"dead" = HP ≤ 0 AND the HP→destroy rule is not gated** (a "cannot be
   destroyed" character at 0 HP keeps its owner in the game — see
   02-destroy). Simple `lose`/`win` restrictions can block a determination
   (03-win-lose); the "prevent instead" replacement (last breath) is
   deferred (12-replacement-effects) — and when it lands, **the pass
   rechecks state after a replacement resolves** (a last breath that does
   not remove the loss's cause does not save you — the warlock-curse loss
   still stands; see 12). If the game is over after the gates, it ends
   **now**: no destruction events, no death triggers (confirmed — a
   killing blow ends the game; triggers never run at game end).
2. **Destroy / Creation** — every pending destruction (HP ≤ 0 unless a
   `destroy` restriction blocks it, summon timers at 0, queued `destroy`
   actions) happens **simultaneously** (confirmed): all characters move to
   the garbage together, on-defeat buffs cleaned per `removedOnDefeat`,
   then one `character:destroyed` event per character. Creations (summons
   landing) join here.
3. **Gauge settling** — 🔶 *proposed simplification: not an explicit step.*
   Gauges clamp on every write (the `Gauge` class keeps current within
   [min, max] whenever max changes, e.g. after a transform), so there is
   nothing to settle at the pass. Any other "gauge change as a consequence
   of state" is a content SBA or a trigger, not a layer. Confirm?
4. **Ability recomputation** — 🔶 *proposed simplification: automatic.*
   Abilities are derived from the status list at query time
   (`character.abilities`), so destroy/transform/control already update the
   ability set with no recompute step. Aura membership is the only explicit
   maintenance and it is event-driven (07-auras), not a layer. Confirm?

After the pass: emit events and run triggers. **Triggers are queued, not
run inline** — the events emitted by a pass add their matching triggers to a
stack, and the stack drains **after the current resolution unit completes**
(a move's `apply`, or a trigger's own resolution). Appended triggers run
after the current ones (FIFO). Consequences:

- death triggers from a wipe run **after all destructions and events are
  complete** — each trigger sees the full wipe;
- the game-end check at every pass short-circuits the drain: if a wipe ends
  the game, the queued death triggers never run (win/lose-first, confirmed);
- the queue is drained in **seeded-shuffled order** — no defined order,
  only reproducibility between players.

After the drain: **loop back to the pass while state changed** (writes
landed, something destroyed/created, an SBA fired with effect); a no-change
pass ends the loop. Depth cap backstop (the existing max-action-depth
guard).

## Content-registered SBAs

Two registries: **global rules** (conditions over the whole game state,
checked at the pass) and **gauge-attached rules** (the death rules — see
`GaugeSba` below).

### Global rules

Creators register continuous state rules — conditions over the whole game
state, checked at the pass, not event-driven:

```ts
engine.addStateBasedRule({
  name: 'Overbuff',
  priority: 50,                        // built-ins: 10 win/lose, 20 destroy/create, 30/40 reserved
  when: (engine) => totalBuffCount(engine) > 10,
  then: (engine) => [win(ownerOfMostBuffs(engine))],
});

engine.addStateBasedRule({
  name: 'Empty Mana Well',
  when: (engine) => sumOfAllMana(engine) === 0,
  then: (engine) => allCharacters(engine).map((c) => setGauge(c.mana, c.mana.max)),
});
```

Contract:

- each rule fires **at most once per pass**;
- the pass loops while the previous pass produced *any* state change, and
  stops on the first no-change pass — so a rule whose effect changes nothing
  terminates the loop (the mana example refills every well to full, then a
  no-change pass ends it);
- rules should be written so their effect eventually stops changing state;
  the depth cap is the backstop;
- `win`/`lose` produced by a rule resolve at the next pass's layer 1.

### Gauge-attached rules (`GaugeSba`) — the death rules

The death rules are **reusable, gauge-attached state-based actions**, and
they live **on the gauge**: the rule definition is gauge-agnostic (it reads
whatever gauge it is attached to), and the attachment — the gauge instance
— is where it sits. Every character's **HP gauge carries the built-in
death rules by default** (attached at construction, so "a character's HP
is its life" holds for any character in any engine); content can prevent
them, re-attach the same definitions to another gauge (a mana-death game
moves them to mana), or register any condition:

```ts
character.hp.addSba({
  name: 'HP Depleted',                    // the built-in (priority 10)
  aspect: 'current',                      // watch the gauge's current value
  when: (g) => g.current <= g.min,
  then: (c) => [destroy(c)],
  reason: 'hp:current-reached-minimum',   // reported as character:destroyed.reason
});
```

Contract:

- **current-aspect** rules are checked after every batch that **wrote** the
  gauge ("listens for changes"); **max-aspect** rules are checked after
  every status-driven re-derivation of the gauge's max;
- when a rule fires and its `then` returns a `destroy` action targeting the
  character, the destruction is **collected** with every other pending
  destruction of the settle (simultaneous deaths, one `character:destroyed`
  per character carrying the rule's `reason`); a rule whose `then` does not
  destroy has no destroy effect (non-death state effects belong in global
  rules);
- the win/lose **dead** predicate consults the same rules (via
  `character.gauges`): a character whose state would trigger a destroy rule
  counts as dead, still destroy-gate aware ("indestructible at 0 HP keeps
  its owner in the game");
- the SBA pass needs **no gauge-kind knowledge** — it asks each batch gauge
  for its own rules, so arbitrary gauges (a future `stamina`) participate
  with zero engine changes;
- first firing rule wins (priority order — built-ins use 10);
- rules should be written so their effect eventually stops changing state
  (the destroy phase consumes the character, so destroy rules terminate).

```ts
// Prevent one or all built-in deaths on a character…
character.hp.removeSba('HP Depleted');
character.hp.removeSba('HP Max Collapsed');
// …and attach the same death to HP, or any condition:
character.hp.addSba({
  name: 'Fragile',
  aspect: 'current',
  when: (g) => g.current === 4,           // "a character gets destroyed if its HP is exactly 4"
  then: (c) => [destroy(c)],
  reason: 'fragile:hp-exactly-4',
});
// Applying a rule to every character (a global "prevent" or a new death
// rule) is a short loop over the engine's characters:
for (const c of engine.registeredCharacters) c.hp.addSba({ /* … */ });
```

### Conditional buff gates (`GaugeBuffGate`) — "keep this buff while the value matches"

A gate is the **reversible** sibling of a death rule: while the gauge's
value matches the condition the gate's buff stays attached; when it stops
matching, the buff is removed — as many times as the value crosses the
threshold. Applying an already-attached / removing an absent buff is a
no-op, so the pass terminates. Gates live on the gauge like `sbas`:

```ts
const tired = buff({ name: 'Tired', weight: 1,
  abilities: [stat({ name: 'Tired', stat: 'speed', multiply: 0.5 })] });

stamina.addBuffGate({
  name: 'Tired Gate',
  when: (g) => g.current <= g.max * 0.2,   // "low stamina"
  buff: tired,                              // attach/keep Tired while low
});
```

Contract:

- gates are re-evaluated whenever their gauge is **written** (the settle
  after a batch that touched it), applying/removing through the normal
  pipeline — the buff can carry any abilities (stat changes, action
  modifiers, restrictions), so "stamina low → slower" composes with the
  derived-stat system;
- the gate manages its buff **by id**: it applies when the condition holds
  and the character lacks the buff, and removes it when the condition stops
  holding (a buff of the same id from another source is the gate's to
  manage — keep gate buff ids unique);
- a gate whose condition also depends on a *derived* max re-evaluates on
  the next write of that gauge.

Extra gauges (stamina) are content: `CharacterDef.gauges` adds any `Gauge`
to `character.gauges`, so the engine's pass, ownership lookups and win/lose
see it like hp/mana — see `npm run example:stamina`.

## Built-in SBAs

- character HP ≤ 0 → destroy (a `GaugeSba`, removable/re-attachable — the
  built-in default; gated by `destroy` restrictions)
- summon timer at 0 → destroy (normal destroy path)
- countdown win/lose timer at 0 → `win`/`lose` action (resolves at layer 1)
- game-end resolution (layer 1, last among its own checks — explicit
  `win`/`lose` markers, standing teams, draws)

## Open

- 🔶 Confirmation on layers 3–4 (proposed: automatic, not steps).

## Implementation

The registry is built — `GameEngine.addStateBasedRule({ name, priority?,
when, then })` (see `StateBasedRule` in `src/engine/engine.ts`):

- rules run after the destroy phase of every settle (each gauge batch, and
  the end-of-apply leftover when no batch checked them), in ascending
  `priority` order (default 50, after the built-ins);
- each rule fires at most once per pass iteration; the loop repeats while
  any iteration changed the state (a state-version counter) and stops on
  the first no-change iteration — the Empty Mana Well example terminates
  once everyone is full;
- a rule's actions apply through the normal pipeline via nested applies that
  do not re-enter the loop (`#inSBAPass`) and do not drain triggers — their
  events join the unit's queue;
- `win`/`lose` from a rule resolve at the nested apply's win/lose check — the
  game ends before any further rule or event;
- a rule whose effect never stops changing state hits the max-action-depth
  guard ("State-based rules exceeded max depth").

Tests: `test/sba.test.ts` (Overbuff win, Empty Mana Well termination,
no-change stop, priority order, depth guard).
