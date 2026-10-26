---
name: architecture
description: System-level map of Rulegate — packages, dependency graph, CLI entry to plan/apply/verify, state.json ownership, zero-network edge, plugin hooks, CI gates
metadata:
  type: reference
mapped: 2026-10-26
entry: packages/cli/src/bin.ts
---

# Rulegate — architecture map

Observed at commit 5f8cac3 (master). Every claim below was read from a file named next to it.

## Stack and versions (from manifests)

- Node: `engines.node >=20` in every package.json; `.nvmrc` = `22`. CI matrix Node 20 and 22
  (`.github/workflows/ci.yml`). The GitHub Action runs on `node24` (`action/action.yml:17`).
- pnpm `10.18.3` (`package.json` `packageManager`), lockfile v9.0. `pnpm-workspace.yaml`
  globs: `packages/*`, `packages/adapters/*`, `action`, `plugins/rulegate`;
  `onlyBuiltDependencies: []` (no dependency install scripts may run).
- All packages ESM (`"type": "module"`), TypeScript compiled with `tsc` per package
  (`tsconfig.base.json`: ES2023, NodeNext, strict + exactOptionalPropertyTypes +
  noUncheckedIndexedAccess + verbatimModuleSyntax).
- Runtime third-party deps (whole repo): `yaml ^2.6.0` (core, locked 2.9.0), `commander ^12.1.0`
  (cli, locked 12.1.0), `picocolors ^1.1.1` (cli). An allowlist test pins this
  (`invariants.test.ts` "dependency surface").
- Dev: typescript ^5.7 (locked 5.9.3), vitest ^3.0 (3.2.7), eslint ^9.17 (9.39.5),
  typescript-eslint ^8.19, prettier ^3.4, esbuild ^0.25 (0.25.12; a 0.28.2 also in lockfile),
  gpt-tokenizer ^4 (token-accuracy tests only).
- Published package versions: all at `0.4.1` (cli `rulegate`, core, adapter-kit, claude,
  interop, adapters, plugin). `action/` is private `0.1.0`.

## Packages and what each owns

| Package | Dir | Owns | src lines |
|---|---|---|---|
| `rulegate` (CLI) | packages/cli | commander program, commands, UI, adapter registry, the one `claude` spawn | ~3600 |
| `@rulegate/core` | packages/core | model, parse, render, pipeline (plan/apply/verify), state, io, git (read-only), detect, doctor, lint, import/init planning, tokens, diff | ~13600 |
| `@rulegate/adapter-kit` | packages/adapter-kit | frozen public adapter contract (re-exports of core types) + `./testing` harness | ~1000 |
| `@rulegate/adapter-*` (13) | packages/adapters/{aider,antigravity,claude-code,cline,codex,copilot,cursor,gemini,kilo,opencode,roo-code,windsurf,zed} | pure `{detect,read,write,docs}` modules | ~7000 total |
| `@rulegate/claude` | packages/claude | read-only Claude Code setup state, settings planner, ownership guard (shared by CLI + plugin); never writes | ~1740 |
| `@rulegate/interop` | packages/interop | read-only importers for ruler, rulesync, agent-os; used only by `init` | ~1300 |
| `@rulegate/action` | action | GitHub Action wrapping `check` in-process, committed esbuild `dist/` | ~220 |
| `@rulegate/claude-code-plugin` | plugins/rulegate | Claude Code hooks/skills/agents, committed esbuild `dist/` | ~2100 |

### Dependency graph (from package.json `dependencies`)

```
cli ──▶ core
cli ──▶ claude ──▶ core
cli ──▶ adapters/* (13) ──▶ adapter-kit ──▶ core
cli ──▶ interop ──▶ adapter-kit ──▶ core         (not in CLAUDE.md's stated graph)
action ──▶ cli   (imports gatherCheck/reportCheck from 'rulegate')
plugins/rulegate ──▶ claude, core   (src imports only '@rulegate/claude'; core arrives through it, bundled)
```
Enforced by `packages/core/test/invariants.test.ts`: adapters never import `@rulegate/core`
(l.696) and declare only the kit (l.705); core never imports `@rulegate/claude` (l.763);
`@rulegate/claude` imports only Node, core and itself (l.777).

