/**
 * Peer-to-peer hidden zones (src/p2p, docs/design/20-secret-choices-and-dice.md).
 *
 * The owner knows what each card is, the shuffler knows where each is, and neither can
 * learn a card without the other. An honest game passes the audit; every way of
 * cheating below is caught — at the reveal where play can see it, at the audit where
 * it cannot.
 */
import { describe, expect, it } from 'vitest';
import {
  H,
  OwnerDeck,
  Shuffler,
  Transcript,
  audit,
  merkleProof,
  merkleRoot,
  randomBelow,
  verifyMerkle,
  verifyReveal,
  type RandomHex,
  type TranscriptEntry,
} from '../src/p2p/index.js';

const CARDS = ['Fire', 'Ice', 'Wind', 'Stone', 'Leaf'];

/** A repeatable stand-in for randomness (xorshift), so a test is not flaky. Never use for real. */
function seeded(seed: number): RandomHex {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  return (bytes = 16) => {
    let out = '';
    while (out.length < bytes * 2) out += next().toString(16).padStart(8, '0');
    return out.slice(0, bytes * 2);
  };
}

/** Sets up a deck, its published commitments and a shuffled pile, with a transcript of it all. */
async function game(cards: readonly string[] = CARDS, seed = 1) {
  const owner = await OwnerDeck.create(cards, { random: seeded(seed) });
  const transcript = new Transcript();
  await transcript.append({ type: 'deck', ...owner.commitment() });
  const ids = await owner.currentIds();
  await transcript.append({ type: 'idhashes', hashes: await owner.idHashes(ids) });
  const shuffler = await Shuffler.shuffle(ids, { random: seeded(seed + 100) });
  await transcript.append({ type: 'shuffle', commitments: shuffler.published() });
  return { owner, shuffler, transcript, ids };
}

/** The owner draws the top card, checking the reveal against what was published. */
async function draw(g: Awaited<ReturnType<typeof game>>) {
  const commitment = g.shuffler.published()[0]!;
  const slot = g.shuffler.take(0);
  await g.transcript.append({ type: 'take', position: 0, commitment });
  const honest = await verifyReveal(commitment, slot);
  return { slot, honest, card: g.owner.lookup(slot.id)?.card };
}

