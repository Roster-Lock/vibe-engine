/**
 * Shared test corpus for the two surface codecs (`test/render.test.ts`,
 * `test/blocks.test.ts`).
 *
 * `EVERY_CONSTRUCT` is one document that exercises every sentence the
 * language has; `CORPUS` adds the Create page's own samples, which are the
 * documents a player actually sees first.
 */
import { SAMPLES } from '../../src/ui/creator/samples.js';

/** Every construct the sentence grammar has, in one document. */
export const EVERY_CONSTRUCT = `Ability Probe
Deal 5 damage to all enemy characters.
Heal all other ally characters with hp < 10 for 25.
Destroy target enemy character.
Add Poison to this.
Remove Poison from all characters.
Toggle Immolation.
You may destroy all enemy characters.
If there are 2 to 5 enemy characters, deal 7 damage to all enemy characters.
If this has hp < 10, heal this for 4.
If any enemy character has Poison, destroy all enemy characters with Poison.
Repeat up to 3 times while this has hp < 10: heal this for 4.
Repeat if you choose: add Poison to target enemy character.
Deal (this.hp / 2) damage to all enemy characters.
You lose the game.

Ability Picks
Target 1 enemy character as victim and 1 different character as benefactor.
Deal 3 damage to the victim.
Heal the benefactor for 3.

Ability Gate
Available while this has hp < 10.
Deal 1 damage to all enemy characters.

Ability Edges
Destroy all other ally characters owned by you.
Toggle Poison on all enemy characters.
Destroy all enemy characters with not poison.
Heal all ally characters with poison or thorns and hp <= 40 for 3.
Destroy all enemy characters with (poison or thorns) and hp <= 40.
If there are an even number of enemy characters, destroy all enemy characters.

Buff Poison
Weight 2.
Fading 1.
When this is damaged then deal 2 damage to the source.
Outgoing damage is increased by 5.
Incoming damage is capped at 10.
Incoming healing is prevented.
Outgoing damage has a 25% chance to be doubled.
Incoming damage is redirected to mana.

Buff Thorns

Buff Frailty
Fading 0.
When a turn starts then deal 3 damage to this.
When a turn ends then heal all other ally characters for 1.

when a character is destroyed then heal all ally characters for 1.
when this survives then heal this for 5.
when an even number of characters are destroyed then deal 1 damage to all enemy characters.
when 3 or less enemy characters are destroyed then heal all ally characters for 1.
when a character is destroyed then you may heal this for 1.
when this is damaged then repeat up to 2 times: deal 1 damage to the source.
when characters owned by opponents with hp < 10 are destroyed then add Poison to all enemy characters.

import Mark from "./mark.buff"
`;

export const CORPUS: readonly { name: string; text: string }[] = [
  { name: 'every construct', text: EVERY_CONSTRUCT },
  ...SAMPLES.map((sample) => ({ name: sample.title, text: sample.doc })),
];
