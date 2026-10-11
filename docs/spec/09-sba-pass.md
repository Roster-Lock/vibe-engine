# 09 — State-Based Actions (the SBA Pass)

> Slice 6. The engine's heartbeat: a fixed-resolution pass that settles the
> world after writes land, before anything is announced.

## 1. The distinction

- **State-based actions (SBAs) perform changes** — destroy a character at
  HP ≤ 0, expire a timer, resolve the game, run content-registered rules.
- **Rules gate changes** — restrictions ("cannot be X if Y",
  [11-restrictions.md](11-restrictions.md)). SBAs run in the pass below;
  rules are consulted at gates (targeting, destroy, the action pipeline,
  win/lose).

## 2. The pass (resolution order)

**Precondition: gauge writes land first** — netted per gauge (the batch
behavior of [03-actions.md](03-actions.md) §6). The pass then reads
*post-write* state:

1. **Win/lose** — game-end resolution, first. Judges from post-write HP:
   **"dead" = HP ≤ 0 AND the HP→destroy rule is not gated** (a "cannot be
   destroyed" character at 0 HP keeps its owner in the game,
   [10-destroy.md](10-destroy.md) §2). Simple `lose`/`win` restrictions can
   block a determination ([08-players-teams-winlose.md](08-players-teams-winlose.md) §4).
   If the game is over after the gates, it ends **now**: no destruction
   events, no death triggers (win/lose-first — a killing blow ends the
   game; triggers never run at game end).
2. **Destroy / Creation** — every pending destruction (HP ≤ 0 unless a
   `destroy` restriction blocks it, summon timers at 0, queued `destroy`
   actions) happens **simultaneously**: all characters move to the
   graveyard together, on-defeat buffs cleaned per `removedOnDefeat`, then
   one `character:destroyed` event per character
   ([10-destroy.md](10-destroy.md)). Creations (summons landing) join here.
3. **Gauge settling** — *automatic, not an explicit step*: gauges clamp on
   every write, so there is nothing to settle at the pass. Any other
   "gauge change as a consequence of state" is a content SBA or a trigger,
   not a layer.
4. **Ability recomputation** — *automatic*: abilities are derived from the
   status list at query time (`character.abilities`), so destroy/transform/
   control already update the ability set with no recompute step. Aura
   membership is the only explicit maintenance and it is event-driven
   ([13-auras.md](13-auras.md)), not a layer.

**After the pass:** emit events and run triggers. Triggers are **queued,
not run inline** — the events emitted by a pass add their matching triggers
to the queue, and the queue drains **after the current resolution unit
completes** (a move's `apply`, or a trigger's own resolution)
([06-events-triggers.md](06-events-triggers.md) §4).

**After the drain:** loop back to the pass **while state changed** (writes
landed, something destroyed/created, an SBA fired with effect); a no-change
pass ends the loop. **Depth cap backstop** — the max-action-depth guard
(default 100) bounds nested applies, and the content-SBA loop counts its
own iterations against the same cap.

## 3. The destroy phase in detail

One settle's destroy phase:

1. **Collect** the pending destructions:
   - characters whose written gauge carries a firing **current-aspect
     `GaugeSba`** — the built-in: HP crossed `min` this batch
     (`mana:current-reached-minimum`);
   - characters whose gauge's derived **max** a firing **max-aspect
     `GaugeSba`** matches — the built-in: derived mana max driven to 0
     (`mana:maximum-reached-0`);
   - queued `destroy` actions (`direct-action`),
   each gated by the destroy gate (`canDestroy` / restrictions) — gated
   characters stay.
2. **Mark the wearer destroyed, then its on-defeat buffs die with it** —
   the buffs' `buff:destroyed` triggers are collected while they are still
   attached (a buff that dies with its wearer still hears the death; the
   same-batch principle), and the character is marked `destroyed = true`
   first so listeners can read the reason. Bombs fire as queued triggers
   at the drain — no nested applies inside this phase.
3. **Re-run the game-end check before any events** — a `destroy` action can
   end the game, and win/lose-first means no destroyed events and no death
   triggers at game end.

The phase returns the destroyed characters so the caller can announce them
(`character:destroyed` per character, then the `:batch` variant) after the
whole settle — death triggers then see the full wipe
([06-events-triggers.md](06-events-triggers.md) §5).

**State version**: a monotonic counter bumps on every write, destruction,
buff change, and win/lose marker. The content-SBA loop uses it to detect "this
iteration changed nothing" and stop.

## 4. Content-registered SBAs

Creators register continuous state rules — conditions over the whole game
state, checked at the pass, **not event-driven**:

```ts
engine.addStateBasedRule({
  name: 'Overbuff',
  priority: 50,                        // built-ins: 10 win/lose, 20 destroy/create, 30/40 reserved
  when: (engine) => totalBuffCount(engine) > 10,
  then: (engine) => [win('party')],
});

engine.addStateBasedRule({
  name: 'Empty Mana Well',
  when: (engine) => sumOfAllMana(engine) === 0,
  then: (engine) => allCharacters(engine).map((c) => setGauge(c.mana, c.mana.max)),
});
```

```ts
interface StateBasedRule {
  name: string;
  priority?: number;    // sort key among content rules; defaults to 50 (after built-ins)
  when: (engine) => boolean;
  then: (engine) => Action[];
}
```

Contract:

- rules run in ascending `priority` order;
- each rule fires **at most once per pass iteration**;
- the pass loops while any iteration **changed the state**, and stops on
  the first no-change iteration — a rule like "refill every well while
  total mana is 0" terminates once everyone is full;
- rules should be written so their effect eventually stops changing state;
  the depth cap is the backstop;
- `win`/`lose` produced by a rule resolve at the nested apply's win/lose
  check — the game ends before any further rule or event.

## 5. Built-in SBAs

- character HP ≤ 0 → destroy (gated by `destroy` restrictions);
- summon timer at 0 → destroy (normal destroy path);
- countdown win/lose timer at 0 → `win`/`lose` action (resolves at layer 1);
- game-end resolution (layer 1, last among its own checks — explicit
  `win`/`lose` markers, standing teams, draws);
- **the form stack keeps its ties honest** — a `tied` transform entry whose
  keying buff is no longer attached is a dangling tie (the buff left by a
  bypass path) and is popped, reverting the form. The *pinning* itself is
  automatic (the form fold treats live ties as dominant — a transform pushed
  while a hex is active never becomes the character's form; see
  [04-character-status.md](04-character-status.md) §6), so the pass step
  only maintains the tie set, the way the destroy phase maintains the
  graveyard.

## 6. Acceptance criteria (Slice 6)

1. After a gauge batch, layer 1 (win/lose) runs before anything else: a
   killing blow throws `GameEndInterrupt` with no destroyed events and no
   queued triggers.
2. Multiple pending destructions in one settle move to the graveyard
   together; on-defeat buffs are cleaned before the events; each character
   gets one `character:destroyed` with its reason.
3. A destroy-gated character (indestructible) at 0 HP is not destroyed and
   its owner does not lose.
4. A content SBA ("refill every well while total mana is 0") loops until a
   no-change pass and terminates; an SBA that never stops changing state
   throws the depth-cap error.
5. A content SBA producing `win('party')` ends the game at the next
   win/lose check, before further rules or events.
6. Gauge clamping and ability derivation need no explicit pass steps
   (layers 3–4 automatic): a transform that shrinks max HP clamps current
   immediately, and a removed buff's abilities stop appearing in
   `character.abilities` immediately.
