import { describe, expect, test } from "vitest";
import type { Hunk } from "../src/diff.js";
import type { HunkAnswers, Judgement } from "../src/judge.js";
import {
  attention,
  evaluate,
  hasUsableDescription,
  parsePolicy,
  selectForJudging,
  type Findings,
} from "../src/policy.js";

const DESCRIPTION = "Moves fee calculation into its own module and adds a test for rounding.";

interface Spec {
  mechanical?: number;
  secret?: number;
  destructive?: number;
  behaviour?: number;
  testLoosened?: number;
  safety?: number;
  commentDrift?: number;
  /** One of the logic signals. They count by their maximum, so one is enough to test with. */
  condition?: number;
  unrelated?: number | null;
  type?: string;
  typeConfidence?: number;
  area?: string;
  blast?: string;
  custom?: Record<string, number>;
  lowCoverage?: boolean;
}

function choice(options: string[], chosen: string, confidence = 0.9) {
  const probabilities = Object.fromEntries(options.map((option) => [option, option === chosen ? 1 : 0]));
  return { type: "choice", choice: chosen, confidence, probabilities };
}

function answers(spec: Spec = {}): HunkAnswers {
  const noul = (value = 0) => ({ type: "noul", noul: value });
  return {
    code: {
      secret_semantic: noul(spec.secret),
      destructive_data: noul(spec.destructive),
      mechanical: noul(spec.mechanical),
      refactor_changes_behaviour: noul(spec.behaviour),
      test_loosened: noul(spec.testLoosened),
      safety_check_weakened: noul(spec.safety),
      comment_drift: noul(spec.commentDrift),
      error_handling_changed: noul(),
      condition_changed: noul(spec.condition),
      external_io_added: noul(),
      shared_state_changed: noul(),
      limit_or_default_changed: noul(),
      change_type: choice(
        ["feature", "bugfix", "refactor", "test", "docs", "chore"],
        spec.type ?? "feature",
        spec.typeConfidence,
      ),
      sensitive_area: choice(["auth", "payments", "data_migration", "public_api", "none"], spec.area ?? "none"),
      blast_radius: choice(
        ["nobody", "other developers", "end users", "money or data"],
        spec.blast ?? "other developers",
      ),
    },
    custom: spec.custom ?? {},
    mismatch:
      spec.unrelated === null ? null : { unrelated_to_description: noul(spec.unrelated) },
    lowCoverage: spec.lowCoverage ?? false,
  } as unknown as HunkAnswers;
}

function hunk(id: string, overrides: Partial<Hunk> = {}): Hunk {
  return {
    id,
    path: `src/${id}.ts`,
    language: "TypeScript",
    isTest: false,
    startLine: 1,
    endLine: 1,
    added: 5,
    deleted: 5,
    size: 10,
    preClass: null,
    anchor: { line: 1, side: "RIGHT" },
    content: "",
    ...overrides,
  };
}

function run(
  specs: Record<string, Spec>,
  options: {
    policy?: string;
    description?: string;
    extraHunks?: Hunk[];
    pr?: { quality?: number; tests?: number };
    gateOnly?: Record<string, { secret?: number; destructive?: number; lowCoverage?: boolean }>;
    failed?: string[];
  } = {},
): Findings {
  const hunks = [...Object.keys(specs).map((id) => hunk(id)), ...(options.extraHunks ?? [])];
  const judgement = {
    hunks: Object.fromEntries(Object.entries(specs).map(([id, spec]) => [id, answers(spec)])),
    gateOnly: Object.fromEntries(
      Object.entries(options.gateOnly ?? {}).map(([id, spec]) => [
        id,
        {
          answers: {
            secret_semantic: { type: "noul", noul: spec.secret ?? 0 },
            destructive_data: { type: "noul", noul: spec.destructive ?? 0 },
          },
          lowCoverage: spec.lowCoverage ?? false,
        },
      ]),
    ),
    failed: options.failed ?? [],
    pr: {
      description_quality: { type: "score", score: options.pr?.quality ?? 2 },
      tests_cover_change: { type: "noul", noul: options.pr?.tests ?? 0.9 },
    },
    model: "jev-1.13.0",
    requests: 0,
    inputTokens: 0,
  } as unknown as Judgement;
  return evaluate(hunks, judgement, options.description ?? DESCRIPTION, parsePolicy(options.policy ?? ""));
}

