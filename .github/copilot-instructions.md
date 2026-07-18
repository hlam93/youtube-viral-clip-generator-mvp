# DOE Workspace Guidelines

`SYSTEM.md` at the repository root is the canonical DOE contract — read it directly; this file does not
mirror its detail. Keeping one canonical copy of the rules, instead of a second copy kept in sync by
tooling, is the point: fewer places for drift to happen, not better detectors for it.

## Non-negotiable essentials (see SYSTEM.md for full detail)

- Team-first: route work through the DOE role agents in `.github/agents/`; don't solve product-delivery work solo.
- No handoff contract, no implementation start (SYSTEM.md §8.1) — this and the DoR/DoD gates (§8.2) are mandatory, not optional.
- Security depth is risk-proportionate: default-priority for business applications, de-prioritized otherwise unless asked (§4).
- Preserve traceability: directive → delivery slice → execution record → validation evidence (§9), enforced by `scripts/validate_doe_artifacts.rb`.
- This repository is DOE framework/governance only; direct edits are scoped to `.github/`, `directives/`, `executions/`, `scripts/`, `*.md` (§3). End-user product code belongs in the product's own repository.

## Where the rest lives

- **SYSTEM.md** — full DOE loop, role model (§7), Role Gate Matrix (§7.1), workflow (§8), handoff contract (§8.1), DoR/DoD (§8.2), artifact contract (§9), governance automation (§10).
- **`.github/agents/*.agent.md`** — the six role agents; use the one matching the work instead of acting generically.
- **`.github/instructions/*.instructions.md`** — path-scoped rules (YAML artifact conventions, secure delivery, commit policy) that attach automatically to matching files.
- **`.github/skills/*/SKILL.md`** — directive-design and execution-governance procedures, with YAML templates under each skill's `assets/`.

## Keeping this file honest

This file should stay this short. If a change to SYSTEM.md seems to require restating new detail here,
that is a signal to add a pointer, not a paragraph — `scripts/check_governance_consistency.sh` verifies any
`§X` reference here (or in any Markdown file) still matches a real SYSTEM.md heading, and that any stated
retry-cycle bound agrees with SYSTEM.md's.
