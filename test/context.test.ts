import { describe, expect, test } from "vitest";
import { enclosingBlock, moves, relatedHunks, stillPresent } from "../src/context.js";
import type { Hunk } from "../src/diff.js";

const FILE = [
  "import { db } from './db';", // 1
  "", // 2
  "export function searchInvoices(tenantId, query) {", // 3
  "  const filters = [];", // 4
  "  if (query.status) {", // 5
  "    filters.push(status(query.status));", // 6
  "  }", // 7
  "  return db.invoices.where(filters);", // 8
  "}", // 9
  "", // 10
  "export function other() {", // 11
  "  return 1;", // 12
  "}", // 13
].join("\n");

describe("enclosing block", () => {
  test("a hunk inside a nested block gets the whole function, from its opening line to its closing one", () => {
    expect(enclosingBlock(FILE, 6, 6)).toEqual({ startLine: 3, text: FILE.split("\n").slice(2, 9).join("\n") });
  });

  test("a pure deletion is the line it sat at", () => {
    expect(enclosingBlock(FILE, 8, 7)!.startLine).toBe(3);
  });

  test("top-level code has no block, so it gets a window", () => {
    const block = enclosingBlock(FILE, 1, 1)!;
    expect(block.startLine).toBe(1);
    expect(block.text).toContain("export function other()");
  });

  test("an indented language closes on the next line at the opener's depth", () => {
    const python = ["def a(x):", "    if x:", "        return 1", "    return 2", "", "def b():", "    pass"].join("\n");
    expect(enclosingBlock(python, 3, 3)).toEqual({ startLine: 1, text: python.split("\n").slice(0, 6).join("\n") });
  });

  test("a huge function is cut, a line past the end of the file is nothing", () => {
    const long = ["function big() {", ...Array.from({ length: 500 }, (_, index) => `  step(${index});`), "}"].join("\n");
    expect(enclosingBlock(long, 250, 250)!.text.split("\n").length).toBeLessThanOrEqual(121);
    expect(enclosingBlock(FILE, 99, 99)).toBeNull();
  });
});

describe("related hunks", () => {
  const hunk = (id: string, content: string, preClass: Hunk["preClass"] = null) => ({ id, content, preClass }) as Hunk;
  const flagged = hunk("a", "@@\n-  filters.push(tenantFilter(tenantId));\n context mentions requireTenant");
  const moved = hunk("b", "@@\n+  return tenantFilter(tenantId);");
  const unrelated = hunk("c", "@@\n+const LIMIT = 10;");
  const contextOnly = hunk("d", "@@\n tenantFilter(tenantId) here is unchanged context\n+const x = 1;");
  const vendored = hunk("e", "@@\n+tenantFilter(tenantId)", "vendored");

  test("are the ones that change the same identifiers, never itself, context lines, or set-aside files", () => {
    expect(relatedHunks(flagged, [flagged, moved, unrelated, contextOnly, vendored])).toEqual([moved]);
  });

  test("an identifier changed all over the PR ties nothing together", () => {
    const everywhere = Array.from({ length: 8 }, (_, index) => hunk(`r${index}`, "@@\n+logger.info(tenantId)"));
    expect(relatedHunks(hunk("z", "@@\n+logger.warn(tenantId)"), everywhere)).toEqual([]);
  });
});

describe("facts from the whole diff", () => {
  const hunk = (id: string, path: string, content: string, startLine = 1, endLine = 9) =>
    ({ id, path, content, startLine, endLine, preClass: null }) as Hunk;
  const callSite = hunk("policy#1", "src/policy.ts", "@@\n-  flags.push({ hunkId: hunk.id });\n+  flag(hunk, fields);");
  const helper = hunk("policy#0", "src/policy.ts", "@@\n+  const findingId = createHash(hunk.path);");
  const deleted = hunk("report#3", "src/report.ts", "@@\n-function findingId(flagId, hunk) {\n-  return createHash(hunk.path);\n-}", 303, 310);
  const users = Array.from({ length: 8 }, (_, index) => hunk(`t#${index}`, `test/t${index}.ts`, "@@\n+  expect(flag.findingId).toBe(1);"));

  test("a name added in the scope and removed in another hunk was moved here, however many hunks use it", () => {
    const found = moves([callSite, helper], [callSite, helper, deleted, ...users]);
    expect(found.facts).toEqual(["`createHash`, `findingId`, `hunk`, `path` are added here and removed in src/report.ts L303-310."]);
    expect(found.hunks).toEqual([deleted]);
  });

  test("and the other way round, from where the code left", () => {
    expect(moves([deleted], [callSite, helper, deleted]).facts).toEqual([
      "`createHash`, `findingId`, `hunk`, `path` are removed here and added in src/policy.ts L1-9.",
    ]);
  });

  test("one short name going the other way is no evidence of a move, one long name is", () => {
    const adds = (word: string) => hunk("a", "src/a.ts", `@@\n+  ${word}();`);
    const removes = (word: string) => hunk("b", "src/b.ts", `@@\n-  ${word}();`);
    expect(moves([adds("path")], [adds("path"), removes("path")]).facts).toEqual([]);
    expect(moves([adds("tenantFilter")], [adds("tenantFilter"), removes("tenantFilter")]).facts).toHaveLength(1);
  });

  test("a name edited in place within the scope is no move, nor is one that is only added", () => {
    const renamed = hunk("a", "src/a.ts", "@@\n-  tenantFilter(id);\n+  tenantFilter(id, scope);");
    expect(moves([renamed], [renamed, hunk("b", "src/b.ts", "@@\n+  tenantFilter(id);")]).facts).toEqual([]);
    expect(moves([helper], [helper, ...users]).facts).toEqual([]);
  });

  test("a removed name is still in the file, or gone from it", () => {
    const removal = hunk("s", "src/search.ts", "@@\n-  filters.push(tenantFilter(tenantId));\n+  filters.push(other);");
    expect(stillPresent(removal, "const x = tenantId;\nfilters.push(other);")).toEqual([
      "`tenantFilter` no longer appears anywhere in src/search.ts after the change.",
      "`tenantId` still appears on 1 line of src/search.ts after the change.",
    ]);
    expect(stillPresent(removal, null)).toEqual([]);
  });
});
