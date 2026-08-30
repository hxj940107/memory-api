export type InlineMarkdownToken = {
  type: "text" | "strong" | "emphasis" | "code";
  text: string;
};

export type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string; level: number }
  | { type: "quote"; text: string }
  | { type: "unorderedList"; items: string[] }
  | { type: "orderedList"; items: string[] }
  | { type: "divider" }
  | { type: "codeBlock"; code: string; language?: string };

const INLINE_MARKDOWN_PATTERN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;

export function parseInlineMarkdown(text: string): InlineMarkdownToken[] {
  const tokens: InlineMarkdownToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_MARKDOWN_PATTERN)) {
    const index = match.index || 0;
    if (index > cursor) {
      tokens.push({ type: "text", text: text.slice(cursor, index) });
    }

    const value = match[0];
    if (value.startsWith("**")) {
      tokens.push({ type: "strong", text: value.slice(2, -2) });
    } else if (value.startsWith("`")) {
      tokens.push({ type: "code", text: value.slice(1, -1) });
    } else {
      tokens.push({ type: "emphasis", text: value.slice(1, -1) });
    }
    cursor = index + value.length;
  }

  if (cursor < text.length) {
    tokens.push({ type: "text", text: text.slice(cursor) });
  }

  return tokens.length > 0 ? tokens : [{ type: "text", text }];
}

const isBlockStart = (line: string) =>
  /^\s*(?:```|#{1,3}\s+|>|(?:---+|\*\*\*+|___+)\s*$|[-*+]\s+|\d+[.)]\s+)/.test(
    line,
  );

export const hasBlockMarkdown = (text: string) =>
  /(^|\n)\s*(?:```|#{1,3}\s+|>|(?:---+|\*\*\*+|___+)\s*$|[-*+]\s+|\d+[.)]\s+)/m.test(
    text,
  );

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: "codeBlock",
        code: codeLines.join("\n"),
        language: fence[1].trim() || undefined,
      });
      continue;
    }

    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ type: "divider" });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quote = lines[index].match(/^\s*>\s?(.*)$/);
        if (!quote) break;
        quoteLines.push(quote[1]);
        index += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(item[1].trim());
        index += 1;
      }
      blocks.push({ type: "unorderedList", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1].trim());
        index += 1;
      }
      blocks.push({ type: "orderedList", items });
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
  }

  return blocks;
}
