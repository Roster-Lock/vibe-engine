/**
 * Prints the IR as TypeScript — the half of "English becomes executable
 * code" you can actually read.
 *
 * The output is not a pretty-printed data dump: it is a real module of real
 * `cast(ctx)` functions, written against the same `CastApi` the interpreter
 * uses. It is committed to `src/generated/abilities.gen.ts`, which means
 * the project's own `tsc` checks it on every run, and `npm run rts:codegen`
 * regenerates it. If the emitted code did not compile, the build would say
 * so — which is a far stronger claim than a test that only inspects a
 * string.
 *
 * Emission style: one `for (const unit of …)` loop per effect, guards where
 * a noun can be absent, and no cleverness. Generated code is read by people
 * trying to understand what their sentence did, so it is written the way
 * they would have written it by hand.
 */
import type {
  AbilityProgram,
  Anchor,
  EffectNode,
  Program,
  UnitFilter,
  UnitQuery,
  ValueNode,
} from '../ir.js';

/** Emits the whole module: one export per ability, plus the buff data. */
export function generateModule(program: Program, source: string): string {
  const abilities = program.abilities.map((ability) => generateAbility(ability));
  const names = program.abilities.map((ability) => identifier(ability.id));
  return [
    '/*',
    ` * Generated from ${source} — do not edit.`,
    ' *',
    ' * Run `npm run rts:codegen` to regenerate. Every function below was',
    ' * written as an English sentence; this is what the compiler turned it',
    ' * into. It is ordinary TypeScript: the project typechecks it, and the',
    ' * battle in `npm run rts:demo -- --compiled` runs it.',
    ' */',
    "import type { BuffProgram } from '../ir.js';",
    "import type { CastApi, CompiledAbility } from '../english/runtime.js';",
    "import type { Unit } from '../sim/unit.js';",
    '',
    '/** The living members of a selection that may contain absent nouns. */',
    'function living(...units: readonly (Unit | undefined)[]): Unit[] {',
    '  return units.filter((unit): unit is Unit => unit !== undefined && unit.alive);',
    '}',
    '',
    ...abilities,
    '/** Buff definitions stay data — the runtime interprets their ticks and triggers. */',
    `export const COMPILED_BUFFS: readonly BuffProgram[] = ${JSON.stringify(program.buffs, null, 2)};`,
    '',
    `export const COMPILED_ABILITIES: readonly CompiledAbility[] = [${names.join(', ')}];`,
    '',
  ].join('\n');
}

