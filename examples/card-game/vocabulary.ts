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
{ "cost": 1, "type": "spell" }
Deal 3 damage to target enemy character.`],
  ['Deal (self damage)', `Card Blood Pact
{ "cost": 0, "type": "spell" }
Deal 2 damage to this.
Deal 5 damage to target enemy character.`],
  ['Destroy', `Card Assassin's Mark
{ "cost": 4, "type": "spell" }
Destroy target enemy character with hp < 10.`],
  ['Add', `Buff Frailty
Incoming damage is increased by 2.
Card Hex of Frailty
{ "cost": 2, "type": "spell" }
Add Frailty to target enemy character.`],
  ['Remove', `Buff Brittle
Incoming damage is increased by 3.
Card Shatter Hex
{ "cost": 1, "type": "spell" }
Remove Brittle from all characters.`],
  ['Toggle', `Buff Bloodied
Outgoing damage is increased by 2.
Card Shifting Stance
{ "cost": 1, "type": "spell" }
Toggle Bloodied.`],
  ['You win the game', `Card Coup de Grace
{ "cost": 7, "type": "spell" }
If every enemy character has hp < 3, you win the game.`],
  ['You lose the game', `Card Reckless Wish
{ "cost": 0, "type": "spell" }
If this has hp < 3, you lose the game.
Deal 1 damage to this.`],
  ['All players lose the game', `Card Mutual Ruin
{ "cost": 10, "type": "spell" }
If every character has hp < 5, all players lose the game.`],
  /* ------------------------------ keywords ------------------------------- */
  ['Taunt', `Card Gatekeeper
{ "cost": 2, "type": "creature", "creatureConfig": { "power": 1, "health": 4 } }
Taunt.`],
  ['Charge', `Card Outrider
{ "cost": 3, "type": "creature", "creatureConfig": { "power": 3, "health": 1 } }
Charge.`],
  /* ------------------------------- triggers ------------------------------ */
  ['When this enters play', `Card Elven Archer
{ "cost": 1, "type": "creature", "creatureConfig": { "power": 1, "health": 1 } }
When this enters play then Deal 1 damage to target enemy character.`],
  ['When this enters play (no target)', `Card Shockwave Giant
{ "cost": 5, "type": "creature", "creatureConfig": { "power": 4, "health": 4 } }
When this enters play then Deal 2 damage to all enemy characters.`],
  ['enters play from', `Card Stage Presence
{ "cost": 2, "type": "creature", "creatureConfig": { "power": 2, "health": 2 } }
When this enters play from active then Deal 1 damage to all enemy characters.`],
  ['When this is destroyed', `Card Cursed Idol
{ "cost": 2, "type": "creature", "creatureConfig": { "power": 2, "health": 1 } }
When this is destroyed then Deal 2 damage to all enemy characters.`],
  ['When this is damaged', `Card Spiteful Imp
{ "cost": 2, "type": "creature", "creatureConfig": { "power": 1, "health": 3 } }
When this is damaged then Deal 1 damage to all enemy characters.`],
  ['When this survives', `Card Stubborn Ox
{ "cost": 3, "type": "creature", "creatureConfig": { "power": 2, "health": 5 } }
When this survives then Deal 1 damage to all enemy characters.`],
  ['When a character is destroyed', `Card Carrion Crow
{ "cost": 3, "type": "creature", "creatureConfig": { "power": 2, "health": 2 } }
When a character is destroyed then Deal 1 damage to all enemy characters.`],
  ['leaves play to garbage', `Card Departing Spirit
{ "cost": 2, "type": "creature", "creatureConfig": { "power": 2, "health": 2 } }
When this leaves play to garbage then Deal 2 damage to all enemy characters.`],
  ['count: 2 or more', `Card Massacre Witness
{ "cost": 4, "type": "creature", "creatureConfig": { "power": 3, "health": 3 } }
When 2 or more characters are destroyed then Deal 3 damage to all enemy characters.`],
  ['count: parity', `Card Odd Omen
{ "cost": 3, "type": "creature", "creatureConfig": { "power": 2, "health": 3 } }
When an odd number of characters are destroyed then Deal 2 damage to all enemy characters.`],
  ['count: range', `Card Chorus of Ruin
{ "cost": 4, "type": "creature", "creatureConfig": { "power": 3, "health": 3 } }
When 2 to 3 characters are destroyed then Deal 2 damage to all characters.`],
  ['the source', `Card Thornback
{ "cost": 3, "type": "creature", "creatureConfig": { "power": 2, "health": 4 } }
When this is damaged then Deal 2 damage to the source.`],
  /* ------------------------------- filters ------------------------------- */
  ['with hp', `Card Cull the Weak
{ "cost": 3, "type": "spell" }
Deal 4 damage to all enemy characters with hp < 5.`],
  ['with mana', `Card Mana Burn
{ "cost": 2, "type": "spell" }
Deal 3 damage to all enemy characters with mana >= 3.`],
  ['with <buff>', `Buff Plague
