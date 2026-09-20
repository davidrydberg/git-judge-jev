import { describe, expect, test } from "vitest";
import { enclosingBlock, relatedHunks } from "../src/context.js";
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
