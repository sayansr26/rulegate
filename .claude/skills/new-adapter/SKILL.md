---
name: new-adapter
description: Add a Rulegate adapter fixture-first — research the tool's documented precedence, hand-write the goldens, then implement detect/read/write.
disable-model-invocation: true
---

# Add an adapter

`rulegate adapter new <tool>` scaffolds the mechanics. This skill covers the part that is
prose in CLAUDE.md and gets skipped under time pressure: **the goldens come first**, and
the precedence rules come from the vendor's documentation, not from what the code happens
to do.

Take the tool name as the argument. If none was given, ask which tool.

## 1. Research before scaffolding

Find the vendor's own documentation for how the tool loads instructions. Record, with a URL
and the date retrieved, and the tool version you are verifying against:

- Which file(s) the tool reads, at project scope and at global/user scope.
- The order they load in, and whether a later one **overrides** or is **additive**. Getting
  this backwards is the Copilot trap: three competing instruction mechanisms that are
  additive, so enabling `copilot`, `codex` and `claude-code` together sends Copilot the
  same rules three times.
- Whether nesting matters (Cursor reads `.cursor/rules` directories in subdirectories,
  nearest-wins).
- Any frontmatter or metadata the format requires.
- Whether the tool's file is also a valid canonical _input_. If it is — Codex's `AGENTS.md`
  is both input and output — the adapter must decline when `isCanonicalSource` says the
  path is the source.

If the documentation is ambiguous, say so and stop rather than guessing. A wrong precedence
claim in `docs.ts` becomes a bug report filed against the vendor.

## 2. Scaffold

```bash
pnpm build && node packages/cli/dist/bin.js adapter new <tool> --yes
```

It writes nothing without `--yes`, refuses outside a checkout of this monorepo, and never
overwrites — every generated path must be absent and every patched file must exist, checked
before the first write, so a collision leaves the tree untouched. It also handles
registration in the registry, the CLI's dependencies, the Vitest alias and RFC-0001 §4.1,
because `registry.test.ts` pins `ADAPTERS` to the directory listing.

## 3. Hand-write the goldens — before implementing

This is the step that makes the rest correct. Write, from the research in step 1:

- `fixtures/<tool>/{input,expected}` — the byte-exact render. Mind trailing whitespace and
  the final newline; goldens are asserted byte-for-byte.
- `fixtures/<tool>-detect/{positive,negative}` — both directions.
- `fixtures/<tool>-import/{input,expected}` — a repo with the tool's native files and **no**
  `.rulegate/`, plus the canonical rules `read()` must recover from it.

Do not run `pnpm fixtures:update` to create these. Regeneration is for propagating an
intended change to an existing adapter; a golden generated from the implementation asserts
only that the code does what the code does.

## 4. Implement, in order

`detect` → `read` → `write`, plus the real precedence rules in `src/docs.ts`.

- Import from `@rulegate/adapter-kit` only, never `@rulegate/core`. If a symbol is missing,
  add it to the kit — additions are non-breaking; removals cost an `ADAPTER_API_VERSION`
  bump. See `docs/adapter-api-v1.md`.
- Adapters do not touch the filesystem or the network. Read through the injected
  `ReadOnlyFileSystem`. The test harness is a separate entry point,
  `@rulegate/adapter-kit/testing`, for exactly this reason.
- Output must be deterministic: no time, randomness, unordered iteration, locale-sensitive
  sorting, or platform path separators in rendered bytes.
- Never write a literal secret — MCP secrets stay references such as `env:GITHUB_TOKEN`.

## 5. Verify

```bash
pnpm verify
pnpm build && RULEGATE_TEST_DIST=1 pnpm test
node scripts/generate-docs.mjs      # docs/tools/ and docs/adapters.md come from docs.ts
```

Then run the `adapter-conformance-reviewer` agent over the new adapter.

Do not edit `docs/tools/*` or `docs/adapters.md` by hand — they are generated from
`docs.ts`, and a PreToolUse hook will block the attempt.

## 6. Hand off

Report what changed and print the commit command for the user to run. Do not run git
yourself. The commit must include the adapter, all three fixture layouts, the registry and
alias edits, and the regenerated `docs/tools/` pages together.