## Where a request enters and how it reaches data

1. `packages/cli/src/bin.ts` (30 lines) — shebang entry (`bin.rulegate`), EPIPE swallow,
   `buildProgram().parseAsync`, RulegateError → exit 1.
2. `packages/cli/src/program.ts` (266) — commander tree: `init`, `sync`, `check`, `restore`,
   `doctor`, `lint`, `claude settings`, `adapter new`. Global `--cwd`, `--no-color`, `-q`.
   `lint` and `claude settings` are commands CLAUDE.md does not describe.
3. `packages/cli/src/cwd.ts` — `--cwd` is literal; otherwise `findRepoRoot` walks up like git.
4. `packages/cli/src/registry.ts` — `ADAPTERS` array of 13 adapters (pinned to directory
   listing by `registry.test.ts`).
5. Command module in `packages/cli/src/commands/*.ts` builds a filesystem and calls core:
   - `sync.ts`: `new NodeFileSystem(root)` → `computePlan({repoRoot, fs, adapters})` →
     `applyPlan(plan, fs, {dryRun, force})`; `--import` → `computeMergePlan` +
     `applyCanonicalFiles`.
   - `check.ts`: `createReadOnlyFileSystem` (or `StagedFileSystem` for `--staged`) →
     `computePlan` → `verifyPlan`. Exposes `gatherCheck`/`reportCheck`, which the Action reuses.
   - `doctor.ts` / `lint.ts`: plus `createHomeFileSystem` for the user-level probe (`--no-global` skips).
   - `init.ts`: adapters' `read()` + interop importers → core `init/plan.ts` →
     `computePlan({canonical})` for the preview.
6. Core flow: `parse/index.ts` `parse()` (modes `rulegate-dir | rules-only | bare-agents-md`;
   nested levels via `parse/nested.ts`) → `pipeline/plan.ts` `computePlan` (l.113) calls each
   enabled adapter's `write(ctx)`, plus `planSkills/planCommands/planAgents`,
   `finalizeArtifact`, secret scan, `sortArtifacts`, `buildState` → `Plan`.
7. `pipeline/apply.ts` `applyPlan` (l.152) — only writer; `pipeline/verify.ts` `verifyPlan`
   (l.84) — read-only twin. `state/compare.ts` `compareToDisk` produces
   `DiskComparison.orphaned` (the only deletion source).

Exit codes: `packages/cli/src/ui/exit.ts` — 0 ok, 1 drift/failure, 2 usage.

## Data and state

- Canonical source paths: `packages/core/src/model/paths.ts` — `.rulegate/rulegate.yaml`,
  `.rulegate/rules/**/*.md`, `.rulegate/mcp/servers.yaml`, `.rulegate/skills/*/SKILL.md`,
  `.rulegate/commands/`, `.rulegate/agents/`, `.rulegate/state.json`, `.rulegate/backup/`.
- `state.json` (`state/state.ts`, schemaVersion 1): `{artifacts:[{adapter,hash,kind,path}]}`,
  hashes `sha256:` (text) or `sha256-raw:` (binary). It is the sole ownership record.
- No in-process global state; adapters get an `AdapterContext` (`adapter/context.ts`) with a
  `ReadOnlyFileSystem` and the `Canonical` model only. `fs/read-cache.ts` caches reads per run.
- Filesystem implementations: `io/node.ts` (NodeFileSystem, read-only + home variants),
  `io/memory.ts` (tests), `git/index.ts` `StagedFileSystem` (git index).

## Network edge

- Zero network in shipped source, enforced by `invariants.test.ts` "zero network calls"
  (l.131–278): no network primitive in source or in the plugin's committed bundle.
