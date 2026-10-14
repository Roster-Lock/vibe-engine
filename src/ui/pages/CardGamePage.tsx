/**
 * The card table — a playable match of the collectible card game
 * (`examples/card-game`).
 *
 * Three ways to sit at the table:
 *
 * - **You vs the AI** — one human, one `GreedyAI`;
 * - **Two players, one screen** — hotseat: both sides are human, and each
 *   turn waits for the player whose turn it is;
 * - **Watch** — two AIs, paced by the speed control (and pausable).
 *
 * The page does not drive the rules: `CardGame.runLoop()` does. The page
 * only answers the game's request for a move — `HumanCardPlayer.chooseMove`
 * suspends on a promise this component resolves when the player clicks.
 * All state lives in the game object; a `version` counter re-renders the
 * board whenever the engine (or a player) has done something.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CardGame,
  HERO_POWER_COST,
  HumanCardPlayer,
  PacedGreedyAI,
  STARTER_DECK,
  type CardObject,
  type CardPlayer,
  type Move,
} from '../../../examples/card-game/index.js';
import type { Character, Player } from '../../games/turn-based/index.js';
import { PASS, put, type AbilityStackObject } from '../../games/cards/stack.js';
import { isInstant } from '../../games/cards/speed.js';
import { customCards as buildCustomCards, loadCardDocs, type StoredCardDoc } from '../creator/card-store.js';
import { Gloss, GlossaryProvider, Term, useTermPanel } from '../glossary/index.js';
import { liveDefiner, uiGlossaryOptions } from '../glossary/catalogs.js';

type Mode = 'you' | 'hotseat' | 'watch';

const SPEEDS = [
  { label: 'Slow', ms: 1300 },
  { label: 'Normal', ms: 700 },
  { label: 'Fast', ms: 300 },
  { label: 'Instant', ms: 0 },
] as const;

/** What the human at the keyboard is currently choosing. */
type Selection =
  | { readonly kind: 'card'; readonly card: CardObject; readonly targets: Character[] }
  | { readonly kind: 'attack'; readonly attacker: Character }
  | { readonly kind: 'hero-power' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The targeting pattern a selection asks for, if any. */
function patternFor(selection: Selection) {
  switch (selection.kind) {
    case 'card':
      return selection.card.kind === 'spell' ? selection.card.targeting : selection.card.onPlayTargeting;
    case 'attack':
    case 'hero-power':
      return { who: 'enemy' as const, count: 1 };
  }
}

/** Whether a card can be played right now (mana, and somewhere to point it). */
function playableNow(game: CardGame, player: CardPlayer, card: CardObject): boolean {
  const side = game.sideOf(player);
  if (card.cost > side.mana) return false;
  // A creature is always castable: an enters-play effect with nowhere to point simply
  // fizzles (`GreedyAI` reads it the same way).
  if (card.kind === 'creature') return true;
  if (!card.targeting) return true;
  return game.targetsFor(card, player).length > 0;
}

/* ------------------------------ presentation ----------------------------- */

function HeroPanel({
  game,
  player,
  active,
  waiting,
  onTarget,
  targetable,
}: {
  game: CardGame;
  player: CardPlayer;
  active: boolean;
  waiting: boolean;
  onTarget: (character: Character) => void;
  targetable: boolean;
}) {
  const side = game.sideOf(player);
  const hero = side.hero;
  const hp = hero.gauge('hp');
  const mana = hero.gauge('mana');
  return (
    <div
      className={['hero-panel', active ? 'active' : '', waiting ? 'waiting' : '', targetable ? 'targetable' : ''].filter(Boolean).join(' ')}
      onClick={targetable ? () => onTarget(hero) : undefined}
    >
      <div className="hero-name">
        {hero.name}
        {active && <span className="hero-turn">●</span>}
      </div>
      <div className="hero-stats">
        <span className="hero-hp" title="Health">❤ {hp.current}/{hp.max}</span>
        <span className="hero-mana" title="Mana">◆ {mana.current}/{mana.max}</span>
      </div>
      <div className="hero-piles">
        <span title="Cards in hand">✋ {side.hand.size}</span>
        <span title="Cards left in deck">🂠 {side.deck.size}</span>
        <span title="Spent spells">🗑 {side.garbage.size}</span>
      </div>
    </div>
  );
}

function MinionToken({
  character,
  ready,
  targetable,
  attacking,
  onClick,
}: {
  character: Character;
  ready: boolean;
  targetable: boolean;
  attacking: boolean;
  onClick: () => void;
}) {
  const { define } = useTermPanel();
  const hp = character.gauge('hp');
  const power = character.stat('power') ?? 0;
  const taunt = character.hasStatus('taunt');
  // The minion's name is a term: clicking it explains *this* creature (its
  // gauges now, its buffs, its abilities) without being mistaken for an
  // attack. The inner span stops the click from reaching the token.
  const definition = define({ kind: 'character', name: character.name });
  return (
    <button
      className={['minion', ready ? 'ready' : '', targetable ? 'targetable' : '', attacking ? 'attacking' : '', taunt ? 'taunt' : ''].filter(Boolean).join(' ')}
      onClick={onClick}
      disabled={!ready && !targetable}
      title={taunt ? 'Taunt — must be attacked first' : undefined}
    >
      <span className="minion-name">
        {definition ? <Term term={definition}>{character.name}</Term> : character.name}
      </span>
      <span className="minion-stats">
        <span className="minion-power">{power}</span>
        <span className="minion-hp">{hp.current}</span>
      </span>
      {taunt && <span className="minion-taunt">🛡 taunt</span>}
    </button>
  );
}

/* ---------------------------------- page --------------------------------- */

export function CardGamePage({ onMenu, onCreate }: { onMenu: () => void; onCreate: () => void }) {
  const [mode, setMode] = useState<Mode>('you');
  const [useCustom, setUseCustom] = useState(true);
  const [phase, setPhase] = useState<'setup' | 'playing' | 'done'>('setup');
  const [log, setLog] = useState<string[]>([]);
  const [winners, setWinners] = useState<Player[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [paused, setPaused] = useState(false);
  const [matchKey, setMatchKey] = useState(0);
  const [, setVersion] = useState(0);

  const gameRef = useRef<CardGame | undefined>(undefined);
  const playersRef = useRef<CardPlayer[]>([]);
  const matchIdRef = useRef(0);
  const pausedRef = useRef(false);
  const resumeRef = useRef<(() => void) | undefined>(undefined);
  const speedRef = useRef<number>(SPEEDS[1]!.ms);

  const docs: StoredCardDoc[] = useMemo(() => loadCardDocs(), [matchKey]);
  const custom = useMemo(() => buildCustomCards(docs), [docs]);
  const deck = useMemo(
    () => (useCustom && custom.length > 0 ? [...STARTER_DECK, ...custom] : [...STARTER_DECK]),
    [useCustom, custom],
  );

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const appendLog = useCallback((line: string) => {
    setLog((prev) => (prev.length > 250 ? [...prev.slice(-250), line] : [...prev, line]));
  }, []);

  useEffect(() => {
    speedRef.current = SPEEDS[speedIdx]!.ms;
  }, [speedIdx]);

  const togglePause = useCallback(() => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next) {
      const resume = resumeRef.current;
      resumeRef.current = undefined;
      resume?.();
    }
  }, []);

  const start = useCallback(() => {
    const matchId = matchIdRef.current + 1;
    matchIdRef.current = matchId;
    setPhase('playing');
    setLog([]);
    setWinners(undefined);
    setError(undefined);
    setSelection(undefined);
    pausedRef.current = false;
    setPaused(false);

    const beat = async (): Promise<void> => {
      // A match that was replaced or left parks here forever instead of
      // ticking: the loop is abandoned, not merely ignored.
      if (matchIdRef.current !== matchId) return new Promise<void>(() => {});
      bump();
      if (pausedRef.current) {
        await new Promise<void>((resolve) => {
          resumeRef.current = resolve;
        });
      }
      if (matchIdRef.current !== matchId) return;
      await sleep(speedRef.current);
      if (matchIdRef.current === matchId) bump();
    };

    const human = (name: string, team: string): HumanCardPlayer => {
      const player = new HumanCardPlayer(name, team, deck);
      player.onWaiting = (): void => {
        if (matchIdRef.current !== matchId) return;
        setSelection(undefined);
        bump();
      };
      return player;
    };
    const ai = (name: string, team: string): PacedGreedyAI =>
      new PacedGreedyAI(name, team, deck, beat);

    const players: CardPlayer[] =
      mode === 'hotseat'
        ? [human('Player 1', 'one'), human('Player 2', 'two')]
        : mode === 'watch'
          ? [ai('AI · red', 'red'), ai('AI · blue', 'blue')]
          : [human('You', 'you'), ai('Greedy AI', 'ai')];

    const game = new CardGame(players, {
      log: (line) => {
        if (matchIdRef.current === matchId) appendLog(line);
      },
      onEvent: () => {
        if (matchIdRef.current === matchId) bump();
      },
    });
    gameRef.current = game;
    playersRef.current = players;
    bump();

    void game
      .runLoop()
      .then((result) => {
        if (matchIdRef.current !== matchId) return;
        setWinners(result);
        setPhase('done');
      })
      .catch((cause: unknown) => {
        if (matchIdRef.current !== matchId) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase('done');
      });
  }, [appendLog, bump, deck, mode]);

  /** Abandon the running match and go back to the setup screen. */
  const newMatch = useCallback(() => {
    matchIdRef.current += 1;
    const resume = resumeRef.current;
    resumeRef.current = undefined;
    resume?.();
    setPhase('setup');
    setMatchKey((k) => k + 1); // reload saved cards for the next match
    setSelection(undefined);
    setWinners(undefined);
    setError(undefined);
  }, []);

  const game = gameRef.current;
  const activePlayer = game?.activePlayer;
  const humanWaiting = playersRef.current.find(
    (player): player is HumanCardPlayer => player instanceof HumanCardPlayer && player === activePlayer && player.isWaiting,
  );
  /** A human the game is asking to answer the stack. */
  const responder = playersRef.current.find(
    (player): player is HumanCardPlayer => player instanceof HumanCardPlayer && player.isResponding,
  );
  /** True while the current selection is a *response*, not a move. */
  const [responding, setResponding] = useState(false);
  /** A human whose simultaneous triggers are waiting to be ordered. */
  const orderer = playersRef.current.find(
    (player): player is HumanCardPlayer => player instanceof HumanCardPlayer && player.isOrdering,
  );
  const pendingTriggers = orderer?.pendingTriggers;
  /** The order picked so far — the order they go *on* the stack. */
  const [triggerOrder, setTriggerOrder] = useState<readonly AbilityStackObject[]>([]);
  // A new batch is a new question: start from an empty order.
  useEffect(() => setTriggerOrder([]), [pendingTriggers]);

  /** Picks the next trigger; the last pick resolves first. */
  const chooseTrigger = (trigger: AbilityStackObject): void => {
    if (!orderer || !pendingTriggers) return;
    const chosen = [...triggerOrder, trigger];
    setTriggerOrder(chosen);
    if (chosen.length === pendingTriggers.length) {
      setTriggerOrder([]);
      orderer.submitTriggerOrder(chosen);
      bump();
    }
  };

  /** The characters the current selection may point at. */
  const validTargets = useMemo(() => {
    const actor = humanWaiting ?? responder;
    if (!game || !selection || !actor) return [];
    return selection.kind === 'card'
      ? game.targetsFor(selection.card, actor)
      : selection.kind === 'attack'
        ? game.attackTargets(selection.attacker)
        : game.heroPowerTargets(actor);
  }, [game, selection, humanWaiting, responder]);

  const submit = useCallback(
    (move: Move) => {
      const player = humanWaiting;
      if (!player) return;
      setSelection(undefined);
      player.submitMove(move);
      bump();
    },
    [bump, humanWaiting],
  );

  /** Commits a card: a response puts it on the stack, a move plays it. */
  const commitCard = useCallback(
    (card: CardObject, targets: Character[], response: boolean) => {
      if (!game) return;
      setSelection(undefined);
      if (response) {
        const player = responder;
        setResponding(false);
        if (!player) return;
        // Casting costs, wherever it is cast from.
        void game.chargeFor(card, player).then((paid) => {
          if (paid) player.submitPriority(put(game.castObject(card, player, targets)));
          else player.submitPriority(PASS);
        });
        bump();
        return;
      }
      const player = humanWaiting;
      if (!player) return;
      player.submitMove({ kind: 'play', card, targets });
      bump();
    },
    [bump, game, humanWaiting, responder],
  );

  const maxTargets = (selection: Selection | undefined): number => {
    if (!selection) return 1;
    if (selection.kind !== 'card') return 1;
    const pattern = patternFor(selection);
    const count = pattern?.count ?? 1;
    return Array.isArray(count) ? count[1] : count;
  };

  const pickTarget = (target: Character): void => {
    if (!game || !selection || !(humanWaiting ?? responder)) return;
    // A single-target choice (an attack, the hero power, a 1-target card)
    // commits the moment it is clicked.
    if (selection.kind === 'attack') {
      submit({ kind: 'attack', attacker: selection.attacker, target });
      return;
    }
    if (selection.kind === 'hero-power') {
      submit({ kind: 'hero-power', target });
      return;
    }
    const pattern = patternFor(selection);
    const max = maxTargets(selection);
    const allowDuplicates = (pattern as { allowDuplicates?: boolean } | undefined)?.allowDuplicates === true;
    const chosen = selection.targets.includes(target) && !allowDuplicates
      ? selection.targets.filter((t) => t !== target)
      : [...selection.targets, target];
    if (chosen.length >= max) {
      commitCard(selection.card, chosen, responding);
      return;
    }
    setSelection({ kind: 'card', card: selection.card, targets: chosen });
  };

  /** Begin choosing targets for a card (or commit it immediately). */
  const chooseCard = (card: CardObject, response = false): void => {
    const actor = humanWaiting ?? responder;
    if (!game || !actor) return;
    const pattern = card.kind === 'spell' ? card.targeting : card.onPlayTargeting;
    // A creature whose enters-play effect has no legal target still lands —
    // the effect fizzles rather than the card being unplayable.
    const asks =
      pattern !== undefined &&
      (card.kind === 'spell' || game.targetsFor(card, actor).length > 0);
    if (!asks) {
      commitCard(card, [], response);
      return;
    }
    setSelection({ kind: 'card', card, targets: [] });
  };

  /**
   * What the responding human may actually cast: **instants** only (the
   * symbol from `speed.ts`), affordable, and with somewhere to point.
   */
  const responderHand = useMemo(() => {
    if (!game || !responder) return [];
    const hand = game.sideOf(responder);
    return [...hand.hand.cards]
      .filter((card) => isInstant(card))
      .map((card) => ({
        card,
        playable: card.cost <= hand.mana && playableNow(game, responder, card),
      }));
  }, [game, responder]);

  const side = game && humanWaiting ? game.sideOf(humanWaiting) : undefined;
  const readyAttackers = new Set(game && side ? game.readyAttackers(side) : []);
  const targetSet = new Set(validTargets);

  const opponents = playersRef.current.filter((p) => p !== activePlayer);

  /** One player's whole side of the table. */
  const renderSide = (player: CardPlayer, playerIndex: number) => {
    if (!game) return null;
    const pside = game.sideOf(player);
    const isActive = player === activePlayer;
    const heroTargetable = targetSet.has(pside.hero);
    const showHand = player instanceof HumanCardPlayer || mode === 'watch';
    const handCards = [...pside.hand.cards];
    return (
      <section className={['player-side', isActive ? 'active' : ''].filter(Boolean).join(' ')} key={player.id}>
        <div className="side-head">
          <span className="side-name">{player.name}</span>
          {isActive && <span className="side-badge">{humanWaiting === player ? 'your move' : 'thinking…'}</span>}
        </div>
        <HeroPanel
          game={game}
          player={player}
          active={isActive}
          waiting={humanWaiting === player}
          targetable={heroTargetable}
          onTarget={pickTarget}
        />
        <div className="board-row">
          {pside.board.length === 0 ? (
            <span className="hint board-empty">no creatures</span>
          ) : (
            pside.board.map((creature, index) => (
              <MinionToken
                key={`${creature.name}-${index}`}
                character={creature}
                ready={humanWaiting === player && readyAttackers.has(creature)}
                targetable={targetSet.has(creature)}
                attacking={selection?.kind === 'attack' && selection.attacker === creature}
                onClick={() => {
                  if (targetSet.has(creature)) pickTarget(creature);
                  else if (humanWaiting === player && readyAttackers.has(creature)) {
                    setSelection({ kind: 'attack', attacker: creature });
                  }
                }}
              />
            ))
          )}
        </div>
        <div className="hand-row">
          {!showHand ? (
            <span className="hint board-empty">✋ {pside.hand.size} in hand</span>
          ) : handCards.length === 0 ? (
            <span className="hint board-empty">empty hand</span>
          ) : (
            handCards.map((card, index) => {
              const canPlay = humanWaiting === player && playableNow(game, player, card);
              const chosen = selection?.kind === 'card' && selection.card === card;
              return (
                <button
                  key={`${card.id}-${index}`}
                  className={['hand-card', canPlay ? 'playable' : '', chosen ? 'chosen' : ''].filter(Boolean).join(' ')}
                  disabled={!canPlay}
                  onClick={() => chooseCard(card)}
                >
                  <span className="hand-cost">{card.cost}</span>
                  <span className="hand-name">{card.name}</span>
                  <span className="hand-rules">
                    {card.text ? (
                      <Gloss text={card.text} />
                    ) : card.kind === 'creature' ? (
                      `${card.power}/${card.health}`
                    ) : (
                      ''
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <p className="side-footnote">{playerIndex === 0 ? 'plays first' : 'the coin, simplified: one extra card'}</p>
      </section>
    );
  };

  // Every character the match registered, read lazily: the glossary asks for
  // what is on the board at the moment a word is selected, not when the page
  // first rendered.
  const glossaryOptions = useMemo(
    () =>
      uiGlossaryOptions({
        define: liveDefiner(() => gameRef.current?.engine.registeredCharacters ?? []),
      }),
    [],
  );

  return (
    <GlossaryProvider options={glossaryOptions}>
    <div className="page card-game-page">
      <header className="page-header">
        <button className="back" onClick={onMenu}>← Menu</button>
        <h1>🃏 Card game</h1>
        <button className="back" onClick={onCreate}>⚡ Create cards</button>
      </header>

      {phase === 'setup' && (
        <section className="card-setup">
          <h2>Start a match</h2>
          <div className="mode-picker">
            <button className={mode === 'you' ? 'chosen' : ''} onClick={() => setMode('you')}>You vs the AI</button>
            <button className={mode === 'hotseat' ? 'chosen' : ''} onClick={() => setMode('hotseat')}>Two players, one screen</button>
            <button className={mode === 'watch' ? 'chosen' : ''} onClick={() => setMode('watch')}>Watch two AIs</button>
          </div>
          <label className="custom-toggle">
            <input
              type="checkbox"
              checked={useCustom}
              disabled={custom.length === 0}
              onChange={(e) => setUseCustom(e.target.checked)}
            />
            Use my cards ({custom.length} saved, {docs.length} document{docs.length === 1 ? '' : 's'})
          </label>
          <p className="hint">
            Both decks are the starter deck plus your saved cards. Build cards in the{' '}
            <button className="link-button" onClick={onCreate}>Card creator</button> — they are saved to this browser.
          </p>
          <button className="primary" onClick={start}>▶ Deal</button>
        </section>
      )}

      {phase !== 'setup' && game && (
        <div className="table-layout">
          <div className="table-main">
            {mode !== 'watch' && humanWaiting && (
              <p className="turn-prompt">
                {humanWaiting.name}, your move — play a card, attack, or end the turn.
                {selection && (
                  <span className="selection-hint">
                    {' '}
                    {selection.kind === 'card' && maxTargets(selection) > 1
                      ? `Pick ${maxTargets(selection)} targets (${selection.targets.length} chosen) — a chosen one again removes it.`
                      : 'Click a highlighted target to commit, or cancel.'}
                  </span>
                )}
              </p>
            )}
            {orderer && pendingTriggers && (
              <div className="respond-bar order-bar">
                <div className="respond-head">
                  <strong>{orderer.name}, order your triggers</strong>
                  <span className="hint">
                    {pendingTriggers.length} abilities triggered at once — pick them in the order they go on the
                    stack. The last one you pick resolves first.
                  </span>
                </div>
                <ol className="trigger-order">
                  {triggerOrder.map((trigger, index) => (
                    <li key={`${trigger.name}-${index}`}>{trigger.name}</li>
                  ))}
                  {triggerOrder.length === 0 && <li className="hint">nothing chosen yet</li>}
                </ol>
                <div className="hand-row">
                  {pendingTriggers
                    .filter((trigger) => !triggerOrder.includes(trigger))
                    .map((trigger, index) => (
                      <button
                        key={`${trigger.name}-${index}`}
                        className="hand-card playable"
                        onClick={() => chooseTrigger(trigger)}
                      >
                        <span className="hand-name">{trigger.name}</span>
                      </button>
                    ))}
                </div>
                <button
                  className="menu-secondary"
                  onClick={() => {
                    // Keeping the table order is a real answer, and the one a
                    // player wants when they do not care.
                    setTriggerOrder([]);
                    orderer.submitTriggerOrder([...pendingTriggers]);
                    bump();
                  }}
                >
                  Keep table order
                </button>
              </div>
            )}
            {responder && !humanWaiting && game.cardStack.size > 0 && (
              <div className="respond-bar">
                <div className="respond-head">
                  <strong>{responder.name}, respond?</strong>
                  <span className="hint">
                    {game.cardStack.size} on the stack ({game.cardStack.top?.name}) — cast an instant, or let it resolve.
                  </span>
                </div>
                <div className="hand-row">
                  {responderHand.map(({ card, playable }) => (
                    <button
                      key={card.id}
                      className={['hand-card', playable ? 'playable' : '', selection?.kind === 'card' && selection.card === card ? 'chosen' : ''].filter(Boolean).join(' ')}
                      disabled={!playable}
                      onClick={() => {
                        // The flag is passed, not read from state: state
                        // has not re-rendered yet in this same tick.
                        setResponding(true);
                        chooseCard(card, true);
                      }}
                    >
                      <span className="hand-cost">{card.cost}</span>
                      <span className="hand-name">{card.name}</span>
                      <span className="hand-rules">{card.text ?? ''}</span>
                    </button>
                  ))}
                  {responderHand.length === 0 && <span className="hint board-empty">no instants to cast</span>}
                </div>
                <button
                  className="primary"
                  onClick={() => {
                    setSelection(undefined);
                    setResponding(false);
                    responder.submitPriority(PASS);
                    bump();
                  }}
                >
                  Pass
                </button>
              </div>
            )}
            {renderSide(opponents[0] ?? playersRef.current[1]!, 1)}
            <div className="versus-row">
              <span>turn {game.turn}</span>
              <span className="versus">vs</span>
            </div>
            {renderSide(playersRef.current[0]!, 0)}
          </div>

          <aside className="table-side">
            <section className="creator-card">
              <h2>Controls</h2>
              {selection && (
                <button className="menu-secondary" onClick={() => setSelection(undefined)}>✕ Cancel targeting</button>
              )}
              {humanWaiting && side && (
                <div className="controls-row">
                  <button
                    className="menu-secondary"
                    disabled={side.mana < HERO_POWER_COST || game.heroPowerTargets(humanWaiting).length === 0}
                    onClick={() => setSelection({ kind: 'hero-power' })}
                    title={`${HERO_POWER_COST} mana: deal 1 damage`}
                  >
                    ✦ Fireblast ({HERO_POWER_COST})
                  </button>
                  <button className="primary" onClick={() => submit({ kind: 'end' })}>End turn</button>
                </div>
              )}
              {mode === 'watch' && (
                <>
                  <label className="speed-picker">
                    Speed
                    <select value={speedIdx} onChange={(e) => setSpeedIdx(Number(e.target.value))}>
                      {SPEEDS.map((s, i) => (
                        <option key={s.label} value={i}>{s.label}</option>
                      ))}
                    </select>
                  </label>
                  <button className="menu-secondary" onClick={togglePause}>{paused ? '▶ Resume' : '⏸ Pause'}</button>
                </>
              )}
              <button className="menu-secondary" onClick={newMatch}>↻ New match</button>
            </section>

            <section className="creator-card">
              <h2>Status</h2>
              {error && <p className="run-error">💥 {error}</p>}
              {phase === 'done' && !error && (
                <p className="result-line">
                  {!winners || winners.length === 0
                    ? 'The match ended in a draw.'
                    : `${winners.map((w) => w.name).join(' and ')} win${winners.length === 1 ? 's' : ''}!`}
                </p>
              )}
              {phase === 'playing' && (
                <p className="hint">Turn {game.turn} — {activePlayer?.name} is up.</p>
              )}
            </section>

            <section className="creator-card">
              <h2>Game rules</h2>
              <ul className="rules-list">
                {game.rules.all().map((rule) => (
                  <li key={rule.id} title={`${rule.at} · ${rule.affects}`}>{rule.name}</li>
                ))}
              </ul>
              <p className="hint">Standing rules, not a turn script — content can add, replace or remove one.</p>
            </section>

            <section className="creator-card log-card">
              <h2>Play-by-play</h2>
              <ul className="log-scroll card-log">
                {log.length === 0 ? (
                  <li className="hint">Dealing…</li>
                ) : (
                  log.map((line, i) => (
                    <li key={i}>
                      <Gloss text={line} />
                    </li>
                  ))
                )}
              </ul>
            </section>
          </aside>
        </div>
      )}
    </div>
    </GlossaryProvider>
  );
}
