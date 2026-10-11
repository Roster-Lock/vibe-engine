/**
 * Main menu — the app's front door. The headline option is **Watch**:
 * pick two fighters and let their AIs battle it out. **Create** opens the
 * Ability editor — write abilities in English and test them in battle.
 */
export function MainMenuPage({
  onWatch,
  onCreate,
  onPlay,
}: {
  /** Go to the fighter selection page. */
  onWatch: () => void;
  /** Go to the Ability editor (Create page). */
  onCreate: () => void;
  /** Go to the (preserved) play-it-yourself battle. */
  onPlay: () => void;
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

        <button className="menu-secondary create-btn" onClick={onCreate}>
          ⚡&nbsp; Create an ability
        </button>
        <p className="hint">Write abilities in English — autocomplete and grammar checks as you type, then test them in battle.</p>

        <button className="menu-secondary" onClick={onPlay}>
          🎮 Play yourself
        </button>
        <p className="hint">The old interactive demo — you control the hero.</p>
      </section>
    </div>
  );
}
