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

*(Add further proposals above this line as they're identified.)*
