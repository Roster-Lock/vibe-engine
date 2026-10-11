/**
 * The watch battle — two AIs fighting it out while you spectate.
 *
 * Two phases:
 *
 * 1. **Load UI** — the chosen fighters are built and their "assets"
 *    (sprites, audio, skills, AI brains) are loaded into memory, shown as
 *    a staged progress bar.
 * 2. **Game UI** — a `LocalGame` runs with a `RandomAI` on each side. The
 *    round loop is driven from here so we can pace it: one beat before each
 *    round and after each fighter's action, with speed/pause controls.
 *
 * The loop is invalidated via a match id on rematch or unmount, so a stale
 * async loop can never overwrite a newer match's state.
 */
import { useEffect, useRef, useState } from 'react';
import { GameEndInterrupt, isDamage, isHpChange, type Character, type GameEvent, type Player } from '../../games/turn-based/index.js';
import { LocalGame } from '../../multiplayer/local.js';
import { RandomAI } from '../../multiplayer/random-ai.js';
import { CharacterCard } from '../components/cards.js';
import { CombatLog } from '../components/log.js';
import type { CharacterDef } from '../../games/turn-based/content/index.js';
import { endTurn, startTurn } from '../../games/round-based/index.js';

const MAX_ROUNDS = 60;

const SPEEDS = [
  { label: 'Slow', ms: 1100 },
  { label: 'Normal', ms: 650 },
  { label: 'Fast', ms: 250 },
  { label: 'Instant', ms: 0 },
] as const;

