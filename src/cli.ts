import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createGenerator } from "./generators.js";
import { POLICY_PATH } from "./github.js";
import { createJudgeClient } from "./judge.js";
import { runPipeline } from "./pipeline.js";
import { parsePolicy } from "./policy.js";

// The same pipeline before a pull request exists, for the agent that is about to open one. It judges
// the branch against its base, posts nothing, and prints the report. With the action, this is the
// only module that reads the environment.
//
// Exit code: 0 nothing blocks, 1 a gate would fail the check, 2 it could not run.

const USAGE = `Usage: git-judge-jev [--base main] [--title text] [--description text | --description-file path] [--agent | --json]

Judges the current branch against its merge base with --base. Uncommitted changes to tracked files count, untracked files do not.
Give it the title and description the pull request will have, or the description findings cannot fire.
Needs TYPESAFE_API_KEY and OPENAI_API_KEY in the environment, ANTHROPIC_API_KEY if the policy names a Claude model.
Prints the comment as Markdown. With --agent, the findings for a coding agent as JSON: what to do about each and when it is resolved.
With --json, the full report. Exits 1 when a gate would fail the check.`;

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "main" },
      title: { type: "string" },
      description: { type: "string" },
      "description-file": { type: "string" },
      json: { type: "boolean", default: false },
      agent: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const typesafeKey = process.env.TYPESAFE_API_KEY;
  if (!typesafeKey) throw new Error("TYPESAFE_API_KEY is not set");

  const mergeBase = git("merge-base", values.base, "HEAD").trim();
  // Read from the base, like the action does, so the branch cannot loosen the policy it is judged by.
  let policyYaml = "";
  try {
    policyYaml = execFileSync("git", ["show", `${mergeBase}:${POLICY_PATH}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // No policy file at the base means the defaults.
  }
  const policy = parsePolicy(policyYaml);
  const keys = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
  const { escalation } = policy.generator;
  const root = git("rev-parse", "--show-toplevel").trim();

  const report = await runPipeline({
    diff: git("diff", mergeBase),
    title: values.title ?? git("log", "-1", "--format=%s").trim(),
    description: values["description-file"] ? readFileSync(values["description-file"], "utf8") : (values.description ?? ""),
    policy,
    judgeClient: createJudgeClient(typesafeKey),
    generator: createGenerator(policy.generator.model, keys),
    escalationGenerator: escalation ? createGenerator(escalation.model, keys) : undefined,
    now: Date.now,
    fetchFile: async (path) => {
      try {
        return readFileSync(`${root}/${path}`, "utf8");
      } catch {
        return null;
      }
    },
  });

  // The marker and the block for coding agents are for the comment on GitHub. A person at a terminal wants neither.
  console.log(
    values.agent
      ? JSON.stringify(report.handoff, null, 2)
      : values.json
        ? JSON.stringify(report.json, null, 2)
        : report.summary.replace(/^<!--.*-->\n/, "").replace(/\n\n<!-- git-judge-jev:agents -->[\s\S]*$/, ""),
  );
  if (report.check.conclusion === "failure") process.exitCode = 1;
}
