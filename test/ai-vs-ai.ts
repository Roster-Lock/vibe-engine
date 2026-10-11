/**
 * ai-vs-ai.ts — run two AI players against each other in a realistic battle.
 *
 * "Realish" means: the real example roster (`src/examples/08-27-2026/` —
 * Hero, Paladin, Assassin, Vampire, Pyromancer, War Hound, …) with its real
 * skills, buffs (Poison ticks, stacking Rage), multi-target skills (Life
 * Drain) and mana economy, through the full `LocalGame` ceremony (seed
 * commit/reveal, turn loop, win/lose/draw, round cap).
 *
 * Two brains are available per side:
 *
 * - `random` — the engine's built-in `RandomAI` (default).
 * - `seeded` — a deterministic copy of `RandomAI`; use with `--seed` so a
 *   battle replays identically (same seed ⇒ same trigger order, same picks).
 * - `llm` — a real LLM (DeepSeek chat completions) that reads the battle
 *   state each round and picks abilities + targets as JSON. Falls back to
 *   random moves when the API fails or the reply is invalid. The API key is
 *   read from `$DEEPSEEK_API_KEY` or `$DSH_HOME/.credentials.yaml`.
 *
 * Usage (from the repo root):
 *
 * ```sh
 * npm run ai:vs                                            # random vs random
 * npm run ai:vs -- --seed 42 --matches 5                   # deterministic, 5 matches
 * npm run ai:vs -- --scenario thorn                        # thorn-mail variant
 * npm run ai:vs -- --brain1 llm --brain2 llm --max-rounds 20   # LLM vs LLM
 * npm run ai:vs -- --brain1 llm --brain2 random            # LLM vs built-in AI
 * ```
 *
 * Run with plain node when tsx is available:
 * `node --import tsx --import ./src/games/turn-based/svg-loader.mjs test/ai-vs-ai.ts --seed 42`
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  Character,
  Player,
  amountOf,
  commitSecret,
  isDamage,
  isHeal,
  isHpChange,
  isManaChange,
  skill,
  type Ability,
  type Decision,
  type GameEngine,
  type GameEvent,
  type ManualAbility,
  type TargetPattern,
} from '../src/games/turn-based/index.js';
import { LocalGame } from '../src/multiplayer/local.js';
import { RandomAI } from '../src/multiplayer/random-ai.js';
import {
  ROSTER,
  headbutt,
  makeAssassin,
  makeGoblin,
  makeHero,
  makeHound,
  makePaladin,
  makePyromancer,
  makeVampire,
  thorns,
  warCry,
} from '../src/games/turn-based/content/index.js';

/* =============================== content =============================== */

export interface TeamSpec {
  readonly name: string;
  readonly team: string;
  /** Builds a fresh set of characters for every match. */
  readonly build: () => Character[];
}

export interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly teams: readonly [TeamSpec, TeamSpec];
}

/**
 * A permanent "Thorn Mail" variant of the Goblin Chieftain — the thorns
 * buff is real content (`buffs/thorns`), only granted as a skill instead of
 * being applied at runtime, so a battle exercises the passive retaliation
 * path too.
 */
export function makeThornGoblin(): Character {
  return new Character('Goblin Thornbreaker', {
    maxHp: 110,
    maxMana: 110,
    skills: [
      skill({ name: 'Chieftain', weight: 1, abilities: [headbutt] }),
      skill({ name: 'Berserker', weight: 1, abilities: [warCry] }),
      skill({ name: 'Thorn Mail', weight: 1, abilities: [...(thorns.abilities ?? [])] }),
    ],
  });
}

/** The preset battle scenarios (real roster, real buffs, 3v3). */
export const SCENARIOS: Record<'classic' | 'thorn', Scenario> = {
  classic: {
    id: 'classic',
    label: 'Radiant Order vs Night Court',
    teams: [
      {
        name: 'Radiant Order',
        team: 'light',
        build: () => [makeHero(), makePaladin(), makeAssassin()],
      },
      {
        name: 'Night Court',
        team: 'dark',
        build: () => [makeVampire(), makePyromancer(), makeHound()],
      },
    ],
  },
  thorn: {
    id: 'thorn',
    label: 'Radiant Order vs Thorn Court',
    teams: [
      {
        name: 'Radiant Order',
        team: 'light',
        build: () => [makeHero(), makePaladin(), makeAssassin()],
      },
      {
        name: 'Thorn Court',
        team: 'dark',
        build: () => [makeVampire(), makePyromancer(), makeThornGoblin()],
      },
    ],
  },
};