- Process spawning allowed only in: `packages/core/src/git/` (`GIT_SUBCOMMANDS` =
  `rev-parse`, `ls-files`, `cat-file`, l.184), `plugins/rulegate/src/git/` (four read-only
  subcommands, test l.189), and `packages/cli/src/claude/index.ts` (`spawnSync('claude', …)`,
  pinned argv list: `plugin marketplace list|add|update`, plus install/enable/update).
- The one network exception: `init --plugin --yes` → `packages/cli/src/claude/index.ts`
  asks the `claude` CLI to fetch the plugin (marketplace add/update clones from GitHub).

## Permission / ownership model

- Ownership = presence in `state.json`. `applyPlan` refuses to overwrite an unrecorded file
  (`unmanaged`) or a recorded one whose hash changed (`hand-edited`) unless `--force`, which
  first copies to `.rulegate/backup/` (`backupPathFor`, apply.ts l.62).
- Deletion: only `DiskComparison.orphaned` → `assertDeletable` (apply.ts l.274) →
  `deleteFile`; edited orphans refused and kept in state; backup copy unless
  `options.backup: false`. `restoreFromBackup`/`planRestore` (apply.ts l.355/395) undo.
- Writers outside core, each pinned by `invariants.test.ts` (l.390–523):
  `packages/cli/src/claude/settings-writer.ts` (`claude settings --apply`; writes
  `settings.json`, user `CLAUDE.md` with `.rulegate.bak` — **outside the repo at user scope**),
  plugin `src/session/marker.ts` (tmpdir markers), `src/settings-writer/apply.ts`,
  `src/migrate/memory.ts` (agent-os memory → rulegate-*, copy-verify-unlink).
- Claude Code plugin (`plugins/rulegate/hooks/hooks.json`):
  - SessionStart → `dist/session-start.js` (src `session-start.ts` → `lib/session.ts`): prints
    the agent contract/snapshot; always exit 0.
  - PreToolUse on `Edit|MultiEdit|Write` → `dist/pre-edit.js` (src `pre-edit.ts` →
    `lib/guard.ts` → `@rulegate/claude` `guard.ts`): denies edits to paths in `state.json`
    using core's `parseState`/`findArtifact`/case-folding; else an advisory cartographer
    reminder once per feature per session (`lib/features.ts`, toggle via `lib/config.ts`).
  - Also ships `agents/` (architect, builder, documenter, feature-cartographer, orchestrator,
    reviewer, tester) and `skills/` (init, map, memory).

## Adapter contract

- `packages/core/src/adapter/adapter.ts`: `Adapter {name, apiVersion, detect, read, write, docs}`;
  `ADAPTER_API_VERSION = 1` (`adapter/context.ts`). Adapters are pure: no write, spawn, network.
- `packages/adapter-kit/src/index.ts`: frozen at T011; re-exports from core. Guards:
  `packages/adapter-kit/test/public-api.test.ts`, `test/contract-shape.test.ts`. Policy:
  `docs/adapter-api-v1.md`. Testing entry `@rulegate/adapter-kit/testing` (fixture, compare, docs asserts).
- Typical adapter layout: `src/{index,docs,rules,mcp}.ts` (cursor has `mdc.ts`). `docs.ts`
  holds precedence data → `scripts/generate-docs.mjs` → `docs/tools/*.md`.

## Single render/write path — where enforced

`invariants.test.ts` "the shared rendering path" (l.347–687): write primitives only in core
io/apply + the pinned writers; no rendering primitives (`renderConcatenated`,
`finalizeArtifact`, …) in the CLI (l.635); `verifyPlan` exported alongside `applyPlan` (l.682);
`StagedFileSystem` has no write method (l.611). Action consumes `gatherCheck`, not core directly.

## Committed bundles

- `plugins/rulegate/build.mjs`: every top-level `src/*.ts` → `dist/<name>.js` (esbuild,
  pinned `absWorkingDir`); `--check` byte-compares. Current dist: audit, memory,
  migrate-memory, pre-edit, session-start, settings, state.
