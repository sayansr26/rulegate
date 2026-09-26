# agent-os-project

The project `test/agent-os-migration.test.ts` migrates (T114). Not an adapter fixture:
it lives under the plugin's tests, so `fixtures:update` never sees it.

- `repo/` — a project as agent-os 0.6 leaves it: `.agent-os/`, and the `AGENTS.md` and
  `.claude/rules/20-api.md` its `compile()` writes from it, byte for byte; a hand-written
  `CLAUDE.md` holding the `## Agents in this project (agent-os)` section agent-os's own
  `/init` adds (agent-os never generates a `CLAUDE.md`); cartographer maps under
  `agent-os-feature-cartographer/`, a reviewer whose `rulegate-reviewer/` twin already
  exists, machine-local builder memory, and a `.claude/settings.json` that declares
  agent-os's marketplace.
- `claude-home/` — the Claude config dir: agent-os and rulegate both enabled and
  installed at user scope, git protection and the task tools already on.
- `after-import/` — laid over `repo/` for the `rulegate init --yes` step. Its canonical
  directory is committed as `rulegate-source/` and copied to `.rulegate/`: a `.rulegate/`
  anywhere in this repository is a nested level of its own dogfood, and `rulegate sync`
  would render this repository's rules into it. It holds the rules the import yields —
  ids are agent-os's basenames, the `.agent-os/AGENTS.md` body is `agents`, `CLAUDE.md` is
  `claude` — with the agents section in `claude.md` rewritten to `rulegate:` (Step 4b of
  `references/establishing.md`) and the settings pass's `working-agreement.md`, plus the
  `AGENTS.md`, `CLAUDE.md`, `.claude/rules/20-api.md` and `.rulegate/state.json` that
  `rulegate sync` renders from them. Hand-written; the second test in
  `agent-os-migration.test.ts` runs the real `rulegate init --yes` and those two steps on
  `repo/` and fails if a byte of it differs.
