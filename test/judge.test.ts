import { TypeSafeClient, type Questions, type SystemOneRequest } from "@typesafe-ai/sdk";
import { describe, expect, test } from "vitest";
import type { Hunk } from "../src/diff.js";
import {
  estimateTokens,
  judge,
  REQUEST_OVERHEAD_TOKENS,
  type JudgeClient,
  type PullRequestMeta,
} from "../src/judge.js";

function cannedAnswers(questions: Questions): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (question.type === "noul") return [id, { type: "noul", noul: 0.1 }];
      if (question.type === "choice") {
        const options = Object.keys(question.criteria);
        const probabilities = Object.fromEntries(options.map((option) => [option, 1 / options.length]));
        return [id, { type: "choice", choice: options[0], confidence: 0.5, probabilities }];
      }
      return [id, { type: "score", score: 1, confidence: 0.5, legend: {}, probabilities: {} }];
    }),
  );
}

function fakeClient(options: { failOn?: (request: SystemOneRequest) => boolean } = {}) {
  const requests: SystemOneRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client: JudgeClient = {
    async systemOne(request) {
      requests.push(request);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      if (options.failOn?.(request)) throw new Error("TypeSafe unreachable");
      return {
        model: "jev-1.13.0",
        answers: cannedAnswers(request.questions),
        usage: { input_tokens: 100, output_tokens: 0 },
      } as never;
    },
  };
  return { client, requests, maxInFlight: () => maxInFlight };
}

function hunk(id: string, overrides: Partial<Hunk> = {}): Hunk {
  return {
    id,
    path: "src/pay.ts",
    language: "TypeScript",
    isTest: false,
    startLine: 1,
    endLine: 2,
    added: 1,
    deleted: 1,
    size: 2,
    preClass: null,
    anchor: { line: 1, side: "RIGHT" },
    content: "@@ -1,2 +1,2 @@\n-const fee = 1;\n+const fee = 0;",
    ...overrides,
  };
}

const pr: PullRequestMeta = {
  title: "Refactor fees",
  description: "This is a safe refactor of the fee module, nothing changes.",
  files: ["src/pay.ts", "package-lock.json"],
};

const stateOf = (request: SystemOneRequest) => request.state as Record<string, unknown>;
const asksFor = (request: SystemOneRequest, id: string) => id in request.questions;

describe("which question lands in which call", () => {
  test("code questions never see the PR description, mismatch questions do", async () => {
    const { client, requests } = fakeClient();
    await judge(client, [hunk("a")], pr);

    const code = requests.find((request) => asksFor(request, "secret_semantic"))!;
    expect(Object.keys(code.questions)).toEqual([
      "secret_semantic",
      "destructive_data",
      "mechanical",
      "refactor_changes_behaviour",
      "test_loosened",
      "safety_check_weakened",
      "comment_drift",
      "error_handling_changed",
      "condition_changed",
      "external_io_added",
      "shared_state_changed",
      "limit_or_default_changed",
      "change_type",
      "sensitive_area",
      "blast_radius",
    ]);
    expect(JSON.stringify(code.state)).not.toContain("safe refactor");
    expect(stateOf(code)).toEqual({ file: "src/pay.ts", language: "TypeScript", diff: hunk("a").content });

    const mismatch = requests.find((request) => asksFor(request, "unrelated_to_description"))!;
    expect(Object.keys(mismatch.questions)).toEqual(["unrelated_to_description"]);
    expect(stateOf(mismatch).pr_description).toBe(pr.description);
  });

  test("PR-level questions are asked once, about the title, description, and file list", async () => {
    const { client, requests } = fakeClient();
    await judge(client, [hunk("a"), hunk("b"), hunk("c")], pr);

    const prCalls = requests.filter((request) => asksFor(request, "description_quality"));
    expect(prCalls).toHaveLength(1);
    expect(Object.keys(prCalls[0]!.questions)).toEqual(["description_quality", "tests_cover_change"]);
    expect(stateOf(prCalls[0]!)).toEqual({
      title: pr.title,
      description: pr.description,
      changed_files: pr.files,
    });
    expect(requests).toHaveLength(7);
  });

  test("custom questions run in the code call and come back under their own ids", async () => {
    const { client, requests } = fakeClient();
    const result = await judge(client, [hunk("a")], pr, {
      customQuestions: { invoicing: "This chunk touches invoicing." },
    });

    const code = requests.find((request) => asksFor(request, "secret_semantic"))!;
    expect(code.questions["custom:invoicing"]).toEqual({
      type: "noul",
      instructions: "This chunk touches invoicing.",
    });
    expect(result.hunks.a!.custom).toEqual({ invoicing: 0.1 });
  });

  test("a too-short description skips the mismatch call", async () => {
    const { client, requests } = fakeClient();
    const result = await judge(client, [hunk("a")], pr, { skipMismatch: true });

    expect(requests.some((request) => asksFor(request, "unrelated_to_description"))).toBe(false);
    expect(result.hunks.a!.mismatch).toBeNull();
  });
});