Incoming damage is increased by 2.
Card Plague Strike
{ "cost": 3, "type": "spell" }
Add Plague to target enemy character.`],
  ['filter: and / or / not', `Card Cull the Wounded
{ "cost": 4, "type": "spell" }
Deal 3 damage to all enemy characters with (hp < 6 or mana < 2) and not hp < 1.`],
  ['all other ally characters', `Card Rallying Cost
{ "cost": 2, "type": "spell" }
Deal 1 damage to all other ally characters.
Deal 2 damage to all enemy characters.`],
  /* ----------------------------- conditions ------------------------------ */
  ['If there are', `Card Crowd Control
{ "cost": 3, "type": "spell" }
If there are 3 or more enemy characters, deal 4 damage to all enemy characters.`],
  ['If any', `Buff Marked
Incoming damage is increased by 1.
Card Opportunist
{ "cost": 2, "type": "spell" }
Add Marked to target enemy character.
If any enemy character has Marked, deal 2 damage to all enemy characters.`],
  ['If every', `Card Finishing Volley
{ "cost": 4, "type": "spell" }
If every enemy character has hp < 8, deal 6 damage to all enemy characters.`],
  ['If this has', `Card Desperate Strike
{ "cost": 1, "type": "spell" }
If this has hp < 10, deal 8 damage to target enemy character.`],
  ['You may', `Card Optional Offering
{ "cost": 1, "type": "spell" }
You may deal 3 damage to this.
Deal 3 damage to target enemy character.`],
  ['Repeat (if you choose)', `Card Gambler's Fury
{ "cost": 2, "type": "spell" }
Repeat up to 3 times if you choose: deal 2 damage to all characters.`],
  ['Repeat (while)', `Card Relentless Fire
{ "cost": 3, "type": "spell" }
Repeat up to 4 times while there are 2 or more enemy characters: deal 1 damage to all enemy characters.`],
  /* ------------------------------ modifiers ------------------------------ */
  ['increased', `Buff Banner
Outgoing damage from ally characters is increased by 1.
Card War Banner
{ "cost": 2, "type": "creature", "creatureConfig": { "power": 1, "health": 3 } }
When this enters play then Add Banner to this.`],
  ['reduced', `Buff Hardened
Incoming damage is reduced by 1.
Card Stone Skin
{ "cost": 2, "type": "creature", "creatureConfig": { "power": 1, "health": 4 } }
When this enters play then Add Hardened to this.`],
  ['multiplied', `Buff Fury
Outgoing damage is multiplied by 2.
Card Berserker Lord
{ "cost": 5, "type": "creature", "creatureConfig": { "power": 3, "health": 5 } }
When this enters play then Add Fury to this.`],
  ['doubled', `Buff Edge
Outgoing damage is doubled.
Incoming damage is doubled.
Card Glass Blade
{ "cost": 3, "type": "creature", "creatureConfig": { "power": 2, "health": 2 } }
When this enters play then Add Edge to this.`],
  ['halved', `Buff Dull
Outgoing damage is halved.
Card Dull Sword
{ "cost": 1, "type": "creature", "creatureConfig": { "power": 2, "health": 3 } }
When this enters play then Add Dull to this.`],
  ['capped', `Buff Plating
Incoming damage is capped at 3.
Card Iron Hide
{ "cost": 3, "type": "creature", "creatureConfig": { "power": 2, "health": 6 } }
When this enters play then Add Plating to this.`],
  ['chance', `Buff Wild
Outgoing damage has a 50% chance to be doubled.
Card Wild Swing
{ "cost": 2, "type": "creature", "creatureConfig": { "power": 2, "health": 2 } }
When this enters play then Add Wild to this.`],
  ['redirected', `Buff Shielded
Incoming damage is redirected to mana.
Card Mana Shield
{ "cost": 2, "type": "creature", "creatureConfig": { "power": 1, "health": 3 } }
When this enters play then Add Shielded to this.`],
  /* --------------------------------- buffs ------------------------------- */
  ['Buff: until end of turn', `Buff Blinded
