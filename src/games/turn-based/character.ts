/**
 * **This game's `Character`** — the engine's entity with a turn-based combat
 * game's vocabulary layered on: an `'hp'` gauge that is life, an optional
 * `'mana'` gauge, and the `maxHp`/`maxMana` fields content has always written.
 *
 * It is a **subclass**, not a wrapper, so it is the same entity the engine
 * knows: `instanceof` checks, zone membership, statuses and transforms all
 * behave identically, and `engine.registerCharacter(...)` takes it unchanged.
 * The only difference is the constructor, which turns this game's shorthand
 * into the engine's gauge declarations.
 *
 * ```ts
 * import { Character, GameEngine } from './games/turn-based/index.js';
 *
 * const hero = new Character('Hero', { maxHp: 20, maxMana: 5 });
 * ```
 *
 * A game that wants its life somewhere else never uses this class — it
 * declares its own gauges and passes them to the engine's `Character`
 * directly (see `test/generic-gauges.test.ts`).
 */
import {
  Character as EngineCharacter,
  type CharacterDef as EngineCharacterDef,
  type Gauge,
  type GaugeDef,
  type SkillDef,
} from '../../engine/index.js';
import { collapsesAtZero, depletesAtZero } from './death.js';
import { DEFAULT_SPEED } from './initiative.js';

/**
 * This game's character definition: the engine's fields, plus the `hp`/`mana`
 * shorthand.
 *
 * The shorthand is pure sugar for a gauge declaration — `maxHp: 20` means "an
 * `'hp'` gauge at max 20 carrying the game's death rules", which is exactly
 * what writing that entry in `gauges` would mean. Both spellings produce the
 * same character; there is no privileged path, and an explicit `gauges` entry
 * for the same id always wins over the sugar.
 */
export interface FighterDef extends Omit<EngineCharacterDef, 'gauges'> {
  /** The character's gauges, if it wants to declare any itself. */
  readonly gauges?: readonly (GaugeDef | Gauge)[];
  /** Max HP — sugar for an `'hp'` gauge carrying the game's death rules. */
  readonly maxHp?: number;
  /** Starting HP; defaults to `maxHp`. */
  readonly hp?: number;
  /** Max mana — sugar for a `'mana'` gauge. */
  readonly maxMana?: number;
  /** Starting mana; defaults to `maxMana`. */
  readonly mana?: number;
  /**
   * The gauge this game treats as life. Defaults to `'hp'` when an `'hp'`
   * gauge is present, so the sugar and a hand-declared `{ id: 'hp' }` behave
   * alike.
   */
  readonly lifeGauge?: string;
  readonly speed?: number;
  readonly stats?: Readonly<Record<string, number>>;
  readonly skills?: readonly SkillDef[];
}

/**
 * The field names **this game** reserves, so a custom stat cannot silently
 * shadow one. `speed` is reserved by the engine (it is a field on every
 * `CharacterDef`); these are reserved here, because `maxHp`/`maxMana` are this
 * game's shorthand and mean "declare a gauge", not "a stat called maxHp".
 *
 * The check lives here rather than in the engine for the same reason the
 * shorthand does: the engine has no such fields, so it has nothing to protect.
 */
const RESERVED_STATS = ['maxHp', 'hp', 'maxMana', 'mana'] as const;

export class Character extends EngineCharacter {
  constructor(name: string, def: FighterDef = {}) {
    for (const reserved of RESERVED_STATS) {
      if (def.stats && reserved in def.stats) {
        throw new Error(
          `Character "${name}": "${reserved}" is a built-in stat — set it with its own field ` +
            `(${RESERVED_STATS.join('/')}), not "stats"`,
        );
      }
    }

    const declared = def.gauges ?? [];
    const declaredIds = new Set(declared.map((g) => g.id));

    // This game's shorthand, turned into ordinary gauge declarations. Sugar
    // goes first (hp, then mana) because that is the order the engine's SBA
    // pass and target pools have always enumerated; anything the game declared
    // itself follows in declaration order.
    const sugar: GaugeDef[] = [];
    if (!declaredIds.has('hp') && (def.maxHp !== undefined || def.hp !== undefined)) {
      sugar.push({
        id: 'hp',
        max: def.maxHp ?? def.hp ?? 0,
        ...(def.hp !== undefined ? { current: def.hp } : {}),
        sbas: [depletesAtZero(), collapsesAtZero()],
      });
    }
    // A character built with any of the legacy fields has always carried an
    // (empty by default) mana gauge; keep that so `{ maxHp }` alone is
    // unchanged. A character built purely from `gauges` gets only what it
    // declared.
    const legacy =
      def.maxHp !== undefined ||
      def.hp !== undefined ||
      def.maxMana !== undefined ||
      def.mana !== undefined;
    if (!declaredIds.has('mana') && legacy) {
      sugar.push({
        id: 'mana',
        max: def.maxMana ?? 0,
        ...(def.mana !== undefined ? { current: def.mana } : {}),
      });
    }

    const gauges: (GaugeDef | Gauge)[] = [...sugar, ...declared];
    super(name, {
      gauges,
      lifeGauge: def.lifeGauge ?? (gauges.some((g) => g.id === 'hp') ? 'hp' : undefined),
      speed: def.speed ?? DEFAULT_SPEED,
      ...(def.stats !== undefined ? { stats: def.stats } : {}),
      ...(def.skills !== undefined ? { skills: def.skills } : {}),
    });
  }
}
