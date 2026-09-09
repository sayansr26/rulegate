---
name: verify-full
description: Run the full local equivalent of CI — verify, the dist lane, the dogfood check, and the three staleness gates — and report exactly which gate failed and its fix command.
disable-model-invocation: true
---

# Full verification

`pnpm verify` is **not** the CI gate. CI additionally runs the built-binary lane, this
repository's own `rulegate check`, and three staleness gates over committed generated
output. Committed and stale is worse than absent: a stale Action bundle keeps working while
reporting an older commit's behaviour, and a stale `docs/tools/` page is the project's most
public claim about what a tool reads.

Run these in order. Do not stop at the first failure unless a later step depends on it —
report every gate's result, because two stale artifacts is a common single mistake.

```bash
pnpm lint
pnpm build            # required before the dist, dogfood and bundle steps
pnpm typecheck
pnpm test
pnpm format           # --check; every generated path is in .prettierignore deliberately
```

Then the four gates `pnpm verify` misses:

```bash
RULEGATE_TEST_DIST=1 pnpm test          # built binary: the only lane that catches a broken
                                        # exports map or a regressed exit code
node packages/cli/dist/bin.js check     # dogfood: this repo's own generated agent files
node action/build.mjs --check           # committed Action bundle is current
node scripts/generate-docs.mjs --check  # docs/tools/ and docs/adapters.md are current
```

Optionally, matching CI's symlink cell:

```bash
RULEGATE_REQUIRE_SYMLINKS=1 pnpm test   # turns the symlink suite's self-skip into a failure
```

## Reading a failure

| Failing gate                      | What it means                                    | Fix                                                                                                          |
| --------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `rulegate check` exits 1          | a rule changed and `sync` was not run            | edit `.rulegate/rules/`, then `node packages/cli/dist/bin.js sync` — never edit the generated files          |
| `action/build.mjs --check`        | somebody edited `action/src` and did not rebuild | `node action/build.mjs`                                                                                      |
| `generate-docs.mjs --check`       | an adapter's `docs.ts` changed                   | `node scripts/generate-docs.mjs`                                                                             |
| dist lane only                    | broken `exports` map or wrong exit code          | fix the package's `exports`/exit path; the source lane aliases `@rulegate/*` to source and will not catch it |
| `pnpm format` on a generated path | a formatter touched generated output             | revert it and re-run `sync`; format `.rulegate/rules/` instead                                               |

Remember exit codes are contractual: `0` ok · `1` drift or failure · `2` usage. A usage
error reported as drift is itself a bug.

Note that CI runs a 6-cell matrix (ubuntu/macos/windows × node 20/22) because both
properties this project sells — byte-identical output and a trustworthy exit code — are
platform-sensitive. A green local run on macOS is not evidence about Windows path
separators or CRLF.

## Hand off

Summarise pass/fail per gate. If everything is green and there are changes to commit, print
the commit command for the user to run — do not run git yourself. A rule change must commit
`.rulegate/rules/` **and** every regenerated artifact (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
`.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, and any others) in the same commit.
