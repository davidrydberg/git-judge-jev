# readfirst - PRD

Status: version 0 built 2026-09-18 and run on this repo's own pull requests since. Not yet measured on pull requests nobody planted a defect in, see decision 50.
The project was called readfirst when this was written, and the text below keeps that name. It is git-judge-jev since decision 43.
Not filed as a GitHub issue by request.
Decisions that changed during the build are marked "Build note" where they apply.

---

## Problem Statement

Code review is now the bottleneck, and the code being reviewed is increasingly written by agents.

A typical agent-written pull request is 30 files.
Most of those files are import reorders, renames, formatting, and a lockfile.
A handful contain the actual change.
The reviewer opens the Files tab, does not know where to start, and postpones.
The cost of a review is in starting it, not in reading it.

Three things go wrong in these PRs that a human reviewer routinely misses:

- The agent makes a failing test pass by loosening the assertion instead of fixing the code, then reports green.
- The PR does more than its description says: a migration, an auth change, or a refactor slipped in to make the task work.
- The description was written by the same agent that wrote the code, so it cannot be trusted as a summary.

Existing review bots run a generative model over every hunk and leave 30 comments of equal weight.
They are expensive enough that teams run them only on "important" PRs, and noisy enough that reviewers stop reading them.

## Solution

readfirst is a GitHub Action that tells the reviewer where to look and when the PR's story does not match its diff.

On every push to a PR it:

- Ranks every hunk by how much human attention it deserves, using TypeSafe's Jev model, which returns calibrated probabilities instead of text.
- Flags a small fixed set of things that only judgement can catch: loosened tests, weakened safety checks, behaviour changes disguised as refactors, drive-by changes the description does not mention, destructive migrations.
- Sends only the flagged hunks to a generative model, which confirms or rejects each flag while looking at the code and writes one sentence on what changed and what to verify.
- Posts one summary comment, updated in place, with a two-sentence TL;DR, a reading order, and a count of mechanical hunks to skip.
- Posts one inline comment per confirmed flag.
- Applies labels and a pass/fail check that fails only on hard gates.

A 40-hunk PR costs about half a cent and finishes in a few seconds.
The reviewer reads 4 hunks instead of 40, and starts now instead of tomorrow.

readfirst does not find logic bugs and does not suggest code.
It reorders review and blocks the two things that must never merge.

## User Stories

1. As a reviewer, I want a reading order for the PR, so that I can start with the hunks that matter instead of scrolling 30 files.
2. As a reviewer, I want mechanical hunks (imports, renames, formatting, lockfiles) counted and set aside, so that I can skip them with confidence.
3. As a reviewer, I want a two-sentence TL;DR at the top of the PR, so that I know what the PR really does before I open a file.
4. As a reviewer, I want to be told when a test assertion was loosened, so that a green test suite does not hide a broken fix.
5. As a reviewer, I want to be told when validation, error handling, a permission check, or a limit was removed or weakened, so that I look at that hunk first.
6. As a reviewer, I want to be told when a change labelled a refactor alters behaviour, so that I do not wave it through.
7. As a reviewer, I want to be told when a hunk changes something the PR description does not mention, so that drive-by changes are visible.
8. As a reviewer, I want each flag to come with one sentence on what changed and one on what to verify, so that I do not have to reverse-engineer why it was flagged.
9. As a reviewer, I want flags that the generative model rejected after reading the code to disappear, so that I only see flags that survived a second look.
10. As a reviewer, I want the summary comment updated in place on every push, so that the PR does not fill with stale bot comments.
11. As a reviewer, I want inline comments that are still valid after a push to stay where they are, so that my replies on them are not lost.
12. As a reviewer, I want to be told which sensitive area a PR touches (auth, payments, data migration, public API), so that I know the stakes before reading.
13. As a reviewer, I want a suggestion to split the PR when it mixes a feature, a refactor, and a dependency bump, so that I can ask for smaller PRs with evidence.
14. As a PR author, I want to know before a human reads my PR that my description misses something, so that I can fix the description or split the PR myself.
15. As a PR author, I want the check to fail only on hard gates (secrets, destructive migrations), so that warnings never block me from merging.
16. As a PR author, I want the check to pass with a visible notice when the judging service is down, so that a vendor outage never blocks my merge.
17. As a PR author, I want an empty or one-word PR description to be called out, so that I am nudged to write a real one.
18. As an agent reviewer, I want the same findings as machine-readable JSON, so that I spend my context on the flagged hunks instead of reading the whole diff.
19. As a repo maintainer, I want to install readfirst by adding one workflow file and three secrets, so that setup takes minutes and needs no hosting.
20. As a repo maintainer, I want every threshold and weight in a policy file in the repo, so that strictness is reviewed like code.
21. As a repo maintainer, I want to add a question in plain English to the policy file, so that "flag anything that touches invoicing" needs no code change.
22. As a repo maintainer, I want to choose which generative model writes the comments, and to escalate to a stronger model only for sensitive areas, so that cost stays near zero and quality goes where it matters.
23. As a repo maintainer, I want lockfiles, vendored code, and generated files excluded before anything is judged, so that I do not pay to judge noise.
24. As a repo maintainer, I want a minimum-attention knob, so that I can turn readfirst into a full review bot with a reading order on top when I want that.
25. As a repo maintainer, I want hunks that exceed the model's context cap to be truncated and marked low-coverage in the report, so that I know what was not fully judged.
26. As a repo maintainer, I want the exact cost and duration of each run in the summary comment, so that I can see what I am paying.
27. As a team lead, I want labels applied automatically (sensitive area, size, change type), so that PR lists are filterable without anyone tagging by hand.
28. As a team lead, I want warnings to be silent below threshold, so that the bot has nothing to say on a clean PR.
29. As a contributor to readfirst, I want the question wording in one place, so that I can review and improve what is asked without touching the pipeline.
30. As a contributor to readfirst, I want every stage testable with fake clients and fixture diffs, so that I can change the attention formula without an API key.

