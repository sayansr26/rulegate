# Changelog

All notable changes to this project are recorded here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Internal

- **The Claude Code plugin has a home; its hooks and skills are still to come.** agent-os's
  Claude Code plugin is moving into this repository as the Rulegate plugin for Claude Code.
  The groundwork: a `rulegate` marketplace at the repository root, `plugins/rulegate/`, a
  validator CI runs on every push (agent frontmatter, hook paths, and
  one version shared by the plugin, the marketplace and the CLI), and a committed hook bundle
  with a freshness gate. The zero-network and spawn invariants now cover the plugin's source
  and its bundle; its scripts may run four read-only git subcommands and nothing else.
- **The plugin's seven agents are ported from agent-os** — `rulegate:feature-cartographer`,
  `architect`, `builder`, `tester`, `reviewer`, `documenter` and `orchestrator`. They send
  rule changes to `.rulegate/rules/` and `rulegate sync`, and never edit a file recorded in
  `.rulegate/state.json`.
- **`/rulegate:init`, `/rulegate:map` and `/rulegate:memory`** — the plugin's skills, ported
  from agent-os. `/rulegate:init` audits the project's Claude Code context layer and setup
  (FRESH, REPAIR or HEALTHY) in one read-only call, hands drift to `rulegate check` and token
  cost to `rulegate doctor`, and puts anything bound for `CLAUDE.md` in `.rulegate/rules/`
  instead, because `CLAUDE.md` is generated. Its settings pass previews in this version and
  does not apply yet.
- **A SessionStart hook** tells Claude where the work stands — branch, recent commits,
  uncommitted files, the active task and handoff note — and which `rulegate:*` agent to use
  for what, which features are mapped, and that rules are edited in `.rulegate/rules/`.
  Handoff and task paths are configurable in `.claude/rulegate.json` and must stay inside
  the repository.

## [0.3.0] — unreleased

### Breaking

- **`.codex/config.toml` now writes `env_http_headers` instead of `bearer_token_env_var`, and
  the environment variable's contents must change with it.** Codex supplies the `Bearer `
  scheme for `bearer_token_env_var` itself, so that variable held a _bare token_ — while every
  other tool substitutes the same canonical header reference as the header's whole value, so
  its variable held `Bearer <token>`. One entry in `.rulegate/mcp/servers.yaml` could not be
  right for both, and whichever way you had set the variable, one of your tools was sending
  `Bearer Bearer …` or a token with no scheme.

  **To migrate**: run `rulegate sync`, which rewrites the file — `check` reports it as _stale_,
  not hand-edited, and prints the diff first. Then **change the variable itself** to hold the
  full `Bearer <token>`. `check` can show you the key moving; it cannot see that a value's
  meaning moved with it, so this is the one step nothing will remind you about.

  Only repositories whose MCP servers carry an `Authorization` header _and_ enable the `codex`
  adapter are affected. A side benefit: references now work in **any** header, not just
  `Authorization`, so a server Rulegate used to omit from Codex's config is now written.

### Fixed

- **`init` warns before a credential can be committed.** Taking ownership of a file copies it
  verbatim to `.rulegate/backup/` — which is what lets `restore` return a CRLF or BOM original
  byte for byte — and for an `.mcp.json` holding a token, that copy is a plaintext credential
  inside the directory you are told to commit. `W_BACKUP_SECRET` fires when the file holds a
  literal credential and `.gitignore` does not already cover the backup path. It stays silent
  when your ignore rules already cover it, and it never quotes the credential.
- **A Cursor `globs: ["**/*.py"]` flow sequence imported as one literal glob** whose text was
  the sequence syntax itself, brackets and quotes included — so a rule scoped to Python files
  matched nothing, while `init` reported success and `check` reported in sync. All four
  spellings Cursor accepts now import identically. A glob containing a character class
  (`src/[abc]*.ts`) is untouched.
- **`doctor` counted Rulegate's own backup as one of a tool's configuration files.** A nested
  pattern such as `**/GEMINI.md` matched `.rulegate/backup/GEMINI.md`, which put a backup and a
  real artifact in one row, reported that row as `unmanaged`, and billed the tokens twice. Both
  Claude Code's and Gemini's file counts were wrong on a monorepo.