const flagIds = (findings: Findings) => findings.flags.map((flag) => `${flag.hunkId}:${flag.id}`);

describe("policy file", () => {
  test("an empty file gives the defaults", () => {
    const policy = parsePolicy("");
    expect(policy.thresholds.gates.secret_semantic).toBe(0.9);
    expect(policy.weights.area.auth).toBe(2);
    expect(policy.generator).toEqual({ model: "gpt-5.6-luna", escalation: null });
    expect(policy.failOnError).toBe(false);
  });

  test("a partial file overrides only what it names", () => {
    const policy = parsePolicy("thresholds:\n  warnings:\n    test_loosened: 0.8\nminAttention: 0");
    expect(policy.thresholds.warnings.test_loosened).toBe(0.8);
    expect(policy.thresholds.warnings.comment_drift).toBe(0.5);
    expect(policy.minAttention).toBe(0);
  });

  test.each([
    ["an unknown key", "minAttenton: 1"],
    ["a probability above 1", "thresholds:\n  gates:\n    secret_semantic: 1.5"],
    ["a custom question posing as a gate", "thresholds:\n  gates:\n    invoicing: 0.5"],
    ["a custom question id with a colon", "customQuestions:\n  - id: 'a:b'\n    question: x"],
    ["a duplicate custom question id", "customQuestions:\n  - {id: a, question: x}\n  - {id: a, question: y}"],
  ])("%s is rejected", (_name, yaml) => {
    expect(() => parsePolicy(yaml)).toThrow(/Invalid git-judge-jev policy/);
  });
});

describe("attention formula", () => {
  const policy = parsePolicy("");

  test.each<[string, Spec, number]>([
    ["plain change: (1 - 0) * 1 * 1", {}, 1],
    ["fully mechanical", { mechanical: 1 }, 0],
    ["auth and money: 1 * 2 * 2", { area: "auth", blast: "money or data" }, 4],
    ["half mechanical public API: 0.5 * 1.5 * 1", { mechanical: 0.5, area: "public_api" }, 0.75],
    ["judgement adds twice its highest probability", { mechanical: 1, testLoosened: 0.3, safety: 0.8 }, 1.6],
    ["both terms: 1 * 2 * 1.5 + 2 * 0.9", { area: "payments", blast: "end users", safety: 0.9 }, 4.8],
    ["a feature changing behaviour is normal and adds nothing", { behaviour: 0.95, type: "feature" }, 1],
    ["a refactor changing behaviour adds twice the probability", { behaviour: 0.95, type: "refactor" }, 2.9],
    ["an unsure refactor adds nothing", { behaviour: 0.95, type: "refactor", typeConfidence: 0.3 }, 1],
  ])("%s", (_name, spec, expected) => {
    expect(attention(answers(spec), policy)).toBeCloseTo(expected);
  });

  test("a test file counts area and blast radius at half, a loosened test in full", () => {
    const spec = { area: "auth", blast: "end users", testLoosened: 0.4 };
    expect(attention(answers(spec), policy)).toBeCloseTo(3.8);
    expect(attention(answers(spec), policy, { isTest: true })).toBeCloseTo(2.3);
    expect(attention(answers(spec), parsePolicy("weights:\n  testFile: 1"), { isTest: true })).toBeCloseTo(3.8);
  });

  test("the strongest logic signal scales area and blast radius, and never the judgement term", () => {
    expect(attention(answers({ condition: 0.9 }), policy)).toBeCloseTo(1.9);
    expect(attention(answers({ area: "auth", condition: 0.5, safety: 0.2 }), policy)).toBeCloseTo(2 * 1.5 + 0.4);
    expect(attention(answers({ condition: 0.9 }), parsePolicy("weights:\n  logicSignal: 0"))).toBeCloseTo(1);
  });

  test("prose counts area and blast radius only", () => {
    const spec = { area: "public_api", blast: "end users", safety: 0.9, condition: 0.9 };
    expect(attention(answers(spec), policy, { isProse: true })).toBeCloseTo(2.25);
  });

  test("area weight follows the probabilities, not only the top option", () => {
    const split = answers();
    Object.assign(split.code.sensitive_area.probabilities, { auth: 0.5, none: 0.5 });
    expect(attention(split, policy)).toBeCloseTo(1.5);
  });
});

