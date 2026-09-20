# Changelog

All notable changes to this project are recorded here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — unreleased

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

[unreleased]: https://github.com/sayansr26/rulegate/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sayansr26/rulegate/compare/v0.0.0...v0.2.0
