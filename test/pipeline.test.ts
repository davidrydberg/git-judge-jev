import { readFileSync } from "node:fs";
import type { Questions, SystemOneRequest } from "@typesafe-ai/sdk";
import { expect, test } from "vitest";
import type { JudgeClient } from "../src/judge.js";
import { runPipeline } from "../src/pipeline.js";
import { parsePolicy } from "../src/policy.js";
import type { Generator } from "../src/writer.js";

const MIXED = readFileSync(new URL("./fixtures/mixed.diff", import.meta.url), "utf8");

/** Probability of yes per file and noul id. Everything not listed is 0.05, and every hunk is mechanical unless listed. */
const NOULS: Record<string, Record<string, number>> = {
  "src/auth/session.ts": { mechanical: 0.05, safety_check_weakened: 0.92, refactor_changes_behaviour: 0.9 },
  "test/invoice.test.ts": { mechanical: 0.1, test_loosened: 0.88 },
  "schema.sql": { mechanical: 0.2 },
};
const CHOICES: Record<string, Record<string, string>> = {
  "src/auth/session.ts": { change_type: "refactor", sensitive_area: "auth", blast_radius: "end users" },
  "test/invoice.test.ts": { change_type: "test" },
};

function fakeJudge(overrides: Record<string, Record<string, number>> = {}) {
  const seenFiles = new Set<string>();
  const client: JudgeClient = {
    async systemOne(request: SystemOneRequest) {
      const file = String((request.state as Record<string, unknown>).file ?? "");
      if (file) seenFiles.add(file);
      const answers = Object.fromEntries(
        Object.entries(request.questions as Questions).map(([id, question]) => {
          if (question.type === "noul") {
            const fallback = id === "mechanical" ? 0.95 : 0.05;
            return [id, { type: "noul", noul: overrides[file]?.[id] ?? NOULS[file]?.[id] ?? fallback }];
          }
          if (question.type === "choice") {
            const options = Object.keys(question.criteria);
            const chosen = CHOICES[file]?.[id] ?? (id === "sensitive_area" ? "none" : options[options.length - 1]!);
            const probabilities = Object.fromEntries(options.map((option) => [option, option === chosen ? 1 : 0]));
            return [id, { type: "choice", choice: chosen, confidence: 0.9, probabilities }];
          }
          return [id, { type: "score", score: 1.8, confidence: 0.8, legend: {}, probabilities: {} }];
        }),
      );
      return { model: "jev-1.13.0", answers, usage: { input_tokens: 400, output_tokens: 0 } } as never;
    },
  };
  return { client, seenFiles };
}

const tldrPrompts: string[] = [];
const verdictPrompts: string[] = [];
const generator: Generator = {
  model: "gpt-5.6-luna",
  async generate(request) {
    if (request.schemaName === "tldr") tldrPrompts.push(request.prompt);
    else verdictPrompts.push(request.prompt);
    const value =
      request.schemaName === "tldr"
        ? { tldr: "Removes the token expiry check under the name of a refactor." }
        : { confirmed: true, material: true, severity: "high", what_changed: "A check was removed.", why_it_matters: "Expired tokens would be accepted.", what_to_verify: "Confirm it is enforced elsewhere.", evidence: [] };
    return { value: request.schema.parse(value), inputTokens: 300, outputTokens: 40 };
  },
};

function run(judgeClient: JudgeClient, extra: Partial<Parameters<typeof runPipeline>[0]> = {}) {
  const clock = [1000, 4500];
  return runPipeline({
    ...extra,
    diff: MIXED,
    title: "Refactor session handling",
    description: "Pure refactor of session handling. No behaviour change. Also tidies the invoice test.",
    policy: extra.policy ?? parsePolicy("labels: true\ndebug: true"),
    judgeClient,
    generator,
    now: () => clock.shift()!,
  });
}

test("a mixed PR: the auth change and the loosened test are read first, the rest is set aside", async () => {
  const { client, seenFiles } = fakeJudge();
  const report = await run(client);

  expect(report.json.readingOrder.map((entry) => entry.path)).toEqual([
    "src/auth/session.ts",
    "test/invoice.test.ts",
    "schema.sql",
  ]);
  expect(report.json.verdicts.map((verdict) => [verdict.path, verdict.flagId])).toEqual([
    ["src/auth/session.ts", "safety_check_weakened"],
    ["src/auth/session.ts", "refactor_changes_behaviour"],
    ["test/invoice.test.ts", "test_loosened"],
  ]);
  expect(report.json.verdicts[0]!.anchor).toEqual({ line: 1, side: "LEFT" });
  expect(report.json.skipped).toEqual({ mechanical: 4, lockfile: 0, generated: 0, vendored: 1, unchecked: 0, overCap: 0, failed: 0, gateOnlyCut: 0 });
  expect(report.labels).toEqual(["area: auth", "size: S", "type: refactor"]);
  expect(report.check).toMatchObject({ conclusion: "success", title: "3 findings to check" });
  expect(tldrPrompts.at(-1)).toContain("- src/auth/session.ts: refactor");
  expect(tldrPrompts.at(-1)).toContain("- test/invoice.test.ts: test");
  expect(tldrPrompts.at(-1)).not.toContain("vendor/lib/index.js");
  expect(report.json.durationMs).toBe(3500);
  expect(report.summary).toContain("<summary>Jev answers for 7 hunks</summary>");
  expect(report.summary).toMatch(/\| `src\/auth\/session\.ts` L1-13 \| \d\.\d\d \| 0\.05 \| .*\*\*0\.92\*\* .*\| refactor 0\.90 \| auth 0\.90 \|/);
  // The vendored file is asked the gate questions and named, the binary has no hunk to ask about.
  expect(seenFiles.has("vendor/lib/index.js")).toBe(true);
  expect(report.summary).toContain("checked for secrets and destructive data changes only: `vendor/lib/index.js`.");
  expect(seenFiles.has("assets/logo.png")).toBe(false);
});

