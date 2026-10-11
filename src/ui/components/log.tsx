/**
 * The combat log: turns engine events into readable lines.
 *
 * `describeEvent` renders a single event; `CombatLog` renders a list and
 * turns `turn:start` events into round banners.
 */
import { useEffect, useRef } from 'react';
import { amountOf, type GameEvent } from '../../engine/index.js';

export function describeEvent(event: GameEvent): string {
  switch (event.type) {
    case 'turn:start':
      return '— Round begins —';
    case 'turn:end':
      return '— Round ends —';
    case 'ability:used':
      return `${event.character.name} uses ${event.ability.name}`;
    case 'buff:added':
      return `${event.character.name} gains ${event.buff.name}`;
    case 'buff:destroyed':
      return `${event.character.name} loses ${event.buff.name}`;
    case 'buff:destroyed:batch':
      return `${event.events.length} ${event.events.length === 1 ? 'buff' : 'buffs'} removed!`;
    case 'cycle:detected':
      return `⚠️ ${event.grantor.name} tried to grant its own ancestor ('${event.attemptedId}') — cycle refused, ${event.grantor.name} is removed`;
    case 'character:transformed':
      return event.reason === 'pushed'
        ? `🔮 ${event.character.name} transforms into ${event.form.name ?? 'a new form'}`
        : `🔮 ${event.character.name} is no longer ${event.form.name ?? 'transformed'}`;
    case 'character:transformed:batch':
      return `🔮 ${event.events.length} ${event.events.length === 1 ? 'transformation' : 'transformations'}!`;
    case 'character:destroyed':
      return `💀 ${event.character.name} is destroyed!`;
    case 'character:destroyed:batch':
      return `💀 ${event.events.length} ${event.events.length === 1 ? 'character' : 'characters'} destroyed!`;
    case 'character:survived':
      return `🛡️ ${event.character.name} survives the hit!`;
    case 'character:survived:batch':
      return `🛡️ ${event.events.length} ${event.events.length === 1 ? 'character' : 'characters'} survive the hit!`;
    case 'zone:changed':
      return 'from' in event
        ? `${event.entity.name}: ${event.from.id} → ${event.to.id}`
        : `${event.entity.name} enters ${event.to.id}`;
    case 'zone:changed:batch':
      return `${event.events.length} ${event.events.length === 1 ? 'move' : 'moves'} between zones`;
    case 'gauge:changed:batch':
      return `${event.events.length} ${event.events.length === 1 ? 'gauge' : 'gauges'} changed!`;
    case 'gauge:changed': {
      // HP moves are damage or healing; everything else is a raw gauge line.
      // Looked up by id rather than read as `target.gauge('hp')`: a character need not
      // have an `hp` gauge (the engine does not require one).
      if ('target' in event && event.gauge === event.target.gauge('hp')) {
        const amount = amountOf(event);
        if (event.to < event.from) {
          return `${event.target.name} takes ${amount} damage${from('source' in event ? event.source : undefined, event.target)}`;
        }
        if (event.to > event.from) {
          return `${event.target.name} recovers ${amount}${from('source' in event ? event.source : undefined, event.target)}`;
        }
      }
      return `${event.gauge.id} ${event.from} → ${event.to}`;
    }
    case 'gauge:maxChanged':
      return `${event.gauge.id} max ${event.from} → ${event.to}`;
    case 'stat:changed':
      return `${event.character.name}'s ${event.stat} ${event.from} → ${event.to}`;
    // `GameEventMap` is open — a game may have declared events this renderer
    // has never heard of. It must not assume exhaustiveness, or augmenting the
    // map would stop this file from compiling.
    default:
      return `[${(event as { type: string }).type}]`;
  }
}

/** "from X" only when the source is a different character (e.g. poison hurts itself). */
function from(source: { name: string } | undefined, target: { name: string }): string {
  if (!source) return '';
  if (source.name === target.name) return '';
  return ` from ${source.name}`;
}

export function CombatLog({ events, empty = 'No events yet.' }: { events: GameEvent[]; empty?: string }) {
  const scrollRef = useRef<HTMLUListElement>(null);

  // Follow the action: keep the newest line in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  if (events.length === 0) return <p className="hint">{empty}</p>;

  let round = 0;
  return (
    <ul className="log-scroll" ref={scrollRef}>
      {events.map((event, i) => {
        if (event.type === 'turn:start') {
          round += 1;
          return (
            <li key={i} className="log-round">
              — Round {round} —
            </li>
          );
        }
        return <li key={i}>{describeEvent(event)}</li>;
      })}
    </ul>
  );
}