describe('an honest game', () => {
  it('draws a card the owner can read and nobody else can', async () => {
    const g = await game();
    const { slot, honest, card } = await draw(g);
    expect(honest).toBe(true);
    expect(CARDS).toContain(card);
    // What the shuffler holds is an id and a salt — not the card.
    expect(Object.values(slot)).not.toContain(card);
    expect(slot.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('passes the audit through draws, a scry and a claim', async () => {
    const g = await game();
    const first = await draw(g);
    expect(first.honest).toBe(true);

    // Scry 3: the owner is shown the top three, puts one back on top and two on the bottom.
    const looked = [g.shuffler.peek(0), g.shuffler.peek(1), g.shuffler.peek(2)];
    for (const slot of looked) expect(await verifyReveal(g.shuffler.published()[looked.indexOf(slot)]!, slot)).toBe(true);
    const fresh = await g.owner.rename(looked.map((slot) => slot.id));
    await g.transcript.append({ type: 'idhashes', hashes: await g.owner.idHashes(fresh) });
    const placed = await g.shuffler.rearrange(3, fresh.slice(0, 1), fresh.slice(1));
    await g.transcript.append({ type: 'rearrange', removed: 3, top: placed.top, bottom: placed.bottom });

    // The owner plays a card and proves what it was.
    const claim = await g.owner.claimFor(first.slot.id);
    expect(await verifyMerkle(g.owner.root, await H('leaf', claim.secret, claim.card), claim.proof)).toBe(true);
    await g.transcript.append({ type: 'claim', id: first.slot.id, card: claim.card });

    const result = await audit({
      transcript: g.transcript.entries,
      shufflerOpening: g.shuffler.openAll(),
      deckOpening: g.owner.open(),
    });
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('keeps the pile consistent: every card drawn exactly once, none twice', async () => {
    const g = await game();
    const drawn: string[] = [];
    for (let i = 0; i < CARDS.length; i += 1) drawn.push((await draw(g)).card!);
    expect([...drawn].sort()).toEqual([...CARDS].sort());
    expect((await audit({ transcript: g.transcript.entries, shufflerOpening: g.shuffler.openAll(), deckOpening: g.owner.open() })).ok).toBe(true);
  });
});

describe('what each side can and cannot tell', () => {
  it('the commitments hide the order: the same ids shuffled twice commit to different values', async () => {
    const owner = await OwnerDeck.create(CARDS, { random: seeded(3) });
    const ids = await owner.currentIds();
    const a = await Shuffler.shuffle(ids, { random: seeded(10) });
    const b = await Shuffler.shuffle(ids, { random: seeded(11) });
    expect(new Set([...a.published(), ...b.published()]).size).toBe(ids.length * 2);
  });

  it('a commitment is salted, so it cannot be matched against the ids it could be', async () => {
    const g = await game();
    const unsalted = await Promise.all(g.ids.map((id) => H('slot', id, '')));
    for (const commitment of g.shuffler.published()) expect(unsalted).not.toContain(commitment);
  });

  it('the owner is the only one who can name an id', async () => {
    const g = await game();
    for (const id of g.ids) expect(g.owner.lookup(id)).toBeDefined();
    expect(g.owner.lookup('f'.repeat(64))).toBeUndefined();
  });
});

describe('a bad reveal is caught at once', () => {
  it('rejects a different id, a different salt, or the wrong position', async () => {
    const g = await game();
    const published = g.shuffler.published();
    const real = g.shuffler.peek(0);
    expect(await verifyReveal(published[0]!, real)).toBe(true);
    expect(await verifyReveal(published[0]!, { id: g.ids[0] === real.id ? g.ids[1]! : g.ids[0]!, r: real.r })).toBe(false);
    expect(await verifyReveal(published[0]!, { id: real.id, r: 'a'.repeat(32) })).toBe(false);
    expect(await verifyReveal(published[1]!, real)).toBe(false);
  });
});

describe('cheating the audit catches', () => {
  const run = async (g: Awaited<ReturnType<typeof game>>, overrides: Partial<Parameters<typeof audit>[0]> = {}) =>
    audit({
      transcript: g.transcript.entries,
      shufflerOpening: g.shuffler.openAll(),
      deckOpening: g.owner.open(),
      ...overrides,
    });

  it('a stranger id slipped into the pile', async () => {
    const owner = await OwnerDeck.create(CARDS, { random: seeded(5) });
    const ids = await owner.currentIds();
    const stranger = await H('id', 'not-in-the-deck', 0);
    const crooked = [...ids.slice(0, -1), stranger]; // swap the last card for a stranger
    const transcript = new Transcript();
    await transcript.append({ type: 'deck', ...owner.commitment() });
    await transcript.append({ type: 'idhashes', hashes: await owner.idHashes(ids) });
    const shuffler = await Shuffler.shuffle(crooked, { random: seeded(6) });
    await transcript.append({ type: 'shuffle', commitments: shuffler.published() });
    // The owner already notices it when it is drawn: the id names nothing of theirs.
    expect(owner.lookup(stranger)).toBeUndefined();
    const result = await audit({ transcript: transcript.entries, shufflerOpening: shuffler.openAll(), deckOpening: owner.open() });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/stranger was added/);
    expect(result.problems.join(' ')).toMatch(/a card was dropped/);
  });

  it('a card duplicated in place of another', async () => {
    const owner = await OwnerDeck.create(CARDS, { random: seeded(7) });
    const ids = await owner.currentIds();
    const crooked = [ids[0]!, ids[0]!, ...ids.slice(2)]; // the second card is gone, the first appears twice
    const transcript = new Transcript();
    await transcript.append({ type: 'deck', ...owner.commitment() });
    await transcript.append({ type: 'idhashes', hashes: await owner.idHashes(ids) });
    const shuffler = await Shuffler.shuffle(crooked, { random: seeded(8) });
    await transcript.append({ type: 'shuffle', commitments: shuffler.published() });
    const result = await audit({ transcript: transcript.entries, shufflerOpening: shuffler.openAll(), deckOpening: owner.open() });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/more than one slot/);
    expect(result.problems.join(' ')).toMatch(/never made it onto the table/);
  });

  it('a card the shuffler quietly dropped', async () => {
    const owner = await OwnerDeck.create(CARDS, { random: seeded(9) });
    const ids = await owner.currentIds();
    const transcript = new Transcript();
    await transcript.append({ type: 'deck', ...owner.commitment() });
    await transcript.append({ type: 'idhashes', hashes: await owner.idHashes(ids) });
    const shuffler = await Shuffler.shuffle(ids.slice(1), { random: seeded(9) });
    await transcript.append({ type: 'shuffle', commitments: shuffler.published() });
    const result = await audit({ transcript: transcript.entries, shufflerOpening: shuffler.openAll(), deckOpening: owner.open() });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/an id the owner published is missing|never made it onto the table/);
  });

  it('a slot the shuffler cannot honestly open', async () => {
    const g = await game();
    const opening = g.shuffler.openAll().map((slot, i) => (i === 2 ? { ...slot, r: 'b'.repeat(32) } : slot));
    const result = await run(g, { shufflerOpening: opening });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/does not match the commitment it published/);
  });

  it('an owner who claims a card was something else', async () => {
    const g = await game();
    const { slot, card } = await draw(g);
    const lie = CARDS.find((c) => c !== card)!;
    await g.transcript.append({ type: 'claim', id: slot.id, card: lie });
    const result = await run(g);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(new RegExp(`claimed a card was "${lie}" but it was "${card}"`));
  });

  it('a Merkle proof for a card that is not the committed one fails when it is played', async () => {
    const g = await game();
    const claim = await g.owner.claim(0);
    const forged = await H('leaf', claim.secret, 'A Better Card');
    expect(await verifyMerkle(g.owner.root, forged, claim.proof)).toBe(false);
  });

  it('an owner whose opened deck is not the deck they committed to', async () => {
    const g = await game();
    const open = g.owner.open();
    const swapped = { ...open, cards: open.cards.map((card, i) => (i === 0 ? 'Dragon' : card)) };
    const result = await run(g, { deckOpening: swapped });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/does not match the deck they committed to/);
  });

  it('a transcript that has been edited', async () => {
    const g = await game();
    await draw(g);
    const edited: TranscriptEntry[] = g.transcript.entries.map((entry, i) =>
      i === 1 && entry.type === 'idhashes' ? { ...entry, hashes: entry.hashes.slice(1) } : entry,
    );
    expect(await Transcript.verify(edited)).toBe(false);
    expect((await run(g, { transcript: edited })).problems.join(' ')).toMatch(/hash chain does not hold/);
  });

  it('a transcript with an entry removed or reordered', async () => {
    const g = await game();
    await draw(g);
    const entries = [...g.transcript.entries];
    expect(await Transcript.verify(entries.slice(1))).toBe(false);
    expect(await Transcript.verify([entries[1]!, entries[0]!, ...entries.slice(2)])).toBe(false);
    expect(await Transcript.verify(entries)).toBe(true);
  });

  it('a card taken from a slot that was never published', async () => {
    const g = await game();
    await g.transcript.append({ type: 'take', position: 0, commitment: 'c'.repeat(64) });
    expect((await run(g)).problems.join(' ')).toMatch(/slot nobody had published/);
  });
});

