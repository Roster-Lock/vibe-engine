/**
 * Card Creator — write a card in English, watch it compile, play it.
 *
 * Left: a Monaco editor for a **card document** (`src/english/card.ts`).
 * Right: live grammar problems (click to jump), the compiled card faces
 * (cost, stat line, keywords, effect text), and the deck drawer where the
 * document is saved so the card game can use it.
 *
 * The editor checks the grammar as you type — every word is suggested by
 * `completeCardAt` when it is right, and underlined by the compiler when it
 * is not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/editor/editor.main.js';
import {
  compileCardDocument,
  type CardCompileResult,
  type CompiledCard,
  type Diagnostic,
} from '../../english/index.js';
import {
  CARD_SAMPLES,
  DEFAULT_CARD_SAMPLE,
  cardSampleDoc,
} from '../creator/card-samples.js';
import { applyCardDiagnostics, ensureTinyQuestCardLanguage, TINYQUEST_CARD_LANG } from '../creator/card-language.js';
import { CARD_LANGUAGE_ZONES } from '../../../examples/card-game/index.js';
import {
  loadCardDocs,
  removeCardDoc,
  saveCardDoc,
  type StoredCardDoc,
} from '../creator/card-store.js';

/** A one-line description of what a card's effect asks for. */
function targetingLabel(card: CompiledCard): string {
  if (!card.ability) return 'no effect';
  if (!card.targeting) return 'affects its own victims';
  const who = card.targeting.who === 'enemy' ? 'an enemy' : card.targeting.who === 'ally' ? 'an ally' : 'a character';
  return `picks ${who}`;
}

function CardFace({ card }: { card: CompiledCard }) {
  return (
    <li className="card-face">
      <div className="card-face-head">
        <span className="card-cost" title="Mana cost">
          {card.cost}
        </span>
        <span className="card-face-name">{card.name}</span>
        {card.kind === 'creature' ? (
          <span className="card-face-stats">
            {card.power ?? 0}/{card.health ?? 0}
          </span>
        ) : (
          <span className="card-face-kind">spell</span>
        )}
      </div>
      {card.keywords.length > 0 && (
        <p className="card-keywords">{card.keywords.map((k) => (k === 'taunt' ? 'Taunt' : 'Charge')).join(' · ')}</p>
      )}
      <p className="card-rules">{card.rulesText || '—'}</p>
      <p className="card-meta">
        {targetingLabel(card)}
        {card.triggers.length > 0
          ? ` · ${card.triggers.length} trigger${card.triggers.length === 1 ? '' : 's'}`
          : ''}
      </p>
    </li>
  );
}

