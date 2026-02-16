# node_reqwest

## Project

Rust-based Node.js native addon using neon bindings for HTTP
client functionality (wrapping reqwest). Three Rust packages
(`core`, `meta`, `node`) and TypeScript exports.

## Commands

- `mise run check` — full pre-commit: lint, format, build checks
- `mise run fix` — auto-fix lint and format issues
- `mise run test` — run all tests
- `mise run build` — build all packages
- `/reflect` — review conversation, propose instruction updates

## Guiding Principles

1. **Tooling over documentation** — if a rule can be enforced
   by a tool (clippy, oxlint, ruff), configure the tool.
   Don't document what tooling already enforces.
2. **Lean instructions** — CLAUDE.md captures conventions that
   require judgment; mechanical checks belong in config files.
3. **Config consistency** — CLAUDE.md and agent prompts
   (`.claude/agents/`) must stay in sync.
4. **Reflect periodically** — run `/reflect` after completing
   tasks to capture undocumented patterns.
5. **Hooks for guardrails** — `mise run check` must pass before
   stopping after any coding task. Enforced by the Stop hook
   in `.claude/settings.json`.

## Dependency Management

- **Prefer updating over overriding** — when a transitive
  dependency has a vulnerability, update the parent dependency
  first. Only add overrides as a last resort.
- **Respect cooldown periods** — Python uses
  `exclude-newer = "1 day"` (pyproject.toml) and pnpm uses
  `minimumReleaseAge: 1440` minutes (pnpm-workspace.yaml).
  Never pin to a version published less than 1 day ago.
- **Verify CLI compatibility after upgrades** — tool upgrades
  can change CLI flags (e.g. pyrefly dropped `--all`). After
  bumping a tool version, verify that all mise tasks using it
  still work.

## Code Conventions

- License header on all source files:
  `// SPDX-License-Identifier: Apache-2.0 OR MIT`
- Use `node:` prefix for Node.js built-in imports:
  `import process from "node:process"`.
- Scripts in `scripts/` must use the helper patterns from
  `scripts/helpers/` (`runCommand`, `runScript`).
- Follow existing script patterns
  (see `setup-playwright.ts` as reference).
- Markdown lines must not exceed 100 characters
  (enforced by markdownlint `MD013`).