describe('renaming after a scry', () => {
  it('gives each looked-at card a new id the shuffler cannot connect to the old one', async () => {
    const g = await game();
    const looked = [g.shuffler.peek(0).id, g.shuffler.peek(1).id, g.shuffler.peek(2).id];
    const cardsBefore = looked.map((id) => g.owner.lookup(id)!.card);
    const fresh = await g.owner.rename(looked);
    expect(fresh).toHaveLength(3);
    for (const id of fresh) expect(looked).not.toContain(id);
    // The owner still knows what each is...
    expect(fresh.map((id) => g.owner.lookup(id)!.card).sort()).toEqual([...cardsBefore].sort());
    // ...and each new id is a new generation of the same card.
    for (const id of fresh) expect(g.owner.lookup(id)!.generation).toBe(1);
  });

  it('returns the new ids in a random order, so the set does not say which replaced which', async () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 12; seed += 1) {
      const owner = await OwnerDeck.create(CARDS, { random: seeded(seed) });
      const old = (await owner.currentIds()).slice(0, 3);
      const fresh = await owner.rename(old);
      const sameOrder = fresh.map((id) => owner.lookup(id)!.index).join(',');
      orders.add(sameOrder);
    }
    expect(orders.size).toBeGreaterThan(1); // not always in the original order
  });

  it('refuses to rename an id twice, or one that is not the deck\'s', async () => {
    const g = await game();
    const id = g.ids[0]!;
    await g.owner.rename([id]);
    await expect(g.owner.rename([id])).rejects.toThrow(/already retired/);
    await expect(g.owner.rename(['0'.repeat(64)])).rejects.toThrow(/not one of this deck's/);
  });

  it('rearranges the pile: the scried cards leave, the renamed ones go on top and bottom', async () => {
    const g = await game();
    const sizeBefore = g.shuffler.size;
    const looked = [g.shuffler.peek(0).id, g.shuffler.peek(1).id];
    const fresh = await g.owner.rename(looked);
    await g.shuffler.rearrange(2, [fresh[0]!], [fresh[1]!]);
    expect(g.shuffler.size).toBe(sizeBefore);
    expect(g.shuffler.peek(0).id).toBe(fresh[0]);
    expect(g.shuffler.peek(sizeBefore - 1).id).toBe(fresh[1]);
  });

  it('a pile can only be scried as deep as it is', async () => {
    const g = await game(['A', 'B']);
    await expect(g.shuffler.rearrange(3, [], [])).rejects.toThrow(/only 2 cards/);
    expect(() => g.shuffler.take(5)).toThrow(/no slot at position 5/);
    expect(() => g.shuffler.peek(-1)).toThrow(/no slot/);
  });
});

