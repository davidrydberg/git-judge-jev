// Every question git-judge-jev asks TypeSafe's Jev model, grouped by the call it is sent in.
// This file is meant to be read and edited without knowing the rest of the pipeline.
//
// Rules for wording, from the Jev documentation:
// - Jev reads literally. Write the exact condition, not the intent behind it.
// - Ask one judgement per question. Combining answers happens in policy.ts, never here.
// - Never ask for counting, arithmetic, or date comparison.
//
// A "noul" is a yes/no question and returns the probability of yes.
// A "choice" picks one option and returns a probability per option.
// A "score" rates along ordered levels, lowest first.

import type { Questions } from "@typesafe-ai/sdk";

/**
 * Call A: the state is one hunk of code and its file path.
 * The PR description is never part of this call, so it cannot talk the model out of a gate.
 */
export const CODE_QUESTIONS = {
  secret_semantic: {
    type: "noul",
    instructions:
      "The added lines contain a credential, key, or token, or instructions for obtaining one.",
  },
  destructive_data: {
    type: "noul",
    instructions:
      "This change deletes, renames, or truncates a database table or column, or rewrites existing stored data.",
  },
  mechanical: {
    type: "noul",
    instructions:
      "This chunk is a mechanical change: rename, import reorder, formatting, generated code, lockfile, or version bump.",
  },
  refactor_changes_behaviour: {
    type: "noul",
    instructions:
      "The change alters what the program does for some input, not only how the code is organised.",
  },
  test_loosened: {
    type: "noul",
    instructions:
      "This change makes a test pass by weakening or removing an assertion rather than by fixing the code under test.",
  },
  safety_check_weakened: {
    type: "noul",
    instructions:
      "This change removes or weakens validation, error handling, a permission check, or a limit.",
  },
  comment_drift: {
    type: "noul",
    instructions:
      "A comment or docstring in this chunk no longer matches what the code beside it does.",
  },
  // The five below raise no flag. They say what kind of logic a chunk changes, which spreads the
  // attention scores of ordinary code apart and gives the reader a reason to open the chunk.
  error_handling_changed: {
    type: "noul",
    instructions:
      "The changed lines add, remove, or alter a try, catch, throw, error return, retry, or fallback value.",
  },
  condition_changed: {
    type: "noul",
    instructions:
      "The changed lines add, remove, or alter the condition of an if, a loop, a filter, or a query's where clause.",
  },
  external_io_added: {
    type: "noul",
    instructions:
      "The changed lines add a network request, a database write, a file write, a shell command, or a call to an external service.",
  },
  shared_state_changed: {
    type: "noul",
    instructions:
      "The changed lines add or alter a cache, a global or module-level variable, a lock, a transaction, or code that runs concurrently.",
  },
  limit_or_default_changed: {
    type: "noul",
    instructions:
      "The changed lines alter a numeric limit, a timeout, a threshold, a default value, or a feature flag.",
  },
  change_type: {
    type: "choice",
    instructions: "What kind of change is this?",
    criteria: {
      feature: null,
      bugfix: null,
      refactor: null,
      test: null,
      docs: null,
      chore: null,
    },
  },
  sensitive_area: {
    type: "choice",
    instructions:
      "Which area do the changed lines implement? A mention of an area in a comment, a string, a file path, test data, or documentation does not count, answer none for those.",
    criteria: {
      auth: null,
      payments: null,
      data_migration: null,
      public_api: null,
      none: null,
    },
  },
  blast_radius: {
    type: "choice",
    instructions: "Who could notice if this change is wrong?",
    criteria: {
      nobody: null,
      "other developers": null,
      "end users": null,
      "money or data": null,
    },
  },
} as const satisfies Questions;

/** Call B: the state is one hunk plus the PR title and description. */
export const MISMATCH_QUESTIONS = {
  unrelated_to_description: {
    type: "noul",
    instructions: "This chunk contains changes the PR description does not mention.",
  },
} as const satisfies Questions;

/** Call C: once per PR. The state is the title, the description, and the list of changed files. */
export const PR_QUESTIONS = {
  description_quality: {
    type: "score",
    instructions: "Rate the PR description.",
    criteria: ["generic", "names the area", "states what changed and why"],
  },
  tests_cover_change: {
    type: "noul",
    instructions: "The changed files include tests that plausibly cover the described change.",
  },
} as const satisfies Questions;

/** The only questions that can fail the check. Custom questions from the policy file can never be added here. */
export const GATES = ["secret_semantic", "destructive_data"] as const;

export type GateId = (typeof GATES)[number];

/**
 * Asked of hunks set aside by path as generated or vendored. The path is written by the PR author,
 * so it may spare a hunk the ranking but never the gates.
 */
export const GATE_QUESTIONS = {
  secret_semantic: CODE_QUESTIONS.secret_semantic,
  destructive_data: CODE_QUESTIONS.destructive_data,
} as const satisfies Questions;
