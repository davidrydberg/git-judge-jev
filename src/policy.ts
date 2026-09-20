import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isProse, type Hunk } from "./diff.js";
import type { HunkAnswers, Judgement } from "./judge.js";
import { GATES, type GateId } from "./questions.js";

const probability = z.number().min(0).max(1);
const weight = z.number().min(0);

const AREAS = ["auth", "payments", "data_migration", "public_api", "none"] as const;
const BLAST_RADII = ["nobody", "other developers", "end users", "money or data"] as const;

// Every number below is a guess until the calibrate command exists.
// Jev's calibration differs per repo and per language, so expect to tune these.
const policySchema = z.strictObject({
  thresholds: z
    .strictObject({
      gates: z
        .strictObject({
          secret_semantic: probability.default(0.9),
          destructive_data: probability.default(0.9),
        })
        .prefault({}),
      warnings: z
        .strictObject({
          // Low on purpose. Jev is the recall stage: the writer reads every flagged hunk and drops a
          // warning the code does not show, for about $0.0005 a hunk. Gates stay high, nothing clears them.
          test_loosened: probability.default(0.4),
          safety_check_weakened: probability.default(0.4),
          refactor_changes_behaviour: probability.default(0.4),
          comment_drift: probability.default(0.5),
          unrelated_to_description: probability.default(0.7),
        })
        .prefault({}),
      /** Warn when the description scores below this. 0 is generic, 2 states what changed and why. */
      descriptionQuality: z.number().min(0).max(2).default(1),
      /** Warn when the probability that tests cover the change is below this. */
      testsCoverChange: probability.default(0.3),
      /** A choice answer counts for labels and cross rules only at or above this confidence. */
      choiceConfidence: probability.default(0.5),
    })
    .prefault({}),
  weights: z
    .strictObject({
      area: z
        .strictObject({
          auth: weight.default(2),
          payments: weight.default(2),
          data_migration: weight.default(2),
          public_api: weight.default(1.5),
          none: weight.default(1),
        })
        .prefault({}),
      blastRadius: z
        .strictObject({
          nobody: weight.default(0.5),
          "other developers": weight.default(1),
          "end users": weight.default(1.5),
          "money or data": weight.default(2),
        })
        .prefault({}),
      /** Scales area and blast radius for a hunk in a test file. A loosened test still counts in full. */
      testFile: weight.default(0.5),
      /** How much the strongest logic signal (error handling, condition, IO, shared state, limit) adds: base * (1 + this * p). */
      logicSignal: weight.default(1),
    })
    .prefault({}),
  /** Hunks scoring below this are counted as mechanical. Set to 0 to rank every hunk and let every warning fire on it. */
  minAttention: z.number().min(0).default(0.5),
  /** Below this many characters the description is treated as missing. */
  minDescriptionLength: z.number().int().min(0).default(30),
  maxHunks: z.number().int().min(1).default(200),
  /** With no finding and fewer judged hunks than this, the comment leaves the reading order out. A small clean PR needs no guide. */
  readingOrderFrom: z.number().int().min(0).default(10),
  /** Apply area, size, and type labels. Off by default: they are often wrong on small PRs. */
  labels: z.boolean().default(false),
  /** Show the table of every raw Jev answer in the comment, and embed the answers in its JSON block. For tuning thresholds. */
  debug: z.boolean().default(false),
  /** Upper bound of changed lines per size label. Anything larger is XL. */
  sizeLabels: z
    .strictObject({
      S: z.number().int().default(50),
      M: z.number().int().default(250),
      L: z.number().int().default(1000),
    })
    .prefault({}),
  exclude: z
    .strictObject({
      generated: z.array(z.string()).default([]),
      vendored: z.array(z.string()).default([]),
      /**
       * Generated and vendored files are still asked the gate questions, since their path is the PR author's.
       * A path listed here is the maintainer's word, and is sent nowhere. For a large committed bundle,
       * where the gate check costs more time than the rest of the run.
       */
      unchecked: z.array(z.string()).default([]),
    })
    .prefault({}),
  judge: z.strictObject({ model: z.string().default("jev-latest") }).prefault({}),
  generator: z
    .strictObject({
      model: z.string().default("gpt-5.6-luna"),
      /** Off by default. When set, flags in these areas or blast radii go to the stronger model. */
      escalation: z
        .strictObject({
          model: z.string().default("claude-opus-5"),
          areas: z.array(z.enum(AREAS)).default([]),
          blastRadius: z.array(z.enum(BLAST_RADII)).default([]),
        })
        .nullable()
        .default(null),
    })
    .prefault({}),
  customQuestions: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9_]*$/),
        question: z.string().min(1),
        threshold: probability.default(0.6),
        label: z.string().min(1).optional(),
      }),
    )
    .default([]),
  failOnError: z.boolean().default(false),
});

