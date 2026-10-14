/**
 * The **panel** — what a player sees when they select a word.
 *
 * A panel rather than a tooltip, deliberately: a definition refers to other
 * words ("discover" mentions a library and a mana cost), and those are
 * selectable too. A panel that stays open and keeps a trail makes that chain
 * navigable, where a tooltip that disappears on mouse-out would make it a
 * sequence of unrelated popups.
 *
 * ## Recursion
 *
 * The panel is **connected**, not a pure prop-taker: it reads the trail and the
 * resolution functions from the glossary context and renders its own text
 * through the same annotation the card text uses. That is what makes a
 * definition walkable — a term inside a definition is a term like any other,
 * and selecting it pushes the next definition.
 *
 * It shows the summary first and the details on demand — the same split the
 * `Term` carries — so a buff with three triggers is not a wall of text in a
 * hover, while a player who asked for the whole thing gets it. **Both** the
 * summary and the details are glossed, so a chain can be followed from the
 * first line rather than only after expanding.
 */
import { useEffect, useState } from 'react';
import { DefinitionBody, DefinitionLine } from './markdown.js';
import { DefinitionText } from './Term.js';
import { useTermPanel } from './GlossaryProvider.js';
import type { Term as Definition } from '../../english/index.js';

export interface TermPanelProps {
  readonly onClose: () => void;
}

export function TermPanel({ onClose }: TermPanelProps) {
  const { current, trail, goTo, back } = useTermPanel();
  const [expanded, setExpanded] = useState(false);

  // A new term starts collapsed — the summary is what the player asked for.
  useEffect(() => setExpanded(false), [current?.ref.name, current?.glyph]);

  // Escape closes, the way any other transient panel in the app does.
  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, onClose]);

  if (!current) return null;

  const details = current.details ?? current.summary;
  const hasMore = details.trim() !== current.summary.trim();

  return (
    <aside className={`term-panel kind-${current.ref.kind}`} aria-live="polite">
      <header className="term-panel-head">
        {trail.length > 1 && (
          <button className="term-back" onClick={back} title="Back to the previous definition">
            ←
          </button>
        )}
        <span className="term-kind">{current.ref.kind}</span>
        <h3 className="term-name">{current.ref.name}</h3>
        <button className="term-close" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </header>

      {/*
        The trail, so a chain is a place rather than a stack of leftovers.
        Every step is a jump back to it, which is what keeps a deep walk from
        becoming a one-way trip.
      */}
      {trail.length > 1 && (
        <nav className="term-trail" aria-label="Definitions visited">
          {trail.map((step, index) => (
            <span key={`${step.ref.name}-${index}`} className="term-step">
              {index > 0 && <span className="term-step-sep">›</span>}
              {index === trail.length - 1 ? (
                <span className="term-step-current">{step.ref.name}</span>
              ) : (
                <button className="term-step-link" onClick={() => goTo(index)}>
                  {step.ref.name}
                </button>
              )}
            </span>
          ))}
        </nav>
      )}

      <DefinitionLine text={current.summary} className="term-summary" renderText={termText} />

      {current.facts && current.facts.length > 0 && (
        <dl className="term-facts">
          {current.facts.map((fact) => (
            <div className="term-fact" key={`${fact.label}-${fact.value}`}>
              <dt>{fact.label}</dt>
              {/* A fact can name a thing too ("Stacks: Taunt"), so it is glossed. */}
              <dd>
                <DefinitionText text={fact.value} />
              </dd>
            </div>
          ))}
        </dl>
      )}

      {hasMore &&
        (expanded ? (
          <DefinitionBody markdown={details} renderText={termText} />
        ) : (
          <button className="term-more" onClick={() => setExpanded(true)}>
            More…
          </button>
        ))}

      {current.examples && current.examples.length > 0 && (
        <div className="term-examples">
          <h4>For example</h4>
          <ul>
            {current.examples.map((example) => (
              <li key={example}>
                <DefinitionText text={example} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

/** Every plain run inside the definition becomes selectable terms. */
function termText(text: string, key: string) {
  return <DefinitionText key={key} text={text} />;
}

export type { Definition };
