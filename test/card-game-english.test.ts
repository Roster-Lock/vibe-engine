/**
 * Tests for cards **authored in English** (`examples/card-game/english.ts`)
 * — the pipeline from a player's card document, through the Ability
 * Language, into a card the game can actually play.
 *
 * The point of these tests is that authored content is not a special case:
 * it is bound to the same engine abilities the catalog uses, so a custom
 * spell damages through the same action pipeline as the hand-written
 * Fireball.
 */
import { describe, expect, it } from 'vitest';
import { CardPlayer } from '../examples/card-game/ai.js';
import type { Card } from '../examples/card-game/cards.js';
import { WISP } from '../examples/card-game/cards.js';
import { playableCards, toGameCard } from '../examples/card-game/english.js';
import { CardGame, type Move } from '../examples/card-game/game.js';
import type { Character } from '../src/engine/index.js';

class ScriptedCardPlayer extends CardPlayer {
  #script: ((game: CardGame) => Move)[] = [];

  script(...moves: ((game: CardGame) => Move)[]): this {
    this.#script = [...moves];
    return this;
  }

  override async chooseMove(game: CardGame): Promise<Move> {
    const next = this.#script.shift();
    return next ? next(game) : { kind: 'end' };
  }
}

const deckOf = (card: Card, n = 30): Card[] => Array.from({ length: n }, () => card);

/** Plays the first copy of a card from the active side's hand. */
const play =
  (card: Card, targets: (game: CardGame) => Character[] = () => []) =>
  (game: CardGame): Move => {
    const inHand = game.activeSide.hand.cards.find((c) => c.id === card.id);
    if (!inHand) throw new Error(`test: ${card.name} is not in hand`);
    return { kind: 'play', card: inHand, targets: targets(game) };
  };

async function turn(game: CardGame): Promise<void> {
  await game.collectUserDecisions();
  await game.runGame();
}

