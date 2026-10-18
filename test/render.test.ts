/**
 * Tests for **rendering** the IR back to English (`src/english/render.ts`) —
 * the direction that makes the IR a readable document rather than a
 * write-only share format (docs/design/18-english-and-blocks.md).
 *
 * The three properties under test are the ones the two-surface design
 * depends on:
 *
 *   1. the rendered text is always valid English;
 *   2. for anything the language can say, the round trip
 *      `IR → English → IR` is the identity;
 *   3. rendering is a fixpoint, so switching views repeatedly cannot drift.
 *
 * Plus the honesty property: what English *cannot* say is marked in the text
 * and reported in `gaps`, never silently dropped.
 */
import { describe, expect, it } from 'vitest';
import { parseDocument, lowerDocument, renderDocument, GAP_MARKER } from '../src/english/index.js';
import type { DocumentIR } from '../src/ir/index.js';
import { CORPUS } from './fixtures/documents.js';



/**
 * The IR minus the strings `lower` **generates**: an ability's `description`
 * and a trigger's/modifier's `name` are summaries produced by `describe.ts`,
 * not document data, so a render → re-lower legitimately recomputes them.
 * Everything else is canonical and must survive the round trip.
 */
function canonical(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(canonical);
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    const derivedName =
      'event' in record && 'scope' in record && 'steps' in record
        ? true
        : 'match' in record && 'rewrite' in record;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === 'description') continue;
      if (key === 'name' && derivedName) continue;
      out[key] = canonical(value);
    }
    return out;
  }
  return node;
}

const lower = (text: string): DocumentIR => lowerDocument(parseDocument(text).doc);

describe('renderDocument', () => {
  it('renders every document in the corpus without gaps', () => {
    for (const { name, text } of CORPUS) {
      const parsed = parseDocument(text);
      expect(parsed.diagnostics, `${name} should be valid source`).toEqual([]);
      const { gaps } = renderDocument(lower(text));
      expect(gaps, `${name} should be fully expressible in English`).toEqual([]);
    }
  });

  it('always produces text that parses', () => {
    for (const { name, text } of CORPUS) {
      const rendered = renderDocument(lower(text)).text;
      const reparsed = parseDocument(rendered);
      expect(reparsed.diagnostics, `${name} rendered to invalid English:\n${rendered}`).toEqual([]);
    }
  });

  it('round-trips IR → English → IR canonically identically', () => {
    for (const { name, text } of CORPUS) {
      const ir = lower(text);
      const rendered = renderDocument(ir).text;
      const back = lower(rendered);
      expect(canonical(back), `${name} did not round-trip:\n${rendered}`).toEqual(canonical(ir));
    }
  });

  it('is a fixpoint, so switching surfaces repeatedly cannot drift', () => {
    for (const { name, text } of CORPUS) {
      const once = renderDocument(lower(text)).text;
      const twice = renderDocument(lower(once)).text;
      expect(twice, `${name} drifted on a second render`).toBe(once);
    }
  });

  it('renders an empty document as empty text', () => {
    expect(renderDocument({ version: 1, imports: [], abilities: [], buffs: [], triggers: [] })).toEqual({
      text: '',
      gaps: [],
    });
  });

  it('reports a targeting pattern it has no sentence for, instead of losing it', () => {
    // English implies a targeting pattern from a `target …` phrase inside a
    // sentence, and can only ever mean one pick. A range, or a pattern no
    // sentence refers to, would re-lower to `{ who: 'self', count: 1 }` — so it
    // is a gap rather than a quiet rewrite.
    const base = {
      version: 1 as const,
      imports: [],
      buffs: [],
      triggers: [],
      abilities: [
        {
          id: 'ranged',
          name: 'Ranged',
          targeting: { who: 'enemy' as const, count: [1, 3] as const },
          steps: [{ effects: [{ kind: 'destroy' as const, query: { kind: 'self' as const } }] }],
        },
      ],
    };
    const ranged = renderDocument(base);
    expect(ranged.gaps.map((gap) => gap.reason)).toEqual([
      expect.stringContaining('a range of targets'),
    ]);
    expect(parseDocument(ranged.text).diagnostics).toEqual([]);

    const unreferenced = renderDocument({
      ...base,
      abilities: [{ ...base.abilities[0]!, targeting: { who: 'enemy', count: 1 } }],
    });
    expect(unreferenced.gaps.map((gap) => gap.reason)).toEqual([
      expect.stringContaining('no sentence refers to'),
    ]);
  });

  it('marks what English cannot say instead of dropping it', () => {
    // Three constructs the sentence grammar has no frame for, around one it
    // does — so a partial document must stay partial, not become all-or-nothing.
    const ir: DocumentIR = {
      version: 1,
      imports: [],
      buffs: [],
      triggers: [],
      abilities: [
        {
          id: 'advanced',
          name: 'Advanced',
          targeting: { who: 'self', count: 1 },
          steps: [
            {
              effects: [
                { kind: 'gauge', query: { kind: 'self' }, gauge: 'mana', op: 'subtract', amount: { kind: 'const', value: 3 } },
              ],
            },
            {
              effects: [
                { kind: 'gauge', query: { kind: 'self' }, gauge: { kind: 'life' }, op: 'set', amount: { kind: 'const', value: 1 } },
              ],
            },
            {
              effects: [
                {
                  kind: 'gauge',
                  query: { kind: 'self' },
                  gauge: { kind: 'life' },
                  op: 'subtract',
                  amount: { kind: 'count', query: { kind: 'all', who: 'enemy', other: false } },
                },
              ],
            },
            { effects: [{ kind: 'gauge', query: { kind: 'self' }, gauge: { kind: 'life' }, op: 'add', amount: { kind: 'const', value: 7 } }] },
          ],
        },
      ],
    };

    const { text, gaps } = renderDocument(ir);
    expect(gaps).toHaveLength(3);
    // The one sentence English can say survives, in order.
    expect(text).toContain('Heal this for 7.');
    // Each loss is visible where the author will see it, and named in `gaps`.
    for (const gap of gaps) expect(text).toContain(`${GAP_MARKER}${gap.reason}`);
    // A lossy view is still a *valid* view.
    expect(parseDocument(text).diagnostics).toEqual([]);
  });
});