## Implementation Decisions

### Shape

1. readfirst is a JavaScript GitHub Action written in TypeScript, so it runs without a container build and installs with a single `uses:` line.
2. It triggers on pull request `opened`, `synchronize`, `ready_for_review`, and `edited`.
   Build note: `edited` was added so that fixing the description re-runs the check instead of leaving stale findings until the next push.
3. It requires three secrets: a TypeSafe API key, an OpenAI API key for the default generator, and an Anthropic API key only if escalation is configured.
4. Version 0 supports same-repository PRs only; fork PRs are out of scope until the `pull_request_target` question in Further Notes is settled.

### Modules

5. `diff` turns a unified diff into hunk records carrying file path, language, a test-file flag, line range, size, and a pre-classification of lockfile, generated, or vendored.
   Pre-classified hunks never reach the judge.
   Build note: classification reads the path only, never the hunk content.
   A `@generated` marker inside a hunk is written by the PR author, and honouring it would let a PR opt itself out of judging.
6. `questions` holds the full question catalogue as constants, grouped by which call they belong to, and is the one module a non-engineer is expected to read and edit.
7. `judge` takes hunk records and PR metadata and returns per-hunk answers from TypeSafe.
   It owns batching, the 32k-token state cap, truncation with a low-coverage marker, retries, and the fake-client seam for tests.
   Build note: the TypeSafe SDK already retries 408, 429, and 5xx with backoff and honours `retry-after`, so `judge` raises its retry count and does not reimplement it.
   TypeSafe documents no tokenizer, so tokens are estimated at three characters each, which overestimates for code.
8. `policy` is a pure function from answers plus the policy file to findings: gates, warnings, reading order, labels, split suggestion, and escalation decisions.
9. `writer` takes each flagged finding with its hunk and returns a verdict, then takes all confirmed verdicts and returns a TL;DR.
   It owns the generator provider interface and the structured output contract.
10. `report` renders the summary comment, inline comment bodies, labels, check conclusion, and the hidden JSON block from findings and verdicts.
    It is pure and snapshot-tested.
11. `github` is a thin adapter over Octokit for fetching the diff and description, upserting the summary comment, posting and reconciling inline comments, applying labels, and setting the check.
12. `action` wires inputs and secrets to the pipeline and is the only module that reads the environment.

### Judging with TypeSafe

13. Three calls per hunk batch.
    Call A sends code only and asks the gate, route, and mechanical questions.
    Call B sends code plus the PR description and asks the mismatch questions.
    Call C runs once per PR with title, description, and file list, and asks the PR-level questions.
    Build note: a TypeSafe request takes one state, and Jev loses accuracy when the state holds material unrelated to the question.
    So a "hunk batch" is one hunk: two requests per hunk plus one per PR, run with bounded concurrency.
14. Gate and mechanical questions never see the PR description.
    A description saying "this is a safe refactor" is exactly the framing the model is documented to be swayed by.
15. Questions are boolean (noul) or categorical (choice) only.
    Nothing is asked that requires counting, arithmetic, or date comparison, which the model is documented to be weak at.
