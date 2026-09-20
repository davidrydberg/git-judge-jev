import type { Hunk } from "./diff.js";

// What the writer reads beside a flagged hunk. A hunk carries three lines of context, which cannot
// show whether a check that was removed here still stands a few lines up, or was moved to another
// file of the same PR. Pure: the file content is fetched by the caller.

export interface HunkContext {
  /** The block of the file, as it is after the change, that holds the hunk. Null when the file could not be read. */
  enclosing: { startLine: number; text: string } | null;
  /** Other hunks of the PR that change the same identifiers, most shared first. A hunk the code moved to or from comes before those. */
  related: Hunk[];
  /**
   * What code found by searching the whole diff and the file: where a name added here was removed,
   * where a name removed here was added, whether a removed name is still in the file. The writer
   * cannot see these from a hunk, and without them it reads moved code as new behaviour.
   */
  facts: string[];
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

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{3,}/g;

/** Identifiers on the added and on the removed lines of a hunk. */
function sides(hunk: Hunk): { added: Set<string>; removed: Set<string> } {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const line of hunk.content.split("\n")) {
    if (!/^[+-]/.test(line)) continue;
    for (const word of line.match(IDENTIFIER) ?? []) {
      if (!KEYWORDS.has(word.toLowerCase())) (line[0] === "+" ? added : removed).add(word);
    }
  }
  return { added, removed };
}

function changedIdentifiers(hunk: Hunk): Set<string> {
  const { added, removed } = sides(hunk);
  return new Set([...added, ...removed]);
}

const only = (from: Set<string>, not: Set<string>) => [...from].filter((word) => !not.has(word));

const MAX_MOVE_FACTS = 4;
const MAX_NAMES_PER_FACT = 5;
const MIN_LONE_NAME = 8;
const MAX_PRESENCE_FACTS = 4;

/**
 * Where the code of `scope` came from or went to. A name that is only added in the scope and only removed
 * in another hunk was moved here, and the other way round. `scope` is the flagged hunk and the hunks of
 * its file inside the enclosing block, since that block is what the writer reads and reasons about.
 * No cap on how many hunks share the name: a move is the one case where a common name still ties two hunks.
 */
export function moves(scope: Hunk[], hunks: Hunk[]): { facts: string[]; hunks: Hunk[] } {
  const inScope = new Set(scope.map((hunk) => hunk.id));
  const here = scope.map(sides);
  const addedHere = new Set(here.flatMap((side) => only(side.added, side.removed)));
  const removedHere = new Set(here.flatMap((side) => only(side.removed, side.added)));
  // A name both added and removed within the scope was edited in place, not moved.
  for (const word of [...addedHere]) if (removedHere.delete(word)) addedHere.delete(word);

  // One shared name is weak evidence when the name is `path` or `hunk`. A move shows as several names
  // going the same way between the same two places, or as one name long enough to be specific.
  const found: { other: Hunk; names: string[]; fact: string }[] = [];
  const consider = (other: Hunk, names: string[], verbs: string) => {
    names.sort((a, b) => b.length - a.length);
    if (names.length < 2 && (names[0]?.length ?? 0) < MIN_LONE_NAME) return;
    const at = `${other.path} ${other.endLine < other.startLine ? `near L${other.startLine}` : `L${other.startLine}-${other.endLine}`}`;
    const listed = names.slice(0, MAX_NAMES_PER_FACT).map((name) => `\`${name}\``).join(", ");
    found.push({ other, names, fact: `${listed} ${names.length === 1 ? "is" : "are"} ${verbs} ${at}.` });
  };
  for (const other of hunks) {
    if (inScope.has(other.id) || other.preClass !== null) continue;
    const there = sides(other);
    consider(other, only(there.removed, there.added).filter((word) => addedHere.has(word)), "added here and removed in");
    consider(other, only(there.added, there.removed).filter((word) => removedHere.has(word)), "removed here and added in");
  }
  const kept = found.sort((a, b) => b.names.length - a.names.length).slice(0, MAX_MOVE_FACTS);
  return { facts: kept.map((entry) => entry.fact), hunks: [...new Set(kept.map((entry) => entry.other))] };
}

/** Whether the names a hunk removes are still in its file after the change. Null content gives no facts. */
export function stillPresent(hunk: Hunk, content: string | null): string[] {
  if (content === null) return [];
  const { added, removed } = sides(hunk);
  return only(removed, added)
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_PRESENCE_FACTS)
    .map((word) => {
      const lines = content.split("\n").filter((line) => new RegExp(`\\b${word}\\b`).test(line)).length;
      return lines === 0
        ? `\`${word}\` no longer appears anywhere in ${hunk.path} after the change.`
        : `\`${word}\` still appears on ${lines} ${lines === 1 ? "line" : "lines"} of ${hunk.path} after the change.`;
    });
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
