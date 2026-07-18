---
name: DOE Artifact Conventions
description: "Use when creating or updating DOE directives, execution records, work-package YAML, backlog artifacts, or traceability metadata in directives/ or executions/."
applyTo:
  - "directives/**/*.yaml"
  - "executions/**/*.yaml"
---
# DOE Artifact Conventions

- Keep artifacts structured as YAML with stable identifiers.
- Prefer explicit fields over narrative prose so downstream agents can parse dependencies, risks, and acceptance criteria.
- Every execution artifact should reference one or more directive identifiers.
- Capture security expectations explicitly for business applications or explicit security requests, including data sensitivity, auth/authz assumptions, and verification steps.
- For web application artifacts, include preview/run readiness and a free-host deployment path (or explicit N/A).
- Use measurable acceptance criteria and definition-of-done checkpoints.
- Record residual risks and rollback or mitigation notes when delivery changes runtime behavior.
