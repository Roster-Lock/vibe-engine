/**
 * Rendering a `Term` as markdown, for surfaces that show markdown rather than
 * React: the Monaco hovers, and anything that has to put a definition into a
 * string.
 *
 * The React panel (`TermPanel`) draws its own layout from the same fields, so
 * the two are deliberately parallel rather than shared — a hover that wanted
 * `DefinitionBody` would have to drag the DOM into the editor's language
 * service, and a panel that wanted this string would lose its facts grid.
 */
import type { Term } from '../../english/index.js';

/** A term as a markdown hover: summary, facts, then the details. */
export function describeTerm(term: Term): string {
  const parts: string[] = [`**${term.ref.name}**`];
  const facts = (term.facts ?? []).map((fact) => `${fact.label} ${fact.value}`);
  if (facts.length > 0) parts.push(`_${facts.join(' · ')}_`);
  const details = term.details?.trim();
  if (details && details !== term.summary.trim()) parts.push(details);
  else parts.push(term.summary);
  return parts.join('\n\n');
}
