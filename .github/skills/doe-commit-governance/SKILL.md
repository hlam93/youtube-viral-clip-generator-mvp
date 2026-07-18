---
name: doe-commit-governance
description: "Create an appropriate number of commits for staged or unstaged work by grouping changes into sensible, validated units of work. Use when the orchestrator, architect, or delivery engineer should checkpoint implementation incrementally instead of making one oversized commit."
argument-hint: "Specify mode (preview|execute), branch preference (current|new[:branch-name]), and the change set or delivery slice to split into commits."
---

# DOE Commit Governance

Use this skill when a change set should be committed in one or more coherent checkpoints instead of a single catch-all commit.

## When to Use

- A delivery slice includes multiple separable units of work
- The orchestrator wants delivery progress checkpointed cleanly
- The delivery engineer has completed several related but distinct changes
- A feature includes setup, implementation, tests, and follow-up cleanup that should not all land in one commit unless they are inseparable

## Goal

Produce the smallest sensible number of commits that preserves clarity, traceability, and reviewability without fragmenting the work into noisy micro-commits.

## Preview

Use preview mode to plan commit boundaries without creating commits.

- Include a branch strategy preview using the same rules as execute mode:
  - default to current branch
  - if a new branch is requested with a user-provided name, prefix it with `<YYYY>/` when it does not already start with a 4-digit year segment
  - otherwise propose `<YYYY>/<type>/<intent-slug>`
- Inspect the diff and propose the smallest sensible commit sequence.
- Explain why each group belongs together.
- List the validations that should run before committing.
- Provide commit-ready messages.
- Do not stage files, switch branches, or create commits in preview mode; only preview the suggested branch and commit plan.

## Execute

Use execute mode to stage, validate, and create the commit sequence.

- Default behavior: execute on the current branch.
- If the user requests a new branch:
  - if a user-provided branch name is specified, prefix it with `<YYYY>/` when it does not already start with a 4-digit year segment
  - otherwise create a branch using this convention:  
    `<YYYY>/<type>/<intent-slug>`
- For default new-branch naming, set `<intent-slug>` from the commit intent (for example, `workspace-mission-boundary-clarification`).
- Resolve `<YYYY>` as the current calendar year at branch creation time (for example, `2026`).
- Keep the commit grouping and validation behavior identical to preview, but then perform staging and commits.

## Commit Grouping Rules

- Keep unrelated changes in separate commits.
- Keep tightly coupled changes together when splitting them would break meaning, tests, or runtime safety.
- Prefer one commit per coherent delivery unit such as:
  - schema or contract change
  - backend implementation slice
  - frontend implementation slice
  - test coverage addition
  - targeted refactor directly supporting the feature
- Do not create separate commits for trivial churn that adds no review value.
- Do not mix opportunistic cleanup with feature work unless the cleanup is required for the feature to land safely.

## Procedure

1. Inspect the current diff and identify natural units of work.
2. Map each unit back to its directive, delivery slice, or execution record when applicable.
3. Decide whether the work should be:
   - one commit because it is a single coherent change, or
   - multiple commits because there are distinct reviewable units
4. Stage and commit each unit in a sequence that keeps history understandable and minimizes broken intermediate states.
5. Run the smallest relevant validation for each commit or commit group, using existing project checks only.
6. Use clear commit messages that match repository style, start with a concise conventional prefix, and describe the delivered unit rather than just the files changed.
7. Omit `Co-authored-by` trailers unless a human explicitly requests them for the specific commit.
8. Confirm the final sequence is easy to review, bisect, and trace back to DOE artifacts.

## Validation Expectations

- Each commit should be logically complete enough for review.
- The overall series should preserve delivery intent and avoid hiding security-sensitive changes.
- If a commit introduces a contract or schema change, pair it with the minimum code or tests needed to explain and validate that change.
- If the repository has no meaningful intermediate validation, document that limitation and still keep commit boundaries coherent.

## Output

Return:

- proposed commit breakdown
- reason each group belongs together
- validation run for the sequence
- final commit messages or commit-ready summaries

## Guidance for DOE Roles

- **DOE Orchestrator / Architect:** use this skill to decide commit boundaries across a delivery slice and enforce clean history.
- **DOE Full Stack Delivery:** use this skill when implementation work is ready to be checkpointed and should be committed in sensible increments.
