/**
 * Loader hooks so headless scripts can import the example content's `.svg`
 * assets (portraits, buff icons) that the browser build resolves through
 * Vite. Each `.svg` import becomes a `data:` URI string — exactly what
 * `CharacterDef.media` / `StatusDef.icon` expect.
 */
import { readFile } from 'node:fs/promises';

/** @type {import('node:module').LoadHook} */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.svg')) {
    const data = await readFile(new URL(url));
    const base64 = data.toString('base64');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default "data:image/svg+xml;base64,${base64}";`,
    };
  }
  return nextLoad(url, context);
}
