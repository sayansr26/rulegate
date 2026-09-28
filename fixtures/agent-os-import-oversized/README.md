# `agent-os-import-oversized`

The T110 preflight's lmsfront, at fixture size (T143). `config.json` targets Claude Code
alone, so agent-os 0.6.0 wrote `.claude/rules/` and an `AGENTS.md` that lists the scoped
rules as a short index — every file here past `.agent-os/` and `CLAUDE.md` is its own
`agent-os sync` output, byte for byte. `CLAUDE.md` has no banner because a person wrote it.

The three scoped rules are about 4.5 KB each, and their text is formulaic on purpose: only
their size matters. `init` enables codex from the bannered `AGENTS.md`, and codex inlines
every rule it is sent, so `AGENTS.md` grows from 590 bytes to about 14 KB — past the
12,000-byte per-file limit Windsurf documents, under Antigravity's 24,000 and Codex's
32 KiB. Windsurf is neither enabled nor detected here, which is the point:

- `init`'s plan names the growth, the cap and Windsurf, before anything is written.
- `rulegate lint` after `init --yes` exits 0. `oversized-file` for Windsurf and
  `conflicting-rules` for Copilot and OpenCode are reported as `info`: they describe tools
  this repository does not use.

There is no `expected/`: the assertions are about what `init` prints and what `lint` exits,
not the canonical tree, and live in `packages/cli/test/init-size-caps.test.ts`.
