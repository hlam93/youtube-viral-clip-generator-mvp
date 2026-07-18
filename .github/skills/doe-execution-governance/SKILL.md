---
name: doe-execution-governance
description: "Run DOE execution governance for implementation slices, sprint work, release candidates, and validation evidence. Use when work should be recorded in executions/ with tests, risks, and release gates, including OWASP-aware gates for business applications or explicit security requests."
argument-hint: "Describe the execution slice, sprint objective, or release candidate."
---

# DOE Execution Governance

Use this skill to structure and verify delivery work in `executions/`.

## When to Use

- A directive has been refined into an implementation slice
- Engineering work needs a tracked execution record
- QA evidence should be captured before release; include security evidence for business applications or explicit security requests

## Procedure

1. Create or update an execution YAML in `executions/`.
2. Reference the parent directive identifiers and backlog items.
3. Record a handoff contract before implementation starts: role owners, acceptance criteria, risk tier/rationale (reconciled with the directive's security scope per SYSTEM.md §4), validation plan, release gates, and rollback expectation.
4. Record implementation scope, test plan, risks, and rollback notes.
5. Capture role-based Definition of Ready (DoR) and Definition of Done (DoD) evidence in the execution record, including PM's acceptance-criteria confirmation and UX's flow/accessibility confirmation (or `n/a`) at DoD — see SYSTEM.md §7.1 Role Gate Matrix.
6. For web application slices, record preview/run commands and free-host deployment steps (or explicit N/A).
7. Capture validation evidence from engineering, QA/security, and CI enforcement checks.
8. If a delivery blocker, QA/security finding, or CI enforcement finding blocks DoD, do not proceed straight to a release recommendation: route it back to the owning role(s), adapt scope or the handoff contract as needed, and log the cycle in `iteration_log` before re-running the affected step. Escalate to the orchestrator/user after 2 retry cycles without resolution.
9. Use the execution template:
   - [execution template](./assets/execution-record.template.yaml)

## Process Depth Is Risk-Proportionate Too

SYSTEM.md §4 scales *security* depth to risk; scale the *paperwork* the same way — a low-risk,
non-business, documentation/tooling-only slice should not carry the same ceremony as a
medium+/business-scope one.

- Always required, any tier: `metadata`, `scope`, `handoff` (owners, acceptance criteria, risk
  tier + rationale, validation plan, release gates, rollback expectation), `quality_gates` DoR/DoD,
  `validation`, `risk`.
- Omit entirely rather than filling with placeholder content: `backlog` (skip it if the slice has
  no items distinct from `scope.in_scope` — do not invent a synthetic backlog item just to
  populate the section), `iteration_log` (only add it if a replan cycle actually happened),
  `amendments` (only add it if a *substantive* claim in an already-complete record — a risk tier,
  a residual risk, a release recommendation — needed correcting after the fact; append an entry
  rather than editing the original fields, and don't spawn a full new EXE-#### record just to
  document one correction — correction cost should stay proportionate to the correction),
  `implementation.preview`/
  `implementation.deployment` (use `N/A` for non-web slices, or omit if the surrounding section
  allows it).
- Keep list items to one concise, factual sentence. An evidence entry names the command, file, or
  check that proves the claim — it does not narrate how the session arrived at it.
- When actual execution matched `handoff.validation_plan` exactly, keep the matching
  `validation.*_checks` entry terse (e.g. "as planned — passed") instead of restating the plan's
  command/description a second time; reserve full prose in `validation` for a result that
  *deviates* from the plan — a finding, a bug caught, evidence the plan didn't anticipate. Same
  idea for `quality_gates.*.notes`: point at where a fact is already stated (`scope.in_scope`,
  `validation.qa_checks`) rather than re-narrating it in prose.

## Release Gate

Do not mark the execution complete until:

- acceptance criteria are satisfied
- handoff contract is complete and DoR checks are satisfied before implementation
- relevant tests have run or gaps are explicitly documented
- security-sensitive changes (or business-application slices) have negative-path coverage
- web application slices include preview/build and free-host deployment evidence (or explicit N/A)
- any DoD-blocking finding (delivery, QA, or CI) has an `iteration_log` entry showing how it was resolved, escalated, or deferred with documented residual risk — validator-enforced to at most 2 non-escalated entries, with no entry following an `escalated-to-user` result
- if the slice implements or hardens a `SEC-####` security baseline directive's controls or `verification.required_tests`, that `SEC-####` id is listed in `metadata.directive_refs` alongside the product `DIR-####`
- for `risk_tier: high|critical` slices, `handoff.rollback_verified` is `true` and `quality_gates.definition_of_done.security_signoff` is recorded (`pass|fail`) — both validator-enforced
- DoD evidence from engineering, PM, UX (where applicable), QA/security, CI enforcement, and orchestrator is recorded
- residual risk and release recommendation are recorded
