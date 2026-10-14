/**
 * The player's saved card documents — the bridge between the Card Creator
 * and the card game.
 *
 * What is stored is the **source the player wrote**, never the compiled
 * closures: a `Card` carries engine functions, so it is rebuilt on load by
 * compiling the document again. That keeps the authored deck exactly as
 * portable as the language itself (docs/GOAL.md: the document *is* the
 * share format), and means a fix to the compiler immediately improves every
 * saved card.
 */
import { playableCards, type Card } from '../../../examples/card-game/index.js';
import { compileCardDocument } from '../../english/index.js';

export interface StoredCardDoc {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly savedAt: number;
}

const STORAGE_KEY = 'tinyquest.card-docs.v1';

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The saved documents, newest first. */
export function loadCardDocs(): StoredCardDoc[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredDoc).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

function isStoredDoc(value: unknown): value is StoredCardDoc {
  if (typeof value !== 'object' || value === null) return false;
  const doc = value as Partial<StoredCardDoc>;
  return typeof doc.id === 'string' && typeof doc.title === 'string' && typeof doc.source === 'string';
}

function persist(docs: readonly StoredCardDoc[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(docs));
  } catch {
    // Storage may be full or blocked; the session still works in memory.
  }
}

/** The title of a document — its first card's name. */
export function documentTitle(source: string): string {
  const compiled = compileCardDocument(source);
  return compiled.cards[0]?.name ?? 'Untitled card';
}

/** Saves (or replaces, by title) a document and returns the new list. */
export function saveCardDoc(source: string, title = documentTitle(source)): StoredCardDoc[] {
  const doc: StoredCardDoc = {
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'card',
    title,
    source,
    savedAt: Date.now(),
  };
  const others = loadCardDocs().filter((entry) => entry.id !== doc.id);
  const docs = [doc, ...others];
  persist(docs);
  return docs;
}

export function removeCardDoc(id: string): StoredCardDoc[] {
  const docs = loadCardDocs().filter((entry) => entry.id !== id);
  persist(docs);
  return docs;
}

/**
 * Compiles every saved document into playable cards. Documents with errors
 * are skipped — the editor only saves clean ones, but a hand-edited
 * localStorage entry should not be able to break a match.
 */
export function customCards(docs: readonly StoredCardDoc[]): Card[] {
  const byId = new Map<string, Card>();
  for (const doc of docs) {
    const result = playableCards(doc.source);
    if (result.diagnostics.some((d) => d.severity === 'error')) continue;
    for (const card of result.cards) byId.set(card.id, card);
  }
  return [...byId.values()];
}
