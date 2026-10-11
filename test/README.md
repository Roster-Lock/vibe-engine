# test/ — battle scripts & tests

| File | What it is |
| --- | --- |
| `ai-vs-ai.ts` | **Runnable script**: two AI players fight through the full `LocalGame` ceremony using the real example roster (Hero, Paladin, Assassin, Vampire Lord, Pyromancer, War Hound, Thorn-mail Goblin). Two brains per side: `random`/`seeded` (the engine's random AI, plus a deterministic copy) and `llm` (a real DeepSeek chat-completions brain that picks moves as JSON and falls back to random moves on any error). Emits a readable combat log, per-character final state, battle stats (damage/healing/buffs/abilities), invariant checks over the event stream, and — with `--matches N` — an aggregate report. |
| `ai-vs-ai.test.ts` | Vitest suite for the runner: full-battle invariants, seed replayability, round-cap draws, the thorns passive path, the LLM fallback path, and the LLM prompt/parse/validate helpers. |

## Running the battle script

```sh
npm run ai:vs                                          # random vs random, one classic battle
npm run ai:vs -- --seed 42 --matches 5                 # deterministic, 5 matches
npm run ai:vs -- --scenario thorn                      # thorn-mail variant
npm run ai:vs -- --scenario all --quiet --matches 3    # both scenarios, results only
npm run ai:vs -- --brain1 llm --brain2 llm --max-rounds 20   # LLM vs LLM
npm run ai:vs -- --brain1 llm --brain2 random          # LLM vs built-in AI
npm run ai:vs -- --help                                # all options
```

Full options: `--matches <n>`, `--scenario classic|thorn|all`, `--brain1/--brain2
random|seeded|llm`, `--max-rounds <n>` (default 100), `--seed <n>`, `--model <id>`
(default `deepseek-chat`), `--quiet`, `--verbose`.

**LLM mode** needs a DeepSeek API key — it is read from `$DEEPSEEK_API_KEY` or
`$DSH_HOME/.credentials.yaml`. It makes **one API call per player per round**
(batched, all of a player's living characters in one prompt), so keep
`--max-rounds` modest.

## Why the loader flags?

The script runs with `node --import tsx --import ./src/games/turn-based/svg-loader.mjs`. The example
content imports `.svg` assets that Vite resolves in the browser; `src/games/turn-based/svg-loader.mjs`
(plus its hooks in `src/games/turn-based/svg-hooks.mjs`) teaches plain Node to load them as `data:`
URI strings. Running the tests needs no special flags — Vitest/Vite handle SVG
imports natively.
