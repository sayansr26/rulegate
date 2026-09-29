# `agent-os-import-scaffold`

An agent-os project whose `.agent-os/AGENTS.md` was never filled in (T141). The file is
lmsfront's, byte for byte: the placeholder `agent-os init` writes, followed by the
path-scoped index agent-os 0.5.0 compiled into an unbannered `AGENTS.md`, which 0.6.0's
`init` then adopted back as the source. Every line of it is agent-os's text, and the
`src/api/**` rule it lists is the scaffold's `example.md`, long since deleted.

The import skips it with a note rather than put "Replace this with…" at the top of every
tool's instructions. `expected/` — the hand-written `.rulegate/` tree — has no `agents`
rule. Assertions live in `packages/cli/test/interop-import.test.ts`.