Fading 0.
Outgoing damage is halved.
Card Flash Powder
{ "cost": 1, "type": "spell" }
Add Blinded to target enemy character.`],
  ['Buff: for n turns', `Buff Venom
Fading 2.
When a turn starts then deal 2 damage to this.
Card Slow Poison
{ "cost": 2, "type": "spell" }
Add Venom to target enemy character.`],
  ['Buff: weight', `Buff Doom
  Weight 2.
Incoming damage is increased by 3.
Card Heavy Curse
{ "cost": 3, "type": "spell" }
Add Doom to target enemy character.`],
  ['When a turn ends then', `Buff Embers
When a turn ends then deal 1 damage to all enemy characters.
Card Ember Wall
{ "cost": 3, "type": "creature", "creatureConfig": { "power": 0, "health": 5 } }
When this enters play then Add Embers to this.`],
  /* ----------------------- the turn a creature enters play ----------------------- */
  ['This can act the turn it enters play', `Card Quick Study
{ "cost": 3, "type": "creature", "creatureConfig": { "power": 2, "health": 3 } }
This can act the turn it enters play.`],
  ['This can attack the turn it enters play', `Card Ambusher
{ "cost": 2, "type": "creature", "creatureConfig": { "power": 3, "health": 1 } }
This can attack the turn it enters play.`],
  ['This can use any ability the turn it enters play', `Card Tinkerer
{ "cost": 2, "type": "creature", "creatureConfig": { "power": 1, "health": 3 } }
This can use any ability the turn it enters play.`],
  ['Creatures you own can attack the turn they enter play', `Card Warchief
{ "cost": 4, "type": "creature", "creatureConfig": { "power": 2, "health": 4 } }
Creatures you own can attack the turn they enter play.`],
  /* ----------------------------- math & names ---------------------------- */
  ['math', `Card Proportional Strike
{ "cost": 3, "type": "spell" }
Deal (this.hp / 10) damage to target enemy character.`],
  ['Target … as', `Card Linked Fates
{ "cost": 4, "type": "spell" }
Target 1 enemy character as victim and 1 different character as bystander.
Deal 6 damage to the victim.
Deal 2 damage to the bystander.`],
  /* ------------------------------ cards & dice --------------------------- */
  ['Draw', `Card Study
{ "cost": 1, "type": "spell" }
Draw(you, 2).`],
  ['Draw (each opponent)', `Card Gift of Knowledge
{ "cost": 2, "type": "spell" }
Draw(all opponents, 1).
Deal 4 damage to target enemy character.`],
  ['Roll / Store', `Card Loaded Dice
{ "cost": 2, "type": "spell" }
Roll a d6.
Store that value as Pages.
Draw(you, Pages).`],
  ['Roll: that value', `Card Fortune's Wheel
{ "cost": 3, "type": "spell" }
Roll a d6.
Deal that value damage to target enemy character.`],
  ['vote (caster first)', `Card Council of War
{ "cost": 3, "type": "spell" }
Starting with you, each player chooses Attack or Retreat.
If votes for Attack > votes for Retreat, deal 5 damage to target enemy character.
If votes for Attack < votes for Retreat, deal 2 damage to this.`],
  ['vote (caster last)', `Card Last Word
{ "cost": 3, "type": "spell" }
Ending with you, each player chooses Attack or Retreat.
If votes for Attack > votes for Retreat, deal 4 damage to all enemy characters.
If votes for Attack = votes for Retreat, deal 1 damage to all characters.`],
  ['vote (random start)', `Card Wheel of Fortune
{ "cost": 3, "type": "spell" }
Starting with a random player, each player chooses Boon or Bane.
If votes for Boon > votes for Bane, draw(you, 2).
If votes for Boon < votes for Bane, deal 3 damage to this.`],
  ['vote (reverse order)', `Card Reverse Parliament
{ "cost": 2, "type": "spell" }
In reverse order, each player chooses Red, Green or Blue.
If votes for Red > votes for Blue, deal 3 damage to all enemy characters.`],
  ['commit a vote / reveal', `Card Secret Ballot
{ "cost": 3, "type": "spell" }
All players commit Attack or Retreat face down.
When they are ready, reveal.
If votes for Attack > votes for Retreat, deal 6 damage to target enemy character.
If votes for Retreat > votes for Attack, deal 3 damage to this.`],
  ['commit a number / reveal', `Card Blind Gambit
{ "cost": 1, "type": "spell" }
All players commit a number from 1 to 6 face down.
When they are ready, reveal.
Deal 2 damage to all enemy characters.`],
  ['commit a card: everyone discards', `Card Mutual Sacrifice
{ "cost": 2, "type": "spell" }
All players commit a card from their hand face down.
When they are ready, reveal.
All players move the card they committed to their garbage.
Draw(all players, 1).`],
  ['commit a card: opponents discard', `Card Forced Offering
{ "cost": 3, "type": "spell" }
All opponents commit a card from their hand face down.
When they are ready, reveal.
All opponents move the card they committed to their garbage.
Deal 2 damage to all enemy characters.`],
  /* --------------------------- moving cards ---------------------------- */
  ['Move: revive (garbage to play)', `Card Raise Dead
{ "cost": 4, "type": "spell" }
Move a creature card from your garbage to play.`],
  ['Move: cheat (hand to play)', `Card Cheat Death
{ "cost": 3, "type": "spell" }
Move a creature card from your hand to play.`],
  ['Move: thoughtsteal', `Card Thoughtsteal
{ "cost": 3, "type": "spell" }
Move a random card from target opponent's hand to your stolen zone.`],
  ['Move: top of the deck', `Card Dig Deep
{ "cost": 2, "type": "spell" }
Move the top 3 cards from your deck to your hand.`],
  ['Move: bottom of the deck', `Card Bury
{ "cost": 1, "type": "spell" }
Move the bottom card from your deck to your garbage.`],
  ['Move: mill', `Card Mind Erosion
{ "cost": 2, "type": "spell" }
Move the top 3 cards from target opponent's deck to their garbage.`],
  ['Move: choose several', `Card Reclaim
{ "cost": 3, "type": "spell" }
Move 2 cards from your garbage to your hand.`],
  ['Move: all', `Card Great Reset
{ "cost": 6, "type": "spell" }
Move all cards from all players' hand to its owner's garbage.
Draw(all players, 3).`],
  ['Move: from the stack to play', `Card Flash Cheat
{ "cost": 2, "type": "spell" }
Move a creature card from the stack to play.`],
  ['Reveal / castable by', `Card Mind Purge
{ "cost": 4, "type": "spell" }
Reveal all cards castable by target opponent.
Move a card castable by target opponent to its owner's garbage.`],
  ['Move: any number, the rest, in the order of your choice', `Card Divination
{ "cost": 1, "type": "spell" }
Move any number of the top 3 cards from your deck to the bottom of your deck and the rest on the top of your deck in the order of your choice.`],
  ['temporary zones: Fact or Fiction', `Card Fact or Fiction
{ "cost": 4, "type": "spell" }
Move the top 5 cards from your deck to the temporary zone Pool.
Reveal all cards from Pool.
Target opponent separates Pool into Fact and Fiction.
You choose Fact or Fiction.
Move all cards from the chosen pile to your hand.
Move all cards from the other pile to your garbage.`],
  ['Contest: Rock Paper Scissors', `Contest Rock Paper Scissors
Players 2.
All players commit Rock, Paper or Scissors face down.
When they are ready, reveal.
If all players committed the same option, it is a tie.
If player 1 committed Rock and player 2 committed Scissors, player 1 win and player 2 lose.
If player 1 committed Scissors and player 2 committed Paper, player 1 win and player 2 lose.
If player 1 committed Paper and player 2 committed Rock, player 1 win and player 2 lose.
Otherwise player 2 win and player 1 lose.

Card Showdown
{ "cost": 3, "type": "spell" }
You and target opponent play Rock Paper Scissors.
Draw(the winners, 2).
Deal 5 damage to all characters owned by the losers.`],
  ['Creature definition + Create', `Creature Giant Golem
{ "type": "creature", "creatureConfig": { "power": 6, "health": 6 } }
Taunt.

Card Forge
{ "cost": 5, "type": "spell" }
Create a Giant Golem.`],
  ['Zone + counters + Suspend', `Zone Suspend (per-player, public)
When your turn starts then remove a counter from all cards in this zone.
When your turn starts then cast all cards with no counters from this zone without paying their cost.

Card Ancestral Vision
{ "cost": 6, "type": "spell" }
Draw(you, 3).
Suspend: Move this to the Suspend zone with 2 counters on it.`],
  ['Surveil', `Card Grave Insight
{ "cost": 1, "type": "spell" }
Surveil(you, 2).
Draw(you, 1).`],
  ['Scry', `Card Foresight
{ "cost": 1, "type": "spell" }
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