16. Each answer is stored with its probability; no structural relationship between answers is assumed.

The question catalogue for version 0:

| id | Call | Type | Question |
|---|---|---|---|
| secret_semantic | A | noul | The added lines contain a credential, key, or token, or instructions for obtaining one. |
| destructive_data | A | noul | This change deletes, renames, or truncates a database table or column, or rewrites existing stored data. |
| mechanical | A | noul | This chunk is a mechanical change: rename, import reorder, formatting, generated code, lockfile, or version bump. |
| refactor_changes_behaviour | A | noul | The change alters what the program does for some input, not only how the code is organised. |
| test_loosened | A | noul | This change makes a test pass by weakening or removing an assertion rather than by fixing the code under test. |
| safety_check_weakened | A | noul | This change removes or weakens validation, error handling, a permission check, or a limit. |
| comment_drift | A | noul | A comment or docstring in this chunk no longer matches what the code beside it does. |
| change_type | A | choice | What kind of change is this? Options: feature, bugfix, refactor, test, docs, chore. |
| sensitive_area | A | choice | Which area does this chunk touch? Options: auth, payments, data_migration, public_api, none. |
| blast_radius | A | choice | Who could notice if this change is wrong? Options: nobody, other developers, end users, money or data. |
| unrelated_to_description | B | noul | This chunk contains changes the PR description does not mention. |
| description_quality | C | score | Rate the PR description. 0: generic. 1: names the area. 2: states what changed and why. Jev score levels start at 0. |
| tests_cover_change | C | noul | The changed files include tests that plausibly cover the described change. |

### Policy

17. The policy file is `.readfirst.yml`, is read from the base commit so a PR cannot loosen the policy it is judged by, and unknown keys are errors.
    It lives in the repo root and holds thresholds per question, area and blast-radius weights, the minimum-attention cutoff, generator selection and escalation rules, and a maximum hunk count.
18. Attention per hunk is computed in code as: (1 minus probability of mechanical) times the area weight times the blast-radius weight, plus twice the highest of the test-loosened, safety-weakened, and behaviour-change probabilities.
    Build note, after the first live PRs: the behaviour-change probability counts only when the hunk's change type is refactor, the same condition as the warning.
    Every feature and bugfix changes behaviour, Jev says so at 0.95, and counted for all hunks it put three unflagged hunks above the one real finding.
    Build note: each weight is the probability-weighted average over the options, not the weight of the top option, so a hunk at 51% auth and one at 49% score almost the same.
19. Reading order is hunks sorted by attention, cut at the minimum-attention threshold.
    Hunks below the cutoff are counted as mechanical in the report and never sent to the generator.
    Build note: a hunk that trips a gate is always in the reading order, and first, whatever its attention.
    Build note, after the first live PRs: `report` re-sorts once the verdicts are in, so the order is gates, then hunks with a confirmed finding, then the rest by attention.
    The comment lists every flagged hunk up to 15 and only the top 5 unflagged ones.
    The full order stays in the JSON block.
20. Cross-question logic lives in `policy`, never in a question.
    A hunk whose change type is refactor and whose behaviour-change probability exceeds threshold produces the "called it a refactor" warning.
    A PR whose hunks spread across three or more change types produces the split suggestion.
    Build note: only feature, bugfix, refactor, and chore count.
    Tests and docs accompany any change, and counting them would suggest splitting every ordinary feature PR.
21. Only gate questions can fail the check.
    Everything else is a warning or a label.
    Build note: a gate compares a probability with a threshold and nothing else.
    The generator writes about a gate flag but cannot clear it, because it reads the same author-controlled code.
    A gate the generator disputes is still reported and still fails the check, with the dispute stated.
22. If the PR description is empty or under a configurable length, the mismatch questions are skipped and a single "no description" warning is emitted instead.
23. Escalation rules select a stronger generator for a hunk when its sensitive area or blast radius is in a configured list.
    Escalation is off by default.
24. Repo maintainers may add custom noul questions to the policy file.
    Custom questions run in call A, produce warnings and labels only, and can never gate.

### Writing with a generative model

25. The default generator is OpenAI GPT-5.6 Luna (`gpt-5.6-luna`), chosen because the writer stage runs on every push and Luna is cheap and fast enough that per-push cost stays under a cent.
26. The escalation generator, when configured, is Claude Opus 5 (`claude-opus-5`).
    The provider is picked from the model name: `claude-` goes to Anthropic, everything else to OpenAI.
