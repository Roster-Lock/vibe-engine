# multiplayer

The network / opponent layer. Every module here plugs a *source of
decisions* into the `Game` loop (`../engine/game.ts`): a `Game` collects
`Decision`s via `collectUserDecisions()` and applies them in `runGame()`,
and each `Player` (`../engine/player.ts`) answers with `decide(engine)`.

## Modules

- `local.ts` — same-machine play: `LocalGame` (a concrete `Game`) runs any
  mix of players against each other, plus `ScriptedPlayer` (first skill,
  first valid target — deterministic, handy for tests and scripted battles).
- `random-ai.ts` — `RandomAI`: a `Player` that randomly chooses a skill and
  random valid targets for each living character, every round.
- `webrtc.ts` — *planned*: peer-to-peer play, syncing each side's decisions
  and the game state between two clients over WebRTC.

## Examples

```ts
import { LocalGame, ScriptedPlayer } from './local.js';
import { RandomAI } from './random-ai.js';

const game = new LocalGame([
  new ScriptedPlayer('Hero', [hero], 'party'),
  new RandomAI('Goblins', [goblin], 'monsters'),
], { onEvent: log });

const winners = await game.runLoop();   // Player[] — the surviving side
```

A human player works the same way: `decide()` waits for input instead of
computing it (see `../ui/human-player.ts`).
