# `agent-os-import`

An ordinary **agent-os** project (T113): `.agent-os/` holds the sources, and every other file
is what agent-os 0.6.0 generated from them, byte for byte — the outputs were checked against
agent-os's own `compile()` in `src/targets.mjs`, with all eight targets enabled.

- `.agent-os/AGENTS.md` and `.agent-os/rules/{api,style,tests}.md` are the sources. `api`
  has a block-list `paths:`, `tests` a scalar one, and `style` has `always: true`, so the
  `paths` → `globs` mapping is falsifiable in both shapes and against the repo-wide case.
- `.agent-os/config.json` carries a `claude` block, which belongs to the Rulegate plugin's
  `.claude/rulegate.json` and is printed, never written, by `init`.
- The bannered outputs — `AGENTS.md`, `.claude/rules/`, `.clinerules/`, `.cursor/rules/`,
  `.windsurf/rules/`, `.agents/rules/` — must not be imported a second time. They are what
  `init --yes` takes ownership of, with backups, because the rule ids are agent-os's
  basenames and Rulegate renders to the same paths.
- `.gemini/settings.json`, `opencode.json` and `kilo.json` are merged configs with no banner.
  They are warned about, not masked and not taken over.
- The skill copies under `.agents/skills/`, `.claude/skills/` and `.cline/skills/` are named,
  not imported: Rulegate does not manage skills yet (T057).
- **`CLAUDE.md` and `.cursor/rules/team.mdc` have no banner, because a person wrote them.**
  They must still reach canonical, `team.mdc` although it sits where agent-os writes its own.
  They are the control against an importer that masks every known output unconditionally, as
  `ruler-import`'s `GEMINI.md` is.

`expected/` is the `.rulegate/` tree `init` writes, hand-written: `rulegate.yaml` and one
file per rule. `pnpm fixtures:update` skips this directory by name, because interop
importers are not adapters and it cannot drive them. The assertions live in
`packages/cli/test/interop-import.test.ts` and `packages/cli/test/init.test.ts`.

The T120 seed — a `.agent-os/` built from Rulegate's own output — is
[`agent-os-import-adopted`](../agent-os-import-adopted/README.md).
