# ui

A React application (Vite + React 19). It's a small page router: pick two
fighters on the Select page and **watch their AIs battle it out** on the
Game page — or play the original interactive demo.

## Pages

| Page | What it does |
| --- | --- |
| `pages/MainMenuPage.tsx` | The front door. The headline option is **Watch**; the old interactive demo is preserved as "Play yourself". |
| `pages/SelectPage.tsx` | Shows the fighter roster (`ROSTER` in `../examples/08-27-2026/index.ts`). Pick Fighter A and Fighter B, or hit **Random Select** to let fate choose, then **Start Watch**. |
| `pages/GamePage.tsx` | The watch battle. First a **Load UI**: the chosen fighters are built and their assets (sprites, audio, skills, AI brains) are staged into memory with a progress bar. Then the **Game UI**: two `RandomAI` players fight in a `LocalGame`. The round loop is driven from the page so it can be paced — speed (Slow/Normal/Fast/Instant) and pause controls, a round counter, live HP/mana cards, and a combat log. |
| `pages/PlayPage.tsx` | The original human-vs-AI battle (you click skills and targets). |

Shared UI (`components/cards.tsx`, `components/log.tsx`) renders character
cards (hp / mana bars, buffs, defeat) and the combat log.

## Run it

```bash
npm run ui:dev      # dev server at http://localhost:5173
npm run ui:build    # compiled app to dist/ui/
```

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
