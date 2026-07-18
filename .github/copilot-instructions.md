# DOE Workspace Guidelines

`SYSTEM.md` at the repository root is the canonical DOE contract — read it directly; this file does not
mirror its detail. Keeping one canonical copy of the rules, instead of a second copy kept in sync by
tooling, is the point: fewer places for drift to happen, not better detectors for it.

## Non-negotiable essentials (see SYSTEM.md for full detail)

- Team-first: route work through the DOE role agents in `.github/agents/`; don't solve product-delivery work solo.
- No handoff contract, no implementation start (SYSTEM.md §8.1) — this and the DoR/DoD gates (§8.2) are mandatory, not optional.
- Security depth is risk-proportionate: default-priority for business applications, de-prioritized otherwise unless asked (§4).
- Preserve traceability: directive → delivery slice → execution record → validation evidence (§9), enforced by `scripts/validate_doe_artifacts.rb`.
- This is a product repository that vendored the DOE framework core (SYSTEM.md §13); the vendored assets are read-only — add your own directives/executions/agents/skills and product code alongside them, never inside them (CONSUMERS.md).

## Where the rest lives

- **SYSTEM.md** — full DOE loop, role model (§7), Role Gate Matrix (§7.1), workflow (§8), handoff contract (§8.1), DoR/DoD (§8.2), artifact contract (§9), governance automation (§10).
- **`.github/agents/*.agent.md`** — the six role agents; use the one matching the work instead of acting generically.
- **`.github/instructions/*.instructions.md`** — path-scoped rules (YAML artifact conventions, secure delivery, commit policy) that attach automatically to matching files.
- **`.github/skills/*/SKILL.md`** — directive-design, execution-governance, and commit-governance procedures, with YAML templates under each skill's `assets/`.
- **CONSUMERS.md** — what was vendored, what was intentionally not (the framework's own self-governance scripts and the DOE Workflow Guardian agent are maintainer-only and stay upstream), and how to update/verify your pinned copy.

## Keeping this file honest

This file should stay this short. If a change to your pinned `SYSTEM.md` seems to require restating new
detail here, that is a signal to add a pointer, not a paragraph. The dynamic `§X`-reference and
retry-cycle-bound consistency checks that police this file in the upstream framework repository
(`scripts/check_governance_consistency.sh`) are maintainer-only and were not vendored into this repository
(CONSUMERS.md) — keep this file accurate by review, and rely on `scripts/validate_doe_artifacts.rb`
(vendored) for the structural checks that were shipped.
