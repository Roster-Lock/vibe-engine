/**
 * tinyquest UI — a small page router over four screens:
 *
 * - **Main menu** — the front door. The headline option is *Watch*.
 * - **Select** — pick the two fighters (or let fate choose).
 * - **Game** — the watch battle: a Load UI first, then two AIs fight it
 *   out while you spectate (speed + pause controls).
 * - **Create** — the Ability editor: write abilities in English with
 *   autocomplete and grammar squiggles, then test them in a battle.
 *
 * The original play-it-yourself battle is preserved as a fifth page.
 */
import { useState } from 'react';
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
  | { name: 'play' };

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
    case 'play':
      return <PlayPage onMenu={() => setRoute({ name: 'menu' })} />;
    case 'menu':
      return (
        <MainMenuPage
          onWatch={() => setRoute({ name: 'select' })}
          onCreate={() => setRoute({ name: 'create' })}
          onPlay={() => setRoute({ name: 'play' })}
        />
      );
  }
}
