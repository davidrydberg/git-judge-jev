import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseDiff, type Hunk, type ParsedDiff } from "../src/diff.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.diff`, import.meta.url), "utf8");
}

function hunkOf(parsed: ParsedDiff, path: string): Hunk {
  const hunk = parsed.hunks.find((candidate) => candidate.path === path);
  if (!hunk) throw new Error(`no hunk for ${path}`);
  return hunk;
}

describe("lockfile bump", () => {
  const parsed = parseDiff(fixture("lockfile-bump"));

  test("the only hunk is pre-classified as a lockfile", () => {
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]).toMatchObject({
      path: "package-lock.json",
      preClass: "lockfile",
      added: 1,
      deleted: 1,
    });
  });
});

describe("rename-only PR", () => {
  const parsed = parseDiff(fixture("rename-only"));

  test("the file is reported as renamed and there is nothing to judge", () => {
    expect(parsed.files).toEqual([
      {
        path: "src/new_name.ts",
        oldPath: "src/old_name.ts",
        status: "renamed",
        binary: false,
        preClass: null,
      },
    ]);
    expect(parsed.hunks).toEqual([]);
  });
});

describe("mixed PR", () => {
  const parsed = parseDiff(fixture("mixed"));

  test("every file is listed with its status", () => {
    expect(parsed.files.map((file) => [file.path, file.status])).toEqual([
      ["assets/logo.png", "modified"],
      ["docs/my notes/plan.md", "modified"],
      ["schema.sql", "added"],
      ["src/auth/session.ts", "modified"],
      ["src/billing/invoice.ts", "modified"],
      ["src/legacy.txt", "modified"],
      ["src/new_name.ts", "deleted"],
      ["test/invoice.test.ts", "modified"],
      ["vendor/lib/index.js", "modified"],
    ]);
  });

  test("a binary file is flagged and yields no hunk", () => {
    expect(parsed.files[0]).toMatchObject({ path: "assets/logo.png", binary: true });
    expect(parsed.hunks.some((hunk) => hunk.path === "assets/logo.png")).toBe(false);
  });

  test("hunk boundaries, counts, and line range", () => {
    expect(hunkOf(parsed, "src/auth/session.ts")).toMatchObject({
      id: "src/auth/session.ts#0",
      language: "TypeScript",
      startLine: 1,
      endLine: 13,
      added: 2,
      deleted: 5,
      size: 7,
    });
  });

  test("a removed line that looks like a file header stays inside its hunk", () => {
    const hunk = hunkOf(parsed, "src/billing/invoice.ts");
    expect(hunk.deleted).toBe(1);
    expect(hunk.content).toContain("--- not code");
    expect(parsed.hunks).toHaveLength(8);
  });

  test("no-newline markers are kept in the content and not counted as lines", () => {
    const hunk = hunkOf(parsed, "src/legacy.txt");
    expect(hunk).toMatchObject({ added: 1, deleted: 1, language: null });
    expect(hunk.content.match(/No newline/g)).toHaveLength(2);
  });

  test("the anchor is the first changed line", () => {
    expect(hunkOf(parsed, "src/auth/session.ts").anchor).toEqual({ line: 1, side: "LEFT" });
    expect(hunkOf(parsed, "docs/my notes/plan.md").anchor).toEqual({ line: 2, side: "RIGHT" });
    expect(hunkOf(parsed, "src/new_name.ts").anchor).toEqual({ line: 1, side: "LEFT" });
  });

  test("test files are detected", () => {
    expect(hunkOf(parsed, "test/invoice.test.ts").isTest).toBe(true);
    expect(hunkOf(parsed, "src/auth/session.ts").isTest).toBe(false);
  });

  test("vendored paths are pre-classified", () => {
    expect(hunkOf(parsed, "vendor/lib/index.js").preClass).toBe("vendored");
    expect(hunkOf(parsed, "src/auth/session.ts").preClass).toBeNull();
  });

  test("policy globs extend the built-in classification", () => {
    const withGlobs = parseDiff(fixture("mixed"), { generated: ["**/*.sql"], vendored: ["docs/**"] });
    expect(hunkOf(withGlobs, "schema.sql").preClass).toBe("generated");
    expect(hunkOf(withGlobs, "docs/my notes/plan.md").preClass).toBe("vendored");
  });

  test("a path the policy lists as unchecked wins over the built-in guess, a lockfile stays a lockfile", () => {
    const parsed = parseDiff(fixture("mixed"), { unchecked: ["vendor/**", "**/*.lock"] });
    expect(hunkOf(parsed, "vendor/lib/index.js").preClass).toBe("unchecked");
    expect(parseDiff(fixture("lockfile-bump"), { unchecked: ["**"] }).hunks.every((hunk) => hunk.preClass === "lockfile")).toBe(true);
  });
});

describe("test snapshots", () => {
  test("are generated, whatever code they quote", () => {
    const diff = (path: string) =>
      [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1,2 @@", "+exports[`auth 1`] = `src/auth/session.ts`;", " // Vitest Snapshot", ""].join("\n");
    expect(parseDiff(diff("test/__snapshots__/report.test.ts.snap")).hunks[0]!.preClass).toBe("generated");
    expect(parseDiff(diff("src/ui/Button.snap")).hunks[0]!.preClass).toBe("generated");
    expect(parseDiff(diff("src/snapshot.ts")).hunks[0]!.preClass).toBeNull();
  });
});

describe("classification ignores hunk content", () => {
  test("a @generated marker added by the PR does not opt the hunk out", () => {
    const diff = [
      "diff --git a/src/pay.ts b/src/pay.ts",
      "index 1111111..2222222 100644",
      "--- a/src/pay.ts",
      "+++ b/src/pay.ts",
      "@@ -1 +1,2 @@",
      "+// @generated DO NOT EDIT",
      " export const fee = 0;",
      "",
    ].join("\n");
    expect(parseDiff(diff).hunks[0]!.preClass).toBeNull();
  });
});
