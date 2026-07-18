---
name: doe-directive-design
description: "Design DOE directives for new products, major features, epics, roadmap slices, or security baselines. Use when a request needs structured directives in directives/ before backlog decomposition or implementation."
argument-hint: "Describe the product idea, feature, or directive scope to structure."
---

# DOE Directive Design

Use this skill to convert a rough product request into directive artifacts that can guide planning and execution.

## When to Use

- A new project starts from an idea, problem statement, or stakeholder request
- A large feature needs product and delivery constraints defined first, with security constraints for business applications or explicit security requests
- The workspace needs a reusable directive baseline before implementation begins

## Procedure

1. Classify the request as product, feature, platform, or security directive.
2. Create or update directive YAML in `directives/` using the provided templates.
3. Define outcomes, non-goals, stakeholders, constraints, and acceptance criteria; include security expectations for business applications or explicit security requests. Keep outcomes at the durable "why" level and acceptance criteria at the testable "done" level — a new slice does not need a new outcomes line if it doesn't change the underlying "why," only a new acceptance criterion.
4. For web application directives, include preview/run expectations and at least one free-host deployment target.
5. Identify work slices that should later become execution records in `executions/`.
6. Reference the appropriate asset template:
   - [product directive template](./assets/product-directive.template.yaml)
   - [security baseline template](./assets/security-directive.template.yaml)

## Required Checks

- Scope is small enough to decompose
- Risks and assumptions are explicit
- `security.scope` is set to exactly `business` or `non-business` (validator-enforced; SYSTEM.md §4/§9) — a non-business directive the user asked to harden still uses `non-business` and notes the elevated depth in `abuse_cases`
- Security posture covers assets, trust boundaries, and abuse cases for business applications or explicit security requests
- Web directives include previewability and free-host deployment expectations
- Acceptance outcomes are measurable
