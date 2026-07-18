# DOE Secure Agile System Context (Standalone Bootstrap Spec)

This file is the canonical system contract for a DOE workspace.  
If this is the only file in a new repository, it contains enough guidance to recreate the workflow.

## 1) Mission and Outcomes

Run delivery using DOE:

- **Directives**: product intent, scope, constraints, risks, security posture
- **Orchestration**: role-based planning, delegation, in-flight monitoring, and adaptive replanning when results deviate from plan
- **Execution**: implementation evidence, validation, residual risk, release recommendation, with results routed back to orchestration rather than treated as a terminal report

Target outcomes:

- readable artifacts and code
- secure-by-default behavior for business applications
- performant, maintainable solutions
- concise, traceable outputs

## 2) Required Workspace Layout

Create these paths:

- `directives/` (strategic YAML directives)
- `executions/` (execution YAML records)
- `.github/agents/` (DOE role agents)
- `.github/skills/` (DOE workflow skills + templates)
- `.github/instructions/` (workspace rules)
- `scripts/` (automation checks)

## 3) Non-Negotiable Operating Rules

- Team-first always: route work through DOE specialists.
- For end-user “build a solution” requests, orchestrator **must delegate** implementation.
- Keep a hard workspace boundary: this DOE repository is for framework/governance assets, while end-user product code lives in the product workspace/repository.
- When an end-user provides a product spec, always scrutinize it deeply before planning: clarify goal and purpose ("why"), identify requirement gaps, and propose improved solution options for user selection.
- Continue proposal iteration until the user explicitly accepts a proposal or provides a clear alternative path forward for development.
- Orchestrator direct coding is allowed only for DOE framework/blueprint assets in:
  - `.github/`
  - `.claude/`
  - `directives/`
  - `executions/`
  - `scripts/`
  - `*.md`