- `action/build.mjs` same discipline → `action/dist/main.js`.

## Fixtures

`fixtures/<tool>/{input,expected}` goldens; `<tool>-detect/{positive,negative}`;
`<tool>-import/{input,expected}`; plus `<tool>-mcp`, `cursor-legacy`, interop imports
(`ruler-import`, `rulesync-import`, `agent-os-import*`), `skills-roundtrip-*`,
`{agents,commands,skills}-sync`, `doctor`, `eol`, `tokens`, `malformed`, `import-dedupe`,
`detect-engine`. Regenerate: `pnpm build && pnpm fixtures:update` (`scripts/update-fixtures.mjs`).
`fixtures/**` is in the dogfood manifest's `ignore`.

## Build, run, CI

Root scripts: `build` (`pnpm -r run build`), `typecheck` (per-package tsc + `tsconfig.workspace.json`),
`test` (vitest; `vitest.config.ts` aliases every `@rulegate/*` and `rulegate` to src),
`lint`, `format`, `verify`, `fixtures:update`, `docs:generate`, `smoke`, `bench`.
Run locally: `node packages/cli/dist/bin.js <cmd>` after build.

`ci.yml` jobs: `verify` (3 OS × Node 20/22: lint, build, typecheck, test with
`RULEGATE_REQUIRE_SYMLINKS=1`, test with `RULEGATE_TEST_DIST=1`, dogfood
`rulegate check`, `action/build.mjs --check`, `plugins/rulegate/build.mjs --check`,
`generate-docs.mjs --check`, `validate-plugin.mjs`); `smoke` (packed tarballs,
`scripts/smoke.mjs`); `action` (`uses: ./action`); `format` (prettier); `bench`
(`scripts/bench.mjs`, NFR6 budget). Also `release.yml`, `homebrew.yml` (not read).
`scripts/validate-plugin.mjs`: plugin frontmatter, hook targets exist, and
`marketplace.json` / `plugin.json` / `packages/cli/package.json` versions agree (all 0.4.1).

## Dogfooding

`.rulegate/rulegate.yaml` enables 10 tools: aider, claude-code, cline, codex, copilot, cursor,
roo-code, windsurf, zed, gemini — **not** antigravity, kilo, opencode (so "every shipped
adapter" in CLAUDE.md is not literal). Rules: `.rulegate/rules/{10-project,15-claude-code-plugin,
20-architecture,30-invariants,40-commands,50-conventions}.md`. state.json records 26 artifacts
(CLAUDE.md, AGENTS.md, GEMINI.md, CONVENTIONS.md, .rules, .github/copilot-instructions.md,
.cursor/rules/*.mdc, .clinerules/*, .roo/rules/*, .windsurf/rules/*). Never edit those.

## Read first

1. `packages/core/src/pipeline/plan.ts` — computePlan, the only renderer.
2. `packages/core/src/pipeline/apply.ts` — applyPlan, ownership, backup, assertDeletable.
3. `packages/core/src/adapter/adapter.ts` + `packages/adapter-kit/src/index.ts` — the contract.
4. `packages/core/test/invariants.test.ts` — the invariants as executable rules.
(Then `packages/cli/src/program.ts` and `plugins/rulegate/hooks/hooks.json`.)

## Not determined / open

- `release.yml`, `homebrew.yml`, `docs/*` contents not read; publish flow unmapped.
- Internals of `computePlan` beyond l.1–113 (nesting, secret-scan behaviour) not traced.
- What exactly `session-start` prints (`lib/session.ts`), and audit/memory/settings plugin
  entries and skills, not read.
- Whether `.claude/` artifacts (agents/commands/skills) are generated in this repo: state.json
  shows rules artifacts only; `.rulegate/` has no agents/commands/skills dirs listed (only
  backup, rulegate.yaml, rules, state.json).
- Why two esbuild versions are in the lockfile (0.25.12, 0.28.2) — likely transitive (vitest/vite); unverified.
