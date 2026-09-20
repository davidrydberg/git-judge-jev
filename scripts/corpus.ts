// Turns merged pull requests of a real repo into eval cases, labelled from what happened to them.
// Usage: npm run corpus -- owner/repo [--limit 50] [--min-files 3] [--days 14]
//
// A must-read hunk is one a human left a review comment on, or one whose lines a later commit
// with "fix" or "revert" in its message changed within --days of the merge. Both are evidence that the
// hunk deserved a reader, neither is proof, so every label names where it came from and a wrong one
// is deleted by hand. Findings are not labelled here: `npm run eval -- --cases eval/corpus` prints
// each case's verdicts to be labelled.
//
// Cases go to eval/corpus/, which git ignores. They are other repos' code and must not land in this one.
// Reads GitHub through the `gh` CLI and calls no model.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDiff, type Hunk } from "../src/diff.js";

const args = process.argv.slice(2);
const repo = args.find((arg) => !arg.startsWith("--"));
if (!repo || !repo.includes("/")) throw new Error("Usage: npm run corpus -- owner/repo [--limit 50] [--min-files 3] [--days 14]");
const option = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const LIMIT = option("limit", 50);
const MIN_FILES = option("min-files", 3);
const DAYS = option("days", 14);
const MAX_FILES_CHECKED = 30;
const FIX = /\b(fix|fixes|fixed|bug|revert|hotfix|regression)\b/i;
const OUT = "eval/corpus";

const gh = (...ghArgs: string[]) => execFileSync("gh", ghArgs, { encoding: "utf8", maxBuffer: 1 << 28 });
const api = <T>(path: string): T => JSON.parse(gh("api", "--paginate", "--slurp", path)).flat() as T;

interface Pull {
  number: number;
  title: string;
  body: string;
  url: string;
  mergedAt: string;
  changedFiles: number;
}
interface ReviewComment {
  path: string;
  line: number | null;
  side: string;
  user: { type: string } | null;
}
interface Commit {
  sha: string;
  commit: { message: string };
}
interface CommitDetail {
  files?: { filename: string; patch?: string }[];
}

const pulls = (
  JSON.parse(
    gh("pr", "list", "-R", repo, "--state", "merged", "--limit", String(LIMIT * 3), "--json", "number,title,body,url,mergedAt,changedFiles"),
  ) as Pull[]
)
  .filter((pull) => pull.changedFiles >= MIN_FILES)
  .slice(0, LIMIT);

/** The hunk a line on the new side falls in, if it is one the judge would rank. */
const hunkAt = (hunks: Hunk[], path: string, line: number, slack = 0) =>
  hunks.find(
    (hunk) => hunk.path === path && hunk.preClass === null && hunk.startLine - slack <= line && line <= hunk.endLine + slack,
  );

let written = 0;
for (const pull of pulls) {
  let diff: string;
  try {
    diff = gh("pr", "diff", String(pull.number), "-R", repo);
  } catch {
    // Over GitHub's diff limit. The action ends such a PR as "did not run" too.
    continue;
  }
  const { hunks } = parseDiff(diff);
  const mustRead = new Map<string, { path: string; line: number; why: string }>();
  const label = (hunk: Hunk | undefined, why: string) => {
    // One label per hunk, named by a line inside it. The scorer needs a label to match exactly one hunk.
    if (hunk && !mustRead.has(hunk.id)) mustRead.set(hunk.id, { path: hunk.path, line: hunk.startLine, why });
  };

  for (const comment of api<ReviewComment[]>(`repos/${repo}/pulls/${pull.number}/comments`)) {
    if (comment.user?.type === "Bot" || comment.line === null || comment.side !== "RIGHT") continue;
    label(hunkAt(hunks, comment.path, comment.line), "review comment");
  }

  const until = new Date(new Date(pull.mergedAt).getTime() + DAYS * 86_400_000).toISOString();
  const paths = [...new Set(hunks.filter((hunk) => hunk.preClass === null).map((hunk) => hunk.path))].slice(0, MAX_FILES_CHECKED);
  const details = new Map<string, CommitDetail>();
  for (const path of paths) {
    const commits = api<Commit[]>(
      `repos/${repo}/commits?path=${encodeURIComponent(path)}&since=${pull.mergedAt}&until=${until}`,
    ).filter((commit) => FIX.test(commit.commit.message.split("\n")[0]!));
    for (const commit of commits) {
      let detail = details.get(commit.sha);
      if (!detail) details.set(commit.sha, (detail = JSON.parse(gh("api", `repos/${repo}/commits/${commit.sha}`)) as CommitDetail));
      const patch = detail.files?.find((file) => file.filename === path)?.patch;
      if (!patch) continue;
      // The old side of the fix is the new side of the PR, give or take the commits in between.
      for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? /gm)) {
        const start = Number(match[1]);
        const middle = start + Math.floor(Number(match[2] ?? 1) / 2);
        label(hunkAt(hunks, path, middle, 3), `changed again by ${commit.sha.slice(0, 7)}: ${commit.commit.message.split("\n")[0]}`);
      }
    }
  }

  const dir = join(OUT, `${repo.replace("/", "-")}-${pull.number}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pr.diff"), diff);
  writeFileSync(
    join(dir, "case.json"),
    `${JSON.stringify({ source: pull.url, title: pull.title, description: pull.body, mustRead: [...mustRead.values()] }, null, 2)}\n`,
  );
  written++;
  console.log(`${dir}: ${hunks.length} hunks, ${mustRead.size} must-read`);
}
console.log(`\n${written} cases in ${OUT}. Read the labels, then: npm run eval -- --cases ${OUT}`);