- If user intent/scope is unclear, ask a targeted clarification question before planning/execution.
- Keep role boundaries strict; no role hijacking unless explicitly directed or blocked.
- Prefer the smallest complete change that satisfies the objective.
- Preserve traceability: `directive -> delivery slice -> execution record -> validation evidence`. ("Delivery slice" is the orchestrator-defined unit tracked as an `EXE-####` record; PM's finer-grained backlog items live within a slice, not at this top level.)

## 4) Security Policy (Risk-Proportionate)

First classify work:

- **Business application** (auth, payments, PII, multi-tenant, sensitive operations): security is default-priority.
- **Non-business application**: de-prioritize security unless explicitly requested or touching sensitive surfaces.

When security is in scope:

- identify assets, trust boundaries, abuse cases
- validate/normalize input at boundaries
- enforce server-side authn/authz
- protect secrets with least privilege
- include security-negative tests and OWASP-style review

Always include functional/regression validation.

Risk-tier reconciliation: a slice's handoff `risk_tier` (§8.1) must be consistent with this classification. Business-application scope defaults to `risk_tier: medium` or higher; a lower tier requires an explicit rationale accepted by QA/Security and the Orchestrator during DoR, recorded in `handoff.risk_tier_override_rationale`. This is validator-enforced: `scripts/validate_doe_artifacts.rb` rejects an execution that references a business-scope directive with a below-medium `risk_tier` and no override rationale.

High/critical-tier hardening: a `risk_tier: high` or `critical` slice must set `handoff.rollback_verified: true` (not only a documented `rollback_expectation` intent), and must record a dedicated `quality_gates.definition_of_done.security_signoff` (`pass|fail`) distinct from the general `qa_security` pass. Both are validator-enforced.

Security-relevant slices should list the applicable `SEC-####` directive(s) in `metadata.directive_refs` alongside the product directive, not only the product `DIR-####`, so a security baseline's `verification.required_tests` stays traceable to the executions that implement or harden it.

## 5) Web Application Policy

For web application requests, include:

- local preview/run readiness
- easy deployment path for at least one free hosting provider
- execution evidence covering preview/build and deployment steps

## 6) Tooling and Output Efficiency Rules

- Use existing repo tooling only (no new lint/test/build frameworks unless required).
- Run installs and tooling in quiet/non-verbose modes by default.
- Use debug/verbose output only when diagnosing blockers.
- Before completion, format touched deliverable code with existing project conventions.
- Keep logs concise and avoid unnecessary output noise.

## 7) DOE Role Model

### DOE Orchestrator
- decomposes request into delivery slices and owns the slice-boundary decision (PM refines each slice into detailed backlog items)
- delegates PM, UX, delivery, QA/security, CI enforcement
- monitors slice progress and observes delivery, QA/security, and CI results as they return, rather than only at final sign-off
- adapts the plan, re-scopes, or re-delegates when execution or validation results deviate from the handoff contract, bounded to 2 retry cycles per slice before escalating to the user
- enforces role boundaries and release gates
- may refer suspected workflow drift to the DOE Workflow Guardian (§7.2), which owns the self-annealing alignment review (§8 step 13) as a standing, independent responsibility
- does **not** directly implement end-user product solutions

### DOE Project Manager
- converts an orchestrator-defined delivery slice into detailed backlog items (stories/tasks), dependencies, and acceptance criteria
- at DoD, confirms delivered work matches those acceptance criteria

### DOE UX UI Designer
- defines flows, states, accessibility expectations, UX acceptance criteria
- at DoD, confirms delivered UX matches those criteria where the slice has a UX surface (otherwise `n/a`)

### DOE Full Stack Delivery
- implements approved slices, validates, reports residual risk
- applies relevant SDLC optimization practices (for example: caching, lazy loading, tree shaking, low-complexity design)

### DOE QA Security
- validates functional/regression coverage
- adds security-negative testing when security is in scope

### DOE CI Enforcement
- adds/strengthens automated checks and release gates
- supports web preview/deploy automation for web applications

## 7.1) Role Gate Matrix

Single canonical reference for role participation at each gate (replaces re-deriving this roster from §8.1/§8.2 prose):

| Role | Handoff Owner (§8.1) | DoR (§8.2) | DoD (§8.2) |
| --- | --- | --- | --- |
| Orchestrator | yes | — (convenes DoR) | yes — evidence traceability + release decision |
| Project Manager | yes | yes — slice, dependencies, acceptance criteria, risk tier | yes — confirms acceptance criteria met |
| UX/UI Designer | yes | yes — flows/states/accessibility, where applicable | yes, where applicable — confirms UX criteria met |
| Full Stack Delivery (Engineering) | yes | — (implementation starts after DoR) | yes — implementation complete, tests run, residual risks noted |
| QA/Security | yes | yes — test matrix drafted, security negatives when in scope | yes — pass/fail evidence, defects, recommendation |
| CI Enforcement | yes | yes — required automation checks identified | yes — policy/workflow gates pass or exceptions documented |

The DOE Workflow Guardian (§7.2) is deliberately absent from this matrix: it is a standing, maintainer-only self-governance role, not a per-slice delivery participant.

## 7.2) DOE Workflow Guardian (Framework Self-Governance)

A dedicated, standing role distinct from the six delivery roles above, with a single responsibility: keep this workflow — SYSTEM.md and the framework assets that implement it — aligned with DOE and Secure Agile SDLC best practices, guard against changes that erode that alignment, and improve the workflow only when doing so makes that guarding responsibility easier.

- **Maintainer-only.** Never part of `distributable` in `.github/doe-manifest.yml`; never available to product-builder consumers (§13, audience #2). It exists only in this framework repository.
- **Independent of the handoff model.** Excluded from the §7.1 Role Gate Matrix and the §8.1 mandatory-handoff-before-implementation gate — its review work needs no handoff contract to start, and it is not a required signoff for other roles' delivery slices. A finding that needs cross-role implementation, QA, or CI evidence still routes through the normal directive → slice → handoff → DoR/DoD process; the Guardian is not gated behind that process to begin looking, but does not bypass it for multi-role fixes.
- **Owns the self-annealing alignment review** (§8 step 13) end-to-end, autonomously, on its existing bounded triggers — not only when the Orchestrator refers a suspicion to it.
- **Authority to guard.** May block or flag a proposed framework change (from any role, including a human maintainer) that would weaken a validator rule, a security gate, a traceability link, or role boundaries, without first needing a handoff contract of its own.
- **Self-validates** against the deterministic governance scripts (`scripts/validate_doe_artifacts.rb`, `scripts/check_governance_consistency.sh`, `scripts/check_workspace_boundary.sh`) as evidence for its own direct maintenance fixes, rather than convening PM/UX/QA/CI signoffs the way a delivery slice does.

## 8) End-to-End Workflow

1. Clarify request if ambiguous.
2. For user-provided specs, run goal/purpose interrogation, requirement-gap analysis, and one-or-more improved proposals.
3. Review proposals with the user and iterate until acceptance or explicit direction.
4. Determine if existing directive applies; otherwise create one that states intent, outcomes, and constraints — the directive does not pre-assign execution slice IDs; orchestration produces those during decomposition.
5. Orchestrator decomposes the directive into delivery slices and assigns role owners. PM then defines each slice's scope plus a handoff contract and role-based Definition of Ready (DoR).
6. UX, QA/security, and CI enforcement prepare their role outputs in parallel from the same handoff contract.
7. Delivery implements slice only after DoR gates are satisfied.
8. QA/security validates (scope-based security depth) against the handoff contract and Definition of Done (DoD).
9. CI enforcement validates policy/workflow/release gates and captures automation evidence.
10. Orchestrator observes the results of steps 7-9 (delivery, QA/security, CI) as they return — not only at final sign-off. If a blocker or finding prevents DoR→DoD progress at any of those steps, orchestrator routes it back to the owning role(s), adapts scope or the handoff contract as needed, and repeats the affected step(s) — bounded to 2 retry cycles per slice before escalating to the user as a blocked slice. Every cycle, including delivery-stage rework and not just QA/CI findings, is logged in the execution record's `iteration_log` (see `.github/skills/doe-execution-governance/assets/execution-record.template.yaml`).
11. Record evidence, including any iteration/replan history, in the execution artifact.
12. Decide release recommendation: `go | go-with-risk | no-go`.
13. Capture reusable lessons in instructions/skills/templates; when a lesson originates from a directive-level gap (not just an execution-level one), reflect it back into the parent directive's outcomes or acceptance criteria so the next decomposition starts from corrected intent. When a lesson is a reusable *maintenance* insight rather than a workflow-rule change (a recurring question, a non-obvious tradeoff already reasoned through), propose it as a draft `MAINTAINER_FAQ.md` entry for maintainer review instead of appending it unreviewed — a documented convention any LLM or maintainer can apply, not tool-specific automation, so it holds regardless of which assistant or clone is doing the work. This is reactive (triggered by a found mistake); also periodically check for drift between this file's stated principles and actual enforcement even when nothing has gone wrong yet — owned by the DOE Workflow Guardian (§7.2) as a standing responsibility independent of the handoff model — trigger a self-annealing review when a previously-dormant validator rule fires for the first time (for example, the first `risk_tier: high|critical` slice), the same residual risk recurs unresolved across 2+ execution records, or roughly every 5 execution records as a lightweight checkpoint. "No gap found" is a valid, low-cost outcome — do not manufacture hardening work just to justify a checkpoint; a genuine, evidence-based gap becomes its own bounded delivery slice through the normal handoff/DoR/DoD process.

## 8.1) Mandatory Handoff Contract (Operational Standard)

Every execution slice must include a handoff contract before implementation starts.

Minimum required fields:

- scope boundary (in/out)
- acceptance criteria
- risk tier (`low|medium|high|critical`) and rationale — reconciled with the §4 security classification (`security.scope: business` defaults to medium-or-higher; a lower tier needs `handoff.risk_tier_override_rationale`)
- threat/abuse assumptions (or explicit N/A)
- validation plan (engineering + QA/security + CI)
- release gate requirements (`handoff.rollback_verified` must be `true`, not only documented intent, when risk tier is high or critical — §4)
- rollback expectation
- owners by role (orchestrator/pm/ux/engineering/qa/ci)

Handoff rule:

- No handoff contract, no implementation start. This gate, and the DoR/DoD gates in §8.2, are mandatory operational requirements for every assistant/LLM operating in this workspace — not optional guidance a cross-LLM boot-context file may soften.

## 8.2) Definition of Ready / Definition of Done

DoR (before engineering starts):

- PM: slice, dependencies, acceptance criteria, and risk tier documented
- UX: flows/states/accessibility criteria documented where applicable
- QA/Security: test matrix drafted, security negatives added when in scope
- CI Enforcement: required automation checks identified

DoD (before release recommendation):

- Engineering: implementation complete, formatting/tests run, residual risks noted
- PM: confirms delivered work matches the slice's acceptance criteria
- UX: confirms delivered UX matches flow/accessibility criteria, where the slice has a UX surface (otherwise `n/a`)
- QA/Security: pass/fail evidence and defects documented with recommendation, plus a dedicated `security_signoff` when risk tier is high or critical (§4)
- CI Enforcement: policy/workflow gates pass or exceptions documented
- Orchestrator: evidence traceability complete and release decision recorded

## 9) Artifact Contract (Minimum)

### Directive YAML (`directives/*.yaml`)
Must include:

- `metadata.directive_id` (`DIR-####` or `SEC-####`)
- `metadata.title`, `metadata.status`, `metadata.last_updated`
- product directives: `context`, `delivery`, `security`
- security directives: `scope`, `controls`, `verification`
- product directives: `security.scope` is `business` or `non-business` (validator-enforced enum — this is the exact literal §4's risk-tier reconciliation matches, so an unrecognized value fails validation instead of silently never reconciling)
- `delivery.release_slices` (product directives) is populated by orchestration as slices are decomposed and executed — a traceability record of fulfillment, not a plan the directive author pre-assigns.

### Execution YAML (`executions/*.yaml`)
Must include:

- `metadata.execution_id` (`EXE-####`)
- `metadata.directive_refs` (non-empty)
- `scope`, `validation`, `risk`
- `handoff` contract section with role owners and gates
- `quality_gates` section with DoR/DoD evidence, including `definition_of_done.project_manager` and `definition_of_done.ux_ui` (`pass|fail|n/a`)
- `risk.release_recommendation` in `go|go-with-risk|no-go`
- `iteration_log` (optional) when the workflow step 10 observe/adapt/retry loop runs — omit or leave empty for slices that completed without a replan cycle; when present, each entry's `result` is validator-enforced to `resolved|escalated-to-user|deferred-with-residual-risk`, at most 2 non-escalated entries are allowed, and no entry may follow one with `result: escalated-to-user`
- `handoff.rollback_verified` (`true`), and `quality_gates.definition_of_done.security_signoff` (`pass|fail`), when `handoff.risk_tier` is `high` or `critical` (§4)

For web apps, include preview/deployment evidence (or explicit N/A).

### Referential Integrity (validator-enforced)

`scripts/validate_doe_artifacts.rb` cross-checks the traceability chain, not just per-file shape:

- every execution's `metadata.directive_refs` must point at a directive that actually exists
- a product directive's `delivery.release_slices` and the executions that list it back in `directive_refs` must agree bidirectionally — either side drifting from the other fails validation
- `metadata.directive_id`/`metadata.execution_id` values must be unique across all files of that type; a duplicate id (for example, from a copy-pasted template with a forgotten renumber) fails validation instead of silently shadowing the earlier file

## 10) Suggested Governance Automation

Implement and run:

- DOE artifact schema/shape validation, including unique-id and `security.scope` enum enforcement, cross-file referential integrity (§9), risk-tier reconciliation (§4), the `iteration_log` retry-cycle cap (§8), and high/critical-tier rollback-verification/security-signoff hardening (§4)
- commit subject policy check
- PR title policy check
- governance consistency check for workflow/policy/script drift, including dynamic checks derived from SYSTEM.md itself (retry-cycle bound — checked against every role agent/skill that restates it, not only the boot-context summary — and section-heading references) rather than only a curated term list

Recommended commit subject format:

- `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`, `perf: ...`, `test: ...`, `chore: ...`

Merge/revert allowance:

- merge and revert commits generated by Git or hosting providers may use their generated subjects

Commit policy:

- omit assistant `Co-authored-by` trailers unless explicitly requested by a human

## 11) Current Strategic Gap (Intentional)

Baseline governance may exist, but project-specific CI/release hardening is usually end-user-owned:

- stack-specific lint/test/build/security automation
- release gates tied to execution evidence

Prioritize incremental CI hardening as real stacks are introduced.

## 12) Response Style

- concise, direct, actionable
- structured summaries over long prose
- evidence-first, assumption-light

## 13) Audience and Adoption Model

This workspace serves two distinct audiences, kept separate by the §3 boundary:

- **Framework maintainers** evolve the DOE workflow itself. Their changes stay within the §3 framework paths; `CONTRIBUTING.md` is their entry point and `scripts/check_workspace_boundary.sh` enforces the boundary in CI.
- **Product builders (end-users)** consume the workflow from their own product repository without editing it. They vendor the distributable DOE assets — declared once in `.github/doe-manifest.yml` — via `scripts/doe-install.sh`, pin a version, and layer their own directives, executions, agents, and product code alongside the vendored core. Framework improvements arrive by re-running the installer at a newer version; `CONSUMERS.md` is their entry point.

The boundary is what keeps the audiences separate: product code never lands in this framework repository, and the vendored core is never hand-edited in a product repository. Consumers adopt only the *portable* governance automation (§10); the framework's self-governance checks — including the DOE Workflow Guardian agent (§7.2) — are maintainer-only. This model is additive to §1–§12 and changes none of the existing gates.
