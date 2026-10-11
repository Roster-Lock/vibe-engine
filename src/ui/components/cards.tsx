/**
 * Shared character display: an HP/mana card used by every page that shows
 * fighters.
 */
import type { Character } from '../../engine/index.js';

export function CharacterCard({
  character,
  label,
  tone,
}: {
  character: Character;
  label?: string;
  /** Side accent used by the watch battle (red vs blue). */
  tone?: 'red' | 'blue';
}) {
  const hpPct = (character.gauge('hp').current / character.gauge('hp').max) * 100;
  const manaPct = character.gauge('mana').max > 0 ? (character.gauge('mana').current / character.gauge('mana').max) * 100 : 0;
  // All buffs — including permanent ones (`removable: false`, e.g. an
  // aura's mark) — show as buff badges.
  const buffs = character.statuses.filter((s) => s.type === 'buff');

  return (
    <article className={['card', character.isDefeated ? 'defeated' : '', tone ? `tone-${tone}` : ''].filter(Boolean).join(' ')}>
      <h2>{character.name}</h2>
      {label && <p className="team">{label}</p>}
      <Bar label="HP" value={character.gauge('hp').current} max={character.gauge('hp').max} pct={hpPct} tone="hp" />
      {character.gauge('mana').max > 0 && (
        <Bar label="Mana" value={character.gauge('mana').current} max={character.gauge('mana').max} pct={manaPct} tone="mana" />
      )}
      <div className="buffs">
        {buffs.length === 0 ? (
          <span className="hint">no buffs</span>
        ) : (
          groupBuffs(buffs).map(({ id, name, icon, count }) => (
            <span className="buff" key={id}>
              {icon ? <img className="buff-icon" src={icon} alt="" /> : <span aria-hidden>✨</span>}
              {name}
              {count > 1 ? ` ×${count}` : ''}
            </span>
          ))
        )}
      </div>
      {character.isDefeated && <p className="defeated-tag">💀 defeated</p>}
    </article>
  );
}

/**
 * Groups stacked buff instances (each stack is its own instance) into one
 * badge per buff id, so "Rage ×3" reads as a single buff with a count.
 */
function groupBuffs(buffs: readonly { id: string; name: string; icon?: string }[]) {
  const groups = new Map<string, { id: string; name: string; icon?: string; count: number }>();
  for (const buff of buffs) {
    const group = groups.get(buff.id);
    if (group) {
      group.count += 1;
    } else {
      groups.set(buff.id, { id: buff.id, name: buff.name, icon: buff.icon, count: 1 });
    }
  }
  return [...groups.values()];
}

export function Bar({
  label,
  value,
  max,
  pct,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  pct: number;
  tone: 'hp' | 'mana';
}) {
  return (
    <div className="bar">
      <span className="bar-label">
        {label} {value}/{max}
      </span>
      <div className="bar-track">
        <div className={`bar-fill ${tone}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </div>
    </div>
  );
}