27. The generator sits behind a provider interface with OpenAI and Anthropic adapters; the model is a string in the policy file.
28. Per flagged hunk, the generator receives the flag, the hunk, a fixed number of surrounding lines, and the PR description.
    It returns a structured object with a confirmed boolean, a severity, a one-sentence "what changed", and a one-sentence "what to verify".
    Build note: one generator call per flag, not per hunk.
    Version 0 sends the hunk with the three context lines the diff already carries, and does not fetch more surrounding lines.
    A `secret_semantic` flag is never sent to the generator, since that would hand a suspected credential to a second vendor.
    It gets a fixed verdict.
29. A rejected flag is dropped from the report entirely.
    Jev is tuned for recall; the generator is the precision filter.
30. The generator may only write about the flag it was given.
    The structured output has one slot per flag, so it cannot introduce findings of its own.
31. The TL;DR call receives only the confirmed verdicts and the PR title, never the raw diff, and returns at most two sentences.
    Build note, after the first live PRs: it also receives the changed file paths with Jev's change type per file, still never the diff.
    With verdicts alone it described a PR with one finding as if that finding were the whole PR.
    It is now written for clean PRs too, from the file overview, and told there are no findings.
32. Generator calls for one PR run in parallel.

### Reporting on GitHub

33. The summary comment carries a hidden marker so it can be found and edited in place on every push.
34. Inline comments are posted as a single review with one comment per confirmed flag, anchored to the hunk's first changed line.
    Build note, superseding this decision and decision 35: git-judge-jev posts no inline comments at all.
    On a live PR every push added a review to the timeline and a notification per comment, which read as spam.
    The one summary comment is the complete report: each finding carries what changed and what to verify, and links to its first changed line in the Files tab.
    Reconciliation and the hunk content hash are gone with it.
    Build note, after the first live PRs: `unrelated_to_description` never becomes an inline comment.
    It is a statement about the PR, not about a line, and one unannounced rename produced 18 identical comments.
    It is reported once in the summary, with the files it covers.
35. On each push, existing readfirst inline comments are reconciled by file, flag id, and hunk content hash.
    Unchanged ones are kept so human replies survive; the rest are deleted and reposted.
36. Labels applied: one per sensitive area found, one size label, and the dominant change type.
    Labels are created if missing.
37. The check run passes unless a gate threshold is exceeded.
    Build note: the check is the workflow job itself, failed with `core.setFailed`. No separate check run is created, so the action needs no `checks: write` permission.
    If TypeSafe or the generator is unreachable, the check passes and the summary comment states that readfirst did not run, unless the policy sets fail-on-error.
38. The summary comment ends with hunk count, duration, and estimated cost.
39. The summary comment embeds the full findings and verdicts as JSON inside an HTML comment, and the same JSON is exposed as an action output.
    Build note: the comment also carries a collapsed table of every raw Jev answer per judged hunk, with the value that raised a flag in bold, and the JSON carries the same answers.
    It exists to tune thresholds from real PRs.
    The table is capped at 60 rows, and if the comment would pass GitHub's 65,536 character limit the raw answers are dropped from the JSON block but kept in the action output.
    Build note: the JSON names the head commit it judged, and each finding has an id hashed from its flag, its file, and its changed lines.
    The hunk id is a position in the diff and shifts when a push adds a hunk above it, so an agent reading two reports could not tell a standing finding from a new one.
    The id changes when the flagged lines change, which is correct: that is a new claim about new code.
    Tracking findings across pushes, and deciding to fix, dispute, or escalate one, is the reading agent's job and stays out of git-judge-jev.
40. Each unflagged hunk in the reading order says why it is there: change type, sensitive area, blast radius, and every near miss.
    A near miss is a question that scored from half its threshold up to the threshold.
    It raises no flag, is never sent to the generator, and costs nothing, since Jev already answered.
    On the first live PR with no findings the comment was a TL;DR and a list of bare links, which gave a human nothing to read.
    The description flag is never a near miss, it is a statement about the PR and not about a hunk.
    This is not a comment that is not tied to a flag in the sense of Out of Scope: no model writes it and it gives no advice.
    Test snapshots (`__snapshots__/`, `*.snap`) are pre-classified as generated.
    They quote the code they render, and one that contained an auth path was ranked first as auth code.
41. A finding shows the code it is about.
    The verdict schema gains `evidence`, the changed lines that show the claim.
    The generator only points: a returned line is kept when the hunk has that changed line, and the text shown is the hunk's own, in diff order, six lines at most.
    So the one list in the schema cannot carry a finding or code of the model's own.
    A near miss has no model behind it, so it shows the hunk's first eight changed lines instead.
    A possible secret is never quoted, as a flag or as a near miss: the comment would keep it after a force-push took it off the branch.
    Snippets are fenced with more backticks than any run inside them, since the lines are author-controlled.