describe("reading order", () => {
  test("sorted by attention, cut at the minimum, the rest counted as mechanical", () => {
    const findings = run({
      imports: { mechanical: 0.95 },
      auth: { area: "auth", blast: "end users" },
      plain: {},
      rename: { mechanical: 0.8 },
    });
    expect(findings.readingOrder.map((entry) => entry.hunkId)).toEqual(["auth", "plain"]);
    expect(findings.skipped.mechanical).toBe(2);
  });

  test("a score from half its threshold up to the threshold is a near miss, with no flag", () => {
    const findings = run({ close: { safety: 0.3, testLoosened: 0.19, secret: 0.5 }, far: { safety: 0.1 } });
    expect(findings.flags).toEqual([]);
    const misses = Object.fromEntries(findings.readingOrder.map((entry) => [entry.hunkId, entry.nearMisses]));
    expect(misses.close).toEqual([
      { id: "secret_semantic", probability: 0.5, threshold: 0.9 },
      { id: "safety_check_weakened", probability: 0.3, threshold: 0.4 },
    ]);
    expect(misses.far).toEqual([]);
  });

  test("a raised flag is not also a near miss, and the description flag never is one", () => {
    const findings = run({ hit: { safety: 0.7, unrelated: 0.5 } });
    expect(findings.flags.map((flag) => flag.id)).toEqual(["safety_check_weakened"]);
    expect(findings.readingOrder[0]!.nearMisses).toEqual([]);
  });

  test("changing behaviour is a near miss only where it could be a flag, inside a refactor", () => {
    expect(run({ feature: { behaviour: 0.3 } }).readingOrder[0]!.nearMisses).toEqual([]);
    expect(run({ tidy: { type: "refactor", behaviour: 0.3 } }).readingOrder[0]!.nearMisses).toEqual([
      { id: "refactor_changes_behaviour", probability: 0.3, threshold: 0.4 },
    ]);
  });

  test("a logic signal is passed on only when Jev is sure of it, and never for prose", () => {
    expect(run({ a: { condition: 0.7 } }).readingOrder[0]!.signals).toEqual(["condition_changed"]);
    expect(run({ a: { condition: 0.69 } }).readingOrder[0]!.signals).toEqual([]);
    const judgement = {
      hunks: { readme: answers({ condition: 0.9 }) },
      gateOnly: {},
      failed: [],
      pr: { description_quality: { score: 2 }, tests_cover_change: { noul: 1 } },
    } as unknown as Judgement;
    const prose = evaluate([hunk("readme", { path: "README.md" })], judgement, DESCRIPTION, parsePolicy(""));
    expect(prose.readingOrder[0]!.signals).toEqual([]);
  });

  test("a pick Jev was not confident in is not passed on as a reason to read", () => {
    const [sure, guess] = [run({ a: { type: "bugfix", area: "auth" } }), run({ a: { type: "bugfix", typeConfidence: 0.39 } })];
    expect(sure.readingOrder[0]).toMatchObject({ changeType: "bugfix", area: "auth", blastRadius: "other developers" });
    expect(guess.readingOrder[0]).toMatchObject({ changeType: null, area: "none" });
  });

  test("the cutoff is inclusive, and zero keeps every hunk", () => {
    expect(run({ edge: { mechanical: 0.5 } }).readingOrder).toHaveLength(1);
    expect(run({ below: { mechanical: 0.51 } }).readingOrder).toHaveLength(0);
    expect(run({ below: { mechanical: 1 } }, { policy: "minAttention: 0" }).readingOrder).toHaveLength(1);
  });

  test("warnings on a hunk below the cutoff are not raised", () => {
    const findings = run({ drifted: { mechanical: 0.9, commentDrift: 0.95 } });
    expect(findings.flags).toEqual([]);
  });

  test("pre-classified, over-cap, and low-coverage hunks are reported", () => {
    const findings = run(
      { judged: { lowCoverage: true } },
      {
        extraHunks: [
          hunk("lock", { preClass: "lockfile" }),
          hunk("vendored", { preClass: "vendored" }),
          hunk("generated", { preClass: "generated" }),
          hunk("bundle", { preClass: "unchecked" }),
          hunk("not-judged"),
          hunk("no-answer"),
        ],
        gateOnly: { vendored: { lowCoverage: true } },
        failed: ["no-answer"],
      },
    );
    // The generated hunk got no gate answers and did not fail, so the cap left it out.
    expect(findings.skipped).toEqual({
      mechanical: 0,
      lockfile: 1,
      generated: 1,
      vendored: 1,
      unchecked: 1,
      overCap: 2,
      failed: 1,
      gateOnlyCut: 1,
    });
    expect(findings.lowCoverage).toEqual(["judged"]);
  });

  test("the hunk cap is spent on ranked hunks first, generated and vendored ones take what is left", () => {
    const hunks = [
      hunk("vendored", { preClass: "vendored" }),
      hunk("a"),
      hunk("lock", { preClass: "lockfile" }),
      hunk("generated", { preClass: "generated" }),
      hunk("b"),
    ];
    const ids = (selected: Hunk[]) => selected.map((entry) => entry.id);
    const roomy = selectForJudging(hunks, parsePolicy("maxHunks: 3"));
    expect([ids(roomy.judged), ids(roomy.gateOnly), ids(roomy.overCap)]).toEqual([["a", "b"], ["vendored"], ["generated"]]);
    const tight = selectForJudging(hunks, parsePolicy("maxHunks: 1"));
    expect([ids(tight.judged), ids(tight.gateOnly), ids(tight.overCap)]).toEqual([["a"], [], ["b", "vendored", "generated"]]);
  });
});

