<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Test coverage

After any task that changes code, run `vp run test:coverage` at the repo root before calling the task done. Coverage must stay at 100% for statements, branches, functions and lines. If it drops, add tests for the uncovered code until it is back at 100%. Do not lower the thresholds in `vite.config.ts` or add coverage-ignore comments to get there.

# Git convention

## Branch

Follow [Conventional Branch](https://conventional-branch.github.io/): `<type>/<description>`.

- `feature/` (or `feat/`): new feature, e.g. `feature/pull-readiness`
- `bugfix/` (or `fix/`): bug fix, e.g. `fix/queue-ordering`
- `hotfix/`: urgent fix, e.g. `hotfix/security-patch`
- `release/`: release preparation, e.g. `release/v1.2.0`
- `chore/`: non-code work such as docs, deps or tooling, e.g. `chore/update-deps`
- `refactor/`: code restructuring. Touch no feature. Preserve all behavior.

Rules:

- Use lowercase `a-z`, `0-9` and hyphens. Dots are allowed only in release versions.
- No leading, trailing or consecutive hyphens or dots.
- Keep it short and descriptive. Ticket numbers are fine, e.g. `feature/issue-123-pending-writes`.
- Add no brand identifiers, such as `claude`, `codex`, ...

## Commit message

Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `<type>[optional scope][!]: <description>`.

- `feat`: new feature
- `fix`: bug fix
- `refactor`: code change that touches no feature and preserves all behavior
- `perf`: performance improvement
- `docs`: documentation only
- `test`: add or fix tests
- `build`: build system or dependencies
- `ci`: CI configuration
- `style`: formatting only
- `chore`: anything else
- `revert`: revert a previous commit

Rules:

- Use a one-line message in the imperative mood, lowercase, with no trailing period, e.g. `feat(client-core): expose pending writes`.
- Scope is optional and names the affected package by its `packages/` folder, e.g. `fix(client-firebase): ...`.
- Mark breaking changes with `!` after the type/scope, e.g. `feat(client-core)!: rename sync options`.
- Add no brand identifiers, such as `claude`, `codex`, ...

PRs are squash-merged, so the PR title follows the same format and becomes the commit on `main`. release-please reads those commits to bump versions and write changelogs: `feat`, `fix`, `perf` and `revert` bump patch, and `!`/`BREAKING CHANGE` bumps minor while packages are below 1.0. Other types (`refactor`, `docs`, `test`, `build`, `ci`, `style`, `chore`) do not release.
