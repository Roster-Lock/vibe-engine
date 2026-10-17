/**
 * Peer-to-peer hidden zones — the protocol core (docs/design/20-secret-choices-and-dice.md).
 *
 * A way to play with a deck nobody can see and no server to trust: the owner knows what
 * each card is, the shuffler knows where each is, and each reveal is checked against a
 * hash published in advance. See `deck.ts` (the owner), `shuffler.ts`, `transcript.ts`,
 * and `audit.ts` (the end-of-game check).
 *
 * This is the protocol only: no networking, no signatures, and no connection to the
 * engine's zones yet. It has not been reviewed by a cryptographer.
 */
export { H, merkleProof, merkleRoot, randomBelow, randomHex, verifyMerkle, type MerkleStep, type RandomHex } from './hash.js';
export { OwnerDeck, type CardClaim, type DeckCommitment, type DeckOpening } from './deck.js';
export { Shuffler, verifyReveal, type OpenedSlot, type Slot } from './shuffler.js';
export { Transcript, type TranscriptBody, type TranscriptEntry } from './transcript.js';
export { audit, type AuditInput, type AuditResult } from './audit.js';
