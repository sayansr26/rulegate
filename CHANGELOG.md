# Changelog

All notable changes to this project are recorded here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Adapters for Antigravity, OpenCode and Kilo Code.** Antigravity gets one
  `.agents/rules/<id>.md` per rule with a native `trigger: glob` for scoped rules. OpenCode gets
  `.opencode/rules/*.md` plus a `.opencode/opencode.json` that Rulegate owns outright and that
  lists them; OpenCode appends it to your own `instructions`, and your root `opencode.json` is
  never touched. Kilo Code gets `.kilocode/rules/*.md`, the one Kilo location loaded without a
  config entry. `rulegate init` imports each tool's existing rules, and the local files OpenCode
  and Kilo `instructions` list. It never fetches a remote instruction URL, never follows an entry
  out of the repository — by `..`, an absolute path or a symlink — and never follows one into
  `.agent-os/`, `.ruler/` or a file another adapter imports, such as a `.cursor/rules/*.mdc`. It
  warns when a setting in `.opencode/opencode.json` would stop applying, when an existing file it
  did not import sits where it renders a rule, when an Antigravity rule is inactive today because
  of its frontmatter, and names every imported file the tool will keep loading beside its
  generated copy. `@rulegate/adapter-kit` now exports `stripJsonc`, an additive change with no
  `ADAPTER_API_VERSION` bump.
