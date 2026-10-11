/**
 * Ambient types for monaco-editor's deep ESM entry points.
 *
 * monaco-editor's `exports` map exposes its ESM build as
 * `monaco-editor/editor/…` (mapping to `esm/vs/…`), and those files ship
 * no adjacent `.d.ts`. The top-level `monaco-editor` entry has full types,
 * so re-export them for the deep entries the UI imports.
 */
declare module 'monaco-editor/editor/editor.main.js' {
  export * from 'monaco-editor';
}

declare module 'monaco-editor/editor/editor.worker.js' {
  // Side-effect only: runs monaco's worker bootstrap when imported inside
  // the web worker.
}