test("the defaults are quiet: no labels, no answers table", async () => {
  const report = await run(fakeJudge().client, { policy: parsePolicy("") });
  expect(report.labels).toEqual([]);
  expect(report.summary).not.toContain("Jev answers for");
});

test("a secret in a vendored file fails the check, and is sent to no writer", async () => {
  const { client } = fakeJudge({ "vendor/lib/index.js": { secret_semantic: 0.97 } });
  verdictPrompts.length = 0;
  const report = await run(client);

  expect(report.check).toMatchObject({ conclusion: "failure", title: "Blocked: possible secret" });
  expect(report.summary).toContain("**Possible secret** (high) in `vendor/lib/index.js`");
  expect(verdictPrompts.some((prompt) => prompt.includes("vendor/lib/index.js"))).toBe(false);
});

test("with the writer down the report still posts, and a gate still fails the check", async () => {
  const { client } = fakeJudge({ "schema.sql": { destructive_data: 0.95 } });
  const down: Generator = {
    model: "gpt-5.6-luna",
    generate: async () => {
      throw new Error("OpenAI returned 503");
    },
  };
  const report = await runPipeline({
    diff: MIXED,
    title: "Refactor session handling",
    description: "Pure refactor of session handling. No behaviour change. Also tidies the invoice test.",
    policy: parsePolicy(""),
    judgeClient: client,
    generator: down,
    now: () => 0,
  });

  expect(report.check).toMatchObject({ conclusion: "failure", title: "Blocked: destructive data change" });
  expect(report.json).toMatchObject({ writerError: "OpenAI returned 503", unchecked: 3, tldr: null });
  expect(report.summary).toContain("3 warnings from Jev had no second look and are not shown.");
});

test("the writer reads the code around a flagged hunk, from the file after the change", async () => {
  verdictPrompts.length = 0;
  const asked: string[] = [];
  await run(fakeJudge().client, {
    fetchFile: async (path) => {
      asked.push(path);
      return path === "src/auth/session.ts" ? "export function verify(token) {\n  const claims = decode(token);\n  return claims;\n}\n" : null;
    },
  });

  // Two flags on the auth hunk, one read of its file. A file that cannot be read costs the context, not the run.
  expect(asked.sort()).toEqual(["src/auth/session.ts", "test/invoice.test.ts"]);
  const auth = verdictPrompts.filter((prompt) => prompt.includes("File: src/auth/session.ts"));
  expect(auth).toHaveLength(2);
  expect(auth[0]).toContain('<code_after_change file="src/auth/session.ts" first_line="1">');
  expect(verdictPrompts.find((prompt) => prompt.includes("File: test/invoice.test.ts"))).not.toContain("<code_after_change");
});

test("a warning a reviewer dismissed costs no writer call and is no finding, until its hunk changes", async () => {
  const first = await run(fakeJudge().client);
  const loosened = first.json.verdicts.find((verdict) => verdict.flagId === "test_loosened")!;

  verdictPrompts.length = 0;
  const next = await run(fakeJudge().client, {
    previous: { findingIds: first.json.verdicts.map((verdict) => verdict.id), dismissed: [loosened.id] },
  });
  expect(next.json.verdicts.map((verdict) => [verdict.flagId, verdict.status])).toEqual([
    ["safety_check_weakened", "standing"],
    ["refactor_changes_behaviour", "standing"],
  ]);
  expect(next.json.dismissed).toEqual([{ id: loosened.id, flagId: "test_loosened", hunkId: loosened.hunkId }]);
  expect(verdictPrompts.some((prompt) => prompt.includes("File: test/invoice.test.ts"))).toBe(false);
  expect(next.check.title).toBe("2 findings to check");
});

test("a gate cannot be dismissed from the comment", async () => {
  const { client } = fakeJudge({ "src/legacy.txt": { secret_semantic: 0.97 } });
  const first = await run(client);
  const gate = first.json.verdicts.find((verdict) => verdict.kind === "gate")!;
  const next = await run(client, { previous: { findingIds: [gate.id], dismissed: [gate.id] } });
  expect(next.check.conclusion).toBe("failure");
  expect(next.json.dismissed).toEqual([]);
});

test("a secret in an otherwise mechanical hunk fails the check", async () => {
  const { client } = fakeJudge({ "src/legacy.txt": { secret_semantic: 0.97 } });
  const report = await run(client);

  expect(report.check).toMatchObject({ conclusion: "failure", title: "Blocked: possible secret" });
  expect(report.json.readingOrder[0]!.path).toBe("src/legacy.txt");
  expect(report.summary).toContain("### Blocking");
});
