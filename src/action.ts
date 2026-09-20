import * as core from "@actions/core";
import { context } from "@actions/github";
import { createGenerator } from "./generators.js";
import { createGitHub, type GitHub } from "./github.js";
import { createJudgeClient } from "./judge.js";
import { runPipeline } from "./pipeline.js";
import { parsePolicy } from "./policy.js";
import { buildDidNotRunReport, readPrevious } from "./report.js";

async function main(): Promise<void> {
  const pull = context.payload.pull_request;
  if (!pull) {
    core.setFailed("git-judge-jev only runs on pull_request events.");
    return;
  }
  // A fork PR gets no secrets under pull_request, and pull_request_target has not had its security review.
  if (pull.head.repo?.full_name !== pull.base.repo.full_name) {
    core.notice("git-judge-jev does not run on pull requests from forks yet.");
    return;
  }

  // Dependabot runs in the same repo but is given no secrets and a read-only token. Without this it
  // would fail on the missing key, then fail again trying to say so in a comment. Only Dependabot:
  // a key missing from any other run is a broken setup, and must not read as a pass.
  if (context.actor === "dependabot[bot]" && !core.getInput("typesafe-api-key")) {
    core.notice("git-judge-jev did not judge this pull request. Dependabot pull requests get no secrets.");
    core.setOutput("conclusion", "did_not_run");
    return;
  }

  const github = createGitHub(core.getInput("github-token", { required: true }), {
    owner: context.repo.owner,
    repo: context.repo.repo,
    number: pull.number,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
  });

  // A broken policy file is the maintainer's bug, not an outage. It fails loudly instead of passing quietly.
  const policy = parsePolicy(await github.fetchPolicy());

  // Memory is a nicety. A comment that cannot be read costs the "new" marks, not the run.
  const previousSummary = await github.fetchPreviousSummary().catch(() => null);
  const previous = previousSummary ? readPrevious(previousSummary) : null;

  let report;
  try {
    const keys = {
      openai: core.getInput("openai-api-key") || undefined,
      anthropic: core.getInput("anthropic-api-key") || undefined,
    };
    const { escalation } = policy.generator;
    report = await runPipeline({
      diff: await github.fetchDiff(),
      title: pull.title,
      description: pull.body ?? "",
      policy,
      judgeClient: createJudgeClient(core.getInput("typesafe-api-key", { required: true })),
      generator: createGenerator(policy.generator.model, keys),
      escalationGenerator: escalation ? createGenerator(escalation.model, keys) : undefined,
      now: Date.now,
      prUrl: pull.html_url,
      headSha: pull.head.sha,
      fetchFile: (path) => github.fetchFile(path),
      previous,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (await skipIfStale(github)) return;
    const didNotRun = buildDidNotRunReport(reason, policy.failOnError, previous?.dismissed);
    await github.upsertSummary(didNotRun.summary);
    core.setOutput("conclusion", "did_not_run");
    if (didNotRun.check.conclusion === "failure") core.setFailed(`git-judge-jev did not run: ${reason}`);
    else core.warning(`git-judge-jev did not run: ${reason}`);
    return;
  }

  if (await skipIfStale(github)) return;
  await github.upsertSummary(report.summary);
  if (policy.labels || report.labels.length > 0) await github.syncLabels(report.labels, policy.labels);
  // Every tick is a labelled false positive. This line is the per-repo precision record for tuning thresholds.
  const shown = report.json.verdicts.filter((verdict) => verdict.kind === "warning" && verdict.material).length;
  core.info(`feedback: ${report.json.dismissed.length} dismissed by a reviewer, ${shown} shown`);
  core.setOutput("conclusion", report.check.conclusion);
  core.setOutput("json", JSON.stringify(report.json));
  core.setOutput("handoff", JSON.stringify(report.handoff));
  if (report.check.conclusion === "failure") core.setFailed(report.check.title);
  else core.info(report.check.title);
}

async function skipIfStale(github: GitHub): Promise<boolean> {
  // If the head cannot be read the report is posted. A failed lookup must not hide the run's own
  // result, or in the error path the reason the pipeline failed.
  const moved = await github.headMoved().catch(() => false);
  if (!moved) return false;
  core.notice("The pull request has a newer commit. This run posts nothing, the run for that commit will.");
  core.setOutput("conclusion", "did_not_run");
  return true;
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
