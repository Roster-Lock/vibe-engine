/**
 * A **contest**, written the way a rulebook states it:
 *
 * ```
 * Contest Rock Paper Scissors
 * The player count must be 2.
 * Players commit an option from "Rock", "Paper" and "Scissors".
 * If both players choose the same option, it is a tie.
 * If player 1 chooses Rock and player 2 chooses Scissors, player 1 wins and player 2 loses.
 * If player 1 chooses Scissors and player 2 chooses Paper, player 1 wins and player 2 loses.
 * If player 1 chooses Paper and player 2 chooses Rock, player 1 wins and player 2 loses.
 * Otherwise player 2 wins and player 1 loses.
 * ```
 *
 * A contest is played by a **list of players** (`You and target opponent play Rock Paper
 * Scissors.`); "player 1" is the first of the list. The rules are read in order and the first
 * one that fits decides who wins and who loses.
 */
import type { ContestIR, ContestRuleIR } from '../ir/index.js';

export interface ContestLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface ContestProblem {
  readonly message: string;
  readonly code: string;
  readonly start: number;
  readonly end: number;
}

/** `"Rock"`, `Rock`, `"Hold fire"` — an option's name as written. */
function names(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/"([^"]+)"|([A-Za-z][\w'-]*)/g)) {
    const word = match[1] ?? match[2]!;
    if (match[2] !== undefined && ['and', 'or'].includes(match[2].toLowerCase())) continue;
    found.push(word);
  }
  return found;
}

function unquote(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

/** `player 1 wins and player 2 loses` → winners [1], losers [2]. */
function outcome(text: string): { winners: number[]; losers: number[] } | undefined {
  const winners: number[] = [];
  const losers: number[] = [];
  for (const part of text.split(/\s+and\s+/i)) {
    const match = /^player\s+(\d+)\s+(wins|loses)$/i.exec(part.trim());
    if (!match) return undefined;
    (match[2]!.toLowerCase() === 'wins' ? winners : losers).push(Number(match[1]));
  }
  return { winners, losers };
}

export function parseContest(name: string, lines: readonly ContestLine[]): { contest?: ContestIR; problems: ContestProblem[] } {
  const problems: ContestProblem[] = [];
  const bad = (line: ContestLine, message: string, code = 'contest-rule'): void => {
    problems.push({ message, code, start: line.start, end: line.end });
  };
  let playerCount: number | undefined;
  let options: string[] | undefined;
  const rules: ContestRuleIR[] = [];
  const ruleLines: ContestLine[] = [];

  for (const line of lines) {
    const text = line.text.trim().replace(/\.$/, '');
    let match: RegExpExecArray | null;
    if ((match = /^the player count must be (\d+)$/i.exec(text))) {
      playerCount = Number(match[1]);
      continue;
    }
    if ((match = /^players? (?:commit|choose|commit\/reveal)(?:\s+an?)?\s+(?:option|item)s? from (.+)$/i.exec(text))) {
      options = names(match[1]!);
      continue;
    }
    if (/^if (?:both|all) players choose the same (?:option|item),?\s+(?:it is a tie|return a tie|the result is a tie)$/i.test(text)) {
      rules.push({ kind: 'tie' });
      ruleLines.push(line);
      continue;
    }
    if ((match = /^otherwise,?\s+(.+)$/i.exec(text))) {
      const result = outcome(match[1]!);
      if (!result) {
        bad(line, `"${match[1]}" is not a result — write "player 2 wins and player 1 loses"`);
        continue;
      }
      rules.push({ kind: 'otherwise', ...result });
      ruleLines.push(line);
      continue;
    }
    if ((match = /^if (.+?),\s+(player\s+\d+\s+(?:wins|loses).*)$/i.exec(text))) {
      const picks: { player: number; option: string }[] = [];
      let ok = true;
      for (const part of match[1]!.split(/\s+and\s+(?=player\s)/i)) {
        const pick = /^player\s+(\d+)\s+chooses\s+(.+)$/i.exec(part.trim());
        if (!pick) {
          ok = false;
          break;
        }
        picks.push({ player: Number(pick[1]), option: unquote(pick[2]!) });
      }
      const result = outcome(match[2]!);
      if (!ok || !result) {
        bad(line, `"${text}" is not a rule — write "If player 1 chooses Rock and player 2 chooses Scissors, player 1 wins and player 2 loses."`);
        continue;
      }
      rules.push({ kind: 'when', picks, ...result });
      ruleLines.push(line);
      continue;
    }
    bad(line, `"${text}" is not a line of a contest — it states the player count, what players commit, and the rules ("If … , player 1 wins and player 2 loses.")`);
  }

  const first = lines[0];
  const at = first ?? { start: 0, end: 0, text: '' };
  if (!options || options.length < 2) {
    problems.push({
      message: `"${name}" needs what players commit — write 'Players commit an option from "Rock", "Paper" and "Scissors".'`,
      code: 'contest-options',
      start: at.start,
      end: at.end,
    });
  }
  if (options) {
    rules.forEach((rule, index) => {
      if (rule.kind !== 'when') return;
      for (const pick of rule.picks) {
        if (!options!.includes(pick.option)) {
          bad(ruleLines[index]!, `"${pick.option}" is not one of the options (${options!.join(', ')}) — options are matched exactly, capitals included`);
        }
      }
    });
  }
  if (playerCount !== undefined) {
    rules.forEach((rule, index) => {
      const used = rule.kind === 'tie' ? [] : [...rule.winners, ...rule.losers, ...(rule.kind === 'when' ? rule.picks.map((p) => p.player) : [])];
      for (const player of used) {
        if (player < 1 || player > playerCount!) bad(ruleLines[index]!, `there is no player ${player} — the player count must be ${playerCount}`);
      }
    });
  }
  if (problems.length > 0 || !options) return { problems };
  return {
    contest: { name, ...(playerCount !== undefined ? { playerCount } : {}), options, rules },
    problems,
  };
}
