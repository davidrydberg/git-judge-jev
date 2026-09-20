import picomatch from "picomatch";

/** "unchecked" is a path the maintainer named in the policy as never to be sent anywhere. The policy is read from the base, so a PR cannot add one. */
export type PreClass = "lockfile" | "generated" | "vendored" | "unchecked";

export type FileStatus = "added" | "deleted" | "renamed" | "modified";

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  preClass: PreClass | null;
}

export interface Anchor {
  line: number;
  side: "LEFT" | "RIGHT";
}

export interface Hunk {
  id: string;
  path: string;
  language: string | null;
  isTest: boolean;
  /** Line range on the new side of the diff. A pure deletion has endLine < startLine. */
  startLine: number;
  endLine: number;
  added: number;
  deleted: number;
  size: number;
  preClass: PreClass | null;
  /** First changed line, where the report links to. */
  anchor: Anchor;
  /** Hunk header plus body, exactly as it appeared in the diff. */
  content: string;
}

export interface ParsedDiff {
  files: ChangedFile[];
  hunks: Hunk[];
}

export interface DiffOptions {
  /** Extra globs from the policy file, on top of the built-in path rules. */
  generated?: string[];
  vendored?: string[];
  unchecked?: string[];
}

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "Podfile.lock",
  "pubspec.lock",
  "mix.lock",
  "flake.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "Package.resolved",
]);

const VENDORED = /(^|\/)(vendor|node_modules|third_party|third-party|bower_components)\//;

const GENERATED = [
  /(^|\/)dist\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.pb\.go$/,
  /_pb2(_grpc)?\.py$/,
  /\.g\.dart$/,
  /\.generated\.[^./]+$/,
  /\.designer\.cs$/i,
  // Test snapshots. They quote the code they render, so Jev reads an auth path in one as auth code.
  /(^|\/)__snapshots__\//,
  /\.snap$/,
];

const TEST_PATHS = [
  /(^|\/)(tests?|__tests__|specs?|e2e)\//,
  /\.(test|spec)\.[^./]+$/,
  /_test\.[^./]+$/,
  /(^|\/)test_[^/]+\.py$/,
  /Tests?\.(java|kt|cs|swift)$/,
];

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  cs: "C#",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  hpp: "C++",
  php: "PHP",
  scala: "Scala",
  ex: "Elixir",
  exs: "Elixir",
  dart: "Dart",
  sh: "Shell",
  bash: "Shell",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  vue: "Vue",
  svelte: "Svelte",
  json: "JSON",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  md: "Markdown",
  tf: "Terraform",
  proto: "Protocol Buffers",
};

const PROSE = /(\.(md|mdx|txt|rst|adoc)|(^|\/)(LICENSE|NOTICE|AUTHORS|CHANGELOG)[^/]*)$/i;

/** Documentation and other prose, by path. Questions about code have no meaning there. */
export function isProse(path: string): boolean {
  return PROSE.test(path);
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(diff: string, options: DiffOptions = {}): ParsedDiff {
  const classify = pathClassifier(options);
  const files: ChangedFile[] = [];
  const hunks: Hunk[] = [];
  const lines = diff.split("\n");

  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.startsWith("diff --git ")) {
      i++;
      continue;
    }
    const header = parseFileHeader(lines, i);
    i = header.next;
    const file: ChangedFile = {
      path: header.path,
      oldPath: header.oldPath,
      status: header.status,
      binary: header.binary,
      preClass: classify(header.path),
    };
    files.push(file);

    let ordinal = 0;
    while (i < lines.length && HUNK_HEADER.test(lines[i]!)) {
      const parsed = parseHunk(lines, i, file, ordinal++);
      hunks.push(parsed.hunk);
      i = parsed.next;
    }
  }
  return { files, hunks };
}

interface FileHeader {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  next: number;
}