- **`rulegate adapter new` scaffolded every adapter at a hardcoded `0.0.0`**, which made a
  newly scaffolded adapter a version island the moment the workspace released.

### Known limitations

- **A tool that scans subdirectories will read `.rulegate/backup/`.** Gemini walks below the
  working directory honouring only `.gitignore` and `.geminiignore`, so unless you have ignored
  `.rulegate/`, the pre-Rulegate copy of your rules is delivered to the model alongside the
  generated one. Adding `.rulegate/backup/` to `.gitignore` fixes both this and the credential
  exposure above. A built-in answer is still being decided.
- **No unaided external first run yet**, and cold install is proven on macOS and Linux only —
  Windows is unverified and the Windows CI matrix has never run.

## [0.2.0] — 2026-09-20

Upgrading from `0.0.0` is the only upgrade path there is: `0.1.0` was never published and
never will be.

> **What `0.0.0` already contained.** `0.0.0` was the name-claiming publish (T034), but it was
> not a placeholder — the tarball already shipped all ten adapters, MCP sync, `sync --import`,
> `check --staged`, `restore`, and ruler/rulesync interop. It was simply never announced, so
> for anyone finding this project now those are new; they are not new _since `0.0.0`_, and this
> entry does not claim them. The boundary is commit `eed754c`, two minutes before `0.0.0` went
> to the registry.

### Added

- **Monorepo support.** Nested `.rulegate/` discovery and resolution, and nested semantics for
  `sync` and `check`, so a package's own rules reach the tools that read per-directory config.
- **`rulegate lint`** — a rule engine with severity and suppression over the canonical source.
  Exit 1 only on what you chose to call an error. Absent from the `0.0.0` tarball entirely.

### Fixed

- **A case-insensitive filesystem could make one file look like two**, and the same run would
  then delete the artifact it had just refused to write. `state.json` and `compareToDisk` now
  agree on path identity. The worst bug in this release by some distance.
- **`options.ignore` was never serialized**, so a manifest carrying one lost it through any
  model → serialize → parse trip — which is the path `init` writes through.
- **`init`'s formatter warning named `.eslintignore` for flat ESLint configs.** ESLint 9 does
  not read that file and errors when it exists, so acting on the hint broke the lint run the
  warning exists to protect. Flat configs now point at an `ignores` entry, and the hint names
  the config file that actually exists rather than the first spelling in an internal table.
- **`init` no longer warns about ESLint unless something has pointed it past JavaScript.**
  Rulegate never generates a `.js` or `.ts` file, so on an ordinary repository that warning
  fired on the first run about files ESLint would never open. Prettier, Biome and dprint stay
  unconditional: all three reformat Markdown and JSON by default.

### Documented

- **`next dev` writes `AGENTS.md` and `CLAUDE.md` too**, from inside `node_modules`, where it
  cannot be configured away. Encoded in the codex and claude-code adapters' precedence docs
  with a source link: Next.js replaces only its own marker region and skips a write that would
  change nothing, so a generated file carrying that block as a canonical rule is stable. Drop
  the block from `.rulegate/` and Next.js re-adds it, which `check` then correctly reports as a
  hand-edit.

### Internal

- Test files are now typechecked. Nothing in the workspace typechecked them before, so a test
  could reference a symbol that no longer existed and stay green.

### Known limitations

- **No unaided external first run yet.** The M1 gate (three external developers running `init`
  on their own repositories, unhelped) stands at 0 of 3. One maintainer-driven rehearsal on a
  real Next.js repository found the two ESLint bugs above and lost no user content.
- **Cold install is proven on macOS only.** Linux and Windows are unverified and the Windows CI
  matrix has never run.
- No generated file has been opened in any of the ten tools and checked by eye.
- `AGENTS.md` sits at Windsurf's per-file cap with no headroom; the lint rule reports it, the
  adapter does not yet do anything about it.

[unreleased]: https://github.com/sayansr26/rulegate/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sayansr26/rulegate/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sayansr26/rulegate/compare/v0.0.0...v0.2.0
