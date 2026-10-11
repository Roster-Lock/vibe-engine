/**
 * Loader entry — registers the `.svg` hooks (see `svg-hooks.mjs`) onto the
 * Node loader chain. Use together with tsx, which must register *before*
 * this one so its hooks sit later in the chain:
 *
 * ```sh
 * node --import tsx --import ./svg-loader.mjs test/ai-vs-ai.ts
 * ```
 */
import { register } from 'node:module';

register(new URL('./svg-hooks.mjs', import.meta.url));
