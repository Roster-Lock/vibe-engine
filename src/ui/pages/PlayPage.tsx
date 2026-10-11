/**
 * The preserved interactive battle: you play the Hero (click skills and
 * targets) against the goblins' `RandomAI`. This was the original tinyquest
 * UI, now living as a page reachable from the main menu.
 */
import { useState } from 'react';
import type { Character, GameEvent, ManualAbility, Player } from '../../engine/index.js';
import { LocalGame } from '../../multiplayer/local.js';
import { RandomAI } from '../../multiplayer/random-ai.js';
import { CharacterCard } from '../components/cards.js';
import { CombatLog } from '../components/log.js';
import { HumanPlayer, makeGoblin, makeHero, thorns } from '../../games/turn-based/content/index.js';

export function PlayPage({ onMenu }: { onMenu: () => void }) {
  const [hero, setHero] = useState(makeHero);
  const [goblin, setGoblin] = useState(makeGoblin);
  const [human, setHuman] = useState<HumanPlayer | undefined>(undefined);
  const [game, setGame] = useState<LocalGame | undefined>(undefined);
  const [started, setStarted] = useState(false);
  const [winners, setWinners] = useState<Player[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [log, setLog] = useState<GameEvent[]>([]);
  const [picked, setPicked] = useState<{ ability: ManualAbility; targets: Character[] } | undefined>(undefined);

  const start = () => {
    const h = makeHero();
    const g = makeGoblin();
    const you = new HumanPlayer('You', [h], 'party');
    const goblins = new RandomAI('Goblins', [g], 'monsters');
    const local = new LocalGame([you, goblins], {
      maxRounds: 100,
      onEvent: (event) => setLog((prev) => [...prev.slice(-7), event]),
    });

    setHero(h);
    setGoblin(g);
    setHuman(you);
    setGame(local);
    setStarted(true);
    setWinners(undefined);
    setError(undefined);
    setLog([]);
    setPicked(undefined);

    void (async () => {
      await local.engine.addBuff(g, thorns); // the goblin wears thorn mail
      const w = await local.runLoop();
      setWinners(w);
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const isHumanTurn = started && !winners && !error && human?.isWaiting === true && !hero.isDefeated;

  const chooseAbility = (ability: ManualAbility) => {
    setPicked({ ability, targets: [] });
  };

  const toggleTarget = (target: Character) => {
    setPicked((prev) => {
      if (!prev) return prev;
      const already = prev.targets.includes(target);
      const targets = already
        ? prev.targets.filter((t) => t !== target)
        : [...prev.targets, target];
      return { ...prev, targets };
    });
  };

  const submit = () => {
    if (!picked || !human || picked.targets.length === 0) return;
    human.submit([{ character: hero, ability: picked.ability, targets: picked.targets }]);
    setPicked(undefined);
  };

  const validTargets = picked && game ? game.engine.validTargets(picked.ability.targeting, hero) : [];
  const maxTargets = picked ? maxCount(picked.ability) : 0;

  return (
    <div className="page play-page">
      <header className="page-header">
        <button className="back" onClick={onMenu}>← Menu</button>
        <h1>Play yourself</h1>
        <span />
      </header>

      <p className="status">{statusText(started, winners, error, isHumanTurn)}</p>

      <main>
        <section className="cards">
          <CharacterCard character={hero} label={human?.name ?? 'You'} />
          <CharacterCard character={goblin} label="Goblins" />
        </section>

        <section className="panel">
          {!started && (
            <button className="primary" onClick={start}>
              Start battle
            </button>
          )}
          {started && !winners && !error && (
            <div className="actions">
              {isHumanTurn ? (
                <>
                  <h2>Your turn — choose a skill for {hero.name}</h2>
                  <div className="skills">
                    {hero.manualAbilities.map((ability) => {
                      const targets = game?.engine.validTargets(ability.targeting, hero) ?? [];
                      const chosen = picked?.ability === ability;
                      return (
                        <button
                          key={ability.id}
                          className={chosen ? 'skill chosen' : 'skill'}
                          disabled={targets.length === 0}
                          onClick={() => chooseAbility(ability)}
                        >
                          {ability.name}
                        </button>
                      );
                    })}
                  </div>
                  {picked && (
                    <>
                      <h3>Targets ({picked.targets.length}/{maxTargets})</h3>
                      <div className="skills">
                        {validTargets.map((target) => (
                          <button
                            key={target.name}
                            className={picked.targets.includes(target) ? 'target chosen' : 'target'}
                            disabled={!picked.targets.includes(target) && picked.targets.length >= maxTargets}
                            onClick={() => toggleTarget(target)}
                          >
                            {target.name}
                          </button>
                        ))}
                      </div>
                      <button
                        className="primary"
                        disabled={picked.targets.length === 0}
                        onClick={submit}
                      >
                        Confirm
                      </button>
                    </>
                  )}
                </>
              ) : (
                <p className="hint">The goblins are acting…</p>
              )}
            </div>
          )}
          {winners && (
            <div className="result">
              <h2>{winners.length === 0 ? 'Draw!' : `${winners.map((w) => w.name).join(' and ')} win!`}</h2>
              <button className="primary" onClick={start}>
                Rematch
              </button>
            </div>
          )}
          {error && (
            <div className="result error">
              <h2>Something went wrong</h2>
              <p>{error}</p>
            </div>
          )}
        </section>

        <section className="log">
          <h2>Combat log</h2>
          <CombatLog events={log} empty="No events yet." />
        </section>
      </main>
    </div>
  );
}

/* ----------------------------- helpers ----------------------------- */

function statusText(started: boolean, winners: Player[] | undefined, error: string | undefined, isHumanTurn: boolean): string {
  if (error) return 'Error — see below.';
  if (!started) return 'Two fighters, one winner. Pick your skills.';
  if (winners) return winners.length === 0 ? 'It’s a draw.' : `${winners.map((w) => w.name).join(' and ')} win!`;
  return isHumanTurn ? 'Your turn.' : 'Battle in progress…';
}

function maxCount(ability: ManualAbility): number {
  const count = ability.targeting.count;
  if (typeof count === 'number') return count;
  if (Array.isArray(count)) return count[1] ?? 1;
  return 1;
}
