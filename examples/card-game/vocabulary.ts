/**
 * One card per piece of the language's vocabulary, written in English (a card document).
 * No healing and no invincibility; creatures can be killed, and a card may hurt its own side.
 *
 *   npx tsx examples/card-game/vocabulary.ts     # compiles them all and lists any diagnostics
 */
import { playableCards } from './english.js';

/** [vocabulary it shows, the card's English] */
export const VOCABULARY: readonly (readonly [string, string])[] = [
  /* ------------------------------- actions ------------------------------- */
  ['Deal', `Card Sparkbolt
Cost 1
Spell
Deal 3 damage to target enemy character.`],
  ['Deal (self damage)', `Card Blood Pact
Cost 0
Spell
Deal 2 damage to this.
Deal 5 damage to target enemy character.`],
  ['Destroy', `Card Assassin's Mark
Cost 4
Spell
Destroy target enemy character with hp < 10.`],
  ['Add', `Buff Frailty (stacks)
Incoming damage is increased by 2.
Card Hex of Frailty
Cost 2
Spell
Add Frailty to target enemy character.`],
  ['Remove', `Buff Brittle
Incoming damage is increased by 3.
Card Shatter Hex
Cost 1
Spell
Remove Brittle from all characters.`],
  ['Toggle', `Buff Bloodied
Outgoing damage is increased by 2.
Card Shifting Stance
Cost 1
Spell
Toggle Bloodied.`],
  ['You win the game', `Card Coup de Grace
Cost 7
Spell
If every enemy character has hp < 3, you win the game.`],
  ['You lose the game', `Card Reckless Wish
Cost 0
Spell
If this has hp < 3, you lose the game.
Deal 1 damage to this.`],
  ['All players lose the game', `Card Mutual Ruin
Cost 10
Spell
If every character has hp < 5, all players lose the game.`],
  /* ------------------------------ keywords ------------------------------- */
  ['Taunt', `Card Gatekeeper
Cost 2
Creature 1/4
Taunt.`],
  ['Charge', `Card Outrider
Cost 3
Creature 3/1
Charge.`],
  /* ------------------------------- triggers ------------------------------ */
  ['When this enters play', `Card Elven Archer
Cost 1
Creature 1/1
When this enters play then Deal 1 damage to target enemy character.`],
  ['When this enters play (no target)', `Card Shockwave Giant
Cost 5
Creature 4/4
When this enters play then Deal 2 damage to all enemy characters.`],
  ['enters play from', `Card Stage Presence
Cost 2
Creature 2/2
When this enters play from active then Deal 1 damage to all enemy characters.`],
  ['When this dies', `Card Cursed Idol
Cost 2
Creature 2/1
When this dies then Deal 2 damage to all enemy characters.`],
  ['When this takes damage', `Card Spiteful Imp
Cost 2
Creature 1/3
When this takes damage then Deal 1 damage to all enemy characters.`],
  ['When this survives', `Card Stubborn Ox
Cost 3
Creature 2/5
When this survives then Deal 1 damage to all enemy characters.`],
  ['When a character dies', `Card Carrion Crow
Cost 3
Creature 2/2
When a character dies then Deal 1 damage to all enemy characters.`],
  ['leaves play to garbage', `Card Departing Spirit
Cost 2
Creature 2/2
When this leaves play to garbage then Deal 2 damage to all enemy characters.`],
  ['count: 2 or more', `Card Massacre Witness
Cost 4
Creature 3/3
When 2 or more characters die then Deal 3 damage to all enemy characters.`],
  ['count: parity', `Card Odd Omen
Cost 3
Creature 2/3
When an odd number of characters die then Deal 2 damage to all enemy characters.`],
  ['count: range', `Card Chorus of Ruin
Cost 4
Creature 3/3
When 2 to 3 characters die then Deal 2 damage to all characters.`],
  ['the source', `Card Thornback
Cost 3
Creature 2/4
When this takes damage then Deal 2 damage to the source character.`],
  /* ------------------------------- filters ------------------------------- */
  ['with hp', `Card Cull the Weak
Cost 3
Spell
Deal 4 damage to all enemy characters with hp < 5.`],
  ['with mana', `Card Mana Burn
Cost 2
Spell
Deal 3 damage to all enemy characters with mana >= 3.`],
  ['with <buff>', `Buff Plague
Incoming damage is increased by 2.
Card Plague Strike
Cost 3
Spell
Add Plague to target enemy character.`],
  ['filter: and / or / not', `Card Cull the Wounded
Cost 4
Spell
Deal 3 damage to all enemy characters with (hp < 6 or mana < 2) and not hp < 1.`],
  ['all other ally characters', `Card Rallying Cost
Cost 2
Spell
Deal 1 damage to all other ally characters.
Deal 2 damage to all enemy characters.`],
  /* ----------------------------- conditions ------------------------------ */
  ['If there are', `Card Crowd Control
Cost 3
Spell
If there are 3 or more enemy characters, deal 4 damage to all enemy characters.`],
  ['If any', `Buff Marked
Incoming damage is increased by 1.
Card Opportunist
Cost 2
Spell
Add Marked to target enemy character.
If any enemy character has Marked, deal 2 damage to all enemy characters.`],
  ['If every', `Card Finishing Volley
Cost 4
Spell
If every enemy character has hp < 8, deal 6 damage to all enemy characters.`],
  ['If this has', `Card Desperate Strike
Cost 1
Spell
If this has hp < 10, deal 8 damage to target enemy character.`],
  ['You may', `Card Optional Offering
Cost 1
Spell
You may deal 3 damage to this.
Deal 3 damage to target enemy character.`],
  ['Repeat (if you choose)', `Card Gambler's Fury
Cost 2
Spell
Repeat up to 3 times if you choose: deal 2 damage to all characters.`],
  ['Repeat (while)', `Card Relentless Fire
Cost 3
Spell
Repeat up to 4 times while there are 2 or more enemy characters: deal 1 damage to all enemy characters.`],
  /* ------------------------------ modifiers ------------------------------ */
  ['increased', `Buff Banner
Outgoing damage from ally characters is increased by 1.
Card War Banner
Cost 2
Creature 1/3
When this enters play then Add Banner to this.`],
  ['reduced', `Buff Hardened
Incoming damage is reduced by 1.
Card Stone Skin
Cost 2
Creature 1/4
When this enters play then Add Hardened to this.`],
  ['multiplied', `Buff Fury
Outgoing damage is multiplied by 2.
Card Berserker Lord
Cost 5
Creature 3/5
When this enters play then Add Fury to this.`],
  ['doubled', `Buff Edge
Outgoing damage is doubled.
Incoming damage is doubled.
Card Glass Blade
Cost 3
Creature 2/2
When this enters play then Add Edge to this.`],
  ['halved', `Buff Dull
Outgoing damage is halved.
Card Dull Sword
Cost 1
Creature 2/3
When this enters play then Add Dull to this.`],
  ['capped', `Buff Plating
Incoming damage is capped at 3.
Card Iron Hide
Cost 3
Creature 2/6
When this enters play then Add Plating to this.`],
  ['chance', `Buff Wild
Outgoing damage has a 50% chance to be doubled.
Card Wild Swing
Cost 2
Creature 2/2
When this enters play then Add Wild to this.`],
  ['redirected', `Buff Shielded
Incoming damage is redirected to mana.
Card Mana Shield
Cost 2
Creature 1/3
When this enters play then Add Shielded to this.`],
  /* --------------------------------- buffs ------------------------------- */
  ['Buff: until end of turn', `Buff Blinded (until end of turn)
Outgoing damage is halved.
Card Flash Powder
Cost 1
Spell
Add Blinded to target enemy character.`],
  ['Buff: for n turns', `Buff Venom (for 3 turns)
When the turn starts, deal 2 damage to this.
Card Slow Poison
Cost 2
Spell
Add Venom to target enemy character.`],
  ['Buff: weight', `Buff Doom (weight 2, stacks)
Incoming damage is increased by 3.
Card Heavy Curse
Cost 3
Spell
Add Doom to target enemy character.`],
  ['When the turn ends', `Buff Embers
When the turn ends, deal 1 damage to all enemy characters.
Card Ember Wall
Cost 3
Creature 0/5
When this enters play then Add Embers to this.`],
  /* ----------------------- the turn a creature enters play ----------------------- */
  ['This can act the turn it enters play', `Card Quick Study
Cost 3
Creature 2/3
This can act the turn it enters play.`],
  ['This can attack the turn it enters play', `Card Ambusher
Cost 2
Creature 3/1
This can attack the turn it enters play.`],
  ['This can use any ability the turn it enters play', `Card Tinkerer
Cost 2
Creature 1/3
This can use any ability the turn it enters play.`],
  ['Creatures you own can attack the turn they enter play', `Card Warchief
Cost 4
Creature 2/4
Creatures you own can attack the turn they enter play.`],
  /* ----------------------------- math & names ---------------------------- */
  ['math', `Card Proportional Strike
Cost 3
Spell
Deal (this.hp / 10) damage to target enemy character.`],
  ['Target … as', `Card Linked Fates
Cost 4
Spell
Target 1 enemy character as victim and 1 different character as bystander.
Deal 6 damage to the victim.
Deal 2 damage to the bystander.`],
  /* ------------------------------ cards & dice --------------------------- */
  ['Draw', `Card Study
Cost 1
Spell
Draw(you, 2).`],
  ['Draw (each opponent)', `Card Gift of Knowledge
Cost 2
Spell
Draw(each opponent, 1).
Deal 4 damage to target enemy character.`],
  ['Roll / Store', `Card Loaded Dice
Cost 2
Spell
Roll a d6.
Store that value as Pages.
Draw(you, Pages).`],
  ['Roll: that total', `Card Fortune's Wheel
Cost 3
Spell
Roll a d6.
Deal that total damage to target enemy character.`],
  ['vote (caster first)', `Card Council of War
Cost 3
Spell
Starting with you, each player votes for Attack or Retreat.
If votes for Attack is higher than votes for Retreat, deal 5 damage to target enemy character.
If votes for Attack is lower than votes for Retreat, deal 2 damage to this.`],
  ['vote (caster last)', `Card Last Word
Cost 3
Spell
Ending with you, each player votes for Attack or Retreat.
If votes for Attack is higher than votes for Retreat, deal 4 damage to all enemy characters.
If votes for Attack is the same as votes for Retreat, deal 1 damage to all characters.`],
  ['vote (random start)', `Card Wheel of Fortune
Cost 3
Spell
Starting with a random player, each player votes for Boon or Bane.
If votes for Boon is higher than votes for Bane, draw(you, 2).
If votes for Boon is lower than votes for Bane, deal 3 damage to this.`],
  ['vote (reverse order)', `Card Reverse Parliament
Cost 2
Spell
In reverse order, each player votes for Red, Green or Blue.
If votes for Red is higher than votes for Blue, deal 3 damage to all enemy characters.`],
  ['commit a vote / reveal', `Card Secret Ballot
Cost 3
Spell
Each player commits a vote for Attack or Retreat face down.
When they are ready, reveal.
If votes for Attack is higher than votes for Retreat, deal 6 damage to target enemy character.
If votes for Retreat is higher than votes for Attack, deal 3 damage to this.`],
  ['commit a number / reveal', `Card Blind Gambit
Cost 1
Spell
Each player commits a number from 1 to 6 face down.
When they are ready, reveal.
Deal 2 damage to all enemy characters.`],
  ['commit a card: everyone discards', `Card Mutual Sacrifice
Cost 2
Spell
Each player commits a card from their hand face down.
When they are ready, reveal.
Each player puts the card they committed into their garbage.
Draw(each player, 1).`],
  ['commit a card: opponents discard', `Card Forced Offering
Cost 3
Spell
Each opponent commits a card from their hand face down.
When they are ready, reveal.
Each opponent puts the card they committed into their garbage.
Deal 2 damage to all enemy characters.`],
  /* --------------------------- moving cards ---------------------------- */
  ['Move: revive (garbage to play)', `Card Raise Dead
Cost 4
Spell
Move a creature card from your garbage to play.`],
  ['Move: cheat (hand to play)', `Card Cheat Death
Cost 3
Spell
Move a creature card from your hand to play.`],
  ['Move: thoughtsteal', `Card Thoughtsteal
Cost 3
Spell
Move a random card from target opponent's hand to your stolen zone.`],
  ['Move: top of the deck', `Card Dig Deep
Cost 2
Spell
Move the top 3 cards from your deck to your hand.`],
  ['Move: bottom of the deck', `Card Bury
Cost 1
Spell
Move the bottom card from your deck to your garbage.`],
  ['Move: mill', `Card Mind Erosion
Cost 2
Spell
Move the top 3 cards from target opponent's deck to their garbage.`],
  ['Move: choose several', `Card Reclaim
Cost 3
Spell
Move 2 cards from your garbage to your hand.`],
  ['Move: all', `Card Great Reset
Cost 6
Spell
Move all cards from each player's hand to its owner's garbage.
Draw(each player, 3).`],
  ['Move: from the stack to play', `Card Flash Cheat
Cost 2
Spell
Move a creature card from the stack to play.`],
  ['Reveal / castable by', `Card Mind Purge
Cost 4
Spell
Reveal all cards castable by target opponent.
Move a card castable by target opponent to its owner's garbage.`],
  ['Move: any number, the rest, in the order of your choice', `Card Divination
Cost 1
Spell
Move any number of the top 3 cards from your deck to the bottom of your deck and the rest on the top of your deck in the order of your choice.`],
  ['temporary zones: Fact or Fiction', `Card Fact or Fiction
Cost 4
Spell
Move the top 5 cards from your deck to the temporary zone Pool.
Reveal all cards from Pool.
Target opponent separates Pool into Fact and Fiction.
You choose Fact or Fiction.
Move all cards from the chosen pile to your hand.
Move all cards from the other pile to your garbage.`],
  ['Contest: Rock Paper Scissors', `Contest Rock Paper Scissors
The player count must be 2.
Players commit an option from "Rock", "Paper" and "Scissors".
If both players choose the same option, it is a tie.
If player 1 chooses Rock and player 2 chooses Scissors, player 1 wins and player 2 loses.
If player 1 chooses Scissors and player 2 chooses Paper, player 1 wins and player 2 loses.
If player 1 chooses Paper and player 2 chooses Rock, player 1 wins and player 2 loses.
Otherwise player 2 wins and player 1 loses.

Card Showdown
Cost 3
Spell
You and target opponent play Rock Paper Scissors.
Draw(the winners, 2).
Deal 5 damage to all characters owned by the losers.`],
  ['Creature definition + Create', `Creature Giant Golem 6/6
Taunt.

Card Forge
Cost 5
Spell
Create a Giant Golem.`],
  ['Zone + counters + Suspend', `Zone Suspend (per-player, public)
At the start of your turn, remove a counter from all cards in this zone.
At the start of your turn, cast all cards with no counters from this zone without paying their cost.

Card Ancestral Vision
Cost 6
Spell
Draw(you, 3).
Suspend: Move this card to the Suspend zone with 2 counters on it.`],
  ['Surveil', `Card Grave Insight
Cost 1
Spell
Surveil(you, 2).
Draw(you, 1).`],
  ['Scry', `Card Foresight
Cost 1
Spell
Scry(you, 3).
Draw(you, 1).`],
];

export const VOCABULARY_SOURCE = VOCABULARY.map(([, text]) => text).join('\n\n');

if (process.argv[1]?.endsWith('vocabulary.ts')) {
  let bad = 0;
  for (const [label, text] of VOCABULARY) {
    const { cards, diagnostics } = playableCards(text);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length || cards.length !== 1) {
      bad += 1;
      console.log(`✗ ${label}: ${errors.map((d) => d.message).join(' | ') || `${cards.length} cards`}`);
    }
  }
  console.log(`${VOCABULARY.length - bad}/${VOCABULARY.length} compile cleanly`);
}

/** Every vocabulary card, compiled together (they share one document, so buff names are shared). */
export function vocabularyCards() {
  return playableCards(VOCABULARY_SOURCE);
}