describe("gates", () => {
  test.each<[string, Spec, string[], Findings["conclusion"]]>([
    ["secret at threshold", { secret: 0.9 }, ["h:secret_semantic"], "failure"],
    ["secret just below", { secret: 0.89 }, [], "success"],
    ["destructive migration", { destructive: 0.95 }, ["h:destructive_data"], "failure"],
    ["both", { secret: 1, destructive: 1 }, ["h:secret_semantic", "h:destructive_data"], "failure"],
  ])("%s", (_name, spec, expected, conclusion) => {
    const findings = run({ h: spec });
    expect(flagIds(findings)).toEqual(expected);
    expect(findings.conclusion).toBe(conclusion);
  });

  test("a path does not spare a hunk the gates: a secret in a vendored file fails the check", () => {
    const findings = run(
      { h: {} },
      {
        extraHunks: [hunk("bundle", { preClass: "generated" }), hunk("lib", { preClass: "vendored" })],
        gateOnly: { bundle: { secret: 0.89 }, lib: { secret: 0.95, destructive: 0.2 } },
      },
    );
    expect(flagIds(findings)).toEqual(["lib:secret_semantic"]);
    expect(findings.conclusion).toBe("failure");
    // It is blocked, not ranked: the reading order holds only hunks judged in full.
    expect(findings.readingOrder.map((entry) => entry.hunkId)).toEqual(["h"]);
  });

  test("a gate fires on a hunk that looks mechanical, and that hunk is read first", () => {
    const findings = run({ risky: { area: "auth", blast: "money or data" }, bump: { mechanical: 0.99, secret: 0.97 } });
    expect(findings.readingOrder.map((entry) => entry.hunkId)).toEqual(["bump", "risky"]);
    expect(findings.flags[0]).toMatchObject({ hunkId: "bump", kind: "gate" });
  });

  test("warnings never fail the check", () => {
    const findings = run({ h: { testLoosened: 1, safety: 1, commentDrift: 1, unrelated: 1, condition: 0.9 } });
    expect(findings.flags).toHaveLength(4);
    expect(findings.conclusion).toBe("success");
  });
});

