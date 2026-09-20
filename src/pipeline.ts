import { enclosingBlock, relatedHunks, type HunkContext } from "./context.js";
import { parseDiff, type Hunk } from "./diff.js";
import { judge, type JudgeClient } from "./judge.js";
import { evaluate, hasUsableDescription, selectForJudging, type Policy } from "./policy.js";
import { buildReport, type Previous, type Report } from "./report.js";
import { write, type Generator } from "./writer.js";

export interface PipelineInput {
  diff: string;
  title: string;
  description: string;
  policy: Policy;
  judgeClient: JudgeClient;
  generator: Generator;
  escalationGenerator?: Generator | undefined;
  /** Milliseconds clock, injected so the reported duration is testable. */
  now: () => number;
  prUrl?: string | undefined;
  headSha?: string | undefined;
  /** Reads a file as it is after the change, null when it cannot be read. Without it the writer sees the diff alone. */
  fetchFile?: ((path: string) => Promise<string | null>) | undefined;
  /** What the previous comment on this PR remembers. */
  previous?: Previous | null | undefined;
}

/** Diff in, report out. Touches no network except through the injected clients. */
export async function runPipeline(input: PipelineInput): Promise<Report> {
  const started = input.now();
  const { policy, title, description } = input;

  const { files, hunks } = parseDiff(input.diff, policy.exclude);
  const { judged, gateOnly } = selectForJudging(hunks, policy);
  const judgement = await judge(
    input.judgeClient,
    [...judged, ...gateOnly],
    { title, description, files: files.map((file) => file.path) },
    {
      customQuestions: Object.fromEntries(policy.customQuestions.map((question) => [question.id, question.question])),
      skipMismatch: !hasUsableDescription(description, policy),
      model: policy.judge.model,
    },
  );
  const findings = evaluate(hunks, judgement, description, policy);

  const typesByFile = new Map<string, Set<string>>();
  for (const hunk of judged) {
    const type = judgement.hunks[hunk.id]?.code.change_type.choice;
    if (type) typesByFile.set(hunk.path, (typesByFile.get(hunk.path) ?? new Set()).add(type));
  }
  const overview = [...typesByFile].map(([path, types]) => ({ path, changeTypes: [...types].sort() }));

  // A warning a reviewer ticked off stays off while its hunk is unchanged. It costs no writer call.
  // A gate is never dismissed this way: the box can be ticked by anything holding a token.
  const ticked = new Set(input.previous?.dismissed ?? []);
  const dismissed = findings.flags.filter((flag) => flag.kind === "warning" && ticked.has(flag.findingId));
  const flags = findings.flags.filter((flag) => !dismissed.includes(flag));

  const written = await write({
    flags,
    contexts: await contextsFor(flags, hunks, input.fetchFile),
    overview,
    hunks,
    title,
    description,
    policy,
    generator: input.generator,
    escalationGenerator: input.escalationGenerator,
  });
  return buildReport({
    hunks,
    findings,
    written,
    judgement,
    durationMs: input.now() - started,
    prUrl: input.prUrl,
    headSha: input.headSha,
    previous: input.previous,
    dismissed,
    debug: policy.debug,
    readingOrderFrom: policy.readingOrderFrom,
  });
}

type Flags = ReturnType<typeof evaluate>["flags"];

/** Context for each flagged hunk the writer will read. One file read per file, whatever the number of flags in it. */
async function contextsFor(
  flags: Flags,
  hunks: Hunk[],
  fetchFile: PipelineInput["fetchFile"],
): Promise<Map<string, HunkContext>> {
  // A suspected secret goes to no second vendor, not as a hunk and not inside another hunk's context.
  const secret = new Set(flags.filter((flag) => flag.id === "secret_semantic").map((flag) => flag.hunkId));
  const secretHunks = hunks.filter((hunk) => secret.has(hunk.id));
  const flagged = hunks.filter((hunk) => !secret.has(hunk.id) && flags.some((flag) => flag.hunkId === hunk.id));

  const files = new Map<string, Promise<string | null>>();
  const read = (path: string) => {
    if (!fetchFile) return Promise.resolve(null);
    let content = files.get(path);
    if (!content) files.set(path, (content = fetchFile(path).catch(() => null)));
    return content;
  };

  const contexts = new Map<string, HunkContext>();
  await Promise.all(
    flagged.map(async (hunk) => {
      const content = await read(hunk.path);
      let enclosing = content === null ? null : enclosingBlock(content, hunk.startLine, hunk.endLine);
      if (enclosing) {
        const last = enclosing.startLine + enclosing.text.split("\n").length - 1;
        const overlaps = secretHunks.some(
          (other) => other.path === hunk.path && other.startLine <= last && Math.max(other.endLine, other.startLine) >= enclosing!.startLine,
        );
        if (overlaps) enclosing = null;
      }
      const related = relatedHunks(hunk, hunks).filter((other) => !secret.has(other.id));
      contexts.set(hunk.id, { enclosing, related });
    }),
  );
  return contexts;
}
