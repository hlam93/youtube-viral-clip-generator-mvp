# Upstream Proposals for the DOE Framework

> **Workspace convention (local, non-vendored):** this file is the source of
> truth for candidate framework improvements identified while working in this
> repo. When a SYSTEM.md §8 step 13-style reusable lesson surfaces — a
> maintenance insight worth a maintainer's attention that isn't itself a
> workflow-rule defect — log it here as a new `## Proposal N` entry instead of
> letting it live only in conversation history. Entries stay in draft status
> until filed upstream via the framework's real feedback channel
> (`CONSUMERS.md` §7); this file is a staging area, not itself the filing
> mechanism.

Draft proposals observed while operating this consumer repo, held here until the
project reaches a stopping point and they can be filed via the framework's
consumer feedback channel (`CONSUMERS.md` §7) for maintainer review. These are
**not** bug reports — vendor hygiene defects get fixed and reported as they're
found. This file is for patterns worth maintainers *evaluating*, not patterns
already known to be correct.

Per `SYSTEM.md` §8 step 13, a reusable maintenance insight that isn't a
workflow-rule defect should be proposed as a draft entry for maintainer review,
not adopted unilaterally into the framework. Each entry below follows that
intent.

---

## Proposal 1: Optional `metadata.reference_artifacts` field + documented convention for shared config/contract/policy artifacts

**Status:** draft — not yet filed. Evidence base is a single consumer repo (n=1).
Hold until this pattern is confirmed to recur in a second product repo before
proposing as accepted guidance.

### Problem

