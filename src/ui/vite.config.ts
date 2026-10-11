import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The UI is a Vite + React app rooted at src/ui/. Run it with:
 *
 *   npm run ui:dev      # dev server (http://localhost:5173)
 *   npm run ui:build    # emits the compiled app to dist/ui/
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // The Ability editor's monaco worker is a module worker (it imports
  // monaco's worker script), so workers build in ES format.
  worker: {
    format: 'es',
  },
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
  },
});