export type Policy = z.infer<typeof policySchema>;

/** Parses the policy file. An empty or missing file gives the defaults. Unknown keys are errors. */
export function parsePolicy(yaml: string): Policy {
  const parsed = policySchema.safeParse(parseYaml(yaml) ?? {});
  if (!parsed.success) throw new Error(`Invalid git-judge-jev policy:\n${z.prettifyError(parsed.error)}`);
  const ids = parsed.data.customQuestions.map((question) => question.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Invalid git-judge-jev policy:\ncustom question id "${duplicate}" is used twice`);
  return parsed.data;
}

export type WarningId =
  | "test_loosened"
  | "safety_check_weakened"
  | "refactor_changes_behaviour"
  | "comment_drift"
  | "unrelated_to_description";

export interface Flag {
  /**
   * The flag, the file, and the hunk's changed lines, hashed. The hunk id is a position in the diff and
   * moves when a push adds a hunk above it, this does not. It covers the whole hunk, not only the lines
   * the flag is about: an edit within three lines merges into the hunk and reads as a new finding.
   */
  findingId: string;
  hunkId: string;
  /** A gate id, a warning id, or "custom:<id>" for a question from the policy file. */
  id: GateId | WarningId | `custom:${string}`;
  kind: "gate" | "warning";
  probability: number;
  /** Send this flag to the escalation generator instead of the default one. */
  escalate: boolean;
}

export type PrWarning =
  | { id: "no_description" }
  | { id: "weak_description"; score: number }
  | { id: "tests_missing"; probability: number }
  | { id: "split_suggested"; changeTypes: string[] };

/** A question that scored under its threshold but close enough to tell the reader what to look for. */
export interface NearMiss {
  id: Flag["id"];
  probability: number;
  threshold: number;
}

export interface Findings {
  flags: Flag[];
  prWarnings: PrWarning[];
  /** Hunks worth reading, most important first. */
  readingOrder: {
    hunkId: string;
    attention: number;
    nearMisses: NearMiss[];
    /** Logic signals Jev is sure of, strongest first. They raise nothing, they tell the reader what kind of code changed. */
    signals: (typeof LOGIC_SIGNALS)[number][];
    /** Jev's picks for the hunk, each null when it was not confident enough to be repeated to a reader. */
    changeType: string | null;
    area: string | null;
    blastRadius: string | null;
  }[];
  skipped: {
    mechanical: number;
    lockfile: number;
    generated: number;
    vendored: number;
    /** Hunks in paths the policy lists under `exclude.unchecked`. Sent nowhere. */
    unchecked: number;
    overCap: number;
    /** Hunks TypeSafe gave no answer for after retries. */
    failed: number;
    /** Generated or vendored hunks too large to check for gates in full. */
    gateOnlyCut: number;
  };
  lowCoverage: string[];
  labels: string[];
  conclusion: "success" | "failure";
}

export function hasUsableDescription(description: string, policy: Policy): boolean {
  return description.trim().length >= policy.minDescriptionLength;
}

/**
 * Splits hunks into those judged in full, those asked the gate questions only, and those left out by
 * the hunk cap, each in diff order. Generated and vendored hunks take what the cap has left.
 */
export function selectForJudging(
  hunks: Hunk[],
  policy: Policy,
): { judged: Hunk[]; gateOnly: Hunk[]; overCap: Hunk[] } {
  const candidates = hunks.filter((hunk) => hunk.preClass === null);
  const setAside = hunks.filter((hunk) => hunk.preClass === "generated" || hunk.preClass === "vendored");
  const judged = candidates.slice(0, policy.maxHunks);
  const gateOnly = setAside.slice(0, policy.maxHunks - judged.length);
  return { judged, gateOnly, overCap: [...candidates.slice(judged.length), ...setAside.slice(gateOnly.length)] };
}

/** A hunk counts as a refactor only when Jev picks that type with enough confidence. */
function claimsRefactor(answers: HunkAnswers, policy: Policy): boolean {
  const type = answers.code.change_type;
  return type.choice === "refactor" && type.confidence >= policy.thresholds.choiceConfidence;
}

/** Questions that raise no flag and only say what kind of logic changed. */
export const LOGIC_SIGNALS = [
  "error_handling_changed",
  "condition_changed",
  "external_io_added",
  "shared_state_changed",
  "limit_or_default_changed",
] as const;

export interface HunkTraits {
  isTest?: boolean;
  /** Prose has no tests to loosen and no checks to weaken, so only area and blast radius count. */
  isProse?: boolean;
}

export function attention(answers: HunkAnswers, policy: Policy, traits: HunkTraits = {}): number {
  const { code } = answers;
  const { isTest = false } = traits;
  if (traits.isProse) {
    return (
      (1 - code.mechanical.noul) *
      expectedWeight(code.sensitive_area.probabilities, policy.weights.area) *
      expectedWeight(code.blast_radius.probabilities, policy.weights.blastRadius)
    );
  }
  // Every feature and bugfix changes behaviour, and Jev says so at 0.95. Counted for all hunks it
  // drowned out the other two signals, so it counts only where it is a finding: inside a refactor.
  const judgement = Math.max(
    code.test_loosened.noul,
    code.safety_check_weakened.noul,
    claimsRefactor(answers, policy) ? code.refactor_changes_behaviour.noul : 0,
  );
  // A test that mentions auth is not auth code. Where scores are close, which is most PRs, tests
  // were outranking the production code they cover. The judgement term is left alone.
  const logic = Math.max(...LOGIC_SIGNALS.map((id) => code[id].noul));
  return (
    (isTest ? policy.weights.testFile : 1) *
      (1 + policy.weights.logicSignal * logic) *
      (1 - code.mechanical.noul) *
      expectedWeight(code.sensitive_area.probabilities, policy.weights.area) *
      expectedWeight(code.blast_radius.probabilities, policy.weights.blastRadius) +
    2 * judgement
  );
}

// The probability-weighted weight, not the weight of the top option, so a hunk that is
// 51% auth and one that is 49% auth score almost the same instead of jumping a whole weight.
function expectedWeight<K extends string>(
  probabilities: Readonly<Record<K, number>>,
  weights: Readonly<Record<K, number>>,
): number {
  let sum = 0;
  for (const option of Object.keys(weights) as K[]) sum += probabilities[option] * weights[option];
  return sum;
}

// Tests and docs accompany any kind of change, so they never count towards a split.
const SPLITTABLE_TYPES = new Set(["feature", "bugfix", "refactor", "chore"]);

// A score from this share of its threshold up to the threshold is a near miss. It raises nothing
// and costs nothing, it only tells the reader why a hunk with no finding is still worth a look.
const NEAR_MISS_SHARE = 0.5;
// A logic signal is repeated to the reader only when Jev is this sure of it.
const SIGNAL_SHOWN = 0.7;

export function evaluate(
  hunks: Hunk[],
  judgement: Judgement,
  description: string,
  policy: Policy,
): Findings {
  const judged = hunks.flatMap((hunk) => {
    const answers = judgement.hunks[hunk.id];
    if (!answers) return [];
    const traits = { isTest: hunk.isTest, isProse: isProse(hunk.path) };
    return [{ hunk, answers, attention: attention(answers, policy, traits) }];
  });
  const confident = (answer: { confidence: number }) =>
    answer.confidence >= policy.thresholds.choiceConfidence;
  const sure = (answer: { choice: string; confidence: number }) => (confident(answer) ? answer.choice : null);

  const flags: Flag[] = [];
  const ids = new Map<string, number>();
  const flag = (hunk: Hunk, fields: Omit<Flag, "findingId" | "hunkId">) => {
    const changed = hunk.content.split("\n").filter((line) => /^[+-]/.test(line));
    const id = createHash("sha256").update([fields.id, hunk.path, ...changed].join("\n")).digest("hex").slice(0, 12);
    const count = (ids.get(id) ?? 0) + 1;
    ids.set(id, count);
    // The same edit twice in one file hashes the same, so the later one is numbered.
    flags.push({ findingId: count === 1 ? id : `${id}-${count}`, hunkId: hunk.id, ...fields });
  };
  const gated = new Set<string>();
  const nearMisses = new Map<string, NearMiss[]>();
  const nearMiss = (hunkId: string, id: Flag["id"], probability: number, threshold: number) => {
    if (probability < threshold * NEAR_MISS_SHARE) return;
    nearMisses.set(hunkId, [...(nearMisses.get(hunkId) ?? []), { id, probability, threshold }]);
  };
  for (const { hunk, answers } of judged) {
    // Gates compare a probability with a threshold and nothing else. The generator writes about
    // a gate flag but cannot clear it, since it reads the same author-controlled code.
    for (const id of GATES) {
      const probability = answers.code[id].noul;
      if (probability >= policy.thresholds.gates[id]) {
        flag(hunk, { id, kind: "gate", probability, escalate: escalates(answers, policy) });
        gated.add(hunk.id);
      } else {
        nearMiss(hunk.id, id, probability, policy.thresholds.gates[id]);
      }
    }
  }

  // A path is written by the PR author. It spares a generated or vendored hunk the ranking, never the gates.
  for (const hunk of hunks) {
    const gateOnly = judgement.gateOnly[hunk.id];
    if (!gateOnly) continue;
    for (const id of GATES) {
      const probability = gateOnly.answers[id].noul;
      if (probability < policy.thresholds.gates[id]) continue;
      flag(hunk, { id, kind: "gate", probability, escalate: false });
      gated.add(hunk.id);
    }
  }

  const reading = judged
    .filter((entry) => entry.attention >= policy.minAttention || gated.has(entry.hunk.id))
    .sort(
      (a, b) =>
        Number(gated.has(b.hunk.id)) - Number(gated.has(a.hunk.id)) || b.attention - a.attention,
    );

  for (const { hunk, answers } of reading) {
    const warn = (id: Flag["id"], probability: number, threshold: number) => {
      if (probability >= threshold) {
        flag(hunk, { id, kind: "warning", probability, escalate: escalates(answers, policy) });
        // The description flag is a statement about the PR, so a near miss on it says nothing about this hunk.
      } else if (id !== "unrelated_to_description") {
        nearMiss(hunk.id, id, probability, threshold);
      }
    };
    const { code, mismatch, custom } = answers;
    const thresholds = policy.thresholds.warnings;
    // Jev scored "safety check weakened" 0.30 on a README. Questions about code are not asked of prose.
    const isCode = !isProse(hunk.path);
    if (isCode) warn("test_loosened", code.test_loosened.noul, thresholds.test_loosened);
    // In a test file a weakened check is a loosened test, which is already its own flag.
    if (isCode && !hunk.isTest) {
      warn("safety_check_weakened", code.safety_check_weakened.noul, thresholds.safety_check_weakened);
    }
    if (isCode) warn("comment_drift", code.comment_drift.noul, thresholds.comment_drift);
    // Changing behaviour is only worth a warning when the hunk presents itself as a refactor.
    if (isCode && claimsRefactor(answers, policy)) {
      warn(
        "refactor_changes_behaviour",
        code.refactor_changes_behaviour.noul,
        thresholds.refactor_changes_behaviour,
      );
    }
    if (mismatch) {
      warn("unrelated_to_description", mismatch.unrelated_to_description.noul, thresholds.unrelated_to_description);
    }
    for (const question of policy.customQuestions) {
      const probability = custom[question.id];
      if (probability !== undefined) warn(`custom:${question.id}`, probability, question.threshold);
    }
  }

  const prWarnings: PrWarning[] = [];
  if (!hasUsableDescription(description, policy)) {
    prWarnings.push({ id: "no_description" });
  } else {
    const { score } = judgement.pr.description_quality;
    if (score < policy.thresholds.descriptionQuality) prWarnings.push({ id: "weak_description", score });
    const covered = judgement.pr.tests_cover_change.noul;
    if (covered < policy.thresholds.testsCoverChange) {
      prWarnings.push({ id: "tests_missing", probability: covered });
    }
  }
  const changeTypes = new Set(
    reading
      .map(({ answers }) => answers.code.change_type)
      .filter((answer) => confident(answer) && SPLITTABLE_TYPES.has(answer.choice))
      .map((answer) => answer.choice),
  );
  if (changeTypes.size >= 3) prWarnings.push({ id: "split_suggested", changeTypes: [...changeTypes].sort() });

  const count = (preClass: Hunk["preClass"]) => hunks.filter((hunk) => hunk.preClass === preClass).length;
  const failed = new Set(judgement.failed);
  const unjudged = hunks.filter(
    (hunk) =>
      hunk.preClass !== "lockfile" &&
      hunk.preClass !== "unchecked" &&
      !judgement.hunks[hunk.id] &&
      !judgement.gateOnly[hunk.id] &&
      !failed.has(hunk.id),
  );

  return {
    flags,
    prWarnings,
    readingOrder: reading.map((entry) => ({
      hunkId: entry.hunk.id,
      attention: entry.attention,
      nearMisses: nearMisses.get(entry.hunk.id) ?? [],
      signals: isProse(entry.hunk.path)
        ? []
        : LOGIC_SIGNALS.filter((id) => entry.answers.code[id].noul >= SIGNAL_SHOWN).sort(
            (a, b) => entry.answers.code[b].noul - entry.answers.code[a].noul,
          ),
      changeType: sure(entry.answers.code.change_type),
      area: sure(entry.answers.code.sensitive_area),
      blastRadius: sure(entry.answers.code.blast_radius),
    })),
    skipped: {
      mechanical: judged.length - reading.length,
      lockfile: count("lockfile"),
      generated: count("generated"),
      vendored: count("vendored"),
      unchecked: count("unchecked"),
      overCap: unjudged.length,
      failed: failed.size,
      gateOnlyCut: Object.values(judgement.gateOnly).filter((answers) => answers.lowCoverage).length,
    },
    lowCoverage: judged.filter((entry) => entry.answers.lowCoverage).map((entry) => entry.hunk.id),
    labels: labels(hunks, reading, flags, policy),
    conclusion: gated.size > 0 ? "failure" : "success",
  };
}

function escalates(answers: HunkAnswers, policy: Policy): boolean {
  const { escalation } = policy.generator;
  if (!escalation) return false;
  return (
    escalation.areas.includes(answers.code.sensitive_area.choice) ||
    escalation.blastRadius.includes(answers.code.blast_radius.choice)
  );
}

function labels(
  hunks: Hunk[],
  reading: { hunk: Hunk; answers: HunkAnswers }[],
  flags: Flag[],
  policy: Policy,
): string[] {
  const result = new Set<string>();
  // A label a maintainer asked for by name is always applied. The guessed ones are opt-in.
  for (const question of policy.customQuestions) {
    if (question.label && flags.some((flag) => flag.id === `custom:${question.id}`)) result.add(question.label);
  }
  if (!policy.labels) return [...result].sort();

  const sizeByType = new Map<string, number>();
  for (const { hunk, answers } of reading) {
    const { sensitive_area: area, change_type: type } = answers.code;
    if (area.choice !== "none" && area.confidence >= policy.thresholds.choiceConfidence) {
      result.add(`area: ${area.choice}`);
    }
    sizeByType.set(type.choice, (sizeByType.get(type.choice) ?? 0) + hunk.size);
  }
  const dominant = [...sizeByType].sort((a, b) => b[1] - a[1])[0];
  if (dominant) result.add(`type: ${dominant[0]}`);

  const changed = hunks
    .filter((hunk) => hunk.preClass === null)
    .reduce((sum, hunk) => sum + hunk.size, 0);
  const { S, M, L } = policy.sizeLabels;
  result.add(`size: ${changed <= S ? "S" : changed <= M ? "M" : changed <= L ? "L" : "XL"}`);
  return [...result].sort();
}