describe('the Merkle commitment', () => {
  it('proves every leaf of a tree of any size, and nothing else', async () => {
    for (let size = 1; size <= 9; size += 1) {
      const leaves = await Promise.all(Array.from({ length: size }, (_, i) => H('leaf', i, 'x')));
      const root = await merkleRoot(leaves);
      for (let i = 0; i < size; i += 1) {
        expect(await verifyMerkle(root, leaves[i]!, await merkleProof(leaves, i))).toBe(true);
      }
      expect(await verifyMerkle(root, await H('leaf', 'other'), await merkleProof(leaves, 0))).toBe(false);
    }
  });

  it('is sensitive to order and to content', async () => {
    const a = await merkleRoot(['1', '2', '3']);
    expect(await merkleRoot(['1', '3', '2'])).not.toBe(a);
    expect(await merkleRoot(['1', '2', '4'])).not.toBe(a);
  });

  it('refuses a proof for a leaf that is not there', async () => {
    await expect(merkleProof(['a', 'b'], 2)).rejects.toThrow(/no leaf 2/);
  });
});

describe('the hashing', () => {
  it('cannot confuse one input with another: the parts are length-prefixed and the domain is part of it', async () => {
    expect(await H('d', 'ab', 'c')).not.toBe(await H('d', 'a', 'bc'));
    expect(await H('slot', 'x', 'y')).not.toBe(await H('leaf', 'x', 'y'));
    expect(await H('d', 'x')).toBe(await H('d', 'x'));
  });

  it('draws unbiased integers: a die from the injected randomness lands near evenly', () => {
    const random = seeded(42);
    const counts = new Array<number>(6).fill(0);
    for (let i = 0; i < 6000; i += 1) counts[randomBelow(6, random)]! += 1;
    for (const count of counts) expect(Math.abs(count - 1000)).toBeLessThan(150);
    expect(() => randomBelow(0, random)).toThrow();
  });
});