describe("warnings", () => {
  test.each<[string, Spec, string[]]>([
    ["test loosened at threshold", { testLoosened: 0.4 }, ["h:test_loosened"]],
    ["test loosened below", { testLoosened: 0.39 }, []],
    ["safety check weakened", { safety: 0.7 }, ["h:safety_check_weakened"]],
    ["comment drift", { commentDrift: 0.7 }, ["h:comment_drift"]],
    ["unrelated to description, in a hunk that changes logic", { unrelated: 0.7, condition: 0.7 }, ["h:unrelated_to_description"]],
    ["unrelated to description, in a sensitive area", { unrelated: 0.7, area: "auth" }, ["h:unrelated_to_description"]],
    ["unrelated to description, where users would notice", { unrelated: 0.7, blast: "end users" }, ["h:unrelated_to_description"]],
    ["unrelated to description, in a hunk where nothing is at stake", { unrelated: 0.95, condition: 0.69 }, []],
    ["behaviour change in a feature is expected", { behaviour: 0.95, type: "feature" }, []],
    ["behaviour change in a refactor", { behaviour: 0.95, type: "refactor" }, ["h:refactor_changes_behaviour"]],
    ["refactor below the behaviour threshold", { behaviour: 0.39, type: "refactor" }, []],
    ["unsure it is a refactor", { behaviour: 0.95, type: "refactor", typeConfidence: 0.3 }, []],
  ])("%s", (_name, spec, expected) => {
    expect(flagIds(run({ h: spec }))).toEqual(expected);
  });
});

describe("prose", () => {
  test("questions about code raise nothing on documentation, gates and the description flag still do", () => {
    const readme = hunk("readme", { path: "docs/README.md" });
    const spec = { safety: 0.9, testLoosened: 0.9, commentDrift: 0.9, type: "refactor", behaviour: 0.9, unrelated: 0.9, secret: 0.95, blast: "end users" };
    const judgement = {
      hunks: { readme: answers(spec) },
      gateOnly: {},
      failed: [],
      pr: { description_quality: { score: 2 }, tests_cover_change: { noul: 1 } },
    } as unknown as Judgement;
    const findings = evaluate([readme], judgement, DESCRIPTION, parsePolicy(""));
    expect(flagIds(findings)).toEqual(["readme:secret_semantic", "readme:unrelated_to_description"]);
    expect(findings.readingOrder[0]!.nearMisses).toEqual([]);
  });
});

describe("test files", () => {
  test("a weakened check in a test file is reported once, as a loosened test", () => {
    const hunks = [hunk("spec", { isTest: true }), hunk("code")];
    const spec = { testLoosened: 0.9, safety: 0.9 };
    const judgement = {
      hunks: { spec: answers(spec), code: answers(spec) },
      gateOnly: {},
      failed: [],
      pr: { description_quality: { score: 2 }, tests_cover_change: { noul: 1 } },
    } as unknown as Judgement;
    const findings = evaluate(hunks, judgement, DESCRIPTION, parsePolicy(""));

    // The test file ranks below the production file it sits beside, so its flag comes after.
    expect(flagIds(findings)).toEqual(["code:test_loosened", "code:safety_check_weakened", "spec:test_loosened"]);
  });
});

