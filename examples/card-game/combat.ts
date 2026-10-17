/**
 * The rules of the board, written as ordinary engine **content** — no
 * engine internals, the same `cast` / `skill` / `buff` / `restriction`
 * pieces a content creator writes (README.md, "Writing content").
 *
 * What lives here:
 *
 * - **Attack** — a manual ability every creature has. Attacking a creature
 *   trades damage both ways; attacking a hero does not (a hero has no
 *   `power` stat, so its retaliation is 0).
 * - **Taunt** — a `restriction({ on: 'target' })`: while a side controls a
 *   taunter, its other characters *cannot be chosen* by an attack. The
 *   engine's `validTargets` enforces it, so the AI never even sees an
 *   illegal attack.
 * - **Summoning sickness** — a marker buff the card layer clears at the
 *   start of its controller's turn.
 * - **Mana crystals** — one `maxModifier` buff per crystal, so the hero's
 *   mana **max is derived** (the engine never lets content write a max).
 */
import {
  Character,
  buff,
  cast,
  changeGaugeBy,
  damage,
  maxModifier,
  restriction,
  skill,
  type GameEngine,
  type Player,
  type SkillDef,
  type TargetPattern,
} from '../../src/games/turn-based/index.js';
import type { CardSide, CreatureCard } from './cards.js';
import { isAlly, isEnemy } from '../../src/games/round-based/index.js';

/**
 * The attack pattern, exported as a **single shared object** so the taunt
 * restriction can recognise an attack by identity (`ctx.pattern ===
 * ATTACK_PATTERN`).
 *
 * Engine gap: `validTargets` builds the `AttemptContext` without the
 * `ability` that is doing the targeting, so a restriction cannot ask "is
 * this an attack?" any other way. See README.md, "What the engine is
 * missing".
 */
export const ATTACK_PATTERN: TargetPattern = { who: 'enemy', count: 1 };

/** Marker skill: a creature with it is a taunter. */
export const TAUNT_MARKER: SkillDef = skill({ id: 'taunt', name: 'Taunt', weight: 0, abilities: [] });

/** True when `character` is a taunter that is still on the board. */
export function hasTaunt(character: Character): boolean {
  return character.hasStatus('taunt');
}

/** The card data a creature carries about its entry (see `CreatureCard.entry`). */
interface EntryHolder {
  readonly entry?: CreatureCard['entry'];
  readonly keywords?: CreatureCard['keywords'];
}

/**
 * Whether a creature that has just entered play may use `ability` anyway — the exceptions a
 * creature card states about itself (`This can attack the turn it enters play.`), or that
 * another creature of the same controller grants (`Creatures you own can attack …`).
 * `Charge` is the attack exception, as a keyword.
 *
 * With no ability named (a general "can it act at all?"), only `act` exceptions count.
 */
export function mayActOnEntry(
  engine: GameEngine,
  creature: Character,
  ability: { readonly id: string; readonly name: string } | undefined,
): boolean {
  const isAttack = ability?.id === attack.id;
  const own = (card: EntryHolder): boolean => {
    const entry = card.entry;
    if (entry?.act) return true;
    if (!ability) return false;
    if (isAttack && (entry?.attack || card.keywords?.includes('charge'))) return true;
    if (entry?.abilities?.includes(ability.name)) return true;
    return !isAttack && entry?.abilities?.includes('*') === true;
  };
  if (own(creature as EntryHolder)) return true;
  const controller = creature.controller;
  if (!controller) return false;
  return engine.registeredCharacters.some((other) => {
    if (other.controller !== controller || !engine.isInPlay(other)) return false;
    const entry = (other as EntryHolder).entry;
    return entry?.ownedAct === true || (isAttack && entry?.ownedAttack === true);
  });
}

/**
 * A creature that has just entered play: **it cannot act** — use an ability or attack —
 * until its controller's next turn. The standing rule (`rules.ts`) puts this on a creature
 * as it arrives, and a creature card can state exceptions (`mayActOnEntry`).
 */
export const summoningSickness = buff({
  id: 'summoning-sickness',
  name: 'Summoning Sickness',
  description: 'cannot act until its controller’s next turn',
  weight: 0,
  abilities: [
    restriction({
      name: 'Cannot act',
      description: 'cannot use abilities or attack the turn it enters play',
      on: 'activate',
      when: (ctx) => !mayActOnEntry(ctx.engine, ctx.self, ctx.ability),
    }),
  ],
});

/** One mana crystal: a derived +1 to the hero's mana **max**. */
export const manaCrystal = buff({
  id: 'mana-crystal',
  name: 'Mana Crystal',
  description: '+1 maximum mana',
  weight: 0,
  removable: false,
  stacks: true, // ten separate crystals, not one buff that cannot repeat
  abilities: [maxModifier({ name: 'Mana Crystal', gauge: 'mana', add: 1 })],
});

/** Attack — the move every creature has. */
export const attack = cast({
  id: 'attack',
  name: 'Attack',
  description: 'deal this creature’s power to a target; creatures strike back',
  targeting: ATTACK_PATTERN,
  cast: (ctx, targeting) => {
    const target = targeting.targets[0];
    if (!target) return [];
    const mine = ctx.self.stat('power') ?? 0;
    const theirs = target.stat('power') ?? 0;
    return [
      ...(mine > 0 ? [damage(target.gauge('hp'), mine, ctx.self)] : []),
      // Creatures trade; a hero has no power, so it never strikes back.
      ...(theirs > 0 ? [damage(ctx.self.gauge('hp'), theirs, target)] : []),
    ];
  },
});

/**
 * "You must attack the taunter first", as a restriction on *everyone else*.
 *
 * A restriction is consulted about the character it is attached to
 * (`ctx.self` is the would-be target), so taunt is written from the
 * defender's side: *I* cannot be attacked while an ally of mine taunts.
 */
export const tauntRule = restriction({
  id: 'taunt-rule',
  name: 'Taunt',
  description: 'cannot be attacked while an ally taunts',
  on: 'target',
  when: (ctx) => {
    if (ctx.pattern !== ATTACK_PATTERN) return false; // spells ignore taunt
    if (hasTaunt(ctx.self)) return false; // the taunter itself is fair game
    return ctx.engine.registeredCharacters.some(
      (other) =>
        other !== ctx.self &&
        ctx.engine.isInPlay(other) &&
        isAlly(ctx.self, other) &&
        hasTaunt(other),
    );
  },
});

/** What a hero power costs; the card layer checks it before offering the move. */
export const HERO_POWER_COST = 2;

/**
 * Hero Power — 2 mana, deal 1 damage to any enemy. The cost is part of the
 * cast, the way a mana-costing ability is written in the engine's own
 * quickstart: one list of actions, paid and dealt in the same pipeline.
 */
export const heroPower = cast({
  id: 'hero-power',
  name: 'Fireblast',
  description: '2 mana: deal 1 damage',
  targeting: { who: 'enemy', count: 1 },
  cast: (ctx, targeting) => {
    const target = targeting.targets[0];
    if (!target) return [];
    return [changeGaugeBy(ctx.self.gauge('mana'), -HERO_POWER_COST), damage(target.gauge('hp'), 1, ctx.self)];
  },
});

/** A player's avatar: 30 life, an empty mana bar, and a hero power. */
export function makeHero(name: string): Character {
  return new Character(name, {
    maxHp: 30,
    maxMana: 0, // every point of mana comes from a crystal buff
    skills: [skill({ name: 'Hero', weight: 1, abilities: [heroPower, tauntRule] })],
  });
}