42. From a review of the first live comment with reasons on it:
    - A hunk in a test file counts its area and blast radius at `weights.testFile`, default 0.5. Scores sat between 1.0 and 1.9, a test that quotes an auth path ranked above the untested production code it covers, and the judgement term is left in full so a loosened test still leads.
    - The reason line repeats a pick only at or above `choiceConfidence`, the same bar labels use. It had stated "bugfix" at 0.39 and "touches auth" at 0.45 as facts. Policy decides this and hands the report the picks that passed.
    - The comment lists ten unflagged hunks, not five. With a reason on each line ten is still a short read, and the riskiest code of that PR ranked 8 to 14.
    - No flag on a hunk with a possible secret goes to the generator. Before this only the secret flag itself was held back, so a second flag sent the secret to a second vendor, and with evidence the model could point at the secret line. A warning there is dropped, since it needs the generator to stand, and the secret gate already puts the hunk first. The destructive-data gate stands on its probability with fixed text.
    - The finding id covers the hunk's changed lines, not only the lines a flag is about. An edit within three lines merges into the hunk and changes the id. Accepted, and said so where the id is described.
    - A failed head lookup posts the report instead of hiding it, or in the error path hiding why the pipeline failed.
    - The TL;DR prompt forbids listing files and areas. The TL;DR never sees the diff, so "drops stale runs" in a title still reads to it as removing them. Accepted.
    - When the comment is too large the hidden JSON loses the raw answers, then the reading order past 50. The visible comment is always rendered from the full data, and the action output keeps everything.
43. The project is named git-judge-jev, so the name says which judge it runs on.
    The comment markers changed with it. A comment posted under the old marker is still found and updated in place.
    The policy file is `.git-judge-jev.yml`. No install existed outside this repo, so there is no fallback to the old name.
44. `npm run eval` replays labelled diffs through the real pipeline and scores the report: must-read hunks in the top 5 and top 10, flag recall, and flag precision after the writer.
    Model answers are cached by request. This is not the `calibrate` command of Out of Scope: it measures, it does not tune.
    Seven cases are a planted defect among routine changes, built with real `git diff`. One is the first commit of PR #5, labelled with the untested stale-run guard.
    The planted defects ranked first from the start, so the synthetic cases guard against regressions and the real one measures ranking. More real cases are the next thing the suite needs.
45. Measured with that suite, baseline top 5 70%, top 10 90%, flag recall 100%, precision 86%:
    - Five logic-signal questions (error handling, condition, external IO, shared state, limit or default). They raise no flag. The strongest scales area and blast radius by `1 + weights.logicSignal * p`. Top 5 went to 90%: the stale-run guard moved from ranks 7 and 8 to 3 and 4, and attention spread from 1.0-1.9 to 1.1-3.1. Jev input cost rose 9%. A signal at 0.7 or more is printed as a reason beside the hunk.
    - `sensitive_area` asks which area the changed lines implement, and says a mention in a comment, string, path, test data, or documentation is not one.
    - Warning thresholds went from 0.6 and 0.7 to 0.4 and 0.5. Jev is the recall stage and the writer the precision stage, at about $0.0005 a hunk. Precision held at 86%. No true flag in the suite sat between the old and the new threshold, so the gain is unproven, only the harm is ruled out.
    - Questions about code raise no warning, near miss, or signal on prose (`.md`, `.txt`, `.rst`, `LICENSE`). Gates and the description flag still apply. Jev had scored a weakened safety check 0.30 on a README.
    - Tried and removed: a 1.25 weight on production code with no test hunk in the PR. It moved nothing in the suite.
    Jev's cap is 32k tokens for the state plus the longest question, which `judge` already enforces. One hunk is one request and a typical hunk is under 1k tokens, so the new questions fit with room to spare. That room is the next lever: the enclosing function as context for a hunk, and the changed test hunks in the PR-level call so `tests_cover_change` stops judging from file names.
46. A run whose PR head has moved by the time it finishes posts nothing, neither comment nor labels.
    Runs finish out of order, and an older report written over a newer one describes code that is no longer there.
    The README workflow also sets `concurrency` with `cancel-in-progress`, which stops most stale runs before they cost anything.
