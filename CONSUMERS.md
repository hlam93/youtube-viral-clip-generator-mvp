# Using DOE in Your Product Repository (for Product Builders)

This is the entry point for **audience #2**: teams building a product who want to *use*
the DOE secure-agile workflow without editing it. If instead you maintain the DOE
framework itself, see [CONTRIBUTING.md](CONTRIBUTING.md).

The model is **vendor and pin** (SYSTEM.md §13): you copy a pinned version of the DOE
assets into your own repository, layer your product artifacts and code alongside them,
and pull framework improvements by re-installing at a newer version. You never hand-edit
the vendored core, so updates stay clean.

## Prerequisites

- **Git**, plus one of:
  - **Bash** to run `scripts/doe-install.sh` (macOS/Linux: native; Windows: Git Bash or WSL).
  - **PowerShell 5.1+** (`powershell.exe`, ships with Windows, or `pwsh`) to run
    `scripts/doe-install.ps1` — a behavior-identical, Windows-native twin, so Windows
    consumers don't need Git Bash/WSL just to install. Every example below shows both.
- **Ruby is not required locally.** The vendored CI workflow
  (`.github/workflows/doe-governance.yml` after install) sets up Ruby 3.3 itself via
  `ruby/setup-ruby@v1` to run the validator in your CI — you only need Ruby locally if
  you want to run `validate_doe_artifacts.rb` yourself before pushing.

## 1. Obtain and install

```bash
# 1. Get the framework at the version you want to pin.
git clone https://github.com/dhynlkm/agentic-secure-agile-sdlc-doe-workflow.git doe-framework
cd doe-framework
git checkout <tag-or-commit>        # pin a version

# 2. Vendor the distributable assets into your product repo.
scripts/doe-install.sh install /path/to/your-product-repo
```

On Windows without Git Bash/WSL, use the PowerShell twin instead — same steps, same result:

```powershell
git clone https://github.com/dhynlkm/agentic-secure-agile-sdlc-doe-workflow.git doe-framework
cd doe-framework
git checkout <tag-or-commit>

.\scripts\doe-install.ps1 install C:\path\to\your-product-repo
```

This copies the assets declared under `distributable:` in
[.github/doe-manifest.yml](.github/doe-manifest.yml) (maintainer-only — that manifest file
itself is never vendored into your repo, only the assets it declares) into your repo, writes a
`.doe-framework-version` stamp recording the pinned version, and marks every vendored
path `linguist-vendored linguist-generated=true` in a managed block in your repo's
`.gitattributes` (creating it if needed, merging into it if you already have one). This
keeps the vendored core git-tracked and committed — required for the shipped CI workflow
to run at all, and for teammates to get it without re-running the installer — while
GitHub's language stats, diffs, and blame treat it as vendored/generated rather than your
own product code. The block is regenerated on every `install`/`update`; don't hand-edit
between the `# BEGIN DOE vendored files` / `# END DOE vendored files` markers, add your
own `.gitattributes` rules outside them. What you get:

- **License** — `LICENSE.md` (MIT), covering the vendored framework assets
- **Boot context** — `SYSTEM.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`
- **Role agents** — `.github/agents/` (orchestrator, PM, UX, delivery, QA/security, CI), plus
  their Claude Code native adapters in `.claude/agents/` (same six roles, Claude's
  subagent/frontmatter format, pointing back to the `.github/agents/` source of truth)
- **Skills + templates** — `.github/skills/`, plus their Claude Code native adapters in
  `.claude/skills/`
- **Path-scoped rules** — `.github/instructions/`
- **Portable governance** — `scripts/validate_doe_artifacts.rb` (+ its unit test),
  `scripts/check_commit_messages.sh`, `scripts/check_pr_title.sh`
- **Starter CI** — `.github/workflows/doe-governance.yml` (portable checks only)

What is **not** shipped: this repo's own `directives/`, `executions/`, `README.md`, the
maintainer-only self-governance scripts (`check_governance_consistency.sh`,
`check_workspace_boundary.sh`), and the maintainer-only DOE Workflow Guardian agent
(SYSTEM.md §7.2) in either format. Neither format is vendored:
`.github/agents/doe-workflow-guardian.agent.md` (maintainer-only, not vendored) nor
`.claude/agents/doe-workflow-guardian.md` (maintainer-only, not vendored). Those police the
framework repo itself; your pinned copy of `SYSTEM.md` is already policed upstream, so you
don't re-run them.

Two of the files above ship with content adapted for your repository rather than a
byte-for-byte copy of this framework repo's own: `.github/copilot-instructions.md` and
`.github/agents/doe-ci-enforcement.agent.md` (and its `.claude/agents/` mirror, which just
points at it). This framework repo's own copies correctly reference the maintainer-only
scripts above; a verbatim copy would leave your repo with dead references to files that
were never vendored, so the installer substitutes a consumer-appropriate variant
(`scripts/assets/consumer-copilot-instructions.md`,
`scripts/assets/consumer-ci-enforcement.agent.md`) at install time instead.

## 2. Extend without editing the core

Build *on top of* the vendored assets — never inside them:

- Put **your** product/security directives in `directives/` (`DIR-0001-your-product.yaml`).
- Put **your** execution records in `executions/`.
- Add **product-specific** agents or skills as *new* files in `.github/agents/` /
  `.github/skills/` — do not modify the vendored DOE ones.
- Your product application code lives wherever your stack expects (`src/`, `app/`, …).

Treat every vendored file as read-only. Local edits to the core will be overwritten on
the next update and will show up as drift (see below).

## 3. Your first slice (quickstart)

