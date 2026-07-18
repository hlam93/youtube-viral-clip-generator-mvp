---
name: Commit Policy Guidance
description: "Use when creating, amending, rewording, squashing, or splitting git commits, rebasing local history, or preparing a branch for review. Covers concise conventional prefixes, sensible commit boundaries, and omission of assistant co-author trailers."
applyTo:
  - "**/*"
---
# Commit Policy Guidance

- Start commit subjects with one of these conventional prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `test:`, or `chore:`.
- Merge and revert commits created by Git or hosting providers may use their generated subjects.
- Use the same conventional prefix style for pull request titles to keep review queues consistent with commit policy.
- Keep the subject short, descriptive, and focused on the delivered unit of work.
- Omit `Co-authored-by` trailers for assistants unless a human explicitly requests them for a specific commit.
- Use sensible commit boundaries that preserve reviewability and DOE traceability.
- Keep unrelated changes in separate commits and keep tightly coupled changes together.
- Before sharing history, fix local commit messages that violate prefix or trailer rules.