47. From a full review on 2026-09-20. A gate needs nothing but Jev, and nothing but a human clears one.
    - A writer failure used to end the run as "did not run" with a passing check, so an OpenAI outage passed a committed secret. Now each writer call fails alone: a gate gets fixed text and still fails the check, a warning is counted as unchecked and not shown, a failed TL;DR is left out, and the comment says the writer was unreachable. Only a TypeSafe outage is "did not run".
    - Superseding the build note of decision 5: pre-classified hunks did not reach the judge at all, so a secret under `dist/` or `vendor/`, or in a `.snap`, was never looked at. The path is as author-controlled as the content. Generated and vendored hunks are now asked the two gate questions and nothing else, take what the hunk cap has left after the ranked hunks, and the comment names the files set aside. Lockfiles stay out: they are named by exact basename, and one bump is hundreds of hunks.
    - `exclude.unchecked` in the policy names paths that are sent nowhere. On this repo the gate check of the 3.8 MB `dist/index.cjs` took a run from 10 to 136 seconds and from one cent to four. A built-in path rule is a guess about a path the author chose, so it keeps the gates. A glob in the policy is the maintainer's word, read from the base.
    - One hunk TypeSafe will not answer for after retries is reported as not judged instead of failing the run. Past five failures with most finished requests failing, or with every hunk failing, it is an outage and the run gives up.
    - The hunk sent to the writer is cut at 24,000 characters. A generated hunk can be megabytes.
48. The writer reads more than the hunk. Superseding the build note of decision 28: for a flagged hunk it gets the enclosing block of the file as it is after the change, and up to three other hunks of the PR that change the same identifiers.
    With three context lines it could not tell a removed check from a moved one, and every "verify" read "verify this is intentional".
    The block is found by indentation: up from the hunk to the line at column 0 that opens it, down to the line that closes it, 60 lines each way at most, a 15-line window for top-level code. No parser, no list of languages.
    A related hunk shares a changed identifier that at most five hunks of the PR change. An identifier changed everywhere ties nothing together.
    Only flagged hunks pay for it: one file read per file through the contents API at the head commit. A file that cannot be read costs the context, not the run.
    Jev still sees the hunk alone. Giving it the block would move every probability the thresholds were set against, and is the next lever, with a before and after.
    Context never includes a hunk flagged as a possible secret, and an enclosing block that overlaps one is left out.
49. The verdict gains `material`: would a careful reviewer want to be stopped for this. Superseding decision 29 in part: a rejected warning is still dropped, a warning that holds but does not matter is kept in the JSON and shown as a reason beside its hunk under "Then read", not as a finding.
    At the 0.4 thresholds the writer confirmed what was literally true. On PR 5 both findings were of that kind: a display limit raised from 5 to 10 as "safety check weakened". A gate is always material.
    The evidence matcher compared trimmed text, so one `}` from the model quoted every closing brace in the hunk, six of them on PR 6. It now compares the sign and the text, and a line with no letter or digit is never evidence.
    The PR description goes only to the two claims about the PR's story, `unrelated_to_description` and `refactor_changes_behaviour`. For the rest it is the author's word for what the code does, at the one stage that can drop a warning. Sending it to none was measured first and made the refactor claim fire on a change the description states, so that claim now says it holds only if the description does not state the behaviour change. Suite precision went from 86% to 100% at unchanged recall, `eval/results/3-context-and-materiality.json`.
    Writer calls run eight at a time, not all at once.
50. `npm run corpus -- owner/repo` builds eval cases from merged pull requests, superseding "A `calibrate` command" in Out of Scope only in that the data now exists: it still measures and does not tune.
    A must-read label is a human review comment on the hunk, or a commit with fix, bug, revert, hotfix, or regression in its subject that changed the hunk's lines within 14 days of the merge. Each label says where it came from. Findings are left unlabelled, the eval scores such a case on ranking only and prints its verdicts to be labelled.
    Cases go to `eval/corpus/`, ignored by git: they are other repos' code. The bar for calling this tool useful is set on that corpus, not on the planted cases: 80% of findings worth the stop, 85% of must-read hunks in the top five, no missed gate.
51. Memory across pushes, with the comment as the only state. Decision 39 left tracking to the reading agent. A human reader needs it too: a disputed finding that returns on every push gets the bot muted.
    - A finding not in the previous report is marked "new since the last push". The previous ids are read from the JSON block and from the boxes, since a large comment drops part of its JSON.
    - Every warning has a task-list box. Ticked, that finding id is left out from the next run on and is not sent to the writer, until the hunk's changed lines change or the box is unticked. Dismissed findings are listed ticked in a collapsed section, which is how the state survives the comment being rewritten. A "did not run" comment carries the ticked ids on.
    - A gate has no box. A box can be ticked by anything that can edit the comment.
    - The finding id moved from `report` to `policy`, which sets it on the flag, so a dismissed flag is known before the writer is called.
    - Each run logs how many findings were dismissed and how many shown. That is the per-repo precision record.
    A tick takes effect on the next run. Re-running on the comment edit would need the `issue_comment` event, which carries no pull request and runs from the default branch.