/** Roster emoji by character name (for pretty logs). */
const EMOJI = new Map<string, string>(ROSTER.map((def) => [def.name, def.emoji]));
EMOJI.set('Goblin Thornbreaker', '👺');

function emojiOf(name: string): string {
  return EMOJI.get(name) ?? '';
}

/* ============================== AI brains ============================== */

export type BrainKind = 'random' | 'seeded' | 'llm';

/** A deterministic PRNG (mulberry32) — makes battles replayable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The deterministic sibling of `RandomAI`: same "pick a random skill and
 * random targets" policy, but every pick comes from an injected PRNG and
 * the seed-ceremony secret is derived from it, so a battle with a fixed
 * seed replays identically.
 */
export class SeededRandomAI extends Player {
  readonly #rng: () => number;
  readonly #secret: string;

  constructor(
    name: string,
    characters: readonly Character[],
    team: string | undefined,
    options: { rng: () => number; secret?: string },
  ) {
    super(name, characters, team);
    this.#rng = options.rng;
    this.#secret =
      options.secret ??
      `seeded:${Math.floor(options.rng() * 2 ** 32).toString(16)}${Math.floor(options.rng() * 2 ** 32).toString(16)}`;
  }

  override commitSeed(): string {
    return commitSecret(this.#secret);
  }

  override revealSeed(): string {
    return this.#secret;
  }

  async decide(engine: GameEngine): Promise<Decision[]> {
    const decisions: Decision[] = [];
    for (const character of this.livingCharacters) {
      const decision = randomDecision(engine, character, this.#rng);
      if (decision) decisions.push(decision);
    }
    return decisions;
  }
}

/** Random policy shared by the seeded AI and the LLM's fallback. */
export function randomDecision(
  engine: GameEngine,
  character: Character,
  rng: () => number,
): Decision | undefined {
  const abilities = character.manualAbilities;
  if (abilities.length === 0) return undefined;
  const ability = abilities[Math.floor(rng() * abilities.length)];
  if (!ability) return undefined;
  const options = engine.validTargets(ability.targeting, character);
  if (options.length === 0) return undefined;
  const count = Math.min(desiredCount(ability.targeting, rng), options.length);
  const targets = sample(options, count, rng);
  if (targets.length === 0) return undefined;
  return { character, ability, targets };
}

function desiredCount(pattern: TargetPattern, rng: () => number): number {
  if (typeof pattern.count === 'number') return pattern.count;
  if (Array.isArray(pattern.count)) {
    const [min = 1, max = min] = pattern.count;
    return min + Math.floor(rng() * (max - min + 1));
  }
  return 1;
}

function sample<T>(items: readonly T[], count: number, rng: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]!);
  }
  return out;
}

/* ------------------------------ LLM brain ------------------------------ */

export interface LlmOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly temperature?: number;
  /** PRNG used for the seed-ceremony secret and random fallbacks. */
  readonly rng?: () => number;
}

export interface LlmStats {
  calls: number;
  failures: number;
  invalidMoves: number;
  fallbackMoves: number;
}

interface LlmMove {
  character: string;
  ability: string;
  targets: string[];
}

/**
 * A player whose decisions come from a real LLM: every round each living
 * character's situation is serialized into a prompt, the model answers with
 * JSON moves, and the answers are validated against the engine's own
 * `validTargets` before being used. Anything that fails to parse, names an
 * unknown ability/target or picks an illegal target falls back to a random
 * move, so the battle never deadlocks on a bad reply.
 */
export class LLMPlayer extends Player {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #endpoint: string;
  readonly #temperature: number;
  readonly #rng: () => number;
  readonly #secret: string;
  #round = 0;
  readonly stats: LlmStats = { calls: 0, failures: 0, invalidMoves: 0, fallbackMoves: 0 };

  constructor(
    name: string,
    characters: readonly Character[],
    team: string | undefined,
    options: LlmOptions,
  ) {
    super(name, characters, team);
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? 'deepseek-chat';
    this.#endpoint = options.endpoint ?? 'https://api.deepseek.com';
    this.#temperature = options.temperature ?? 0.2;
    const rng = options.rng ?? Math.random;
    this.#rng = rng;
    this.#secret = `llm:${Math.floor(rng() * 2 ** 32).toString(16)}${Math.floor(rng() * 2 ** 32).toString(16)}`;
  }