function generateAbility(ability: AbilityProgram): string {
  const emitter = new Emitter();
  const lines: string[] = [];
  lines.push(`/** \`${ability.name}\` — ${describe(ability)} */`);
  lines.push(`export const ${identifier(ability.id)}: CompiledAbility = {`);
  lines.push(`  id: ${quote(ability.id)},`);
  lines.push(`  name: ${quote(ability.name)},`);
  lines.push(`  targeting: ${quote(ability.targeting)},`);
  lines.push(`  cooldown: ${number(ability.cooldown)},`);
  lines.push(`  manaCost: ${number(ability.manaCost)},`);
  lines.push(`  castRange: ${number(ability.castRange)},`);

  const body = emitter.effects(ability.effects, 2);
  if (body.length === 0) {
    lines.push('  // A passive: nothing happens on cast.');
    lines.push('  cast(): void {},');
  } else {
    lines.push('  cast(ctx: CastApi): void {');
    lines.push(...body);
    lines.push('  },');
  }

  if (ability.triggers.length > 0) {
    lines.push('  triggers: {');
    for (const trigger of ability.triggers) {
      const triggerBody = emitter.effects(trigger.effects, 3);
      lines.push(`    ${trigger.event}(ctx: CastApi): void {`);
      lines.push(...triggerBody);
      lines.push('    },');
    }
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

/** The one-line summary that becomes the export's doc comment. */
function describe(ability: AbilityProgram): string {
  const parts: string[] = [];
  parts.push(ability.targeting === 'none' ? 'no target' : ability.targeting.replace(/([A-Z])/g, ' $1').toLowerCase());
  if (ability.manaCost > 0) parts.push(`${ability.manaCost} mana`);
  if (ability.cooldown > 0) parts.push(`${ability.cooldown}s cooldown`);
  if (ability.castRange > 0) parts.push(`${ability.castRange} range`);
  return parts.join(', ');
}

/**
 * Emits statements. Holds only a counter: every loop and guard gets a fresh
 * variable name, so nested effects never shadow each other.
 */
class Emitter {
  #counter = 0;

  effects(nodes: readonly EffectNode[], depth: number): string[] {
    return nodes.flatMap((node) => this.effect(node, depth));
  }

  effect(node: EffectNode, depth: number): string[] {
    const pad = '  '.repeat(depth);
    switch (node.kind) {
      case 'damage':
        return this.#overUnits(node.units, depth, (unit) => [`ctx.damage(${unit}, ${this.value(node.amount)});`]);
      case 'heal':
        return this.#overUnits(node.units, depth, (unit) => [`ctx.heal(${unit}, ${this.value(node.amount)});`]);
      case 'addBuff':
        return this.#overUnits(node.units, depth, (unit) => [`ctx.addBuff(${unit}, ${quote(node.buff)});`]);
      case 'removeBuff':
        return this.#overUnits(node.units, depth, (unit) => [`ctx.removeBuff(${unit}, ${quote(node.buff)});`]);
      case 'kill':
        return this.#overUnits(node.units, depth, (unit) => [`ctx.kill(${unit});`]);
      case 'summon':
        return this.#atAnchor(node.anchor, depth, (at) => [
          `${'  '.repeat(depth)}ctx.summon(${quote(node.unit)}, ${number(node.count)}, ${at});`,
        ]);
      case 'teleport':
        return this.#atAnchor(node.anchor, depth, (at, innerDepth) =>
          this.#overUnits(node.units, innerDepth, (unit) => [`ctx.teleport(${unit}, ${at});`]),
        );
      case 'knockback':
        return this.#atAnchor(node.anchor, depth, (from, innerDepth) =>
          this.#overUnits(node.units, innerDepth, (unit) => [`ctx.push(${unit}, ${from}, ${number(node.distance)});`]),
        );
      case 'after':
        return [
          `${pad}ctx.after(${number(node.delay)}, () => {`,
          ...this.effects(node.body, depth + 1),
          `${pad}});`,
        ];
      case 'every':
        return [
          `${pad}ctx.every(${number(node.interval)}, ${number(node.duration)}, () => {`,
          ...this.effects(node.body, depth + 1),
          `${pad}});`,
        ];
    }
  }

  /** `for (const unitN of <selection>) { … }` around one statement. */
  #overUnits(query: UnitQuery, depth: number, body: (unit: string) => string[]): string[] {
    const pad = '  '.repeat(depth);
    // A self-selection is always exactly one living unit, so the loop would
    // only obscure it.
    if (query.kind === 'self') {
      return [`${pad}if (ctx.self.alive) {`, ...body('ctx.self').map((line) => `${pad}  ${line}`), `${pad}}`];
    }
    const name = `unit${(this.#counter += 1)}`;
    return [
      `${pad}for (const ${name} of ${this.units(query)}) {`,
      ...body(name).map((line) => `${pad}  ${line}`),
      `${pad}}`,
    ];
  }

  /** Binds an anchor to a local, guarding the cases where it can be absent. */
  #atAnchor(anchor: Anchor, depth: number, body: (at: string, depth: number) => string[]): string[] {
    const pad = '  '.repeat(depth);
    if (anchor.kind === 'self') return body('ctx.self.pos', depth);
    const name = `at${(this.#counter += 1)}`;
    return [
      `${pad}const ${name} = ${this.anchor(anchor)};`,
      `${pad}if (${name}) {`,
      ...body(name, depth + 1),
      `${pad}}`,
    ];
  }

  /**
   * A unit selection, as an expression that always evaluates to an array.
   * `ctx.area` tolerates an absent anchor, so nothing here needs a guard.
   */
  units(query: UnitQuery): string {
    switch (query.kind) {
      case 'self':
        return 'living(ctx.self)';
      case 'target':
        return 'living(ctx.target)';
      case 'eventUnit':
        return `living(ctx.role(${quote(query.role)}))`;
      case 'area': {
        const options = [
          `who: ${quote(query.who)}`,
          `radius: ${number(query.radius)}`,
          `from: ${this.anchor(query.anchor)}`,
          ...(query.other ? ['other: true'] : []),
        ];
        return `ctx.area({ ${options.join(', ')} })`;
      }
      case 'filtered':
        return `${this.units(query.units)}.filter((unit) => ${this.filter(query.filter)})`;
    }
  }

  anchor(anchor: Anchor): string {
    switch (anchor.kind) {
      case 'self':
        return 'ctx.self.pos';
      case 'target':
        return 'ctx.target?.pos';
      case 'targetPoint':
        return 'ctx.point';
      case 'eventUnit':
        return `ctx.role(${quote(anchor.role)})?.pos`;
    }
  }

  value(node: ValueNode): string {
    if (node.kind === 'const') return number(node.value);
    const scale = number(node.percent / 100);
    // The caster is always present; every other noun may be absent.
    if (node.of.kind === 'self') return `ctx.self.stat(${quote(node.stat)}) * ${scale}`;
    return `(${this.#singleUnit(node.of)}?.stat(${quote(node.stat)}) ?? 0) * ${scale}`;
  }

  /**
   * The single-unit expression a possessive is taken of. The compiler only
   * produces `this unit` / `the target` / an event noun here, but a group
   * still emits something sensible: its first member.
   */
  #singleUnit(query: UnitQuery): string {
    switch (query.kind) {
      case 'self':
        return 'ctx.self';
      case 'target':
        return 'ctx.target';
      case 'eventUnit':
        return `ctx.role(${quote(query.role)})`;
      default:
        return `${this.units(query)}[0]`;
    }
  }

  filter(filter: UnitFilter): string {
    switch (filter.kind) {
      case 'stat':
        return `unit.stat(${quote(filter.stat)}) ${operator(filter.op)} ${this.value(filter.value)}`;
      case 'statShare':
        return `unit.stat(${quote(filter.stat)}) ${operator(filter.op)} unit.stat(${quote(filter.of)}) * ${number(filter.percent / 100)}`;
      case 'buff':
        return `unit.hasBuff(${quote(filter.buff)})`;
      case 'and':
        return `(${this.filter(filter.left)} && ${this.filter(filter.right)})`;
      case 'or':
        return `(${this.filter(filter.left)} || ${this.filter(filter.right)})`;
      case 'not':
        return `!(${this.filter(filter.expression)})`;
    }
  }
}

/** The language's `=` / `!=` become JavaScript's strict forms. */
function operator(op: string): string {
  if (op === '=') return '===';
  if (op === '!=') return '!==';
  return op;
}

function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Keeps floating-point noise out of the emitted source. */
function number(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

/** `thunder-clap` → `thunderClap`, safe as an export name. */
export function identifier(id: string): string {
  const camel = id.replace(/[^a-zA-Z0-9]+(.)?/g, (_, next: string | undefined) => (next ? next.toUpperCase() : ''));
  return /^[0-9]/.test(camel) ? `ability${camel}` : camel;
}
