/**
 * Sample **card documents** for the Card Creator — each one shows a piece of
 * the grammar (`src/english/card.ts`), and every one of them is playable.
 */
export interface CardSample {
  readonly title: string;
  readonly doc: string;
}

export const CARD_SAMPLES: readonly CardSample[] = [
  {
    title: 'Fireball (spell)',
    doc: `# A spell: no body line, just effect sentences. "target enemy
# character" becomes the card's targeting pattern.
Card Fireball
Cost 4
Spell
Deal 6 damage to target enemy character.
`,
  },
  {
    title: 'Shieldbearer (taunt)',
    doc: `# "Creature <power>/<health>" gives the stat line; "Taunt." is a
# keyword. Enemies must attack this before its allies.
Card Shieldbearer
Cost 2
Creature 1/4
Taunt.
`,
  },
  {
    title: 'Elven Archer (enters play)',
    doc: `# Events are explicit, and a zone can be named: "from active" is the
# zone a card resolves in, so this only fires on the normal cast.
# It picks a target, so you choose it as the card is played.
Card Elven Archer
Cost 1
Creature 1/1
When this enters play from active then Deal 1 damage to target enemy character.
`,
  },
  {
    title: 'Doomsayer (arrival trigger)',
    doc: `# An arrival effect that picks nothing is a real trigger: it fires
# however the creature arrives. "from stack" would instead catch a
# card cheated past resolution — name the zone to demand that path.
Card Doomsayer
Cost 4
Creature 0/7
When this enters play from active then Deal 5 damage to all enemy characters.
`,
  },
  {
    title: 'Consecration (board wipe)',
    doc: `# No "target" phrase at all: the effect finds its own victims, so
# nothing is targeted — taunt does not protect against it.
Card Consecration
Cost 4
Spell
Deal 2 damage to all enemy characters.
`,
  },
  {
    title: 'Frost Bolt (buff + damage)',
    doc: `# Buffs are document-level, like in an ability document. This one
# reduces the wearer's incoming damage — and the spell still hits.
Card Frost Bolt
Cost 2
Spell
Deal 3 damage to target enemy character.
Add Chilled to target enemy character.

Buff Chilled (until end of turn)
Incoming damage is reduced by 1.
`,
  },
  {
    title: 'Cursed Idol (on death)',
    doc: `# "When this dies then …" is an ordinary trigger, so the creature
# answers its own destruction.
Card Cursed Idol
Cost 2
Creature 2/1
When this dies then Deal 2 damage to all enemy characters.
`,
  },
  {
    title: 'Berserker (standing trigger)',
    doc: `# Any other "When … then …" is a trigger the creature carries on
# the board. This one grows when it is wounded.
Card Gurubashi Berserker
Cost 5
Creature 2/7
When this takes damage then add Berserker Rage to this.

Buff Berserker Rage (stacks)
Outgoing damage is increased by 2.
`,
  },
  {
    title: 'Wolfrider (charge)',
    doc: `# Charge lets a creature attack the turn it lands. Vanilla
# creatures are just a cost and a stat line.
Card Wolfrider
Cost 3
Creature 3/1
Charge.
`,
  },
];

export const DEFAULT_CARD_SAMPLE = CARD_SAMPLES[0]!.title;

export function cardSampleDoc(title: string): string {
  return CARD_SAMPLES.find((s) => s.title === title)?.doc ?? CARD_SAMPLES[0]!.doc;
}
