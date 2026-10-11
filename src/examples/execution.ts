/**
 * The IR's expression layer in action (docs/free-write/triggered.md): a
 * "translated ability" — a plain data object, no closures — compiled into a
 * real TriggeredAbility and run through the normal engine.
 *
 * Run with:  npm run example:execution
 *
 * "Field Medic": whenever 2 or more of your characters survive damage in the
 * same batch, heal each of them for 5. This is exactly the shape
 * docs/free-write/triggered.md sketches — a `BatchEvent<Trigger>` whose
 * `triggerFilter`/`willTrigger`/`actions` are `DeclaredFn` trees, not TS
 * functions — compiled once with `compileBatchEvent` into an ability the
 * trigger stack can't distinguish from a hand-written `auto(...)`. Actions
 * are the noun-based vocabulary (`gauge`), not a `heal`/`damage` verb.
 */
import {
  Character,
  GameEngine,
  Player,
  buff,
  damage,
  isDamage,
  isHeal,
  amountOf,
  type Action,
  type Decision,
  type GameEvent,
} from '../games/turn-based/index.js';
import { compileBatchEvent, type DeclaredFn } from '../ir/index.js';
import { createEngine } from '../games/turn-based/index.js';

class AutoPlayer extends Player {
  async decide(): Promise<Decision[]> {
    return [];
  }
}

/* ------------------------------ the data ------------------------------ */
/* No TypeScript functions below this point — just JSON-shaped nodes. */

type Survivor = { character: Character };

const heal5EachSurvivor: DeclaredFn<readonly Survivor[], readonly Action[]> = {
  kind: 'forEach',
  array: { kind: 'get', root: 'input', path: [] },
  body: {
    kind: 'gauge',
    op: 'add',
    target: { kind: 'get', root: 'input', path: ['character'] },
    amount: { kind: 'math', expression: { kind: 'number', value: 5 } },
  },
};

const fieldMedic = compileBatchEvent<Survivor>({
  name: 'Field Medic',
  event: 'character:survived:batch',
  triggerFilter: { kind: 'bool', value: true }, // every survivor in the batch counts
  willTrigger: {
    // "2 or more" — the count-phrase table's runtime form
    kind: 'compare',
    op: '>=',
    left: { kind: 'get', root: 'input', path: ['length'] },
    right: { kind: 'math', expression: { kind: 'number', value: 2 } },
  },
  actions: [heal5EachSurvivor],
});

/* ------------------------------ setup ------------------------------ */

const engine = createEngine({
  onEvent: (event: GameEvent) => {
    if (isDamage(event) && 'target' in event && event.target) {
      console.log(`   ${event.target.name} takes ${amountOf(event)} damage (${event.target.gauge('hp').current} HP left)`);
    } else if (isHeal(event) && event.target) {
      console.log(`   ${event.target.name} is healed to ${event.to} HP (Field Medic)`);
    }
  },
});

const commander = new Character('Commander', { maxHp: 100, maxMana: 100 });
const a = new Character('Trooper A', { maxHp: 100, maxMana: 100 });
const b = new Character('Trooper B', { maxHp: 100, maxMana: 100 });
const goblin = new Character('Goblin', { maxHp: 100, maxMana: 100 });
commander.team = 'party';
a.team = 'party';
b.team = 'party';
goblin.team = 'monsters';

engine.registerPlayers([new AutoPlayer('Squad', [commander, a, b], 'party'), new AutoPlayer('Goblins', [goblin], 'monsters')]);

await engine.addBuff(commander, buff({ name: 'Field Medic', weight: 1, abilities: [fieldMedic] }));

/* ------------------------------ battle ------------------------------ */

console.log('=== A single hit — only one survivor in the batch, Field Medic stays quiet ===');
await engine.damage(a.gauge('hp'), 10, goblin);
console.log(`   ${a}`);

console.log('\n=== A simultaneous hit on two troopers — 2 survivors in one batch, Field Medic triggers ===');
await engine.apply([damage(a.gauge('hp'), 10, goblin), damage(b.gauge('hp'), 20, goblin)]);
console.log(`   ${a}`);
console.log(`   ${b}`);