function parseFileHeader(lines: string[], start: number): FileHeader {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let status: FileStatus = "modified";
  let binary = false;

  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ") || HUNK_HEADER.test(line)) break;
    if (line.startsWith("new file mode")) status = "added";
    else if (line.startsWith("deleted file mode")) status = "deleted";
    else if (line.startsWith("rename from ")) {
      status = "renamed";
      oldPath = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) newPath = unquote(line.slice("rename to ".length));
    else if (line.startsWith("--- ")) oldPath = stripPrefix(line.slice(4)) ?? oldPath;
    else if (line.startsWith("+++ ")) newPath = stripPrefix(line.slice(4)) ?? newPath;
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
  }

  // Binary and mode-only changes carry no ---/+++ lines, so fall back to the header.
  const fallback = pathFromGitHeader(lines[start]!);
  const path = newPath ?? oldPath ?? fallback;
  return {
    path,
    oldPath: status === "renamed" ? oldPath : null,
    status,
    binary,
    next: i,
  };
}

/** "--- a/src/x.ts" gives "src/x.ts". "/dev/null" gives null. */
function stripPrefix(raw: string): string | null {
  const path = unquote(raw.split("\t")[0]!);
  if (path === "/dev/null") return null;
  return path.replace(/^[ab]\//, "");
}

/** For a non-rename the header is "diff --git a/P b/P", so P is recoverable even when it contains spaces. */
function pathFromGitHeader(line: string): string {
  const rest = line.slice("diff --git ".length);
  const length = (rest.length - 5) / 2;
  if (Number.isInteger(length) && rest.slice(2, 2 + length) === rest.slice(5 + length)) {
    return unquote(rest.slice(2, 2 + length));
  }
  return unquote(rest.slice(rest.lastIndexOf(" b/") + 3));
}

/** Git quotes paths holding special characters. Escapes inside the quotes are left as they are. */
function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function parseHunk(
  lines: string[],
  start: number,
  file: ChangedFile,
  ordinal: number,
): { hunk: Hunk; next: number } {
  const match = HUNK_HEADER.exec(lines[start]!)!;
  const oldStart = Number(match[1]);
  const newStart = Number(match[3]);
  // The header counts decide where the hunk ends. A removed line reading "-- x" shows up
  // as "--- x", which prefix matching would mistake for a file header.
  let oldRemaining = Number(match[2] ?? 1);
  let newRemaining = Number(match[4] ?? 1);
  const newCount = newRemaining;

  let oldLine = oldStart;
  let newLine = newStart;
  let added = 0;
  let deleted = 0;
  let anchor: Anchor | null = null;

  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("\\")) continue;
    if (oldRemaining === 0 && newRemaining === 0) break;
    if (line.startsWith("+")) {
      anchor ??= { line: newLine, side: "RIGHT" };
      added++;
      newLine++;
      newRemaining--;
    } else if (line.startsWith("-")) {
      anchor ??= { line: oldLine, side: "LEFT" };
      deleted++;
      oldLine++;
      oldRemaining--;
    } else {
      oldLine++;
      newLine++;
      oldRemaining--;
      newRemaining--;
    }
  }

  const hunk: Hunk = {
    id: `${file.path}#${ordinal}`,
    path: file.path,
    language: languageOf(file.path),
    isTest: TEST_PATHS.some((pattern) => pattern.test(file.path)),
    startLine: newStart,
    endLine: newStart + newCount - 1,
    added,
    deleted,
    size: added + deleted,
    preClass: file.preClass,
    anchor: anchor ?? { line: newStart, side: "RIGHT" },
    content: lines.slice(start, i).join("\n"),
  };
  return { hunk, next: i };
}

function languageOf(path: string): string | null {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return null;
  return LANGUAGES[basename.slice(dot + 1).toLowerCase()] ?? null;
}

// Classification looks at the path only, never at the content. A "@generated" marker inside
// a hunk is written by the PR author, and honouring it would let a PR opt itself out of judging.
function pathClassifier(options: DiffOptions): (path: string) => PreClass | null {
  const extraGenerated = picomatch(options.generated ?? [], { dot: true });
  const extraVendored = picomatch(options.vendored ?? [], { dot: true });
  const unchecked = picomatch(options.unchecked ?? [], { dot: true });
  return (path) => {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (LOCKFILES.has(basename)) return "lockfile";
    if (unchecked(path)) return "unchecked";
    if (VENDORED.test(path) || extraVendored(path)) return "vendored";
    if (GENERATED.some((pattern) => pattern.test(path)) || extraGenerated(path)) return "generated";
    return null;
  };
}
