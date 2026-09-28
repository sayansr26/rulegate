# `agent-os-import-claude`

An agent-os project shaped like the one T117 migrates (T149): `config.json` targets Claude
Code alone, so agent-os 0.6.0 wrote `AGENTS.md` and `.claude/rules/` — byte for byte its
own `compile()` output — and never a `CLAUDE.md`. The `CLAUDE.md` here has no banner
because a person wrote it.

agent-os puts `.agent-os/AGENTS.md` into `AGENTS.md` and nowhere else, so the imported
`agents` rule is scoped `tools: [codex]`. The assertion that matters is downstream of the
golden: after `init --yes`, `CLAUDE.md` is the hand-written file with Rulegate's banner in
front of it and not one byte more, where an unscoped body used to land on top of it.

`expected/` is the `.rulegate/` tree `init` writes, hand-written. Assertions live in
`packages/cli/test/interop-import.test.ts`.
