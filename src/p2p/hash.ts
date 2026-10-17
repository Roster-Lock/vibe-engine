/**
 * Hashing for the peer-to-peer hidden-zone protocol (docs/design/20-secret-choices-and-dice.md,
 * "Peer-to-peer hidden zones").
 *
 * SHA-256 through WebCrypto, so the same code runs in Node and in a browser. Every hash
 * is **domain-separated** and **length-prefixed**: `H('slot', id, r)` and `H('leaf', s,
 * card)` cannot collide with each other, and `('ab', 'c')` cannot be confused with
 * `('a', 'bc')`.
 *
 * ⚠ This module has not been reviewed by a cryptographer. It is a faithful
 * implementation of the scheme in the design doc, built so it can be tested, not
 * something to put money or a ranked ladder on without review.
 */

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of `domain` and `parts`, as lowercase hex. */
export async function H(domain: string, ...parts: readonly (string | number)[]): Promise<string> {
  const encoded = [domain, ...parts.map(String)].map((part) => `${part.length}:${part}`).join('|');
  return hex(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(encoded)));
}

/** `bytes` of randomness as hex. A caller injects its own for deterministic tests. */
export type RandomHex = (bytes?: number) => string;

export const randomHex: RandomHex = (bytes = 16) => {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** A uniform integer in `[0, n)` from `random`, by rejection sampling — no modulo bias. */
export function randomBelow(n: number, random: RandomHex): number {
  if (!Number.isInteger(n) || n < 1) throw new Error(`randomBelow: n must be a positive integer, got ${n}`);
  if (n === 1) return 0;
  const range = 2 ** 32;
  const limit = range - (range % n);
  for (;;) {
    const value = Number.parseInt(random(4), 16);
    if (value < limit) return value % n;
  }
}

/* -------------------------------- Merkle -------------------------------- */

/** One step of a Merkle proof: the sibling's hash, and which side it is on. */
export interface MerkleStep {
  readonly hash: string;
  readonly side: 'left' | 'right';
}

/** The root of a Merkle tree over `leaves` (an odd node is paired with itself). */
export async function merkleRoot(leaves: readonly string[]): Promise<string> {
  if (leaves.length === 0) return H('merkle-empty');
  let level = [...leaves];
  while (level.length > 1) level = await nextLevel(level);
  return level[0]!;
}

/** The proof that leaf `index` is in the tree over `leaves`. */
export async function merkleProof(leaves: readonly string[], index: number): Promise<MerkleStep[]> {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`merkleProof: no leaf ${index} in a tree of ${leaves.length}`);
  }
  const steps: MerkleStep[] = [];
  let level = [...leaves];
  let at = index;
  while (level.length > 1) {
    const isRight = at % 2 === 1;
    const sibling = level[isRight ? at - 1 : at + 1] ?? level[at]!;
    steps.push({ hash: sibling, side: isRight ? 'left' : 'right' });
    level = await nextLevel(level);
    at = Math.floor(at / 2);
  }
  return steps;
}

/** True when `leaf` with `proof` hashes up to `root`. */
export async function verifyMerkle(root: string, leaf: string, proof: readonly MerkleStep[]): Promise<boolean> {
  let current = leaf;
  for (const step of proof) {
    current = step.side === 'left' ? await H('node', step.hash, current) : await H('node', current, step.hash);
  }
  return current === root;
}

async function nextLevel(level: readonly string[]): Promise<string[]> {
  const next: string[] = [];
  for (let i = 0; i < level.length; i += 2) {
    next.push(await H('node', level[i]!, level[i + 1] ?? level[i]!));
  }
  return next;
}