export function CardCreatePage({ onBack, onPlay }: { onBack: () => void; onPlay: () => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);

  const [sample, setSample] = useState(DEFAULT_CARD_SAMPLE);
  const [result, setResult] = useState<CardCompileResult>(() =>
    compileCardDocument(cardSampleDoc(DEFAULT_CARD_SAMPLE), { zones: CARD_LANGUAGE_ZONES }),
  );
  const [docs, setDocs] = useState<StoredCardDoc[]>(() => loadCardDocs());
  const [savedNote, setSavedNote] = useState<string | undefined>(undefined);

  useEffect(() => {
    ensureTinyQuestCardLanguage(CARD_LANGUAGE_ZONES);
    const container = mountRef.current;
    if (!container) return;
    const editor = monaco.editor.create(container, {
      model: monaco.editor.createModel(cardSampleDoc(DEFAULT_CARD_SAMPLE), TINYQUEST_CARD_LANG),
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 14,
      lineHeight: 21,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      tabSize: 2,
      insertSpaces: true,
    });
    editorRef.current = editor;

    const refresh = (): void => {
      const value = editor.getValue();
      const compiled = compileCardDocument(value, { zones: CARD_LANGUAGE_ZONES });
      setResult(compiled);
      const model = editor.getModel();
      if (model) applyCardDiagnostics(model, compiled.diagnostics);
    };
    const onChange = (): void => {
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(refresh, 150);
    };
    const disposable = editor.onDidChangeModelContent(onChange);
    refresh();

    return () => {
      disposable.dispose();
      window.clearTimeout(timerRef.current);
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = undefined;
    };
  }, []);

  const loadSample = useCallback((title: string) => {
    setSample(title);
    setSavedNote(undefined);
    editorRef.current?.setValue(cardSampleDoc(title));
  }, []);

  const jumpTo = useCallback((diagnostic: Diagnostic) => {
    const editor = editorRef.current;
    if (!editor) return;
    const position = editor.getModel()?.getPositionAt(diagnostic.start);
    if (!position) return;
    editor.revealPositionInCenter(position);
    editor.setPosition(position);
    editor.focus();
  }, []);

  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = result.diagnostics.filter((d) => d.severity === 'warning').length;
  const canSave = errors === 0 && result.cards.length > 0;

  const save = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !canSave) return;
    const source = editor.getValue();
    const title = result.cards[0]?.name ?? 'Untitled card';
    setDocs(saveCardDoc(source, title));
    setSavedNote(`Saved “${title}” to your deck.`);
  }, [canSave, result.cards]);

  return (
    <div className="page creator-page">
      <header className="page-header">
        <button className="back" onClick={onBack}>← Menu</button>
        <h1>🃏 Card creator</h1>
        <label className="sample-picker">
          Sample
          <select value={sample} onChange={(e) => loadSample(e.target.value)} title="Load a sample card document">
            {CARD_SAMPLES.map((s) => (
              <option key={s.title} value={s.title}>{s.title}</option>
            ))}
          </select>
        </label>
      </header>

      <p className="creator-intro">
        Write a card in English — <code>Card Fireball</code>, a JSON header such as <code>{`{ "cost": 4, "type": "spell" }`}</code>,
        then <code>Deal 6 damage to target enemy character.</code> The editor autocompletes every word
        and compiles the card into something you can play.
      </p>

      <div className="creator-grid">
        <section className="creator-card editor-card">
          <div className="card-heading">
            <h2>Card document</h2>
            <span className={`diag-count ${errors > 0 ? 'has-errors' : ''}`}>
              {errors} error{errors === 1 ? '' : 's'}, {warnings} warning{warnings === 1 ? '' : 's'}
            </span>
          </div>
          <div ref={mountRef} className="editor-shell" />
        </section>

        <aside className="creator-side">
          <section className="creator-card">
            <h2>Problems</h2>
            {result.diagnostics.length === 0 ? (
              <p className="hint">No problems — the card checks out.</p>
            ) : (
              <ul className="diag-list">
                {result.diagnostics.map((d, i) => {
                  const pos = editorRef.current?.getModel()?.getPositionAt(d.start);
                  return (
                    <li key={i} className={`diag diag-${d.severity}`} onClick={() => jumpTo(d)}>
                      <span className="diag-sev">{d.severity}</span>
                      <span className="diag-msg">{d.message}</span>
                      {pos ? <span className="diag-pos">{pos.lineNumber}:{pos.column}</span> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="creator-card">
            <h2>Compiles to</h2>
            {result.cards.length === 0 ? (
              <p className="hint">
                Add a <code>Card &lt;name&gt;</code> heading to compile.
              </p>
            ) : (
              <ul className="card-face-list">
                {result.cards.map((card) => (
                  <CardFace key={card.id} card={card} />
                ))}
              </ul>
            )}
            {result.buffs.length > 0 && (
              <p className="buff-decls">
                Buffs: {result.buffs.map((b) => b.name).join(', ')}
              </p>
            )}
          </section>

          <section className="creator-card">
            <div className="card-heading">
              <h2>My deck</h2>
              <button className="run-btn" onClick={save} disabled={!canSave} title={canSave ? 'Save this document' : 'Fix the errors first'}>
                ＋ Save card{result.cards.length > 1 ? 's' : ''}
              </button>
            </div>
            {savedNote && <p className="save-note">{savedNote}</p>}
            {docs.length === 0 ? (
              <p className="hint">Nothing saved yet. Saved cards are added to the deck in the card game.</p>
            ) : (
              <>
                <ul className="deck-list">
                  {docs.map((doc) => (
                    <li key={doc.id}>
                      <span className="deck-title">{doc.title}</span>
                      <button className="deck-remove" onClick={() => setDocs(removeCardDoc(doc.id))} title="Remove from deck">
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
                <button className="run-btn play-saved" onClick={onPlay}>
                  ▶ Play a match with these cards
                </button>
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
