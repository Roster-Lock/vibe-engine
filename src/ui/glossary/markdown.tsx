/**
 * A deliberately tiny markdown renderer for term details.
 *
 * Definitions are written in the same small subset the editor's hovers already
 * use — bold, code, italics, blockquote, and bullet lists — so this renders
 * **that** subset and nothing more. It is not a markdown library and should not
 * grow into one: adding a dependency for `**bold**` would be the tail wagging
 * the dog, and a definition has no business containing tables or raw HTML.
 *
 * ## Why text is rendered through a hook
 *
 * Every span of text this produces goes through `renderText`, so the *caller*
 * decides what a word becomes. The panel passes a renderer that makes known
 * terms selectable — which is what lets a definition be walked into a
 * definition. Keeping that out of here is what stops the markdown layer from
 * needing to know the glossary exists.
 */
import { Fragment, type ReactNode } from 'react';

/** Turns one run of plain text into nodes, so terms inside it are selectable. */
export type TextRenderer = (text: string, key: string) => ReactNode;

const asText = (text: string, key: string): ReactNode => <Fragment key={key}>{text}</Fragment>;

/** One line of a definition, shaped into the little it is allowed to be. */
type Block =
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'list'; readonly items: string[] }
  | { readonly kind: 'paragraph'; readonly text: string };

function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) continue;
    if (line.startsWith('> ')) {
      out.push({ kind: 'quote', text: line.slice(2) });
    } else if (line.startsWith('## ')) {
      out.push({ kind: 'heading', text: line.slice(3) });
    } else if (line.startsWith('- ')) {
      const last = out.at(-1);
      if (last?.kind === 'list') last.items.push(line.slice(2));
      else out.push({ kind: 'list', items: [line.slice(2)] });
    } else {
      out.push({ kind: 'paragraph', text: line });
    }
  }
  return out;
}

/** The inline spans: `**bold**`, `` `code` ``, `_italic_`. */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g;

function inline(text: string, keyPrefix: string, renderText: TextRenderer): ReactNode[] {
  const parts = text.split(INLINE).filter((part) => part.length > 0);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith('_') && part.endsWith('_')) return <em key={key}>{part.slice(1, -1)}</em>;
    return renderText(part, key);
  });
}

export function DefinitionBody({
  markdown,
  renderText = asText,
}: {
  markdown: string;
  /** Turns plain text into nodes; defaults to leaving it plain. */
  renderText?: TextRenderer;
}) {
  return (
    <div className="term-body">
      {blocks(markdown).map((block, index) => {
        const key = `block-${index}`;
        switch (block.kind) {
          case 'quote':
            return <blockquote key={key}>{inline(block.text, key, renderText)}</blockquote>;
          case 'heading':
            return <h4 key={key}>{inline(block.text, key, renderText)}</h4>;
          case 'list':
            return (
              <ul key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>
                    {inline(item, `${key}-${itemIndex}`, renderText)}
                  </li>
                ))}
              </ul>
            );
          case 'paragraph':
            return <p key={key}>{inline(block.text, key, renderText)}</p>;
        }
      })}
    </div>
  );
}

/** A single line of definition text, in the markdown subset's inline styles. */
export function DefinitionLine({
  text,
  renderText = asText,
  className,
}: {
  text: string;
  renderText?: TextRenderer;
  className?: string;
}) {
  return <p className={className}>{inline(text, 'line', renderText)}</p>;
}