The DOE role model (SYSTEM.md §7) is the same regardless of which LLM tool you use, but
*how you invoke a role* differs by tool today — be aware of this before you start:

- **Claude Code**: the six role agents are wired in as native subagents
  (`.claude/agents/`). A session auto-routes to the matching role from its
  `description` — you can just describe what you want built (e.g. "I want to build a
  todo app with user accounts") and the orchestrator persona picks it up. You can also
  invoke a role by name if you want to be explicit (e.g. "use the DOE Project Manager
  agent to turn this into backlog items").
- **Gemini CLI** and **GitHub Copilot**: `GEMINI.md` / `.github/copilot-instructions.md`
  auto-load the canonical contract (SYSTEM.md), but there's no native subagent
  auto-routing yet for these tools in this framework. Invoke a role explicitly by
  pointing the model at its file, e.g.: *"Follow the DOE Orchestrator role defined in
  `.github/agents/doe-orchestrator.agent.md` and help me scope a first directive for
  \<your product>."* Do this once per role as you move through the loop below.

With that in mind, a first pass through the DOE loop (SYSTEM.md §8) looks like:

1. **Directive** — describe your product intent to the orchestrator role. It should
   scrutinize your spec (goal, gaps, options) before writing
   `directives/DIR-0001-your-product.yaml` — use
   [`doe-directive-design`](.github/skills/doe-directive-design/SKILL.md) and its
   [product directive template](.github/skills/doe-directive-design/assets/product-directive.template.yaml).
   Do not pre-assign execution slice IDs here — that happens next.
2. **Decompose** — the orchestrator breaks the directive into one delivery slice and
   assigns role owners; the PM refines it into a handoff contract (scope, acceptance
   criteria, risk tier, validation plan, release gates, rollback) per SYSTEM.md §8.1,
   using [`doe-execution-governance`](.github/skills/doe-execution-governance/SKILL.md)
   and its [execution template](.github/skills/doe-execution-governance/assets/execution-record.template.yaml).
3. **DoR** — PM/UX/QA/CI each confirm their Definition-of-Ready piece (SYSTEM.md §8.2)
   before any code is written. No handoff contract, no implementation start.
4. **Implement** — the engineering role builds the slice against the handoff contract.
5. **DoD** — QA/security validates, CI enforcement checks policy/workflow gates, PM/UX
   confirm delivered work against their criteria, and the orchestrator records a release
   recommendation (`go | go-with-risk | no-go`) in `executions/EXE-0001-....yaml`.

Run `ruby scripts/validate_doe_artifacts.rb` (if you have Ruby locally) or push to your
vendored CI to confirm your first directive/execution pair is structurally valid before
you consider the slice done.

## 4. Update and detect drift

```bash
# In your framework checkout, move to the newer version, then re-install:
git checkout <newer-tag>
scripts/doe-install.sh update /path/to/your-product-repo

# Check whether your vendored core still matches the pinned framework:
scripts/doe-install.sh verify /path/to/your-product-repo
```

```powershell
# PowerShell equivalent (Windows without Git Bash/WSL):
git checkout <newer-tag>
.\scripts\doe-install.ps1 update C:\path\to\your-product-repo
.\scripts\doe-install.ps1 verify C:\path\to\your-product-repo
```

`verify` reports any vendored file that differs from the framework checkout (an
accidental local edit, or a stale pin) and exits non-zero, so you can wire it into your
own CI if you want hard enforcement that the core stays untouched. `verify` does not
check `.gitattributes` (it's merged with your own rules, not a straight vendored copy) —
`install`/`update` keep its managed block current every time you re-run them.

## 5. Minimum downstream CI baseline

SYSTEM.md §11 intentionally leaves product-stack CI and release gates to you. The
installed `doe-governance.yml` covers the portable DOE checks; add the rest as your
stack matures. Recommended minimum, in priority order:

- [ ] **DOE artifact validation** — shipped (`validate_doe_artifacts.rb`); keep it required.
- [ ] **Commit + PR title policy** — shipped; keep them required.
- [ ] **Lint / format** for your language(s).
- [ ] **Unit + integration tests** with a coverage floor.
- [ ] **Build** (and, for web apps, a preview/build check per SYSTEM.md §5).
- [ ] **Dependency + secret scanning** (e.g. audit, SCA, secret detection).
- [ ] **Security-negative tests** for business applications (SYSTEM.md §4).
- [ ] **Release-disposition gate** — block merge/release on a `no-go` execution outcome.

Use the **DOE CI Enforcement** agent to implement these as real tooling lands, so they
stay traceable to your directives and execution evidence.

## 6. Keep your work traceable

The traceability chain is unchanged in your repo: `directive → delivery slice →
execution record → validation evidence`. The vendored `validate_doe_artifacts.rb`
enforces the artifact shape and referential integrity for *your* directives and
executions exactly as it does here.

## 7. Report feedback

Hit friction with the framework itself, or found a gap in a role agent, skill, or doc?
`doe-install.sh`/`doe-install.ps1` print a direct link after every `install`/`update` run,
or file it any time via the framework repo's
[consumer feedback issue form](https://github.com/dhynlkm/agentic-secure-agile-sdlc-doe-workflow/issues/new?template=consumer-feedback.yml)
— maintainers triage these on a regular cadence (see CONTRIBUTING.md). This links to the
framework repository's own hosted issue form (matching the URL `doe-install.sh`/
`doe-install.ps1` construct from `origin` at install time), not a local path — the issue
template itself is not vendored into your repo, since feedback belongs in the framework's
tracker, not yours. This is for the *framework* (install experience, role agents, skills,
docs) — bugs in your own product code belong in your own repo's tracker, not there.