  override commitSeed(): string {
    return commitSecret(this.#secret);
  }

  override revealSeed(): string {
    return this.#secret;
  }

  async decide(engine: GameEngine): Promise<Decision[]> {
    this.#round += 1;
    const living = this.livingCharacters;
    const decisions: Decision[] = [];
    if (living.length === 0) return decisions;

    let moves: LlmMove[] = [];
    try {
      const prompt = buildPrompt(this.name, this.#round, living, engine);
      moves = await chatOnce(this.#endpoint, this.#model, this.#apiKey, this.#temperature, prompt);
      this.stats.calls += 1;
    } catch {
      this.stats.calls += 1;
      this.stats.failures += 1;
    }

    for (const character of living) {
      const move = moves.find((m) => m.character === character.name);
      const decision = move ? resolveMove(engine, character, move) : undefined;
      if (decision) {
        decisions.push(decision);
      } else {
        this.stats.fallbackMoves += 1;
        if (move) this.stats.invalidMoves += 1;
        const fallback = randomDecision(engine, character, this.#rng);
        if (fallback) decisions.push(fallback);
      }
    }
    return decisions;
  }
}

/** Serializes the battle state for one player's living characters. */
export function buildPrompt(
  playerName: string,
  round: number,
  living: readonly Character[],
  engine: GameEngine,
): string {
  const all = engine.players.flatMap((p) => [...p.characters]);
  const enemies = all.filter((c) => !c.isDefeated && !living.includes(c));
  const lines: string[] = [
    `You are controlling the team "${playerName}" in a turn-based RPG battle.`,
    `Round ${round}.`,
    '',
    'Your living characters:',
  ];
  for (const character of living) {
    lines.push(`- ${character.name} (HP ${character.gauge('hp').current}/${character.gauge('hp').max}, Mana ${character.gauge('mana').current}/${character.gauge('mana').max})${buffsText(character)}`);
    for (const ability of character.manualAbilities) {
      lines.push(`    ${ability.name} — ${ability.description ?? 'use it'} (targets: ${targetingText(ability.targeting)})`);
    }
  }
  lines.push('', 'Enemies:');
  for (const character of enemies) {
    lines.push(`- ${character.name} (HP ${character.gauge('hp').current}/${character.gauge('hp').max}, Mana ${character.gauge('mana').current}/${character.gauge('mana').max})${buffsText(character)}`);
  }
  lines.push(
    '',
    'Rules:',
    '- Choose for EVERY one of your living characters exactly one ability and its targets.',
    '- Use the exact character names and ability names listed above.',
    '- Target names must be from the list of enemies (or yourself/allies for self/ally abilities).',
    '- Reply with ONLY JSON, no commentary, in this exact shape:',
    '{"moves":[{"character":"Hero","ability":"Strike","targets":["Vampire Lord"]}]}',
  );
  return lines.join('\n');
}

function buffsText(character: Character): string {
  const buffs = character.buffs;
  if (buffs.length === 0) return ' [no buffs]';
  const byId = new Map<string, number>();
  for (const buff of buffs) byId.set(buff.name, (byId.get(buff.name) ?? 0) + 1);
  return ` [buffs: ${[...byId.entries()].map(([name, n]) => `${name} ×${n}`).join(', ')}]`;
}

function targetingText(pattern: TargetPattern): string {
  const who =
    pattern.who === 'self'
      ? 'self'
      : pattern.who === 'any'
        ? 'any character'
        : `one ${pattern.who}`;
  const count =
    typeof pattern.count === 'number'
      ? pattern.count
      : Array.isArray(pattern.count)
        ? `${pattern.count[0] ?? 1}-${pattern.count[1] ?? 1}`
        : 1;
  const noun =
    count === 1
      ? who
      : `${count} ${pattern.who === 'enemy' ? 'enemies' : pattern.who === 'ally' ? 'allies' : 'characters'}`;
  return pattern.match ? `${noun} (any of self or enemies)` : noun;
}

/** One chat-completions call; throws on transport/HTTP/parse errors. */
export async function chatOnce(
  endpoint: string,
  model: string,
  apiKey: string,
  temperature: number,
  prompt: string,
): Promise<LlmMove[]> {
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
      temperature,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`LLM HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned no content');
  return parseMoves(content);
}

/** Parses the model's reply tolerantly (code fences, stray prose). */
export function parseMoves(content: string): LlmMove[] {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in LLM reply');
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
    moves?: Array<{ character?: unknown; ability?: unknown; targets?: unknown }>;
  };
  if (!parsed || !Array.isArray(parsed.moves)) throw new Error('LLM reply missing "moves" array');
  return parsed.moves.map((move) => ({
    character: String(move.character ?? ''),
    ability: String(move.ability ?? ''),
    targets: Array.isArray(move.targets) ? move.targets.map(String) : [],
  }));
}

/** Validates one move against the engine and turns it into a `Decision`. */
export function resolveMove(
  engine: GameEngine,
  character: Character,
  move: LlmMove,
): Decision | undefined {
  const ability = character.manualAbilities.find((a) => a.name === move.ability);
  if (!ability) return undefined;
  const options = engine.validTargets(ability.targeting, character);
  if (options.length === 0) return undefined;

  const desired =
    typeof ability.targeting.count === 'number'
      ? ability.targeting.count
      : Array.isArray(ability.targeting.count)
        ? (ability.targeting.count[0] ?? 1)
        : 1;
  const wanted = new Set(move.targets);
  if (wanted.size !== desired || move.targets.length !== desired) return undefined;
  const targets = options.filter((option) => wanted.has(option.name));
  if (targets.length !== desired) return undefined;
  return { character, ability, targets };
}

/* ================================ runner ================================ */

export type EndReason = 'victory' | 'round-cap' | 'mutual-destruction';

export interface MatchResult {
  readonly scenarioId: string;
  readonly scenarioLabel: string;
  readonly teams: readonly [string, string]; // display names
  readonly brainA: BrainKind;
  readonly brainB: BrainKind;
  readonly seeded: boolean;
  readonly rounds: number;
  /** Winning player names (empty on a draw). */
  readonly winners: string[];
  readonly draw: boolean;
  readonly endReason: EndReason;
  readonly final: Array<{
    player: string;
    team: string;
    characters: Array<{
      name: string;
      hp: number;
      maxHp: number;
      mana: number;
      maxMana: number;
      alive: boolean;
      buffs: string[];
    }>;
  }>;
  readonly stats: BattleStats;
  readonly log: string[];
}

export interface BattleStats {
  readonly eventCounts: Record<string, number>;
  /** Damage dealt by a character name. */
  readonly damageDealt: Record<string, number>;
  /** Damage dealt by a buff name (Poison ticks, Thorns retaliation). */
  readonly buffDamage: Record<string, number>;
  readonly damageTaken: Record<string, number>;
  readonly healingDone: Record<string, number>;
  readonly healingTaken: Record<string, number>;
  readonly abilitiesUsed: Record<string, number>;
  readonly buffsApplied: Record<string, number>;
  readonly buffsRemoved: Record<string, number>;
  /** Invariant checks over the whole event stream (should all be 0). */
  readonly invariantViolations: {
    belowMin: number;
    aboveMax: number;
    negativeMax: number;
  };
  /** Per-character lowest observed HP (the life gauge). */
  readonly hpFloor: Record<string, number>;
  readonly llm: LlmStats;
}

export interface MatchOptions {
  readonly scenario: Scenario;
  readonly brainA: BrainKind;
  readonly brainB: BrainKind;
  readonly maxRounds?: number;
  /** When given, both sides use deterministic (seeded) randomness. */
  readonly seed?: number;
  /** Overrides for LLM brains (e.g. a stub endpoint in tests). */
  readonly llmOptions?: Partial<LlmOptions>;
  readonly verbose?: boolean;
  readonly out?: (line: string) => void;
}

/**
 * Runs one full battle: seed ceremony, turn loop, every engine event
 * observed and (optionally) rendered as a readable combat log, ending with
 * a result + stats + invariant checks.
 */
export async function runMatch(options: MatchOptions): Promise<MatchResult> {
  const out = options.out ?? ((line: string) => console.log(line));
  const verbose = options.verbose ?? true;
  const maxRounds = options.maxRounds ?? 100;
  const seeded = options.seed !== undefined;
  const rng = seeded ? mulberry32(options.seed!) : Math.random;

  const [teamA, teamB] = options.scenario.teams;
  const playerA = await buildPlayer(options.brainA, teamA, rng, options.llmOptions);
  const playerB = await buildPlayer(options.brainB, teamB, rng, options.llmOptions);
  const players = [playerA, playerB];

  const log: string[] = [];
  const stats = createStats();
  let round = 0;

  const game = new LocalGame(players, {
    maxRounds,
    onEvent: (event) => {
      observe(event, stats);
      if (event.type === 'turn:start') round += 1;
      if (verbose) {
        const line = renderEvent(event, round);
        if (line) {
          log.push(line);
          out(line);
        }
      }
    },
  });

  const winners = await game.runLoop();
  const livingTotal = players.reduce((n, p) => n + p.livingCharacters.length, 0);
  const endReason: EndReason = winners.length > 0 ? 'victory' : livingTotal > 0 ? 'round-cap' : 'mutual-destruction';

  const llmStats: LlmStats = { calls: 0, failures: 0, invalidMoves: 0, fallbackMoves: 0 };
  for (const player of players) {
    if (player instanceof LLMPlayer) {
      llmStats.calls += player.stats.calls;
      llmStats.failures += player.stats.failures;
      llmStats.invalidMoves += player.stats.invalidMoves;
      llmStats.fallbackMoves += player.stats.fallbackMoves;
    }
  }

  const final = players.map((player) => ({
    player: player.name,
    team: player.team ?? '',
    characters: player.characters.map((character) => ({
      name: character.name,
      hp: character.gauge('hp').current,
      maxHp: character.gauge('hp').max,
      mana: character.gauge('mana').current,
      maxMana: character.gauge('mana').max,
      alive: !character.isDefeated,
      buffs: summarizeBuffs(character.buffs),
    })),
  }));

  if (verbose) {
    out('');
    out(`=== Result: ${winners.length === 0 ? 'draw' : `${winners.map((w) => w.name).join(', ')} win`} after ${round} rounds (${endReason}) ===`);
  }

  return {
    scenarioId: options.scenario.id,
    scenarioLabel: options.scenario.label,
    teams: [teamA.name, teamB.name],
    brainA: options.brainA,
    brainB: options.brainB,
    seeded,
    rounds: round,
    winners: winners.map((w) => w.name),
    draw: winners.length === 0,
    endReason,
    final,
    stats: {
      eventCounts: stats.eventCounts,
      damageDealt: stats.damageDealt,
      buffDamage: stats.buffDamage,
      damageTaken: stats.damageTaken,
      healingDone: stats.healingDone,
      healingTaken: stats.healingTaken,
      abilitiesUsed: stats.abilitiesUsed,
      buffsApplied: stats.buffsApplied,
      buffsRemoved: stats.buffsRemoved,
      invariantViolations: stats.invariantViolations,
      hpFloor: stats.hpFloor,
      llm: llmStats,
    },
    log,
  };
}

async function buildPlayer(
  kind: BrainKind,
  team: TeamSpec,
  rng: () => number,
  llmOptions?: Partial<LlmOptions>,
): Promise<Player> {
  const characters = team.build();
  switch (kind) {
    case 'random':
      return new RandomAI(team.name, characters, team.team);
    case 'seeded':
      return new SeededRandomAI(team.name, characters, team.team, { rng });
    case 'llm': {
      const apiKey = llmOptions?.apiKey ?? (await resolveApiKey());
      if (!apiKey) {
        throw new Error(
          `LLM brain requested but no API key found — set DEEPSEEK_API_KEY or store one in $DSH_HOME/.credentials.yaml`,
        );
      }
      return new LLMPlayer(team.name, characters, team.team, { ...llmOptions, apiKey, rng });
    }
  }
}

/** Reads the DeepSeek key: env wins, then $DSH_HOME/.credentials.yaml. */
export async function resolveApiKey(): Promise<string | undefined> {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv) return fromEnv;
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  try {
    const text = await readFile(join(home, '.credentials.yaml'), 'utf8');
    const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(text);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/* ------------------------------ observation ------------------------------ */

interface StatsAccumulator {
  eventCounts: Record<string, number>;
  damageDealt: Record<string, number>;
  buffDamage: Record<string, number>;
  damageTaken: Record<string, number>;
  healingDone: Record<string, number>;
  healingTaken: Record<string, number>;
  abilitiesUsed: Record<string, number>;
  buffsApplied: Record<string, number>;
  buffsRemoved: Record<string, number>;
  invariantViolations: { belowMin: number; aboveMax: number; negativeMax: number };
  hpFloor: Record<string, number>;
}

function createStats(): StatsAccumulator {
  return {
    eventCounts: {},
    damageDealt: {},
    buffDamage: {},
    damageTaken: {},
    healingDone: {},
    healingTaken: {},
    abilitiesUsed: {},
    buffsApplied: {},
    buffsRemoved: {},
    invariantViolations: { belowMin: 0, aboveMax: 0, negativeMax: 0 },
    hpFloor: {},
  };
}

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

/** Groups a character's buff instances by name — "Rage ×4" instead of four "Rage ×1"s. */
export function summarizeBuffs(buffs: readonly { name: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const buff of buffs) counts.set(buff.name, (counts.get(buff.name) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) =>
    count > 1 ? `${name} ×${count}` : name,
  );
}

/**
 * Damage/heals ride the **HP** gauge — HP is the life gauge. The engine's
 * `isDamage`/`isHeal` helpers are already HP-keyed, so the observer uses
 * them directly. Mana writes (spell costs, drains) are ordinary resource
 * movement: they never count as damage or healing.
 */

function observe(event: GameEvent, stats: StatsAccumulator): void {
  bump(stats.eventCounts, event.type);
  switch (event.type) {
    case 'gauge:changed': {
      if (event.to < event.gauge.min) stats.invariantViolations.belowMin += 1;
      if (event.to > event.gauge.max) stats.invariantViolations.aboveMax += 1;
      const target = 'target' in event ? event.target : undefined;
      if (target && isHpChange(event)) {
        const floor = stats.hpFloor[target.name] ?? target.gauge('hp').current;
        stats.hpFloor[target.name] = Math.min(floor, event.to);
      }
      if (isDamage(event)) {
        const source = 'source' in event ? event.source : undefined;
        bump(stats.damageTaken, target?.name ?? '?', amountOf(event));
        if (source) {
          if (source.type === 'character') {
            bump(stats.damageDealt, source.name, amountOf(event));
          } else {
            bump(stats.buffDamage, source.name, amountOf(event));
          }
        }
      } else if (isHeal(event)) {
        const source = 'source' in event ? event.source : undefined;
        bump(stats.healingTaken, target?.name ?? '?', amountOf(event));
        if (source && source.type === 'character') {
          bump(stats.healingDone, source.name, amountOf(event));
        }
      }
      break;
    }
    case 'gauge:maxChanged': {
      if (event.to < 0) stats.invariantViolations.negativeMax += 1;
      break;
    }
    case 'buff:added':
      bump(stats.buffsApplied, event.buff.name);
      break;
    case 'buff:destroyed':
      bump(stats.buffsRemoved, event.buff.name);
      break;
    case 'ability:used':
      bump(stats.abilitiesUsed, event.ability.name);
      break;
    default:
      break;
  }
}

/* ------------------------------- rendering ------------------------------- */

function renderEvent(event: GameEvent, round: number): string | undefined {
  switch (event.type) {
    case 'turn:start':
      return `\n── Round ${round} ──`;
    case 'ability:used': {
      const targets = event.targeting.targets.map((t) => t.name).join(', ');
      return `  ⚔️  ${emojiOf(event.character.name)} ${event.character.name} uses ${event.ability.name} → ${targets}`;
    }
    case 'gauge:changed': {
      const name = 'target' in event ? event.target.name : event.gauge.id;
      const source = 'source' in event ? ` from ${event.source.name}` : '';
      if (isDamage(event)) {
        // HP is the life gauge: an HP loss is a lethal hit.
        const pct = event.gauge.max > 0 ? ` (${event.to}/${event.gauge.max})` : '';
        return `  🩸 ${emojiOf(name)} ${name} takes ${amountOf(event)} damage${source}${pct}`;
      }
      if (isHeal(event)) {
        return `  💚 ${emojiOf(name)} ${name} recovers ${amountOf(event)}${source} (${event.to}/${event.gauge.max})`;
      }
      if (isManaChange(event)) {
        // Mana is not the life gauge: a loss is a spell cost or a drain,
        // never damage; a gain is a restore, never a heal.
        if (event.to < event.from) {
          if ('source' in event && event.source === event.target) {
            return `  🔷 ${name} spends ${amountOf(event)} mana (${event.to}/${event.gauge.max})`;
          }
          return `  🔷 ${emojiOf(name)} ${name} loses ${amountOf(event)} mana${source} (${event.to}/${event.gauge.max})`;
        }
        if (event.to > event.from) {
          return `  🔷 ${emojiOf(name)} ${name} gains ${amountOf(event)} mana${source} (${event.to}/${event.gauge.max})`;
        }
        return undefined;
      }
      if (event.to > event.from) return `  🔷 ${name} restores ${amountOf(event)} ${event.gauge.id} (${event.to}/${event.gauge.max})`;
      if (event.to < event.from) return `  🔷 ${name} spends ${amountOf(event)} ${event.gauge.id} (${event.to}/${event.gauge.max})`;
      return undefined;
    }
    case 'gauge:maxChanged': {
      const name = event.gauge.id;
      return `  📈 ${name} max ${event.from} → ${event.to}`;
    }
    case 'buff:added': {
      const count = event.character.buffs.filter((b) => b.id === event.buff.id).length;
      const source = 'source' in event ? ` from ${event.source.name}` : '';
      return `  ✨ ${emojiOf(event.character.name)} ${event.character.name} gains ${event.buff.name}${count > 1 ? ` ×${count}` : ''}${source}`;
    }
    case 'buff:destroyed':
      return `  💨 ${emojiOf(event.character.name)} ${event.character.name} loses ${event.buff.name}`;
    case 'character:destroyed':
      return `  💀 ${emojiOf(event.character.name)} ${event.character.name} is defeated!`;
    case 'character:survived': {
      const hp = event.character.gauge('hp').current;
      const max = event.character.gauge('hp').max;
      if (max > 0 && hp > 0 && hp <= max * 0.2) {
        return `  😰 ${emojiOf(event.character.name)} ${event.character.name} survives at ${hp}/${max}`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/* ------------------------------- reporting ------------------------------- */

/** A stable fingerprint of a battle's event stream, for replay checks. */
export function digestOf(result: MatchResult): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        result.rounds,
        result.winners,
        result.final.map((p) =>
          p.characters.map((c) => `${c.name}:${c.hp}:${c.alive}`).join('|'),
        ),
        result.stats.eventCounts,
      ]),
    )
    .update(result.stats.llm.failures === 0 ? '' : 'llm')
    .digest('hex');
}

/** Renders the final standing table for one match. */
export function renderFinal(result: MatchResult): string[] {
  const lines: string[] = [];
  for (const team of result.final) {
    lines.push(`  ${team.player} (${team.team})`);
    for (const character of team.characters) {
      // HP is the life gauge — the standings show it, not mana.
      const state = character.alive ? `${character.hp}/${character.maxHp}` : 'defeated';
      const buffs = character.buffs.length > 0 ? ` [${character.buffs.join(', ')}]` : '';
      lines.push(`    ${emojiOf(character.name)} ${character.name} — ${state}${buffs}`);
    }
  }
  return lines;
}

/* --------------------------------- CLI ---------------------------------- */

interface CliOptions {
  matches: number;
  scenario: keyof typeof SCENARIOS | 'all';
  brainA: BrainKind;
  brainB: BrainKind;
  maxRounds: number;
  seed?: number;
  model?: string;
  quiet: boolean;
  verbose: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    matches: 1,
    scenario: 'classic',
    brainA: 'random',
    brainB: 'random',
    maxRounds: 100,
    quiet: false,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string | undefined => argv[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--matches':
        options.matches = Number(value() ?? '1');
        i += 1;
        break;
      case '--scenario':
        options.scenario = (value() ?? 'classic') as CliOptions['scenario'];
        i += 1;
        break;
      case '--brain1':
        options.brainA = (value() ?? 'random') as BrainKind;
        i += 1;
        break;
      case '--brain2':
        options.brainB = (value() ?? 'random') as BrainKind;
        i += 1;
        break;
      case '--max-rounds':
        options.maxRounds = Number(value() ?? '100');
        i += 1;
        break;
      case '--seed':
        options.seed = Number(value());
        i += 1;
        break;
      case '--model':
        options.model = value();
        i += 1;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.scenario !== 'all' && !(options.scenario in SCENARIOS)) {
    throw new Error(`Unknown scenario: ${options.scenario} (use classic, thorn or all)`);
  }
  for (const brain of [options.brainA, options.brainB]) {
    if (brain !== 'random' && brain !== 'seeded' && brain !== 'llm') {
      throw new Error(`Unknown brain: ${brain} (use random, seeded or llm)`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`ai-vs-ai — run two AI players against each other in a realistic battle.

Usage: node --import tsx --import ./src/games/turn-based/svg-loader.mjs test/ai-vs-ai.ts [options]

Options:
  --matches <n>      battles to run per scenario (default 1)
  --scenario <s>     classic | thorn | all   (default classic)
  --brain1 <kind>    random | seeded | llm   (default random)
  --brain2 <kind>    same choices            (default random)
  --max-rounds <n>   round cap per battle    (default 100)
  --seed <n>         deterministic seed; 'random' brains auto-upgrade to 'seeded'
  --model <id>       LLM model id           (default deepseek-chat)
  --quiet, -q        no per-event battle log, results only
  --verbose          full battle log even with --matches > 1
  --help, -h         this help

Brains:
  random   the engine's RandomAI (uses Math.random)
  seeded   deterministic random AI — pair with --seed for replays
  llm      DeepSeek chat-completions LLM; falls back to random on any error

The LLM key is read from $DEEPSEEK_API_KEY or $DSH_HOME/.credentials.yaml.
LLM mode makes one API call per player per round — keep --max-rounds modest.`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const scenarios =
    options.scenario === 'all' ? Object.values(SCENARIOS) : [SCENARIOS[options.scenario]];
  const out = (line: string): void => console.log(line);
  const needLlm = options.brainA === 'llm' || options.brainB === 'llm';
  const apiKey = needLlm ? await resolveApiKey() : undefined;
  if (needLlm && !apiKey) {
    throw new Error(
      'LLM brain requested but no API key found — set DEEPSEEK_API_KEY or store one in $DSH_HOME/.credentials.yaml',
    );
  }
  const llmOptions = needLlm
    ? { apiKey: apiKey!, ...(options.model ? { model: options.model } : {}) }
    : undefined;

  const total = options.matches * scenarios.length;
  const fullLog = !options.quiet && (options.verbose || total === 1);

  const results: MatchResult[] = [];
  for (const scenario of scenarios) {
    for (let match = 1; match <= options.matches; match += 1) {
      if (!fullLog) {
        out(`Match ${results.length + 1}/${total} — ${scenario.label} (${options.brainA} vs ${options.brainB})${options.seed !== undefined ? `, seed ${options.seed}` : ''}…`);
      }
      const result = await runMatch({
        scenario,
        brainA: options.brainA === 'random' && options.seed !== undefined ? 'seeded' : options.brainA,
        brainB: options.brainB === 'random' && options.seed !== undefined ? 'seeded' : options.brainB,
        maxRounds: options.maxRounds,
        seed: options.seed,
        llmOptions,
        verbose: fullLog,
        out,
      });
      results.push(result);
      if (fullLog) {
        for (const line of renderFinal(result)) out(line);
        out('');
      } else {
        const [teamA, teamB] = result.teams;
        const verdict =
          result.winners.length > 0
            ? `${result.winners[0] === teamA ? teamA : teamB} win`
            : result.endReason === 'round-cap'
              ? 'draw (round cap)'
              : 'draw (mutual destruction)';
        out(`  ${verdict} in ${result.rounds} rounds — ${result.stats.eventCounts['gauge:changed'] ?? 0} gauge events, ${result.stats.llm.calls} LLM calls`);
      }
    }
  }

  if (results.length > 1) printAggregate(results, out);
}

function printAggregate(results: readonly MatchResult[], out: (line: string) => void): void {
  out('');
  out('=== Aggregate ===');
  const byScenario = new Map<string, MatchResult[]>();
  for (const result of results) {
    const list = byScenario.get(result.scenarioId) ?? [];
    list.push(result);
    byScenario.set(result.scenarioId, list);
  }
  for (const [id, list] of byScenario) {
    const [teamA, teamB] = list[0]!.teams;
    const winsA = list.filter((r) => r.winners.includes(teamA)).length;
    const winsB = list.filter((r) => r.winners.includes(teamB)).length;
    const draws = list.length - winsA - winsB;
    const rounds = list.map((r) => r.rounds);
    const avgRounds = Math.round(rounds.reduce((a, b) => a + b, 0) / rounds.length);
    out(`  ${id}: ${winsA}× ${teamA} · ${winsB}× ${teamB} · ${draws}× draw — avg ${avgRounds} rounds`);
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
