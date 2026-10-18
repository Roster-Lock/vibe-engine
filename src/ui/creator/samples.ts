/**
 * Sample ability documents for the Create page — each one shows off a
 * piece of the language (docs/creator/01-ability-language.md).
 */
export interface SampleDoc {
  readonly title: string;
  readonly doc: string;
}

export const SAMPLES: readonly SampleDoc[] = [
  {
    title: 'Battle Cry',
    doc: `# A single effect that hits the whole enemy board at once.
Ability Battle Cry
Deal 20 damage to all enemy characters.
`,
  },
  {
    title: 'Void Bolt',
    doc: `# The player picks the target: "target enemy character" becomes
# the ability's targeting pattern.
Ability Void Bolt
Destroy target enemy character.
`,
  },
  {
    title: 'Sacrifice',
    doc: `# Several sentences run in order. "this" is the user;
# "all other ally characters" skips the user.
Ability Sacrifice
Destroy this.
Heal all other ally characters for 25.
`,
  },
  {
    title: 'Venom Strike',
    doc: `# Poison is declared here so this sample is self-contained.
# It stacks and ticks 10 HP damage to its wearer at every turn:start.
Ability Venom Strike
Add Poison to target enemy character.

Buff Poison
When a turn starts then deal 10 damage to this.
`,
  },
  {
    title: 'Soul Rot (custom buff)',
    doc: `# Custom buffs travel with the ability: this document declares
# Frailty (a stackable marker) and uses it. Payloads (ticks, triggers)
# arrive with the events milestone.
Ability Soul Rot
Add Frailty to target enemy character.
Deal 5 damage to all enemy characters.

Buff Frailty
`,
  },
  {
    title: 'Mercy',
    doc: `# A "with" clause filters the phrase: only allies below 10 HP
# get the heal. Conditions can also check buffs ("with poison")
# and combine with "and".
Ability Mercy
Heal all other ally characters with hp < 10 for 25.
`,
  },
  {
    title: 'Plague (two steps)',
    doc: `# Poison is declared here so the sample can be compiled on its own.
# Sentences run in order as steps — the second sentence sees the
# poison the first applied, so both enemies qualify and the board dies.
Ability Plague
Add Poison to all enemy characters.
Destroy all enemy characters with poison.

Buff Poison
`,
  },
  {
    title: 'Toxic Tentacles (multi-word buff)',
    doc: `# Buff names can be several words. Hover a buff name in the editor
# to see what it does; Ctrl/Cmd+Click jumps to its Buff declaration.
Ability Tentacle Sweep
Add Toxic Tentacles to target enemy character.

Buff Toxic Tentacles
`,
  },
  {
    title: 'Field Medicine (or)',
    doc: `# "or" separates alternatives: heal allies who are poisoned
# OR below 10 HP. "and" binds tighter than "or" — write
# "with poison or thorns and hp <= 40" for poison OR (thorns AND low HP).
Ability Field Medicine
Heal all ally characters with poison or hp < 10 for 25.

Buff Poison
`,
  },
  {
    title: 'Arena Nuke',
    doc: `# Subject-first word order: "All players lose the game." — with
# both sides lost at once, the engine calls it a draw.
Ability Arena Nuke
All players lose the game.
`,
  },
];

export const DEFAULT_SAMPLE = 'Battle Cry';

export function sampleDoc(title: string): string {
  return SAMPLES.find((s) => s.title === title)?.doc ?? SAMPLES[0]!.doc;
}