describe("what reaches the model", () => {
  test("pre-classified hunks are never sent", async () => {
    const { client, requests } = fakeClient();
    const result = await judge(client, [hunk("a"), hunk("lock", { preClass: "lockfile" })], pr);

    expect(Object.keys(result.hunks)).toEqual(["a"]);
    expect(requests).toHaveLength(3);
  });

  test("an oversized hunk is cut at a line boundary under the state cap and marked low-coverage", async () => {
    const line = "+const value = compute(input, options, context);";
    const content = ["@@ -0,0 +1,4000 @@", ...Array.from({ length: 4000 }, () => line)].join("\n");
    const { client, requests } = fakeClient();
    const result = await judge(client, [hunk("big", { content }), hunk("small")], pr);

    expect(result.hunks.big!.lowCoverage).toBe(true);
    expect(result.hunks.small!.lowCoverage).toBe(false);
    for (const request of requests) {
      const longest = Math.max(...Object.values(request.questions).map(estimateTokens));
      expect(estimateTokens(request.state) + longest + REQUEST_OVERHEAD_TOKENS).toBeLessThanOrEqual(32_000);
    }
    const sent = stateOf(requests.find((request) => stateOf(request).diff !== hunk("small").content && asksFor(request, "mechanical"))!);
    expect(String(sent.diff).endsWith(line)).toBe(true);
    expect(String(sent.diff).length).toBeGreaterThan(80_000);
  });
});

describe("running", () => {
  test("concurrency is bounded per hunk", async () => {
    const { client, maxInFlight } = fakeClient();
    const hunks = Array.from({ length: 20 }, (_, index) => hunk(`h${index}`));
    await judge(client, hunks, pr, { concurrency: 3 });

    // Three hunks in flight, two calls each, plus the PR-level call.
    expect(maxInFlight()).toBeLessThanOrEqual(7);
  });

  test("usage and the answering model are reported", async () => {
    const { client } = fakeClient();
    const result = await judge(client, [hunk("a"), hunk("b")], pr);

    expect(result).toMatchObject({ model: "jev-1.13.0", requests: 5, inputTokens: 500 });
  });

  test("one hunk TypeSafe will not answer for is reported as failed, the rest is judged", async () => {
    const { client } = fakeClient({ failOn: (request) => stateOf(request).file === "src/broken.ts" });
    const hunks = [hunk("a"), hunk("b", { path: "src/broken.ts" }), hunk("c")];

    const result = await judge(client, hunks, pr);
    expect(Object.keys(result.hunks)).toEqual(["a", "c"]);
    expect(result.failed).toEqual(["b"]);
  });

  test("an outage is not retried hunk by hunk: past a handful of failures the judgement fails", async () => {
    const { client, requests } = fakeClient({ failOn: (request) => "diff" in stateOf(request) });
    const hunks = Array.from({ length: 100 }, (_, index) => hunk(`h${index}`));

    await expect(judge(client, hunks, pr)).rejects.toThrow("TypeSafe unreachable");
    expect(requests.length).toBeLessThan(40);
  });

  test("every hunk failing fails the judgement, however few they are", async () => {
    const { client } = fakeClient({ failOn: (request) => "diff" in stateOf(request) });
    await expect(judge(client, [hunk("a"), hunk("b")], pr)).rejects.toThrow("TypeSafe unreachable");
  });

  test("a generated or vendored hunk is asked the gate questions and nothing else, a lockfile or an unchecked path nothing", async () => {
    const { client, requests } = fakeClient();
    const hunks = [
      hunk("bundle", { path: "dist/index.js", preClass: "generated" }),
      hunk("lib", { path: "vendor/lib.go", preClass: "vendored" }),
      hunk("lock", { path: "package-lock.json", preClass: "lockfile" }),
      hunk("unchecked", { path: "dist/big.js", preClass: "unchecked" }),
    ];

    const result = await judge(client, hunks, pr);
    expect(Object.keys(result.gateOnly)).toEqual(["bundle", "lib"]);
    expect(result.hunks).toEqual({});
    const perHunk = requests.filter((request) => "diff" in stateOf(request));
    expect(perHunk.map((request) => Object.keys(request.questions))).toEqual([
      ["secret_semantic", "destructive_data"],
      ["secret_semantic", "destructive_data"],
    ]);
    // No description in the state: the gates never see it, on any path.
    expect(perHunk.every((request) => !("pr_description" in stateOf(request)))).toBe(true);
  });

  test("a missing answer is an error, not a silent gap", async () => {
    const client: JudgeClient = {
      async systemOne() {
        return { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } } as never;
      },
    };
    await expect(judge(client, [hunk("a")], pr)).rejects.toThrow(/returned no .* answer/);
  });
});

describe("retries through the real SDK", () => {
  test("429 and 529 are retried until the request succeeds", async () => {
    const statuses = [429, 529];
    let calls = 0;
    const client = new TypeSafeClient({
      apiKey: "test-key",
      retry: { maxRetries: 4, backoffInitialMs: 1, backoffMaxMs: 1 },
      fetch: async (_url, init) => {
        calls++;
        const status = statuses.shift();
        if (status) return new Response(JSON.stringify({ error: "busy" }), { status });
        const { questions } = JSON.parse(String(init?.body)) as { questions: Questions };
        return Response.json({
          model: "jev-1.13.0",
          answers: cannedAnswers(questions),
          usage: { input_tokens: 10, output_tokens: 0 },
        });
      },
    });

    const result = await judge(client, [], pr);
    expect(calls).toBe(3);
    expect(result.pr.tests_cover_change.noul).toBe(0.1);
  });
});
