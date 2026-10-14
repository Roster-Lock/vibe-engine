/**
 * The glossary's React surface.
 *
 * A page imports from here, not from the individual files:
 *
 * ```tsx
 * <GlossaryProvider options={{ buffs, zones, characters }}>
 *   <Gloss text={card.text} />
 * </GlossaryProvider>
 * ```
 */
export {
  GlossaryProvider,
  useGlossary,
  useTermPanel,
  type GlossaryProviderProps,
  type TermPanelState,
} from './GlossaryProvider.js';
export { DefinitionText, Gloss, Term, useTermTextRenderer, type GlossProps } from './Term.js';
export { TermPanel, type TermPanelProps } from './TermPanel.js';
export { DefinitionBody, DefinitionLine, type TextRenderer } from './markdown.js';
