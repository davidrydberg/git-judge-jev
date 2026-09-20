import {
  TypeSafeClient,
  type Questions,
  type SystemOneRequest,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import type { Hunk } from "./diff.js";
import { CODE_QUESTIONS, GATE_QUESTIONS, MISMATCH_QUESTIONS, PR_QUESTIONS } from "./questions.js";

/** The slice of the TypeSafe SDK the judge uses. Tests pass a fake that records requests. */
export interface JudgeClient {
  systemOne<Q extends Questions>(request: SystemOneRequest<Q>): PromiseLike<SystemOneResult<Q>>;
}

export interface PullRequestMeta {
  title: string;
  description: string;
  /** Paths of every changed file, including pre-classified and binary ones. */
  files: string[];
}

export interface JudgeOptions {
  /** Custom noul questions from the policy file, id to wording. They run in call A. */
  customQuestions?: Record<string, string>;
  /** Set when the description is too short to compare against. Call B is not made. */
  skipMismatch?: boolean;
  model?: string;
  concurrency?: number;
}

type Answers<Q extends Questions> = SystemOneResult<Q>["answers"];

export interface HunkAnswers {
  code: Answers<typeof CODE_QUESTIONS>;
  /** Probability of yes per custom question id. */
  custom: Record<string, number>;
  mismatch: Answers<typeof MISMATCH_QUESTIONS> | null;
  /** The hunk did not fit the state cap and was judged on its first part only. */
  lowCoverage: boolean;
}

/** A hunk set aside by path as generated or vendored. It is asked the gate questions and nothing else. */
export interface GateAnswers {
  answers: Answers<typeof GATE_QUESTIONS>;
  lowCoverage: boolean;
}

export interface Judgement {
  hunks: Record<string, HunkAnswers>;
  gateOnly: Record<string, GateAnswers>;
  /** Hunks whose requests still failed after the SDK's retries. They are reported, not judged. */
  failed: string[];
  pr: Answers<typeof PR_QUESTIONS>;
  /** The versioned model id that answered, as reported by TypeSafe. */
  model: string;
  requests: number;
  inputTokens: number;
}

// Jev allows 32k tokens for the state plus the longest question, and 64k for the state plus
// all questions. TypeSafe documents no tokenizer, so tokens are estimated from characters.
// Measured against jev-1.13.0 on 2026-09-18: code runs at about 3.8 characters per token, so three
// overestimates and keeps requests under the cap. Every request also carries about 270 tokens of
// fixed overhead that is not part of the state or the questions.
export const REQUEST_OVERHEAD_TOKENS = 300;
const STATE_AND_LONGEST_QUESTION_TOKENS = 32_000;
const STATE_AND_ALL_QUESTIONS_TOKENS = 64_000;
const CHARS_PER_TOKEN = 3;
const MAX_DESCRIPTION_CHARS = 6_000;
const DEFAULT_CONCURRENCY = 8;
const CUSTOM_PREFIX = "custom:";
// One bad hunk must not cost the whole report, and an outage must not be retried hunk by hunk.
// Past this many failures, with most finished requests failing, the run gives up.
const MAX_TOLERATED_FAILURES = 5;

export function createJudgeClient(apiKey: string): JudgeClient {
  // The SDK retries 408, 429, and 5xx (which covers 529 Overloaded) with backoff and honours
  // retry-after. A PR fans out into many requests, so allow more attempts than the default 2.
  return new TypeSafeClient({ apiKey, retry: { maxRetries: 4 } });
}

export async function judge(
  client: JudgeClient,
  hunks: Hunk[],
  pr: PullRequestMeta,
  options: JudgeOptions = {},
): Promise<Judgement> {
  const model = options.model ?? "jev-latest";
  const description = pr.description.slice(0, MAX_DESCRIPTION_CHARS);
  const codeQuestions: Questions = { ...CODE_QUESTIONS };
  for (const [id, instructions] of Object.entries(options.customQuestions ?? {})) {
    codeQuestions[CUSTOM_PREFIX + id] = { type: "noul", instructions };
  }

  let requests = 0;
  let inputTokens = 0;
  let answeredBy = model;
  const ask = async <Q extends Questions>(state: SystemOneRequest<Q>["state"], questions: Q) => {
    const result = await client.systemOne({ state, questions, model });
    requests++;
    inputTokens += result.usage.input_tokens;
    answeredBy = result.model;
    for (const [id, question] of Object.entries(questions)) {
      const answer: { type: string } | undefined = result.answers[id];
      if (answer?.type !== question.type) {
        throw new Error(`TypeSafe returned no ${question.type} answer for question "${id}"`);
      }
    }
    return result.answers;
  };

  const judgeHunk = async (hunk: Hunk): Promise<[string, HunkAnswers]> => {
    const codeState = fitDiff({ file: hunk.path, language: hunk.language }, hunk.content, codeQuestions);
    const mismatchState = fitDiff(
      { pr_title: pr.title, pr_description: description, file: hunk.path },
      hunk.content,
      MISMATCH_QUESTIONS,
    );
    const [all, mismatch] = await Promise.all([
      ask(codeState.state, codeQuestions),
      options.skipMismatch ? null : ask(mismatchState.state, MISMATCH_QUESTIONS),
    ]);

    const custom: Record<string, number> = {};
    for (const [key, answer] of Object.entries(all)) {
      if (key.startsWith(CUSTOM_PREFIX) && answer.type === "noul") {
        custom[key.slice(CUSTOM_PREFIX.length)] = answer.noul;
      }
    }
    return [
      hunk.id,
      {
        code: all as unknown as Answers<typeof CODE_QUESTIONS>,
        custom,
        mismatch,
        lowCoverage: codeState.truncated || (!options.skipMismatch && mismatchState.truncated),
      },
    ];
  };

  const judgeGates = async (hunk: Hunk): Promise<[string, GateAnswers]> => {
    const { state, truncated } = fitDiff({ file: hunk.path, language: hunk.language }, hunk.content, GATE_QUESTIONS);
    return [hunk.id, { answers: await ask(state, GATE_QUESTIONS), lowCoverage: truncated }];
  };

  const failed: string[] = [];
  let finished = 0;
  let lastError: unknown;
  const tolerant =
    <R>(fn: (hunk: Hunk) => Promise<R>) =>
    async (hunk: Hunk): Promise<R | null> => {
      try {
        return await fn(hunk);
      } catch (error) {
        failed.push(hunk.id);
        lastError = error;
        if (failed.length > MAX_TOLERATED_FAILURES && failed.length * 2 > finished + 1) throw error;
        return null;
      } finally {
        finished++;
      }
    };

  // Lockfiles never reach the model. Generated and vendored hunks are asked the gate questions only.
  const judged = hunks.filter((hunk) => hunk.preClass === null);
  const gateOnly = hunks.filter((hunk) => hunk.preClass === "generated" || hunk.preClass === "vendored");
  // One pool for both kinds, so the limit holds across them.
  type Answered = { full: [string, HunkAnswers] | null; gates: [string, GateAnswers] | null };
  const one = async (hunk: Hunk): Promise<Answered> =>
    hunk.preClass === null
      ? { full: await judgeHunk(hunk), gates: null }
      : { full: null, gates: await judgeGates(hunk) };
  const [answered, prAnswers] = await Promise.all([
    mapPool([...judged, ...gateOnly], options.concurrency ?? DEFAULT_CONCURRENCY, tolerant(one)),
    ask(fitFileList({ title: pr.title, description }, pr.files), PR_QUESTIONS),
  ]);
  const perHunk = answered.flatMap((entry) => (entry?.full ? [entry.full] : []));
  const perGateHunk = answered.flatMap((entry) => (entry?.gates ? [entry.gates] : []));
  // Every hunk failing is an outage, not a bad hunk.
  if (failed.length > 0 && failed.length === judged.length + gateOnly.length) throw lastError;

  return {
    hunks: Object.fromEntries(perHunk),
    gateOnly: Object.fromEntries(perGateHunk),
    failed,
    pr: prAnswers,
    model: answeredBy,
    requests,
    inputTokens,
  };
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

function stateBudgetChars(questions: Questions): number {
  const sizes = Object.values(questions).map(estimateTokens);
  const tokens = Math.min(
    STATE_AND_LONGEST_QUESTION_TOKENS - Math.max(...sizes),
    STATE_AND_ALL_QUESTIONS_TOKENS - sizes.reduce((sum, size) => sum + size, 0),
  );
  return (tokens - REQUEST_OVERHEAD_TOKENS) * CHARS_PER_TOKEN;
}

/** Adds the hunk to the state as `diff`, cut at a line boundary if the state would exceed the cap. */
function fitDiff(
  context: Record<string, string | null>,
  diff: string,
  questions: Questions,
): { state: Record<string, string | null>; truncated: boolean } {
  const budget = stateBudgetChars(questions) - JSON.stringify({ ...context, diff: "" }).length;
  if (JSON.stringify(diff).length <= budget) return { state: { ...context, diff }, truncated: false };

  const kept: string[] = [];
  let used = 0;
  for (const line of diff.split("\n")) {
    used += JSON.stringify(line).length + 1;
    if (used > budget) break;
    kept.push(line);
  }
  return { state: { ...context, diff: kept.join("\n") }, truncated: true };
}

function fitFileList(
  context: Record<string, string>,
  files: string[],
): Record<string, string | string[]> {
  const budget = stateBudgetChars(PR_QUESTIONS) - JSON.stringify({ ...context, changed_files: [] }).length;
  const kept: string[] = [];
  let used = 0;
  for (const file of files) {
    used += JSON.stringify(file).length + 1;
    if (used > budget) break;
    kept.push(file);
  }
  return { ...context, changed_files: kept };
}

/** Maps with at most `limit` calls in flight. Stops starting new calls once one has failed. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
