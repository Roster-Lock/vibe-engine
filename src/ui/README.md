# ui

A React application (Vite + React 19). It's a small page router: pick two
fighters on the Select page and **watch their AIs battle it out** on the
Game page — or play the collectible card game, or author content in English.

## Pages

| Page | What it does |
| --- | --- |
| `pages/MainMenuPage.tsx` | The front door: **Watch**, **Play cards**, **Create a card**, **Create an ability**, and the old interactive demo ("Play yourself"). |
| `pages/SelectPage.tsx` | Shows the fighter roster (`ROSTER` in `../examples/08-27-2026/index.ts`). Pick Fighter A and Fighter B, or hit **Random Select** to let fate choose, then **Start Watch**. |
| `pages/GamePage.tsx` | The watch battle. First a **Load UI**: the chosen fighters are built and their assets (sprites, audio, skills, AI brains) are staged into memory with a progress bar. Then the **Game UI**: two `RandomAI` players fight in a `LocalGame`. The round loop is driven from the page so it can be paced — speed (Slow/Normal/Fast/Instant) and pause controls, a round counter, live HP/mana cards, and a combat log. |
| `pages/CreatePage.tsx` | The **Ability editor**: write abilities in English with Monaco, per-word autocomplete, hover help and grammar squiggles, then run a headless test battle. |
| `pages/CardGamePage.tsx` | The collectible card game (`examples/card-game`): **You vs the AI**, **two players on one screen**, or **watch two AIs** (speed + pause). The page answers both of `CardGame`'s questions — `HumanCardPlayer.chooseMove` suspends until you act, `takePriority` raises the **respond bar** (cast an instant, or pass) whenever something is on the stack — a spell *or* a triggered ability, since the engine runs on the stack's trigger scheduler — and `orderTriggers` raises the **order bar**, where a player clicks their simultaneous triggers into the order they go on the stack. Saved cards from the creator can be added to both decks. |
| `pages/CardCreatePage.tsx` | The **Card Creator**: a `Card` document in English (`src/english/card.ts`) with per-word completion and validation, a live compiled card face, and a deck drawer that saves documents to `localStorage` for the card game. |
| `pages/PlayPage.tsx` | The original human-vs-AI battle (you click skills and targets). |

Shared UI (`components/cards.tsx`, `components/log.tsx`) renders character
cards (hp / mana bars, buffs, defeat) and the combat log.

## Run it

```bash
npm run ui:dev      # dev server at http://localhost:5173
npm run ui:build    # compiled app to dist/ui/
```

## How the card game connects

- `../examples/card-game/index.ts` — the single entry point the UI imports:
  the card catalog, `CardGame`, `GreedyAI`, the UI players
  (`HumanCardPlayer`, `PacedGreedyAI`), and `playableCards` — the bridge
  that turns a card authored in English into a playable `Card`.
- `creator/card-language.ts` — the Monaco glue for the card grammar
  (completion from `completeCardAt`, hover, Ctrl+Click to a `Buff`,
  squiggles from the compiler's spans). The creator compiles with
  `CARD_LANGUAGE_ZONES`, so `from active` / `from stack` are offered and
  validated like any other zone.
- `creator/card-store.ts` — the saved card **documents** (source, not
  compiled closures), rebuilt on load so a fix to the compiler improves
  every saved card.

## How the watch battle connects

- `../examples/08-27-2026/index.ts` — the demo content: the `ROSTER` of
  seven fighters, each in its own folder under `characters/` (Hero, Goblin
  Chieftain, Pyromancer, Shadow Assassin, Paladin, War Hound, Vampire
  Lord), each buff in its own folder under `buffs/` (Rage, Poison, Thorns),
  and the `HumanPlayer` used by the play-it-yourself mode. The UI imports
  everything from this single entry point.
- `../examples/08-27-2026/characters/<id>/` — each fighter is a folder
  containing its source (`index.ts`), its SVG media (`portrait.svg`,
  `idle.svg`, `attack.svg`, `hit.svg`; SMIL, so they play when loaded as
  plain `<img>` sources), and its own `CharacterDef` (`character`) — the
  id, name, emoji, tagline, `make` factory and media. The roster is just
  the list of those defs. Every ability carries its own `description`
  (there is no separate blurb table).
- `../examples/08-27-2026/buffs/<name>/` — each buff is a folder in the
  same style: its source (`index.ts`) and its SVG icon (`icon.svg`).
- `App.tsx` — the tiny page router; navigation is plain React state.
- Each watch match builds **fresh** character instances (`CharacterDef.make`)
  and wraps them in two `RandomAI` players (`../multiplayer/random-ai.ts`)
  inside a `LocalGame` (`../multiplayer/local.ts`). Every engine event
  refreshes the cards and log — and drives the arena figures: acting
  fighters show their attack animation, damaged fighters flinch with the
  hit animation, and both ease back to idle.

### Content rule: one targeting ability per user-triggered skill

A skill the *user* triggers carries exactly **one** targeting ability —
using a skill means picking targets once, not once per bundled ability.
So every fighter above has one skill per move. An ability that targets
several characters at once (e.g. **Life Drain**, which drains a victim and
heals a benefactor) is *its own skill*: a single ability whose targeting
pattern asks for multiple targets (`count: 2`), with the cast reading them
positionally (`targets[0]` victim, `targets[1]` benefactor).

A quick way to sanity-check the roster outside the browser:

```bash
npx tsx -e "import('./src/examples/08-27-2026/index.ts').then(async m => { for (const e of m.ROSTER) console.log(e.name, e.make().hp.max, 'hp'); })"
```