describe('authored cards — conversion', () => {
  it('turns a creature card into a playable stat line with its keyword', () => {
    const { cards, diagnostics } = playableCards(
      ['Card Test Bulwark', 'Cost 2', 'Creature 2/5', 'Taunt.'].join('\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const card = cards[0]!;
    expect(card.kind).toBe('creature');
    if (card.kind !== 'creature') throw new Error('expected a creature');
    expect(card.power).toBe(2);
    expect(card.health).toBe(5);
    expect(card.keywords).toEqual(['taunt']);
    expect(card.id.startsWith('authored-')).toBe(true);
  });

  it('gives an enters-play creature an onPlay with a targeting pattern', () => {
    const { cards } = playableCards(
      ['Card Test Archer', 'Cost 1', 'Creature 1/1', 'When this enters play then Deal 1 damage to target enemy character.'].join('\n'),
    );
    const card = cards[0]!;
    if (card.kind !== 'creature') throw new Error('expected a creature');
    expect(card.onPlay).toBeDefined();
    expect(card.onPlayTargeting).toEqual({ who: 'enemy', count: 1 });
  });

  it('leaves an untargeted effect without a targeting pattern', () => {
    const { cards } = playableCards(
      ['Card Test Wave', 'Cost 2', 'Spell', 'Deal 2 damage to all enemy characters.'].join('\n'),
    );
    const card = cards[0]!;
    if (card.kind !== 'spell') throw new Error('expected a spell');
    expect(card.targeting).toBeUndefined();
  });

  it('keeps the id slug so a card named Fireball is still a fireball', () => {
    const { cards } = playableCards(['Card Fireball', 'Cost 1', 'Spell', 'Deal 6 damage to target enemy character.'].join('\n'));
    expect(cards[0]!.id).toBe('authored-fireball');
  });
});

describe('authored cards — playing them', () => {
  it('deals an authored spell’s damage through the engine', async () => {
    const { cards } = playableCards(
      ['Card Test Bolt', 'Cost 1', 'Spell', 'Deal 6 damage to target enemy character.'].join('\n'),
    );
    const bolt = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(bolt));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(bolt));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const bobHero = game.sideOf(bob).hero;
    alice.script(play(bolt, () => [bobHero]));
    await turn(game);

    expect(bobHero.gauge('hp').current).toBe(24);
  });

  it('runs an enters-play effect the moment the creature lands', async () => {
    const { cards } = playableCards(
      ['Card Test Archer', 'Cost 1', 'Creature 1/1', 'When this enters play then Deal 1 damage to target enemy character.'].join('\n'),
    );
    const archer = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(archer));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(archer));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const bobHero = game.sideOf(bob).hero;
    alice.script(play(archer, () => [bobHero]));
    await turn(game);

    expect(bobHero.gauge('hp').current).toBe(29);
    const board = game.sideOf(alice).board;
    expect(board.map((c) => c.name)).toEqual(['Test Archer']);
  });

  it('honours an authored Taunt restriction', async () => {
    const { cards } = playableCards(
      ['Card Test Bulwark', 'Cost 1', 'Creature 1/4', 'Taunt.'].join('\n'),
    );
    const bulwark = cards[0]!;
    const attackerCard = WISP;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(attackerCard));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(bulwark));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    // Alice lands a Wisp; Bob answers with the taunter.
    alice.script(play(WISP));
    await turn(game);
    bob.script(play(bulwark));
    await turn(game);

    // Turn 3: the Wisp wakes up and looks for a target. Bob's hero is
    // shielded — the only legal attack is into the taunter.
    await game.collectUserDecisions();
    const attacker = game.sideOf(alice).board[0]!;
    const names = game.attackTargets(attacker).map((c) => c.name);
    expect(names).toEqual(['Test Bulwark']);
  });

  it('plays a document’s buff with its card', async () => {
    const { cards, diagnostics } = playableCards(
      [
        'Buff Test Venom (stacks)',
        'Incoming damage is reduced by 1.',
        '',
        'Card Test Coating',
        'Cost 1',
        'Spell',
        'Add Test Venom to this.',
      ].join('\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const coating = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(coating));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(coating));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    alice.script(play(coating));
    await turn(game);

    expect(game.sideOf(alice).hero.hasStatus('test-venom')).toBe(true);
  });

  it('enters play from active, so the `from active` clause is real', async () => {
    const { cards, diagnostics } = playableCards(
      ['Card Test Bulwark', 'Cost 1', 'Creature 1/4', 'When this enters play from active then Heal this for 1.'].join('\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const bulwark = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(bulwark));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(bulwark));
    const transitions: { entity: unknown; type: string; from: string | undefined; to: string }[] = [];
    const game = new CardGame([alice, bob], {
      log: () => {},
      openingHand: 3,
      onEvent: (event) => {
        if (event.type === 'zone:changed') {
          transitions.push({
            entity: event.entity,
            type: event.entity.type,
            from: 'from' in event ? event.from.id : undefined,
            to: event.to.id,
          });
        }
      },
    });
    await game.setup();

    // Every copy is the same card, but only one entity is played — follow it.
    const played = game.sideOf(alice).hand.cards.find((c) => c.id === bulwark.id)!;
    alice.script(() => ({ kind: 'play', card: played, targets: [] }));
    await turn(game);

    // One entity, the whole way: the creature card *is* the permanent, so
    // its life is a single chain of zone changes — hand → stack → active →
    // play. That is what makes `from active` a real fact rather than a
    // convention, and what `enters play from stack` can distinguish.
    const mine = transitions.filter((t) => t.entity === played);
    const path = mine.map((t) => `${t.from ?? '·'} → ${t.to}`);
    // The whole life of one entity: drawn, cast, resolved, landed.
    expect(path).toEqual(['deck → hand', 'hand → stack', 'stack → active', 'active → play']);
    expect(new Set(mine.map((t) => t.type))).toEqual(new Set(['character']));
    expect(game.sideOf(alice).board.map((c) => c.name)).toEqual(['Test Bulwark']);
  });

  it('fires a targetless arrival effect from the normal cast path', async () => {
    const { cards } = playableCards(
      ['Card Test Wave', 'Cost 1', 'Creature 1/1', 'When this enters play from active then Deal 2 damage to all enemy characters.'].join('\n'),
    );
    const wave = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(wave));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(wave));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const bobHero = game.sideOf(bob).hero;
    alice.script(play(wave));
    await turn(game);

    // The arrival trigger fired on the real `active → play` transition.
    expect(bobHero.gauge('hp').current).toBe(28);
  });

  it('does not fire an arrival effect that insists on the stack', async () => {
    const { cards } = playableCards(
      ['Card Test Wave', 'Cost 1', 'Creature 1/1', 'When this enters play from stack then Deal 2 damage to all enemy characters.'].join('\n'),
    );
    const wave = cards[0]!;
    const alice = new ScriptedCardPlayer('Alice', 'a', deckOf(wave));
    const bob = new ScriptedCardPlayer('Bob', 'b', deckOf(wave));
    const game = new CardGame([alice, bob], { log: () => {}, openingHand: 3 });
    await game.setup();

    const bobHero = game.sideOf(bob).hero;
    alice.script(play(wave));
    await turn(game);

    expect(bobHero.gauge('hp').current).toBe(30);
  });

  it('converts a malformed card without throwing', () => {
    const card = toGameCard({
      id: 'broken',
      name: 'Broken',
      cost: 0,
      kind: 'spell',
      keywords: [],
      triggers: [],
      rulesText: '',
      headingSpan: { start: 0, end: 0 },
      nameSpan: { start: 0, end: 0 },
    });
    expect(card.kind).toBe('spell');
  });
});
