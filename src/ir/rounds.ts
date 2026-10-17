/**
 * Checks that an ability's choice rounds could be played at a table
 * (docs/design/20-secret-choices-and-dice.md).
 *
 * A sealed round has a fixed shape — *commit face down, then reveal, then use
 * what was chosen* — and a card that breaks it is not a card a group could
 * resolve with no software: answers that never open, a reveal of nothing, a
 * choice read before it is public. These are checked on the **IR**, not in the
 * English parser, so a document that arrives as JSON is held to the same rules.
 *
 * Every message says what to write instead.
 */
import type { StepIR } from './ability.js';

export interface RoundIssue {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** The index in `steps` of the step the problem is about, so a caller can point at it. */
  readonly step: number;
}

interface RoundSeen {
  readonly secret: boolean;
  readonly step: number;
  revealed: boolean;
}

/** The problems in `steps`, in the order the effects appear. Empty when sound. */
export function validateRounds(steps: readonly StepIR[]): RoundIssue[] {
  const issues: RoundIssue[] = [];
  const rounds = new Map<string, RoundSeen>();
  for (const [stepIndex, step] of steps.entries()) {
    for (const effect of step.effects) {
      switch (effect.kind) {
        case 'choose':
          rounds.set(effect.round, { secret: effect.secret, step: stepIndex, revealed: !effect.secret });
          if (effect.secret && effect.players === 'you') {
            issues.push({
              severity: 'warning',
              message: `"${effect.round}" is committed face down by only one player, so there is no one to hide it from. Use "chooses", or ask more than one player.`,
              step: stepIndex,
            });
          }
          break;
        case 'reveal': {
          const seen = rounds.get(effect.round);
          if (!seen) {
            issues.push({
              severity: 'error',
              message: `"reveal" names "${effect.round}", but nothing has been chosen under that name. Put the choice before the reveal.`,
              step: stepIndex,
            });
          } else if (!seen.secret) {
            issues.push({
              severity: 'error',
              message: `"${effect.round}" was chosen in the open, so there is nothing to reveal. Use "commits … face down" for a sealed choice, or remove the reveal.`,
              step: stepIndex,
            });
          } else if (seen.revealed) {
            issues.push({
              severity: 'error',
              message: `"${effect.round}" is revealed twice. Remove the second reveal.`,
              step: stepIndex,
            });
          } else {
            seen.revealed = true;
          }
          break;
        }
        case 'moveChosen': {
          const seen = rounds.get(effect.round);
          if (!seen) {
            issues.push({
              severity: 'error',
              message: `"${effect.round}" is used before anything is chosen under that name. Put the choice first.`,
              step: stepIndex,
            });
          } else if (!seen.revealed) {
            issues.push({
              severity: 'error',
              message: `"${effect.round}" is used before it is revealed. Add "When they are ready, reveal." before using what they chose.`,
              step: stepIndex,
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }
  for (const [name, seen] of rounds) {
    if (seen.secret && !seen.revealed) {
      issues.push({
        severity: 'error',
        message: `"${name}" is committed face down but never revealed. Add "When they are ready, reveal." after it.`,
        step: seen.step,
      });
    }
  }
  return issues;
}
