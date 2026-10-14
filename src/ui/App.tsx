/**
 * tinyquest UI — a small page router over the screens:
 *
 * - **Main menu** — the front door. Watch, play cards, or create content.
 * - **Select** — pick the two fighters (or let fate choose).
 * - **Game** — the watch battle: a Load UI first, then two AIs fight it
 *   out while you spectate (speed + pause controls).
 * - **Create** — the Ability editor: write abilities in English with
 *   autocomplete and grammar squiggles, then test them in a battle.
 * - **Cards** — the collectible card game: you vs the AI, hotseat, or
 *   watch two AIs.
 * - **CardCreate** — the Card Creator: a card document in English with
 *   per-word completion and validation, saved into your deck.
 *
 * The original play-it-yourself battle is preserved as another page.
 */
import { useState } from 'react';
import { CardCreatePage } from './pages/CardCreatePage.js';
import { CardGamePage } from './pages/CardGamePage.js';
import { CreatePage } from './pages/CreatePage.js';
import { GamePage } from './pages/GamePage.js';
import { MainMenuPage } from './pages/MainMenuPage.js';
import { PlayPage } from './pages/PlayPage.js';
import { SelectPage } from './pages/SelectPage.js';
import type { CharacterDef } from '../games/turn-based/content/index.js';

export type Route =
  | { name: 'menu' }
  | { name: 'select' }
  | { name: 'game'; left: CharacterDef; right: CharacterDef }
  | { name: 'create' }
  | { name: 'play' }
  | { name: 'cards' }
  | { name: 'card-create' };

export function App() {
  const [route, setRoute] = useState<Route>({ name: 'menu' });

  switch (route.name) {
    case 'select':
      return (
        <SelectPage
          onBack={() => setRoute({ name: 'menu' })}
          onStart={(left, right) => setRoute({ name: 'game', left, right })}
        />
      );
    case 'game':
      return (
        <GamePage
          leftEntry={route.left}
          rightEntry={route.right}
          onExit={() => setRoute({ name: 'select' })}
          onMenu={() => setRoute({ name: 'menu' })}
        />
      );
    case 'create':
      return <CreatePage onBack={() => setRoute({ name: 'menu' })} />;
    case 'cards':
      return (
        <CardGamePage
          onMenu={() => setRoute({ name: 'menu' })}
          onCreate={() => setRoute({ name: 'card-create' })}
        />
      );
    case 'card-create':
      return (
        <CardCreatePage
          onBack={() => setRoute({ name: 'menu' })}
          onPlay={() => setRoute({ name: 'cards' })}
        />
      );
    case 'play':
      return <PlayPage onMenu={() => setRoute({ name: 'menu' })} />;
    case 'menu':
      return (
        <MainMenuPage
          onWatch={() => setRoute({ name: 'select' })}
          onCreate={() => setRoute({ name: 'create' })}
          onPlay={() => setRoute({ name: 'play' })}
          onCards={() => setRoute({ name: 'cards' })}
          onCreateCard={() => setRoute({ name: 'card-create' })}
        />
      );
  }
}
