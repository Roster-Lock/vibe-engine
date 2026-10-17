/**
 * The end-of-game audit (docs/design/20-secret-choices-and-dice.md).
 *
 * Playing detects a bad *reveal* at once (the owner checks each against the published
 * hash). What play cannot see is structural cheating — an id added or dropped, a card
 * claimed to be something it is not — so at the end both sides open everything and
 * anyone can recompute it. This detects cheating after the fact; it does not prevent it.
 */
import type { DeckOpening } from './deck.js';
import { H, merkleRoot } from './hash.js';
import type { OpenedSlot } from './shuffler.js';
import { Transcript, type TranscriptEntry } from './transcript.js';

export interface AuditInput {
  /** The log everyone kept: the deck commitment, the id hashes, the shuffle, the takes, the claims. */
  readonly transcript: readonly TranscriptEntry[];
  /** The shuffler opens every slot it ever published. */
  readonly shufflerOpening: readonly OpenedSlot[];
  /** The owner opens the whole deck. */
  readonly deckOpening: DeckOpening;
}

export interface AuditResult {
  readonly ok: boolean;
  /** What is wrong, one sentence each; empty when `ok`. */
  readonly problems: readonly string[];
}

export async function audit(input: AuditInput): Promise<AuditResult> {
  const problems: string[] = [];
  const { transcript, shufflerOpening, deckOpening } = input;

  // 1. The log itself is intact.
  if (!(await Transcript.verify(transcript))) {
    problems.push('the transcript has been altered: its hash chain does not hold');
  }

  // 2. What was published.
  const decks = transcript.filter((entry) => entry.type === 'deck');
  const published: string[] = [];
  const ownerIdHashes = new Set<string>();
  const taken: string[] = [];
  const claims: { id: string; card: string }[] = [];
  for (const entry of transcript) {
    if (entry.type === 'shuffle') published.push(...entry.commitments);
    else if (entry.type === 'rearrange') published.push(...entry.top, ...entry.bottom);
    else if (entry.type === 'idhashes') for (const hash of entry.hashes) ownerIdHashes.add(hash);
    else if (entry.type === 'take') taken.push(entry.commitment);
    else if (entry.type === 'claim') claims.push({ id: entry.id, card: entry.card });
  }
  if (decks.length !== 1) problems.push(`expected one deck commitment in the transcript, found ${decks.length}`);
  const deck = decks[0];

  // 3. The shuffler opened exactly what it published, and each opening is honest.
  const opened = shufflerOpening.map((slot) => slot.commitment);
  if (opened.length !== published.length || opened.some((commitment, i) => commitment !== published[i])) {
    problems.push(
      `the shuffler opened ${opened.length} slot(s) but published ${published.length}, or in a different order`,
    );
  }
  for (const slot of shufflerOpening) {
    if ((await H('slot', slot.id, slot.r)) !== slot.commitment) {
      problems.push('a slot the shuffler opened does not match the commitment it published');
    }
  }
  for (const commitment of taken) {
    if (!published.includes(commitment)) problems.push('a card was taken from a slot nobody had published');
  }

  // 4. Every id is used once.
  const ids = shufflerOpening.map((slot) => slot.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) problems.push('the same id was used for more than one slot (a duplicated card)');
    seen.add(id);
  }

  // 5. The owner's opening matches the commitment made before play.
  const leaves = await Promise.all(deckOpening.cards.map((card, i) => H('leaf', deckOpening.secrets[i] ?? '', card)));
  if (deck && deck.type === 'deck') {
    if ((await merkleRoot(leaves)) !== deck.root) problems.push('the owner\'s opened deck does not match the deck they committed to');
    if (deckOpening.cards.length !== deck.size) problems.push('the owner\'s opened deck is not the size they committed to');
  }

  // 6. The ids on the table are exactly the ids the owner's deck produces — no strangers, none missing.
  const cardOfId = new Map<string, string>();
  for (let i = 0; i < deckOpening.cards.length; i += 1) {
    for (let generation = 0; generation <= (deckOpening.generations[i] ?? 0); generation += 1) {
      cardOfId.set(await H('id', deckOpening.secrets[i] ?? '', generation), deckOpening.cards[i]!);
    }
  }
  for (const id of seen) {
    if (!cardOfId.has(id)) problems.push('an id on the table belongs to no card in the owner\'s deck (a stranger was added)');
  }
  for (const id of cardOfId.keys()) {
    if (!seen.has(id)) problems.push('a card in the owner\'s deck never made it onto the table (a card was dropped)');
  }

  // 7. The ids match the hashes the owner published before handing them over.
  const idHashes = new Set(await Promise.all(ids.map((id) => H('idhash', id))));
  for (const hash of idHashes) {
    if (!ownerIdHashes.has(hash)) problems.push('an id on the table was never among the ids the owner published');
  }
  for (const hash of ownerIdHashes) {
    if (!idHashes.has(hash)) problems.push('an id the owner published is missing from the table');
  }

  // 8. What the owner said cards were during play was true.
  for (const claim of claims) {
    const actual = cardOfId.get(claim.id);
    if (actual === undefined) problems.push('the owner made a claim about an id that is not in their deck');
    else if (actual !== claim.card) problems.push(`the owner claimed a card was "${claim.card}" but it was "${actual}"`);
  }

  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
