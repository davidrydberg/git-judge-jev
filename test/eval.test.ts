import { describe, expect, test } from "vitest";
import type { Hunk } from "../src/diff.js";
import type { ReportJson } from "../src/report.js";
import { resolve, scoreCase, totals, type EvalCase } from "../scripts/eval-score.js";

const hunk = (id: string, path: string, content: string, startLine = 1, endLine = 1) =>
  ({ id, path, content, startLine, endLine }) as Hunk;
const HUNKS = [
  hunk("src/a.ts#0", "src/a.ts", "+import x"),
  hunk("src/a.ts#1", "src/a.ts", "-  if (allowed(user)) {", 40, 46),
  hunk("src/b.ts#0", "src/b.ts", "+const LIMIT = 10;"),
];
const report = (order: string[], verdicts: [string, string, boolean?][]) =>
  ({
    readingOrder: order.map((hunkId) => ({ hunkId })),
    verdicts: verdicts.map(([hunkId, flagId, material = true]) => ({ hunkId, flagId, material })),
  }) as unknown as ReportJson;

const CASE: EvalCase = {
  title: "t",
  description: "d",
  mustRead: [{ path: "src/a.ts", contains: "allowed(user)" }],
  flags: [{ path: "src/a.ts", contains: "allowed(user)", id: "safety_check_weakened" }],
  acceptable: [{ path: "src/b.ts", contains: "LIMIT", id: "safety_check_weakened" }],
};

describe("eval scoring", () => {
  test("a label names exactly one hunk, by file and a string in its diff", () => {
    expect(resolve({ path: "src/a.ts", contains: "allowed" }, HUNKS).id).toBe("src/a.ts#1");
    expect(() => resolve({ path: "src/a.ts", contains: "nowhere" }, HUNKS)).toThrow("matches 0 hunks");
    expect(() => resolve({ path: "src/a.ts", contains: "" }, HUNKS)).toThrow("matches 2 hunks");
  });

  test("ranks the must-read hunk, counts the true flag, and lets an acceptable verdict pass", () => {
    const json = report(["src/b.ts#0", "src/a.ts#1"], [["src/a.ts#1", "safety_check_weakened"], ["src/b.ts#0", "safety_check_weakened"]]);
    expect(scoreCase(CASE, HUNKS, json)).toMatchObject({ ranks: [2], inTop5: 1, truePositives: 1, falsePositives: [], missedFlags: [] });
  });

  test("a hunk outside the reading order has no rank, a missing flag is missed, any other verdict is false", () => {
    const json = report(["src/b.ts#0"], [["src/a.ts#0", "comment_drift"]]);
    expect(scoreCase(CASE, HUNKS, json)).toMatchObject({
      ranks: [null],
      inTop10: 0,
      truePositives: 0,
      falsePositives: ["src/a.ts#0|comment_drift"],
      missedFlags: ["src/a.ts#1|safety_check_weakened"],
    });
  });

  test("totals are ratios over all cases, and an empty ratio is 1", () => {
    const hit = scoreCase(CASE, HUNKS, report(["src/a.ts#1"], [["src/a.ts#1", "safety_check_weakened"]]));
    const miss = scoreCase(CASE, HUNKS, report([], [["src/a.ts#0", "comment_drift"]]));
    expect(totals([hit, miss])).toEqual({ cases: 2, recallTop5: 0.5, recallTop10: 0.5, flagRecall: 0.5, flagPrecision: 0.5 });
    expect(totals([])).toMatchObject({ recallTop5: 1, flagPrecision: 1 });
  });

  test("a label from GitHub names its hunk by a line on the new side", () => {
    expect(resolve({ path: "src/a.ts", line: 43 }, HUNKS).id).toBe("src/a.ts#1");
    expect(() => resolve({ path: "src/a.ts", line: 99 }, HUNKS)).toThrow("line 99 in src/a.ts matches 0 hunks");
  });

  test("a verdict the writer called immaterial is not shown as a finding, so it is not scored as one", () => {
    const score = scoreCase(CASE, HUNKS, report([], [["src/a.ts#0", "comment_drift", false]]));
    expect(score.falsePositives).toEqual([]);
  });

  test("a case with no flag labels is scored on ranking only, and its verdicts are listed to be labelled", () => {
    const unlabelled: EvalCase = { title: CASE.title, description: CASE.description, mustRead: CASE.mustRead };
    const score = scoreCase(unlabelled, HUNKS, report(["src/a.ts#1"], [["src/a.ts#0", "comment_drift"]]));
    expect(score).toMatchObject({ ranks: [1], expectedFlags: 0, falsePositives: [], unlabelled: ["src/a.ts#0|comment_drift"] });
  });
});
