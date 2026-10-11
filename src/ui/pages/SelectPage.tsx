/**
 * Fighter selection — pick the two combatants for the watch battle.
 *
 * Click a roster card to assign it to the first free slot (Fighter A first,
 * then B; new picks replace B when both are taken). Click a selected card
 * to remove it, or use **Random Select** to let fate choose.
 */
import { useMemo, useState } from 'react';
import type { Character } from '../../engine/index.js';
import { ROSTER, type CharacterDef } from '../../games/turn-based/content/index.js';

export function SelectPage({
  onBack,
  onStart,
}: {
  onBack: () => void;
  /** Called with the two chosen fighters when the battle is ready. */
  onStart: (left: CharacterDef, right: CharacterDef) => void;
}) {
  const [left, setLeft] = useState<CharacterDef | undefined>(undefined);
  const [right, setRight] = useState<CharacterDef | undefined>(undefined);

  // One preview character per fighter (fresh instances, only for stats).
  const previews = useMemo(
    () => new Map(ROSTER.map((entry) => [entry.id, entry.make()])),
    [],
  );

  const slotOf = (entry: CharacterDef): 'a' | 'b' | undefined => {
    if (left?.id === entry.id) return 'a';
    if (right?.id === entry.id) return 'b';
    return undefined;
  };

  const toggle = (entry: CharacterDef) => {
    if (left?.id === entry.id) {
      setLeft(undefined);
    } else if (right?.id === entry.id) {
      setRight(undefined);
    } else if (!left) {
      setLeft(entry);
    } else if (!right) {
      setRight(entry);
    } else {
      setRight(entry); // both full: new picks replace Fighter B
    }
  };

  const randomSelect = () => {
    const pool = [...ROSTER];
    const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    const b = pool[Math.floor(Math.random() * pool.length)];
    if (a && b) {
      setLeft(a);
      setRight(b);
    }
  };

  const ready = left !== undefined && right !== undefined;

  return (
    <div className="page select-page">
      <header className="page-header">
        <button className="back" onClick={onBack}>← Menu</button>
        <h1>Choose your fighters</h1>
      </header>

      <section className="slots">
        <Slot label="Fighter A" entry={left} />
        <span className="vs-badge">vs</span>
        <Slot label="Fighter B" entry={right} />
      </section>

      <section className="select-actions">
        <button onClick={randomSelect}>🎲 Random Select</button>
        <button
          className="primary"
          disabled={!ready}
          onClick={() => {
            if (left && right) onStart(left, right);
          }}
        >
          ▶ Start Watch
        </button>
      </section>
      <p className="hint">
        Click a fighter to add them — click again to remove. With both slots
        full, new picks replace Fighter B.
      </p>

      <section className="roster">
        {ROSTER.map((entry) => {
          const slot = slotOf(entry);
          const preview = previews.get(entry.id);
          return (
            <button
              key={entry.id}
              className={['roster-card', slot ? `selected slot-${slot}` : ''].filter(Boolean).join(' ')}
              onClick={() => toggle(entry)}
            >
              <img className="roster-portrait" src={entry.media.portrait} alt={entry.name} />
              <span className="roster-name">{entry.name}</span>
              <span className="roster-tagline">{entry.tagline}</span>
              {preview && <Stats character={preview} />}
              {slot && <span className="slot-tag">{slot === 'a' ? 'A' : 'B'}</span>}
            </button>
          );
        })}
      </section>
    </div>
  );
}

function Slot({ label, entry }: { label: string; entry: CharacterDef | undefined }) {
  return (
    <div className={['slot', entry ? 'filled' : ''].filter(Boolean).join(' ')}>
      <span className="slot-label">{label}</span>
      {entry ? (
        <>
          <img className="slot-portrait" src={entry.media.portrait} alt={entry.name} />
          <span className="slot-name">{entry.name}</span>
        </>
      ) : (
        <span className="slot-empty">— pick a fighter —</span>
      )}
    </div>
  );
}

function Stats({ character }: { character: Character }) {
  return (
    <>
      <span className="roster-stats">
        <span className="chip hp">❤️ {character.gauge('hp').max}</span>
        {character.gauge('mana').max > 0 && <span className="chip mana">🔷 {character.gauge('mana').max}</span>}
        <span className="chip speed">⚡ {character.speed}</span>
      </span>
      <span className="roster-abilities">
        {character.manualAbilities.map((ability) => (
          <span className="roster-ability" key={ability.id}>
            <strong>{ability.name}</strong>
            {ability.description ? ` — ${ability.description}` : ''}
          </span>
        ))}
      </span>
    </>
  );
}
