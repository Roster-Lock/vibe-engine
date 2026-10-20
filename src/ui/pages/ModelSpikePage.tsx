/**
 * Spike: can we render an actual 3D model (MDX, the Warcraft 3 format) in
 * the browser and switch between its named animation sequences? Powered by
 * `mdx-m3-viewer` (WebGL, MIT-licensed). The model here is the library's own
 * `SmileyGW_004.mdx` test asset — not a Warcraft 3 asset, so it carries none
 * of the Hive Workshop licensing questions; it only proves the pipeline.
 *
 * Not a real page yet: no loading state, no error UI beyond a log line, no
 * camera controls. Enough to answer "does this work at all".
 */
import { useEffect, useRef, useState } from 'react';
// Imported from the `viewer` submodule directly, not the package root —
// the root barrel also re-exports `utils.jass2`, which pulls in fengari
// (a Lua VM for Jass scripting we don't use) and, with it, Node built-ins
// (`os`) that don't exist in the browser.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as viewer from 'mdx-m3-viewer/dist/cjs/viewer/index.js';

const MODEL_PATH = '/models/smiley/SmileyGW_004.mdx';

function pathSolver(src: string) {
  return src.startsWith('/') ? src : `/models/smiley/${src}`;
}

export function ModelSpikePage({ onBack }: { onBack: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const instanceRef = useRef<any>(null);
  const [sequences, setSequences] = useState<string[]>([]);
  const [activeSequence, setActiveSequence] = useState(-1);
  const [status, setStatus] = useState('loading…');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const lib = (viewer as any).default ?? viewer;
    const { ModelViewer, handlers } = lib;

    const modelViewer = new ModelViewer(canvas);
    const scene = modelViewer.addScene();
    scene.camera.move([0, 0, 400]);

    modelViewer.addHandler(handlers.mdx);
    modelViewer.addHandler(handlers.blp);

    modelViewer.on('error', (e: unknown) => setStatus(`error: ${JSON.stringify(e)}`));

    let cancelled = false;
    let raf = 0;

    modelViewer.load(MODEL_PATH, pathSolver).then((model: any) => {
      if (cancelled || !model) {
        if (!cancelled) setStatus('failed to load model');
        return;
      }
      const instance = model.addInstance();
      instance.setScene(scene);
      instance.setSequenceLoopMode(2); // always loop, for a steady demo
      instance.setSequence(0);
      instanceRef.current = instance;
      setSequences((model.sequences as { name: string }[]).map((s) => s.name));
      setActiveSequence(0);
      setStatus('loaded');
    });

    (function step() {
      raf = requestAnimationFrame(step);
      modelViewer.updateAndRender();
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  function playSequence(index: number) {
    instanceRef.current?.setSequence(index);
    setActiveSequence(index);
  }

  return (
    <div className="page">
      <header className="page-header">
        <button className="back" onClick={onBack}>
          ← Menu
        </button>
        <h1>3D model spike</h1>
      </header>

      <p className="hint">
        Status: {status}. {sequences.length > 0 && `${sequences.length} sequences found in the model.`}
      </p>

      <canvas
        ref={canvasRef}
        width={640}
        height={480}
        style={{ background: '#0a0a12', borderRadius: 8, display: 'block' }}
      />

      {sequences.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
          {sequences.map((name, i) => (
            <button
              key={`${name}-${i}`}
              className={i === activeSequence ? 'chosen' : ''}
              onClick={() => playSequence(i)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
