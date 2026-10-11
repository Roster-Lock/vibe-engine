/**
 * `npm run rts:codegen` — compiles `abilities.rts` and writes the
 * TypeScript it becomes to `src/generated/abilities.gen.ts`.
 *
 * The output is committed on purpose. It is the artifact that makes the
 * example's claim checkable: the project's `tsc` compiles it like any other
 * source file, the demo can run it instead of the interpreter, and
 * `test/codegen.test.ts` fails if it drifts from the `.rts` file it came
 * from. Regenerating is part of editing the ability text.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateModule } from '../src/english/codegen.js';
import { loadContent } from '../src/content/index.js';

const OUTPUT = fileURLToPath(new URL('../src/generated/abilities.gen.ts', import.meta.url));

const { diagnostics, program } = loadContent();
const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
for (const diagnostic of diagnostics) {
  console.error(`${diagnostic.severity} [${diagnostic.code}] ${diagnostic.message}`);
}
if (errors.length > 0) {
  console.error(`\nabilities.rts has ${errors.length} error(s) — nothing generated.`);
  process.exit(1);
}

writeFileSync(OUTPUT, generateModule(program, 'src/content/abilities.rts'), 'utf8');
console.log(
  `Generated ${program.abilities.length} abilities and ${program.buffs.length} buffs → src/generated/abilities.gen.ts`,
);