52. A quiet comment, user story 28. With no finding and fewer than `readingOrderFrom` judged hunks, default 10, the comment is the TL;DR and the skip count. The order is always in the JSON.
    `labels`, default off, superseding decision 36: area, size, and type labels are guesses and were often wrong on small PRs. With it off no label is removed either, since `area:` and `type:` are prefixes people use themselves. A label named by a custom question is always applied.
    `debug`, default off: the Jev answers table of decision 39 and the raw answers in the embedded JSON. The action output always has them.
    When the comment is too large, after the raw answers and the reading order tail, the embedded verdicts lose their evidence and are cut to 30, and last the JSON block is left out. The visible comment never exceeded its caps, the block did, and GitHub answered 422.
    Model text is put on one line and an `@` in it is broken, so it cannot notify anyone.
53. A command line, superseding "A local CLI or pre-commit hook" in Out of Scope. `npx github:davidrydberg/git-judge-jev --base main` judges the branch against its merge base before a pull request exists, reads the policy from the base, posts nothing, prints Markdown or JSON, and exits 1 on a gate.
    It is for the agent that wrote the code: it can restore a loosened assertion or rewrite the description before a human is asked to read anything. A gate stays a human's.
    One bundle serves both: `dist/index.cjs` is the action inside a workflow run with no arguments, the command line otherwise.
54. A Dependabot run with no TypeSafe key passes with a notice. Dependabot pull requests are same-repo but get no secrets and a read-only token, so they failed on the missing key and then again posting the comment.
    Only Dependabot: git-judge-jev flagged the first version of this on its own diff, where any run without a key passed. A key missing elsewhere is a broken setup and still ends as "did not run".
    `AGENTS.md`, `CLAUDE.md`, and this file are tracked. They were ignored, which made "change `prd.md` in the same commit" impossible.
55. The comment has two readers and a part for each, superseding the hidden JSON block of decision 39.
    - For people, a finding is a short paragraph. The verdict gains `why_it_matters`, and `what_changed` may run to two sentences and says what the enclosing code and the related hunks show. One sentence each read as a form, and since decision 48 the writer knows more than a form has room for. Only findings get prose: the TL;DR stays two sentences and "Then read" stays a list, since a longer comment is read less.
    - For machines, a collapsed block "For coding agents" holds JSON: per finding the id, new or standing, the flag, the location, the claim, the evidence, an `action`, and `resolvedWhen`. Collapsed and not hidden, so an agent that reads the comment as text gets it and a person can see what the agent was told. It is JSON and not a terser dialect of its own: models parse JSON reliably, and the saving is in leaving out what an agent has no use for, the attention scores, near misses, and raw answers.
    - `action` is `fix_code`, `fix_description`, `fix_code_or_description`, `human_only`, or `none`, from a fixed table per flag. A gate is always `human_only`, a custom question `none`.
    - The block is a channel of instructions built from code the PR author controls. So its only instructions are `action` and `resolvedWhen`, both fixed text. The claim and the evidence are data, and the block says so to whatever reads it.
    - A minor or dismissed finding is not in it. With nothing to act on there is no block.
    - The full report, with every raw answer, is the `json` output only. The handoff is also the `handoff` output and `--agent` on the command line. Previous finding ids are read from the block, from the boxes, and from the old hidden JSON of a comment posted before this.
    - The eval cache key left out the output schema, so a changed field description was answered from cache. It is part of the key now. Measured after: precision 100%, recall 100%, `eval/results/4-prose-and-handoff.json`.
