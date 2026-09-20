import { getOctokit } from "@actions/github";
import { isSummaryComment } from "./report.js";

export const POLICY_PATH = ".git-judge-jev.yml";

// Label prefixes git-judge-jev owns. Labels with these prefixes are removed when they no longer apply.
const MANAGED_LABEL = /^(area|size|type): /;

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
}

export interface GitHub {
  fetchDiff(): Promise<string>;
  fetchPolicy(): Promise<string>;
  /** A file at the PR head, null when it is not there or is not text GitHub will serve. */
  fetchFile(path: string): Promise<string | null>;
  /** The body of the summary comment already on the PR, null on a first run. */
  fetchPreviousSummary(): Promise<string | null>;
  /** True when the PR has a newer head than the one this run judged. */
  headMoved(): Promise<boolean>;
  upsertSummary(body: string): Promise<void>;
  /** `removeStale` also takes off area, size, and type labels that no longer apply. Only when git-judge-jev put them there. */
  syncLabels(labels: string[], removeStale: boolean): Promise<void>;
}

export function createGitHub(token: string, pr: PullRequestRef): GitHub {
  const octokit = getOctokit(token);
  const repo = { owner: pr.owner, repo: pr.repo };

  const findSummary = async () => {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      ...repo,
      issue_number: pr.number,
      per_page: 100,
    });
    return comments.find((comment) => isSummaryComment(comment.body ?? ""));
  };

  return {
    async fetchDiff() {
      const response = await octokit.rest.pulls.get({
        ...repo,
        pull_number: pr.number,
        mediaType: { format: "diff" },
      });
      // With the diff media type the body is the raw diff, whatever the response type says.
      return response.data as unknown as string;
    },

    // Read from the base commit, never the head. A PR must not be able to loosen the policy it is judged by.
    async fetchPolicy() {
      try {
        const response = await octokit.rest.repos.getContent({
          ...repo,
          path: POLICY_PATH,
          ref: pr.baseSha,
          mediaType: { format: "raw" },
        });
        return response.data as unknown as string;
      } catch (error) {
        if ((error as { status?: number }).status === 404) return "";
        throw error;
      }
    },

    async fetchFile(path) {
      try {
        const response = await octokit.rest.repos.getContent({
          ...repo,
          path,
          ref: pr.headSha,
          mediaType: { format: "raw" },
        });
        return typeof response.data === "string" ? response.data : null;
      } catch {
        // A deleted file, a submodule, a file over the API's size limit. The writer reads the diff alone.
        return null;
      }
    },

    async fetchPreviousSummary() {
      return (await findSummary())?.body ?? null;
    },

    // Runs finish out of order. A run that lost the race must not write its report over a newer one.
    async headMoved() {
      const response = await octokit.rest.pulls.get({ ...repo, pull_number: pr.number });
      return response.data.head.sha !== pr.headSha;
    },

    async upsertSummary(body) {
      const existing = await findSummary();
      if (existing) {
        await octokit.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
      } else {
        await octokit.rest.issues.createComment({ ...repo, issue_number: pr.number, body });
      }
    },

    async syncLabels(labels, removeStale) {
      const current = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, {
        ...repo,
        issue_number: pr.number,
        per_page: 100,
      });
      const stale = removeStale
        ? current.filter((label) => MANAGED_LABEL.test(label.name) && !labels.includes(label.name))
        : [];
      for (const label of stale) {
        await octokit.rest.issues.removeLabel({ ...repo, issue_number: pr.number, name: label.name });
      }
      // Adding a label that does not exist yet creates it.
      if (labels.length > 0) await octokit.rest.issues.addLabels({ ...repo, issue_number: pr.number, labels });
    },
  };
}