describe("description", () => {
  test.each([
    ["empty", "", false],
    ["one word", "fix", false],
    ["whitespace padding does not count", `fix${" ".repeat(40)}`, false],
    ["a real sentence", DESCRIPTION, true],
  ])("%s", (_name, description, usable) => {
    expect(hasUsableDescription(description, parsePolicy(""))).toBe(usable);
  });

  test("a missing description gives one warning and no other description warnings", () => {
    const findings = run({ h: { unrelated: null } }, { description: "wip", pr: { quality: 0, tests: 0 } });
    expect(findings.prWarnings).toEqual([{ id: "no_description" }]);
  });

  test("a generic description and missing tests are warned about", () => {
    const findings = run({ h: {} }, { pr: { quality: 0.4, tests: 0.1 } });
    expect(findings.prWarnings).toEqual([
      { id: "weak_description", score: 0.4 },
      { id: "tests_missing", probability: 0.1 },
    ]);
  });
});

describe("split suggestion", () => {
  test.each<[string, Record<string, Spec>, string[] | null]>([
    ["feature, refactor, chore", { a: { type: "feature" }, b: { type: "refactor" }, c: { type: "chore" } }, ["chore", "feature", "refactor"]],
    ["two types", { a: { type: "feature" }, b: { type: "refactor" }, c: { type: "feature" } }, null],
    ["tests and docs ride along", { a: { type: "feature" }, b: { type: "test" }, c: { type: "docs" }, d: { type: "bugfix" } }, null],
    ["an unsure type does not count", { a: { type: "feature" }, b: { type: "refactor" }, c: { type: "chore", typeConfidence: 0.2 } }, null],
    ["a mechanical hunk does not count", { a: { type: "feature" }, b: { type: "refactor" }, c: { type: "chore", mechanical: 0.9 } }, null],
  ])("%s", (_name, specs, expected) => {
    const split = run(specs).prWarnings.find((warning) => warning.id === "split_suggested");
    expect(split ? split.changeTypes : null).toEqual(expected);
  });
});

describe("labels", () => {
  test("areas found, the dominant change type by changed lines, and a size", () => {
    const specs = {
      a: { area: "auth", type: "feature" },
      b: { area: "payments", type: "refactor" },
      c: { type: "refactor" },
      skipped: { area: "public_api", mechanical: 1 },
    };
    expect(run(specs, { policy: "labels: true" }).labels).toEqual(["area: auth", "area: payments", "size: S", "type: refactor"]);
    // Guessed labels are opt-in. They are often wrong on small PRs.
    expect(run(specs).labels).toEqual([]);
  });

  test.each([
    [50, "size: S"],
    [51, "size: M"],
    [250, "size: M"],
    [1000, "size: L"],
    [1001, "size: XL"],
  ])("%i changed lines is %s", (size, label) => {
    const judgement = { hunks: {}, gateOnly: {}, failed: [], pr: { description_quality: { score: 2 }, tests_cover_change: { noul: 1 } } };
    const findings = evaluate(
      [hunk("h", { size }), hunk("lock", { size: 9999, preClass: "lockfile" })],
      judgement as unknown as Judgement,
      DESCRIPTION,
      parsePolicy("labels: true"),
    );
    expect(findings.labels).toEqual([label]);
  });
});

describe("escalation", () => {
  const policy = "generator:\n  escalation:\n    areas: [auth]\n    blastRadius: ['money or data']";

  test("off by default", () => {
    expect(run({ h: { area: "auth", safety: 0.9 } }).flags[0]!.escalate).toBe(false);
  });

  test.each<[string, Spec, boolean]>([
    ["configured area", { area: "auth", safety: 0.9 }, true],
    ["configured blast radius", { blast: "money or data", safety: 0.9 }, true],
    ["neither", { area: "payments", blast: "end users", safety: 0.9 }, false],
  ])("%s", (_name, spec, expected) => {
    const findings = run({ h: spec }, { policy });
    expect(findings.flags[0]!.escalate).toBe(expected);
    expect(parsePolicy(policy).generator.escalation!.model).toBe("claude-opus-5");
  });
});

