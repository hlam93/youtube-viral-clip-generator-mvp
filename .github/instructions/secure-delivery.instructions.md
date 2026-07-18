---
name: Secure Delivery Guidance
description: "Use when working on authentication, authorization, APIs, forms, file uploads, secrets, dependency upgrades, session handling, logging, data validation, or other security-sensitive delivery tasks. Applies OWASP-aware engineering and QA expectations."
applyTo:
  - "**/*"
---
# Secure Delivery Guidance

- Model trust boundaries, assets, and abuse cases before or during refinement.
- Validate and normalize untrusted input at the boundary.
- Enforce authorization server-side for every protected action.
- Avoid storing secrets in source; prefer secure configuration and least privilege.
- Use safe defaults for logging, error handling, and session management.
- Review changes against OWASP Top 10 themes and use ASVS-style controls where applicable.
- Ensure QA includes negative tests for access control, validation, and error paths.
- Prefer solutions that are readable, performant, and concise in both code and documentation.
- Resolve routine implementation and verification issues within role boundaries; if request intent or scope is unclear, ask a targeted clarification question before proceeding.
- When installing dependencies or tooling, prefer quiet/non-verbose modes and use debug/verbose output only for blocker diagnosis.
- When a security gap or mistake reveals a reusable lesson, update the relevant artifact or instruction so future work improves.