/** Event kinds worth showing in the watch log (bars already show HP/mana). */
const WATCH_EVENTS = new Set<GameEvent['type']>([
  'turn:start',
  'ability:used',
  'gauge:changed',
  'gauge:changed:batch',
  'buff:added',
  'buff:destroyed',
  'character:destroyed',
  'character:destroyed:batch',
  'character:survived',
  'character:survived:batch',
]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Which SVG animation a fighter is showing right now. */
type Anim = 'idle' | 'attack' | 'hit';
interface AnimState {
  readonly kind: Anim;
  /** Bumped on every change so the <img> remounts and the SMIL replays. */
  readonly n: number;
}

/** How long an attack/hit animation plays before easing back to idle. */
const ANIM_HOLD_MS = 700;

export function GamePage({
  leftEntry,
  rightEntry,
  onExit,
  onMenu,
}: {
  leftEntry: CharacterDef;
  rightEntry: CharacterDef;
  /** Back to fighter selection. */
  onExit: () => void;
  /** Back to the main menu. */
  onMenu: () => void;
}) {
  const [phase, setPhase] = useState<'loading' | 'playing' | 'done'>('loading');
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadLabel, setLoadLabel] = useState('Warming up…');
  const [loadedLeft, setLoadedLeft] = useState(false);
  const [loadedRight, setLoadedRight] = useState(false);

  const [left, setLeft] = useState<Character | undefined>(undefined);
  const [right, setRight] = useState<Character | undefined>(undefined);
  const [log, setLog] = useState<GameEvent[]>([]);
  const [rounds, setRounds] = useState(0);
  const [winners, setWinners] = useState<Player[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const [speedIdx, setSpeedIdx] = useState(2); // Fast by default
  const [paused, setPaused] = useState(false);
  const [matchKey, setMatchKey] = useState(0);

  const [leftAnim, setLeftAnim] = useState<AnimState>({ kind: 'idle', n: 0 });
  const [rightAnim, setRightAnim] = useState<AnimState>({ kind: 'idle', n: 0 });

  const matchIdRef = useRef(0);
  const speedRef = useRef<number>(SPEEDS[2]!.ms);
  const pausedRef = useRef(false);
  const pushEventRef = useRef<(event: GameEvent) => void>(() => {});
  const leftNameRef = useRef('');
  const rightNameRef = useRef('');
  const animTimersRef = useRef<{ left?: number; right?: number }>({});

  /** Which side (if any) a character name belongs to. */
  const sideOf = (name: string | undefined): 'left' | 'right' | undefined => {
    if (!name) return undefined;
    if (name === leftNameRef.current) return 'left';
    if (name === rightNameRef.current) return 'right';
    return undefined;
  };

  /** Show an animation on one side, easing back to idle shortly after. */
  const setSideAnim = (side: 'left' | 'right', kind: Anim) => {
    const setter = side === 'left' ? setLeftAnim : setRightAnim;
    const matchId = matchIdRef.current;
    setter((prev) => ({ kind, n: prev.n + 1 }));
    const timers = animTimersRef.current;
    if (timers[side] !== undefined) window.clearTimeout(timers[side]);
    timers[side] = window.setTimeout(() => {
      timers[side] = undefined;
      if (matchIdRef.current === matchId) {
        setter((prev) => ({ kind: 'idle', n: prev.n + 1 }));
      }
    }, ANIM_HOLD_MS);
  };

  const pushEvent = (event: GameEvent) => {
    setLog((prev) => (prev.length >= 400 ? [...prev.slice(-399), event] : [...prev, event]));
    // Drive the little fighters: act → attack, take damage → flinch.
    if (event.type === 'ability:used') {
      const side = sideOf(event.character.name);
      if (side) setSideAnim(side, 'attack');
    } else if (isDamage(event) && event.target) {
      const side = sideOf(event.target.name);
      if (side) setSideAnim(side, 'hit');
    }
  };
  pushEventRef.current = pushEvent;

  const chooseSpeed = (index: number) => {
    const speed = SPEEDS[index]!;
    setSpeedIdx(index);
    speedRef.current = speed.ms;
  };

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    pausedRef.current = next;
  };

  /* --------------------------- game driving --------------------------- */

  useEffect(() => {
    const matchId = matchIdRef.current + 1;
    matchIdRef.current = matchId;
    void startMatch(matchId);
    // startMatch only touches refs and stable setters, so matchKey is the
    // only dependency worth tracking (a rematch restarts the whole flow).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey]);

  // Invalidate any in-flight loop and clear animation timers on unmount.
  useEffect(
    () => () => {
      matchIdRef.current += 1;
      window.clearTimeout(animTimersRef.current.left);
      window.clearTimeout(animTimersRef.current.right);
    },
    [],
  );

  const startMatch = async (matchId: number) => {
    setPhase('loading');
    setLoadProgress(0);
    setLoadedLeft(false);
    setLoadedRight(false);
    setWinners(undefined);
    setError(undefined);
    setLog([]);
    setRounds(0);
    setPaused(false);
    pausedRef.current = false;
    setLeftAnim({ kind: 'idle', n: 0 });
    setRightAnim({ kind: 'idle', n: 0 });
    window.clearTimeout(animTimersRef.current.left);
    window.clearTimeout(animTimersRef.current.right);
    animTimersRef.current = {};

    // 1. Build the fighters — they now live in memory.
    const leftChar = leftEntry.make();
    const rightChar = rightEntry.make();
    leftNameRef.current = leftChar.name;
    rightNameRef.current = rightChar.name;
    setLeft(leftChar);
    setRight(rightChar);

    // 2. Load their assets (staged, purely for the show).
    const ok = await loadAssets(matchId, leftEntry, rightEntry);
    if (!ok) return;

    // 3. Wire up the AI players and the match.
    const leftAI = new RandomAI(`${leftChar.name} AI`, [leftChar], 'red');
    const rightAI = new RandomAI(`${rightChar.name} AI`, [rightChar], 'blue');
    const local = new LocalGame([leftAI, rightAI], {
      maxRounds: MAX_ROUNDS,
      onEvent: (event) => pushEventRef.current(event),
    });

    if (matchIdRef.current !== matchId) return;
    setPhase('playing');
    await drive(matchId, local);
  };

  const loadAssets = async (matchId: number, left: CharacterDef, right: CharacterDef): Promise<boolean> => {
    const stages: Array<{ label: string; weight: number }> = [
      { label: 'Warming up the engine…', weight: 6 },
      { label: `Building ${left.name}…`, weight: 10 },
      { label: `Loading ${left.name} sprites…`, weight: 14 },
      { label: `Loading ${left.name} audio…`, weight: 10 },
      { label: `Compiling ${left.name} skills…`, weight: 12 },
      { label: `Building ${right.name}…`, weight: 10 },
      { label: `Loading ${right.name} sprites…`, weight: 14 },
      { label: `Loading ${right.name} audio…`, weight: 10 },
      { label: `Compiling ${right.name} skills…`, weight: 12 },
      { label: 'Wiring up the AI brains…', weight: 12 },
    ];
    let progress = 0;
    for (let i = 0; i < stages.length; i += 1) {
      const stage = stages[i]!;
      if (matchIdRef.current !== matchId) return false;
      setLoadLabel(stage.label);
      progress = Math.min(100, progress + stage.weight);
      setLoadProgress(progress);
      // The portraits "arrive in memory" as their load stages complete.
      if (i === 5) setLoadedLeft(true);
      if (i === 9) setLoadedRight(true);
      await sleep(130);
    }
    await sleep(250);
    return true;
  };

  /**
   * The paced battle loop — the same shape as `LocalGame.runLoop`, with a
   * beat between rounds and between each fighter's action so you can watch
   * it play out.
   */
  const drive = async (matchId: number, local: LocalGame): Promise<void> => {
    try {
      let round = 0;
      while (true) {
        if (matchIdRef.current !== matchId) return;
        await beat();

        const decisions = await local.collectUserDecisions();
        round += 1;
        setRounds(round);
        if (round > MAX_ROUNDS) throw new GameEndInterrupt([]); // draw at the cap

        for (const decision of decisions) {
          if (matchIdRef.current !== matchId) return;
          await local.engine.useAbility(decision.character, decision.ability, {
            targets: decision.targets,
          });
          await beat();
        }

        await endTurn(local.engine);
        // Win/lose is decided by the engine now: a killing blow (or a
        // `win`/`lose` action) throws the GameEndInterrupt caught below.
      }
    } catch (caught) {
      if (matchIdRef.current !== matchId) return;
      if (caught instanceof GameEndInterrupt) {
        setWinners(caught.winners);
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      setPhase('done');
    }
  };

  const beat = async () => {
    const ms = speedRef.current;
    if (ms > 0) await sleep(ms);
    while (pausedRef.current) await sleep(80);
  };

  /* ----------------------------- rendering ---------------------------- */

  // Show HP gauge moves (damage/heal) but skip raw mana lines.
  const visibleLog = log.filter(
    (event) => WATCH_EVENTS.has(event.type) && (event.type !== 'gauge:changed' || isHpChange(event)),
  );

  return (
    <div className="page game-page">
      <header className="page-header">
        <button className="back" onClick={onExit}>← Fighters</button>
        <h1>Watch battle</h1>
        <button className="back" onClick={onMenu}>Menu</button>
      </header>

      {phase === 'loading' && left && right && (
        <section className="load-screen">
          <h2>Loading assets into memory…</h2>
          <div className="load-fighters">
            <div className="load-side">
              <img
                className={['load-portrait', loadedLeft ? 'loaded' : ''].filter(Boolean).join(' ')}
                src={leftEntry.media.portrait}
                alt={left.name}
              />
              <CharacterCard character={left} label="red side" tone="red" />
            </div>
            <div className="load-side">
              <img
                className={['load-portrait', loadedRight ? 'loaded' : ''].filter(Boolean).join(' ')}
                src={rightEntry.media.portrait}
                alt={right.name}
              />
              <CharacterCard character={right} label="blue side" tone="blue" />
            </div>
          </div>
          <div className="load-bar">
            <div className="load-fill" style={{ width: `${loadProgress}%` }} />
          </div>
          <p className="load-label">{loadLabel}</p>
        </section>
      )}

      {phase !== 'loading' && left && right && (
        <>
          <section className="match">
            <div className="fighter">
              <div className="arena tone-red">
                <img
                  key={`${leftAnim.kind}-${leftAnim.n}`}
                  className="arena-figure"
                  src={leftEntry.media[leftAnim.kind]}
                  alt={left.name}
                />
              </div>
              <CharacterCard character={left} label="AI · red side" tone="red" />
            </div>
            <div className="match-center">
              <span className="round-badge">Round {rounds}</span>
              <span className="vs-badge">vs</span>
            </div>
            <div className="fighter">
              <div className="arena tone-blue">
                <img
                  key={`${rightAnim.kind}-${rightAnim.n}`}
                  className="arena-figure"
                  src={rightEntry.media[rightAnim.kind]}
                  alt={right.name}
                />
              </div>
              <CharacterCard character={right} label="AI · blue side" tone="blue" />
            </div>
          </section>

          <section className="controls">
            <span className="control-label">Speed</span>
            {SPEEDS.map((speed, i) => (
              <button
                key={speed.label}
                className={i === speedIdx ? 'speed chosen' : 'speed'}
                onClick={() => chooseSpeed(i)}
              >
                {speed.label}
              </button>
            ))}
            <span className="spacer" />
            <button className="pause" onClick={togglePause} disabled={phase === 'done'}>
              {paused ? '▶ Resume' : '⏸ Pause'}
            </button>
          </section>

          <section className="panel log-panel">
            <h2>Combat log</h2>
            <CombatLog events={visibleLog} empty="The fighters are loading…" />
          </section>

          {phase === 'done' && (
            <section className="panel result">
              <h2>
                {winners && winners.length === 0
                  ? 'It’s a draw!'
                  : winners
                    ? `${winners.map((w) => w.name).join(' and ')} win!`
                    : 'The battle is over.'}
              </h2>
              <p className="hint">After {rounds} round{rounds === 1 ? '' : 's'}.</p>
              <div className="result-actions">
                <button className="primary" onClick={() => setMatchKey((k) => k + 1)}>
                  🔄 Rematch
                </button>
                <button onClick={onExit}>Change fighters</button>
                <button onClick={onMenu}>Main menu</button>
              </div>
            </section>
          )}

          {error && (
            <section className="panel result error">
              <h2>Something went wrong</h2>
              <p>{error}</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
