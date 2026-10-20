/**
 * Main menu — the app's front door. The headline option is **Watch**:
 * pick two fighters and let their AIs battle it out. **Create** opens the
 * Ability editor — write abilities in English and test them in battle.
 * **Play cards** opens the collectible card game, and **Create a card**
 * opens the card creator (autocomplete and grammar checks per word).
 */
export function MainMenuPage({
  onWatch,
  onCreate,
  onPlay,
  onCards,
  onCreateCard,
  onModelSpike,
}: {
  /** Go to the fighter selection page. */
  onWatch: () => void;
  /** Go to the Ability editor (Create page). */
  onCreate: () => void;
  /** Go to the (preserved) play-it-yourself battle. */
  onPlay: () => void;
  /** Go to the collectible card game. */
  onCards: () => void;
  /** Go to the card creator. */
  onCreateCard: () => void;
  /** Go to the 3D model rendering spike. */
  onModelSpike: () => void;
}) {
  return (
    <div className="page menu-page">
      <section className="hero">
        <p className="logo">tinyquest</p>
        <h1>Two AIs enter.<br />One walks out.</h1>
        <p className="tagline">Pick a pair of fighters, then sit back and watch their AI brains battle it out — round by round.</p>
      </section>

      <section className="menu-actions">
        <button className="primary watch-btn" onClick={onWatch}>
          ▶&nbsp; Watch
        </button>
        <p className="hint">Choose two fighters, then watch the AIs fight.</p>

        <button className="primary cards-btn" onClick={onCards}>
          🃏&nbsp; Play cards
        </button>
        <p className="hint">A collectible card game — you vs the AI, two players on one screen, or watch two AIs.</p>

        <button className="menu-secondary create-btn" onClick={onCreateCard}>
          🎴&nbsp; Create a card
        </button>
        <p className="hint">Write a card in English — autocomplete and grammar checks on every word, then play it.</p>

        <button className="menu-secondary create-btn" onClick={onCreate}>
          ⚡&nbsp; Create an ability
        </button>
        <p className="hint">Write abilities in English — autocomplete and grammar checks as you type, then test them in battle.</p>

        <button className="menu-secondary" onClick={onPlay}>
          🎮 Play yourself
        </button>
        <p className="hint">The old interactive demo — you control the hero.</p>

        <button className="menu-secondary" onClick={onModelSpike}>
          🧪 3D model spike
        </button>
        <p className="hint">Experimental: render a real 3D model in-browser and switch animations.</p>
      </section>
    </div>
  );
}
