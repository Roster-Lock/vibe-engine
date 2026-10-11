/**
 * `npm run rts:demo` — compiles the ability document and fights a battle
 * with it, printing the log.
 *
 * Flags:
 *
 * - `--compiled` runs the generated TypeScript closures instead of
 *   interpreting the IR. The battle should be identical; that is the point.
 * - `--seed <n>` picks a different battle.
 * - `--quiet` prints only the result.
 * - `--print <Ability>` shows what one ability compiled to, in both forms.
 */
import { createBattle, deployArmies, runBattle } from './battle.js';
import { loadContent } from './content/index.js';
import { generateModule } from './english/codegen.js';
import { COMPILED_ABILITIES } from './generated/abilities.gen.js';
import { slug } from './ir.js';

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const { diagnostics, program } = loadContent();
for (const diagnostic of diagnostics) {
  console.log(`  ${diagnostic.severity}: ${diagnostic.message}  [${diagnostic.code}]`);
}
if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) process.exit(1);

const printName = option('print');
if (printName) {
  const id = slug(printName);
  const ability = program.abilities.find((candidate) => candidate.id === id);
  if (!ability) {
    console.error(`No ability named "${printName}". Known: ${program.abilities.map((a) => a.name).join(', ')}`);
    process.exit(1);
  }
  console.log(`\n=== ${ability.name} — the IR ===\n`);
  console.log(JSON.stringify(ability, null, 2));
  console.log(`\n=== ${ability.name} — as TypeScript ===\n`);
  console.log(generateModule({ abilities: [ability], buffs: [] }, 'src/content/abilities.rts'));
  process.exit(0);
}

const useCompiled = flag('compiled');
const seed = Number(option('seed') ?? 20250926);

console.log(
  `\n${program.abilities.length} abilities, ${program.buffs.length} buffs compiled from English.\n` +
    `Running ${useCompiled ? 'the GENERATED TypeScript' : 'the INTERPRETED IR'} (seed ${seed}).\n`,
);

const battle = createBattle(program, { seed, compiled: useCompiled ? COMPILED_ABILITIES : undefined });
deployArmies(battle);
const result = runBattle(battle);

if (!flag('quiet')) {
  for (const line of battle.world.formatLog()) console.log(line);
}

console.log('\n--- result ---');
console.log(`  ${result.timedOut ? 'stalemate (timed out)' : `team ${result.winner} wins`} after ${result.elapsed.toFixed(1)}s`);
for (const survivor of result.survivors) console.log(`  survivor: ${survivor}`);
