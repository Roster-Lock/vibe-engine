/**
 * The card game's **standing rules**, written as cards.
 *
 * A rule is a card of `"type": "rule"`: it has no cost and is never played — it is simply in force.
 * Every player has their own copy, so "you" and "this" in a rule are its owner and their hero, and
 * `When your turn starts` / `owned by you` mean what they say. That is also what lets a card change
 * one player's rules and not another's. A rule is written in the same language as every other card, so the
 * game's upkeep is something a player can read, and a card document can add a rule or replace one by
 * writing a rule of the same name.
 *
 * Order matters: the steps of a rule (in its braces) run in order (the maximum grows, then the mana refills to it),
 * and rules run in the order they are written, so the draw comes last.
 */
import { BuffDictionary } from '../../src/english/index.js';
import { summoningSickness } from './combat.js';

/** The buffs a rule can name. */
export const RULE_BUFFS = new BuffDictionary([{ name: 'Summoning Sickness', def: summoningSickness }]);

export const CARD_RULES = `Card Mana
{ "type": "rule" }
When your turn starts then {
  If this.mana.max < 10 {
    Increase mana maximum of this by 1.
  }
  Set mana of this to this.mana.max.
}

Card Summoning Sickness
{ "type": "rule" }
When a character owned by you enters play then Add Summoning Sickness to it.

Card Draw
{ "type": "rule" }
When your turn starts then Draw(you, 1).
`;
