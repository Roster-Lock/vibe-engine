/** Shared helpers for building status instances. */

/** The default id for a status: its name lowercased and hyphenated. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Monotonic counter backing `Status.uid` — every instance gets a fresh id. */
let nextUid = 0;

/** The next per-instance id: `'buff-1'`, `'skill-2'`, … (never reused). */
export function nextInstanceUid(kind: 'buff' | 'skill'): string {
  nextUid += 1;
  return `${kind}-${nextUid}`;
}

export { slugify };