describe("custom questions", () => {
  const policy = [
    "customQuestions:",
    "  - id: invoicing",
    "    question: This chunk touches invoicing.",
    "    threshold: 0.5",
    "    label: touches-invoicing",
  ].join("\n");

  test("raise a warning and a label", () => {
    const findings = run({ h: { custom: { invoicing: 0.8 } } }, { policy });
    expect(findings.flags).toEqual([
      { findingId: expect.any(String), hunkId: "h", id: "custom:invoicing", kind: "warning", probability: 0.8, escalate: false },
    ]);
    expect(findings.labels).toContain("touches-invoicing");
  });

  test("can never gate, even at probability 1", () => {
    const findings = run({ h: { custom: { invoicing: 1 } } }, { policy });
    expect(findings.conclusion).toBe("success");
    expect(findings.flags.every((flag) => flag.kind === "warning")).toBe(true);
  });

  test("stay silent below their threshold", () => {
    const findings = run({ h: { custom: { invoicing: 0.49 } } }, { policy });
    expect(findings.flags).toEqual([]);
    expect(findings.labels).not.toContain("touches-invoicing");
  });
});

describe("hunk cap", () => {
  test("pre-classified hunks do not use up the cap, the overflow is kept for the report", () => {
    const hunks = [hunk("lock", { preClass: "lockfile" }), hunk("a"), hunk("b"), hunk("c")];
    const { judged, overCap } = selectForJudging(hunks, parsePolicy("maxHunks: 2"));
    expect(judged.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(overCap.map((entry) => entry.id)).toEqual(["c"]);
  });
});

describe("finding ids", () => {
  const edit = "@@ -2,3 +2,3 @@\n context\n-expect(total).toBe(100);\n+expect(total).toBeDefined();\n context";
  const judgementFor = (ids: string[], spec: Spec) =>
    ({
      hunks: Object.fromEntries(ids.map((id) => [id, answers(spec)])),
      gateOnly: {},
      failed: [],
      pr: { description_quality: { score: 2 }, tests_cover_change: { noul: 1 } },
    }) as unknown as Judgement;
  const idsOf = (hunks: Hunk[], spec: Spec = { testLoosened: 0.9 }) =>
    evaluate(hunks, judgementFor(hunks.map((entry) => entry.id), spec), DESCRIPTION, parsePolicy("")).flags.map(
      (flag) => flag.findingId,
    );
  const testHunk = (id: string, content: string) => hunk(id, { path: "test/invoice.test.ts", isTest: true, content });

  test("a finding keeps its id when a push moves the hunk without touching its changed lines", () => {
    const moved = edit.replace("@@ -2,3 +2,3 @@", "@@ -40,3 +40,3 @@").replaceAll("context", "other context");
    expect(idsOf([testHunk("t#1", moved)])).toEqual(idsOf([testHunk("t#0", edit)]));
  });

  test("a finding gets a new id when its changed lines change", () => {
    const changed = edit.replace("toBeDefined()", "toBeGreaterThan(0)");
    expect(idsOf([testHunk("t#0", changed)])).not.toEqual(idsOf([testHunk("t#0", edit)]));
  });

  test("two flags on one hunk, and the same edit twice in one file, all get different ids", () => {
    const ids = idsOf([testHunk("t#0", edit), testHunk("t#1", edit)], { testLoosened: 0.9, commentDrift: 0.9 });
    expect(new Set(ids).size).toBe(4);
    expect(ids[2]).toBe(`${ids[0]}-2`);
  });
});
