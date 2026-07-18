# Gemini Project Context

@./SYSTEM.md

## Gemini-Specific Notes

- This file is the project-wide Gemini strategy and context file for this repository.
- Treat `SYSTEM.md` as the canonical shared operating contract for cross-LLM interoperability.
- For Gemini CLI system-prompt override mode, point `GEMINI_SYSTEM_MD` at `./SYSTEM.md` so `SYSTEM.md` acts as the stable system layer and `GEMINI.md` remains the project strategy layer.
- Keep future additions modular and concise; prefer `@` imports for larger topic-specific guidance.
- Preserve compatibility with the DOE workspace layout and role model defined in `SYSTEM.md`. (Its handoff/DoR/DoD gates are already stated as mandatory, not optional, in the imported `SYSTEM.md` §8.1 — no restatement needed here.)
