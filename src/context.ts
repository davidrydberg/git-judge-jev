import type { Hunk } from "./diff.js";

// What the writer reads beside a flagged hunk. A hunk carries three lines of context, which cannot
// show whether a check that was removed here still stands a few lines up, or was moved to another
// file of the same PR. Pure: the file content is fetched by the caller.

export interface HunkContext {
  /** The block of the file, as it is after the change, that holds the hunk. Null when the file could not be read. */
  enclosing: { startLine: number; text: string } | null;
  /** Other hunks of the PR that change the same identifiers, most shared first. */
  related: Hunk[];
}

const MAX_LINES_UP = 60;
const MAX_LINES_DOWN = 60;
const WINDOW = 15;
const MAX_ENCLOSING_LINE_CHARS = 300;
const MAX_RELATED = 3;
// An identifier changed in more hunks than this says nothing about which hunks belong together.
const MAX_HUNKS_SHARING = 5;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The enclosing block, found by indentation so it needs no parser and no list of languages: walk up
 * from the hunk to the nearest line at column 0 that opens it, and down to the line that closes it.
 * Lines are 1-based. A pure deletion has endLine < startLine and is treated as the line it sat at.
 */
export function enclosingBlock(content: string, startLine: number, endLine: number): HunkContext["enclosing"] {
  const lines = content.split("\n");
  if (lines.length === 0 || startLine > lines.length) return null;
  const first = Math.max(1, startLine);
  const last = Math.min(lines.length, Math.max(endLine, first));

  const inHunk = lines.slice(first - 1, last).filter((line) => line.trim() !== "");
  const indent = inHunk.length > 0 ? Math.min(...inHunk.map(indentOf)) : 0;

  let top = first;
  let bottom = last;
  if (indent === 0) {
    // Top-level code has no block around it. A window is the best there is.
    top = Math.max(1, first - WINDOW);
    bottom = Math.min(lines.length, last + WINDOW);
  } else {
    let opener = indent;
    while (top > 1 && first - top < MAX_LINES_UP && opener > 0) {
      top--;
      const line = lines[top - 1]!;
      if (line.trim() !== "" && indentOf(line) < opener) opener = indentOf(line);
    }
    while (bottom < lines.length && bottom - last < MAX_LINES_DOWN) {
      bottom++;
      const line = lines[bottom - 1]!;
      if (line.trim() !== "" && indentOf(line) <= opener) break;
    }
  }
  const text = lines
    .slice(top - 1, bottom)
    .map((line) => line.slice(0, MAX_ENCLOSING_LINE_CHARS))
    .join("\n");
  return { startLine: top, text };
}

const KEYWORDS = new Set(
  "abstract async await boolean break case catch class const continue default delete else enum export extends false final finally float from function import instanceof interface internal let long new null number object package private protected public readonly return self static string struct super switch this throw throws true type typeof undefined unknown void while with yield".split(
    " ",
  ),
);

function changedIdentifiers(hunk: Hunk): Set<string> {
  const found = new Set<string>();
  for (const line of hunk.content.split("\n")) {
    if (!/^[+-]/.test(line)) continue;
    for (const word of line.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []) {
      if (!KEYWORDS.has(word.toLowerCase())) found.add(word);
    }
  }
  return found;
}

/** The hunks that most share changed identifiers with `hunk`. A rare identifier counts, a common one does not. */
export function relatedHunks(hunk: Hunk, hunks: Hunk[]): Hunk[] {
  const own = changedIdentifiers(hunk);
  if (own.size === 0) return [];
  const others = hunks
    .filter((other) => other.id !== hunk.id && other.preClass === null)
    .map((other) => ({ other, identifiers: changedIdentifiers(other) }));

  const sharedBy = new Map<string, number>();
  for (const { identifiers } of others) {
    for (const word of identifiers) if (own.has(word)) sharedBy.set(word, (sharedBy.get(word) ?? 0) + 1);
  }
  return others
    .map(({ other, identifiers }) => ({
      other,
      shared: [...identifiers].filter((word) => (sharedBy.get(word) ?? Infinity) <= MAX_HUNKS_SHARING).length,
    }))
    .filter((entry) => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, MAX_RELATED)
    .map((entry) => entry.other);
}