56. From the first run on a pull request nobody planted anything in, PR 8: one good finding, one false positive, and a description section that was right and not worth reading.
    - The false positive read moved code as new behaviour. The finding id had moved from `report` to `policy`, the hunk deleting it was not among the related hunks because `findingId` is changed in more than five hunks, and the writer reasoned correctly from what it had. This is missing input, not a weak model. `context` now computes facts from the whole diff: names only added in the enclosing block's hunks and only removed in another hunk, and the reverse, were moved. One fact per place, and only on two or more names going the same way or one name of eight characters or more, since `path` and `hunk` alone tie nothing together. That hunk is always sent as related. It also says whether each name the hunk removes is still in the file after the change. Facts go to the writer marked as computed by code and true.
    - `unrelated_to_description` is raised only on a hunk Jev is sure changes logic, touches a sensitive area, or is noticed by users or data. Asked of one hunk, Jev finds something a description leaves out in most hunks of a large PR. The writer's claim for it now holds only if a reviewer who read the description would be surprised by the change.
    - The writer's claim for `test_loosened` is what the code shows, a weakened or removed assertion, not Jev's wording about the motive. With the prompt changed, the writer rejected the suite's plainly loosened test by arguing about whether the test would pass. Recall went to 83% and back to 100%.
    - Measured: precision 100%, recall 100%, `eval/results/5-move-facts-and-description-bar.json`. Rerun on PR 8 the false positive is gone and the description section went from three files to two. The `exclude.unchecked` finding of the first run is gone too, with no cause established: a rejected warning leaves no trace. The writer's veto varies between runs, and that is the next thing to look at.

## Testing Decisions

A good test here exercises a stage through its public interface with a realistic input and checks the observable output, never the calls made on the way.

- `diff`: fixture diffs from real PRs (a lockfile bump, a rename-only PR, a mixed PR, a binary file, a file over the state cap) in, hunk records out.
  Assert file classification, hunk boundaries, and test-file detection.
- `judge`: a fake TypeSafe client that records requests and returns canned answers.
  Assert batching respects the state cap, oversized hunks are truncated and marked low-coverage, retries happen on 429 and 529, and each question lands in the right call.
- `policy`: table-driven tests from answers to findings.
  Assert the attention formula, threshold edges, the refactor-behaviour cross rule, the split suggestion, the empty-description path, escalation selection, and that custom questions cannot gate.
- `writer`: a fake generator returning structured objects.
  Assert rejected flags are dropped, the prompt contains only the given flag, escalation picks the configured model, and the TL;DR call receives verdicts and no diff.
- `report`: snapshot tests of the summary comment and inline bodies for a clean PR, a PR with warnings, a gated PR, a PR where readfirst did not run, and a PR over the hunk cap.
  Assert the JSON block round-trips.
- `github` and `action`: no unit tests.
  One manual end-to-end run against a sandbox repo before each release.

Prior art: none, this is a new repo.
Test runner is Vitest.
No test may require an API key.

## Out of Scope

- A hosted GitHub App.
  Version 0 is an Action only.
- Fork PRs.
- Automatic reviewer assignment or CODEOWNERS integration.
- A `calibrate` command that replays merged PRs to tune thresholds.
- Caching of judged hunks across pushes.
- Check-run annotations; inline review comments cover the same need.
- Any comment that is not tied to a flag.
  readfirst does not offer style suggestions, naming advice, or general code review.
- Finding logic bugs in hunks it did not flag.
- A local CLI or pre-commit hook.
- Support for languages TypeSafe performs poorly on; question wording is English and hunks are sent as-is.

## Further Notes

Open questions:

- GPT-5.6 Luna's reliability at the "reject the flag" veto and at strict structured output is unmeasured.
  The first thing to do after the pipeline runs is a bake-off on 50 real PRs comparing Luna, Claude Sonnet 5, and Claude Opus 5 on how often the confirmed flags match what human reviewers actually commented on.
- Jev calibration differs per repo and per language.
  Shipped thresholds are guesses until the calibrate command exists; the policy file must make that obvious.
- Fork PRs need `pull_request_target` to see secrets.
  readfirst never checks out or executes PR code, only reads the diff, so this may be acceptable, but it needs a deliberate security review before enabling.
- The diff is fetched with the diff media type, which GitHub refuses for very large PRs (over 300 files).
  Such a PR currently ends as "did not run".
  Falling back to the paginated file list is the fix when it matters.
- TypeSafe rate limits are documented as adjusting dynamically.
  A large monorepo pushing hundreds of PRs a day could hit them; back-off is handled but the failure mode (skipped run) should be visible.

Risks:

- Jev is documented as not treating its input as hostile.
  Code comments and descriptions can sway it.
  Mitigations in this PRD: gates never see the description, the generator re-reads the code, and gates fail closed only on high probability.
- A subtle bug in a hunk Jev marks mechanical receives no generative attention.
  The minimum-attention knob is the escape hatch; the README must say this plainly.
- Three vendor keys is real install friction.
  Escalation is off by default so most installs need two.

Dependencies:

- TypeSafe API and its JavaScript SDK.
- OpenAI API for the default generator.
- Anthropic API for escalation.
- Octokit and the GitHub Actions toolkit.
