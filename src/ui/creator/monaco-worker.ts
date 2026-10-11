/**
 * The editor web worker, wrapped so Vite can bundle it from a local file
 * (importing monaco's worker script with the `?worker` suffix from a bare
 * specifier does not resolve in this build).
 *
 * Importing monaco's worker module runs its bootstrap inside the worker.
 */
import 'monaco-editor/editor/editor.worker.js';