- **`rulegate init` migrates an agent-os project.** `.agent-os/` is an import source beside
  ruler and rulesync: `.agent-os/AGENTS.md` becomes a repo-wide rule, each `rules/*.md` a rule
  (`paths:` → `globs`, `always: true` → repo-wide), and `config.json`'s `targets` pick the
  adapters to enable. A rule's frontmatter fence is read exactly as agent-os 0.6.0 reads it, so a
  CRLF, BOM or unterminated fence stays unscoped, as agent-os compiled it, with a note naming the
  file. The files agent-os generated carry its banner and are taken over rather than imported
  again, each copied to `.rulegate/backup/` first. agent-os's `claude` block is printed as the
  exact `.claude/rulegate.json` payload — `features`, `cartographerReminder`, `handoff`,
  `activeTask` — and never written. Imported frontmatter keys that Rulegate also reads (`globs`,
  `tools`, `order`) are kept under the importer's prefix (`agent-os-globs`, `rulesync-order`),
  with a `-2` suffix if that name is taken; block lists are kept too. Interop rules rank first and
  share one id space with the rules adapters import. `init` refuses a `.agent-os/` that was
  itself built from Rulegate output (either tool's banner), and warns `W_INTEROP_OUTPUT_LEFT`
  when an interop tool's outputs stay on disk beside the generated files.
- **`init` warns `W_IMPORT_LEFT_BEHIND`** for every file it imported that no generated file
  replaces (an unscoped or nested `.claude/rules` file, a filename that slugs differently,
  Cursor's `.cursorrules`): the original stays on disk and tools that read it get its rules
  twice. For a case-only difference the hint says to list the directory and delete the old name
  only if both appear, never to rename.

### Changed

- **Claude Code: glob-scoped rules now render to native `.claude/rules/<id>.md` files** with a
  double-quoted `paths:` list (loaded only when Claude reads a matching file) and leave
  `CLAUDE.md`; repo-wide rules stay in `CLAUDE.md`. `read()` and `init` import
  `.claude/rules/**/*.md` back, one rule per file, reading frontmatter the way Claude Code
  2.1.283 does, including its retry for tab indentation and unquoted top-level values. After
  upgrading, `rulegate check` reports drift until `rulegate sync`. A pre-existing hand-written
  `.claude/rules/<id>.md` at a generated path is refused as unmanaged (`--force` backs it up
  first). The claude-code docs now record that Claude Code ≥2.1.277 reads `AGENTS.md` when no
  `CLAUDE.md` exists, and `doctor` now measures user-level `~/.claude/rules/*.md` (top level
  only). The Copilot docs list `.claude/rules/**/*.md`, which VS Code's Local agent also loads.

### Fixed

- **`W_NESTED_MERGE_CONFLICT` is decided per generated file from its provenance**, at both ends
  of the override: a repo-wide override of a repo-wide rule no longer warns for Claude Code, and
  a repo-wide override of a root rule scoped into `.claude/rules/` now does. `doctor` no longer
  reports `.claude/rules` files as shadowed by `CLAUDE.md`.
- **`sync --import` recovers an edited `paths:`/globs scope along with the body.** It no longer
  drops a description-less rule's own leading heading, no longer copies the description heading
  into the body under `marker: false`, and refuses a file whose frontmatter no longer parses
  instead of writing raw YAML into canonical. It refuses a scope edit that would move the rule
  to another file (an emptied `paths:`, an `**Applies to:**` typed into `CLAUDE.md`), which the
  next `sync` could neither replace nor delete, and names `sync --force` as the recovery.

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
  instead, because `CLAUDE.md` is generated. Its settings pass previews, asks once, and
  applies.
- **A SessionStart hook** tells Claude where the work stands — branch, recent commits,
  uncommitted files, the active task and handoff note — and which `rulegate:*` agent to use
  for what, which features are mapped, and that rules are edited in `.rulegate/rules/`.
  Handoff and task paths are configurable in `.claude/rulegate.json` and must stay inside
  the repository.
- **A PreToolUse guard blocks edits to generated files** — any path `.rulegate/state.json`
  records, `state.json` itself and `.rulegate/backup/` — and says where the change belongs:
  the rule in `.rulegate/rules/`, then `rulegate sync`, or `rulegate sync --import` to keep a
  hand-edit. It decides ownership exactly as the CLI does, case-insensitively where the
  filesystem is. On the first edit to an unmapped feature it also suggests asking the
  cartographer, once per session; `"cartographerReminder": false` in `.claude/rulegate.json`
  turns that off.
- **The plugin's settings pass now writes.** `/rulegate:init` merges the git write-protection
  deny rules and the task tools into the project's `.claude/settings.json`,
  `~/.claude/settings.json`, or both, after one confirmation. It keeps existing keys, allow and
  deny rules, a value you set yourself, the file's permissions and a CRLF `CLAUDE.md`'s line
  endings. The task-tracking rule is only inserted; nothing else in your `CLAUDE.md` changes.
  Every file it changes is copied to `<file>.rulegate.bak` first, keeping the first backup. In a
  Rulegate project the task-tracking rule becomes `.rulegate/rules/working-agreement.md` for
  `rulegate sync` to render, and the generated `CLAUDE.md` is never edited. It refuses and leaves
  alone: invalid JSON, a file it cannot read, a file that is not UTF-8, symlinks, generated files
  (including while `state.json` does not parse), a rule file you already wrote, and a project
  target that is really `~/.claude`. The preview marks each item it will refuse, and the setup
  state stops pointing a refused item back at the settings pass. A `--root` that is empty or not
  a directory is a usage error. The commands the plugin has the agent run are
  `npx --no rulegate …`, so nothing is fetched from the registry.
- **`/rulegate:init` migrates an agent-os install.** `dist/migrate-memory.js` (preview by
  default, `--apply` to write) moves each `.claude/agent-memory/agent-os-*` directory to
  `rulegate-*`: every file is copied, verified and only then removed, binary files and files
  over 4 MB included, as bytes. When both directories have a `MEMORY.md`, the index lines are
  union-merged and agent-os's index is kept whole as `MEMORY.agent-os.md` (then
  `MEMORY.agent-os.<n>.md` on a later merge), with a pointer line before the first entry. Each
  merge backs up the index it replaces as `MEMORY.md.rulegate[.<n>].bak`, refuses if that index
  changed while the migration ran, and warns when the merged index runs past 200 lines.
  agent-os is disabled with `claude plugin disable … --scope local|project`, and the settings
  pass replaces `sayan-plugins` with `rulegate` in the project's `extraKnownMarketplaces` only
  once the committed settings no longer enable agent-os. The audit gains an AGENT-OS section,
  and a kept `MEMORY*.md` index never counts as a feature map or a memory topic. Step 4b writes
  the agents section to `.rulegate/rules/claude-agents.md` — never `agents.md`, which is the id
  `init` gives an imported `AGENTS.md` — and rewrites an imported agent-os `(agent-os)` section
  in place. A cross-check test holds the migration fixture to the real `rulegate init --yes`
  output.

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
