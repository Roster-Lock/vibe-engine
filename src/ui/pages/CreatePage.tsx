/**
 * Create page — the Ability Language editor (docs/creator/01-ability-language.md).
 *
 * Left: a Monaco editor for the document. Right: the compiler's live
 * problems (click to jump), what the document compiles to (real engine
 * `cast` abilities + declared buffs), and a **Test battle** button that
 * runs the first ability in a headless arena through the actual engine —
 * the same arena the unit tests drive — replaying its event log.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/editor/editor.main.js';
import { renderToString } from 'katex';
import 'katex/dist/katex.min.css';
import {
  buildArena,
  compileDocument,
  conditionToLatex,
  effectSummary,
  runArena,
  targetingSummary,
  type CompileResult,
} from '../../english/index.js';
import type { CharsPhrase, Diagnostic, Sentence } from '../../english/index.js';
import { DEFAULT_SAMPLE, SAMPLES, sampleDoc } from '../creator/samples.js';
import { applyDiagnostics, ensureTinyQuestLanguage, TINYQUEST_LANG } from '../creator/language.js';
import { CombatLog } from '../components/log.js';
import type { GameEvent } from '../../engine/index.js';
import type { Player } from '../../engine/index.js';
import { BuffDictionary } from '../../english/dictionary.js';
import { poison } from '../../games/turn-based/content/buffs/poison/index.js';
import { rage } from '../../games/turn-based/content/buffs/rage/index.js';
import { thorns } from '../../games/turn-based/content/buffs/thorns/index.js';

// The demo application supplies example content explicitly; the language
// package itself has no built-in buffs or characters.
const exampleDictionary = new BuffDictionary([
  { name: 'Poison', def: poison },
  { name: 'Rage', def: rage },
  { name: 'Thorns', def: thorns },
]);

interface BattleState {
  readonly events: GameEvent[];
  readonly lines: string[];
  readonly winners: Player[] | undefined;
  readonly error: string | undefined;
}

function sentenceLines(sentences: readonly Sentence[]): string[] {
  return sentences.map(effectSummary);
}

function sentenceChars(sentence: Sentence): CharsPhrase | undefined {
  return sentence.kind === 'result' ? undefined : sentence.chars;
}

function Formula({ expression }: { expression: import('../../english/index.js').BooleanCondition }) {
  return (
    <span
      className="formula"
      aria-label="Boolean filter formula"
      dangerouslySetInnerHTML={{ __html: renderToString(conditionToLatex(expression), { throwOnError: false }) }}
    />
  );
}

export function CreatePage({ onBack }: { onBack: () => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);

  const [sample, setSample] = useState(DEFAULT_SAMPLE);
  const [result, setResult] = useState<CompileResult>(() => compileDocument(sampleDoc(DEFAULT_SAMPLE), { dictionary: exampleDictionary }));
  const [running, setRunning] = useState(false);
  const [battle, setBattle] = useState<BattleState | undefined>(undefined);

  // One-time editor construction + language registration.
  useEffect(() => {
    ensureTinyQuestLanguage();
    const container = mountRef.current;
    if (!container) return;
    const editor = monaco.editor.create(container, {
      model: monaco.editor.createModel(sampleDoc(DEFAULT_SAMPLE), TINYQUEST_LANG),
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
      const compiled = compileDocument(value, { dictionary: exampleDictionary });
      setResult(compiled);
      const model = editor.getModel();
      if (model) applyDiagnostics(model, compiled.diagnostics);
    };

    const onChange = (): void => {
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(refresh, 150);
    };
    const disposable = editor.onDidChangeModelContent(onChange);
    // Initial markers for the default document.
    refresh();

    return () => {
      disposable.dispose();
      window.clearTimeout(timerRef.current);
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = undefined;
    };
  }, []);

  // Loading a sample replaces the whole document.
  const loadSample = useCallback(
    (title: string) => {
      const doc = sampleDoc(title);
      setSample(title);
      editorRef.current?.setValue(doc);
    },
    [],
  );

  const jumpTo = useCallback((diagnostic: Diagnostic) => {
    const editor = editorRef.current;
    if (!editor) return;
    const position = editor.getModel()?.getPositionAt(diagnostic.start);
    if (!position) return;
    editor.revealPositionInCenter(position);
    editor.setPosition(position);
    editor.focus();
  }, []);

  const runBattle = useCallback(async () => {
    const ability = result.abilities[0];
    if (!ability) {
      setBattle({
        events: [],
        lines: ['The document has no ability — add an "Ability <name>" heading.'],
        winners: undefined,
        error: undefined,
      });
      return;
    }
    setRunning(true);
    setBattle(undefined);
    try {
      const arena = buildArena(ability);
      const run = await runArena(arena, ability);
      const lines: string[] = [];
      if (run.winners) {
        lines.push(run.winners.length === 0 ? 'Game over — a draw.' : `Game over — ${run.winners.map((w) => w.name).join(', ')} win${run.winners.length > 1 ? '' : 's'}!`);
      } else {
        lines.push('Game still going (no win/lose triggered).');
      }
      lines.push(`${arena.hero.name}: HP ${arena.hero.gauge('hp').current}/${arena.hero.gauge('hp').max}${arena.hero.destroyed ? ' (destroyed)' : ''}`);
      lines.push(`${arena.ally.name}: HP ${arena.ally.gauge('hp').current}/${arena.ally.gauge('hp').max}${arena.ally.destroyed ? ' (destroyed)' : ''}`);
      lines.push(`${arena.goblin.name}: HP ${arena.goblin.gauge('hp').current}/${arena.goblin.gauge('hp').max}${arena.goblin.destroyed ? ' (destroyed)' : ''}`);
      lines.push(`${arena.bruiser.name}: HP ${arena.bruiser.gauge('hp').current}/${arena.bruiser.gauge('hp').max}${arena.bruiser.destroyed ? ' (destroyed)' : ''}`);
      if (run.picked) lines.push(`Target picked by the arena: ${run.picked.name}.`);
      setBattle({ events: arena.events, lines, winners: run.winners, error: undefined });
    } catch (error) {
      setBattle({
        events: [],
        lines: [],
        winners: undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(false);
    }
  }, [result]);

  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = result.diagnostics.filter((d) => d.severity === 'warning').length;

  return (
    <div className="page creator-page">
      <header className="page-header">
        <button className="back" onClick={onBack}>← Menu</button>
        <h1>⚡ Ability editor</h1>
        <label className="sample-picker">
          Sample
          <select
            value={sample}
            onChange={(e) => loadSample(e.target.value)}
            title="Load a sample ability document"
          >
            {SAMPLES.map((s) => (
              <option key={s.title} value={s.title}>{s.title}</option>
            ))}
          </select>
        </label>
      </header>

      <p className="creator-intro">
        Write an ability in English — <code>Destroy target enemy character.</code> The
        editor checks the grammar as you type and compiles it into an engine
        ability you can test in battle.
      </p>

      <div className="creator-grid">
        <section className="creator-card editor-card">
          <div className="card-heading">
            <h2>Document</h2>
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
              <p className="hint">No problems — the grammar checks out.</p>
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
            {result.abilities.length === 0 ? (
              <p className="hint">
                Add an <code>Ability &lt;name&gt;</code> heading to compile.
              </p>
            ) : (
              <ul className="compile-list">
                {result.abilities.map((ability, i) => (
                  <li key={ability.id}>
                    <div className="ability-name">{ability.name}</div>
                    <div className="ability-targeting">{targetingSummary(ability)}</div>
                    <ul className="effect-list">
                      {sentenceLines(result.doc.abilities[i]?.sentences ?? []).map((line, j) => {
                        const chars = sentenceChars(result.doc.abilities[i]?.sentences[j]!);
                        return (
                          <li key={j}>
                            {line}
                            {chars?.withClause?.expression ? <Formula expression={chars.withClause.expression} /> : null}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            {result.buffs.length > 0 && (
              <p className="buff-decls">
                Buffs: {result.buffs.map((b) => `${b.name}${b.stacks ? ' (stacks)' : ''} (weight ${b.weight})`).join(', ')}
              </p>
            )}
          </section>

          <section className="creator-card">
            <div className="card-heading">
              <h2>Test battle</h2>
              <button className="run-btn" onClick={runBattle} disabled={running || result.abilities.length === 0}>
                {running ? 'Running…' : '▶ Run test battle'}
              </button>
            </div>
            <p className="hint test-hint">
              Hero (you) + Paladin vs Goblin + Bruiser. The first ability is used once, then a
              turn passes so turn-triggered buffs (Poison) can tick.
            </p>
            {battle?.error && <p className="run-error">💥 {battle.error}</p>}
            {battle && battle.error === undefined && (
              <>
                <CombatLog events={battle.events} empty="No events yet." />
                <ul className="state-list">
                  {battle.lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