Some product directives depend on shared, reusable artifacts that don't fit
cleanly into a single directive's `context`/`delivery`/`security` shape —
things like a scoring config, an API/cache contract, a ranking policy, or
delivery guidelines that multiple directives or executions may reference over
time. The framework's traceability chain (`directive → delivery slice →
execution record → validation evidence`, SYSTEM.md §3) has no place for this:
it covers directive-to-execution linkage but not directive-to-supporting-artifact
linkage.

### Current framework behavior

- `doe-directive-design/SKILL.md` and `product-directive.template.yaml` define
  no concept of a shared reference artifact. Directive content is expected to
  be self-contained.
- `scripts/validate_doe_artifacts.rb` only globs `directives/*.yaml` /
  `executions/*.yaml` (non-recursive) — anything in a subdirectory of
  `directives/` is invisible to the validator by construction, whether or not
  it's a reference artifact.
- Nothing prevents a consumer from inventing their own subdirectory/schema for
  this (which is exactly what happened here — see below) — but nothing guides
  it either, so each consumer would reinvent the shape independently.

### Observed pattern (this repo)

This repo independently created:
- `directives/config/*.yaml` (e.g. `scoring-config.v1.yaml`,
  `limits-thresholds-matrix.v1.yaml`)
- `directives/contracts/*.yaml` (e.g. `api-cache-schemas.v1.yaml`)
- `directives/policies/*.yaml` (e.g. `deterministic-ranking-policy.v1.yaml`)
- `directives/standards/*.yaml` (e.g. `delivery-guidelines.v1.yaml`)

Each carries its own local schema: `metadata.artifact_id`,
`metadata.artifact_type`, `metadata.version`, `metadata.status`,
`metadata.source_documents` (pointing to upstream product docs like
`MISSION.md`, `MVP_v1.md`).

`DIR-0001` never links back to any of these five files, despite its
`authz_model`, `abuse_cases`, and other fields effectively restating content
those files already own. There is no field in the current schema where that
back-reference belongs.

### Proposed addition

An **optional** `metadata.reference_artifacts` list on product directives,
mirroring the `metadata.source_documents` convention the reference artifacts
already use themselves:

```yaml
metadata:
  directive_id: DIR-0001
  ...
  reference_artifacts:
    - directives/config/scoring-config.v1.yaml
    - directives/contracts/api-cache-schemas.v1.yaml
```

Paired with a short SKILL.md note (in `doe-directive-design`) describing the
optional `directives/<category>/` convention for products that accumulate
shared config/contract/policy/standard artifacts, so consumers who need this
don't each invent an incompatible shape.

### Explicitly not proposing

- Making `reference_artifacts` required, or validator-enforced.
- A recursive validator glob change (`directives/**/*.yaml`) — that would pull
  these artifacts into directive-shape validation, which is the wrong fit;
  they have their own schema.
- Any change to `context`/`delivery`/`security` — this is additive to
  `metadata` only.

### Why this belongs in the framework rather than staying local

If this pattern is common (products with a scoring config, an API contract, a
ranking policy, etc., referenced by more than one directive/execution over the
product's life), each consumer independently reinventing the subdirectory
layout and schema is exactly the kind of duplicated-invention the framework
exists to prevent. If it's rare or this repo is an outlier, it isn't worth the
added template surface area, and this proposal should be dropped.

### What would confirm this is worth adopting

- The same shared-artifact need appearing in a second, unrelated consumer
  repo, ideally with an independently-invented shape close enough to suggest
  convergent need rather than coincidence.
- A maintainer judgment call on whether `metadata.reference_artifacts` is the
  right shape vs. some other mechanism (e.g. a `context.reference_artifacts`
  key, or leaving it entirely to consumer-side instructions files).

---

## Proposal 2: DoD role confirmation should require criterion-by-criterion evidence, not a holistic pass/fail, for solo-operator consumers

**Status:** draft — not yet filed. Evidence base is a single consumer repo (n=1),
surfaced during a post-hoc review of EXE-0001..0007 against DIR-0001.

### Problem

SYSTEM.md's role model (§7, §7.1) is presented as valuable for a single
developer specifically because it forces perspective-switching (PM/UX/QA-Security/
CI lenses) that an engineer in implementation mode tends to skip — not because
it coordinates multiple humans. That's a legitimate value proposition, but the
current DoD artifact shape (`quality_gates.definition_of_done.*: pass|fail|n/a`,
SYSTEM.md §9) only records the *outcome* of a role pass, not whether the pass
was actually adversarial. A solo operator can satisfy the schema by writing
`qa_security: pass` immediately after finishing the implementation, with the
same reasoning that just wrote the code — collapsing the intended second
perspective back into the first one, invisibly, because the artifact looks
identical either way.

### Observed pattern (this repo)

Reviewing this repo's delivered code against DIR-0001's acceptance criteria
directly (not via the execution records) surfaced two gaps that the relevant
DoD role should have caught:

- DIR-0001's acceptance criteria requires rendered (Mode B) clips to be
  "capped per job and used only on reliability failures" — implying a real
  render pipeline exists. It doesn't: `/rendered/:jobId/:clipId`
  ([app.ts](src/app.ts)) 302-redirects to the plain YouTube watch URL, and
  `package.json` has no video-processing dependency. This is squarely
  **QA/Security DoD** territory ("confirms delivered work matches acceptance
  criteria" — SYSTEM.md §8.2) — an acceptance-criteria bullet was satisfied by
  routing logic, not the feature it names.
- DIR-0001's `quality.accessibility` field commits to "WCAG 2.1 AA for web
  search and clip feed interactions." The client ships 3 total `aria-*`/`role`
  attributes. This is squarely **UX DoD** territory (confirms delivered UX
  matches accessibility criteria).

Both roles are correctly defined in the framework; both gaps are exactly what
those roles exist to catch. The gap is that whatever pass produced `pass` (or
absence of a documented failure) for these slices didn't re-derive the
directive's specific acceptance-criteria/accessibility bullets and check each
one against the diff — it appears to have been a general "looks complete"
judgment.

### Proposed addition

For consumers operating with a single human across all roles (the common case
per CONSUMERS.md's adoption model), strengthen the DoD guidance so a role's
`pass` requires enumerating the directive's acceptance-criteria (or
accessibility-criteria) bullets individually, each with pass/fail/n/a and a
one-line evidence pointer (file/line or test name), rather than a single
holistic verdict per role. This could be:

- A documented convention in `doe-execution-governance`'s
  `execution-record.template.yaml` (an optional
  `quality_gates.definition_of_done.qa_security_criteria: [{criterion, status,
  evidence}]` breakdown), not a schema-breaking change to the existing
  `pass|fail|n/a` field, or
- Purely a skill-level instruction (in `doe-qa-security`/`doe-ux-ui-designer`
  agent definitions) to re-read the parent directive's specific criteria list
  before recording DoD status, with no artifact schema change at all.

### Explicitly not proposing

- Validator enforcement of a criterion-by-criterion breakdown — this is a
  rigor/process recommendation, not a shape the validator should reject
  deviations from.
- Any change for multi-human teams, where a distinct second reviewer already
  provides the adversarial distance this proposal is trying to manufacture for
  solo operators.

### Why this belongs in the framework rather than staying local

If DOE's stated value for solo developers is the perspective-switching itself
(per this repo's owner's framing, not just this reviewer's), then the artifact
schema should make it hard to satisfy a role's DoD without genuinely
re-deriving that role's checklist from the directive — otherwise the schema
rewards the appearance of a second opinion without requiring the substance of
one. This is a framework-level gap (the schema/guidance), not a one-off
mistake in this repo's execution records.

### What would confirm this is worth adopting

- The same pattern (a DoD `pass` that a later independent review shows didn't
  actually check the relevant acceptance-criteria bullet) recurring in a
  second consumer repo.
- A maintainer judgment call on whether criterion-level evidence belongs in
  the execution record schema itself or is better left as agent-level
  instruction discipline.

---

## Proposal 3: `doe-ci-enforcement` should default-scaffold a product CI workflow when a directive sets `web_deployment.preview_required: true`

**Status:** draft — not yet filed. Evidence base is a single consumer repo (n=1),
surfaced during a post-hoc grading review of this repo against DIR-0001.

### Problem

SYSTEM.md §5 (Web Application Policy) requires web-app directives to include
"local preview/run readiness" and "execution evidence covering preview/build
and deployment steps," and §7's DOE CI Enforcement role is explicitly
responsible for "supports web preview/deploy automation for web applications."
DIR-0001 sets `delivery.web_deployment.preview_required: true` and this repo
has thorough deployment *documentation* (README.md's Render/Railway/Vercel
sections, with verification curl steps). But there is no actual CI workflow
gating PRs on the product's own build/test/typecheck — only
`.github/workflows/doe-governance.yml`, which validates DOE artifact shape,
not the product. A broken build or failing test in `src/`/`tests/` would
currently merge cleanly as far as automation is concerned.

### Current framework behavior

- `doe-ci-enforcement`'s skill/agent guidance discusses policy-as-code checks,
  release gating, and lint/test/build automation in the abstract, but nothing
  in the framework proactively generates a starter product CI workflow keyed
  off a directive's `web_deployment.preview_required` flag.
- The DoD field `quality_gates.definition_of_done.ci_enforcement` can be
  marked `pass` on the strength of the governance workflow passing, without
  distinguishing "DOE artifacts are valid" from "the product itself builds and
  passes its tests in CI."

### Proposed addition

When `doe-ci-enforcement` is engaged for a web-app directive with
`web_deployment.preview_required: true`, have it scaffold (or verify the
presence of) a minimal product CI workflow — typecheck + test + build, using
whatever the consumer's `package.json` scripts already define (`npm run
build`, `npm test`, etc.) — as part of that slice's DoR/DoD evidence, distinct
from the DOE governance workflow. This is additive scaffolding, not a new
validator rule.

### Explicitly not proposing

- Any change to `scripts/validate_doe_artifacts.rb` or the governance
  workflow — those correctly stay scoped to DOE artifact shape.
- Prescribing a specific CI provider or stack-specific tooling — SYSTEM.md
  §11 already treats stack-specific lint/test/build automation as an
  intentional strategic gap the consumer owns; this proposal is only about
  *prompting* that scaffolding to happen by default for web-app directives,
  not about the framework owning stack-specific CI logic itself.

### Why this belongs in the framework rather than staying local

The gap here wasn't a decision this repo made deliberately — it's an omission
that the framework's own stated role responsibilities (§5, §7 CI Enforcement)
should have surfaced during DoR/DoD but didn't, because nothing prompts for it
concretely. A lightweight scaffold-or-verify step closes exactly the gap
between "documented as required" and "actually enforced," which is the same
category of gap as Proposal 2 (recorded pass vs. substantive check), applied
to CI Enforcement instead of QA/Security or UX.

### What would confirm this is worth adopting

- The same gap (deployment docs present, but no product-level CI gate)
  recurring in a second consumer repo.
- A maintainer judgment call on whether this belongs as skill-level guidance
  (a checklist prompt) or as an actual scaffolding action the CI Enforcement
  agent takes.

---

*(Add further proposals above this line as they're identified.)*
