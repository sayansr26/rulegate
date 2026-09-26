---
description: The Claude Code plugin
tools: [claude-code]
order: 15
---

The other half of the wedge lives in `plugins/rulegate/`: **the Rulegate plugin for Claude
Code**, the Claude Code half of agent-os folded into this repository (PRD FR8, Phase 6).
The CLI verifies in CI; the plugin enforces inside the agent — a SessionStart hook states
the agent contract, and a PreToolUse hook denies an edit to any path recorded in
`.rulegate/state.json`. It is optional and installed separately
(`/plugin install rulegate@rulegate`); nothing in `packages/` depends on it, and the CLI's
invariants hold for it too: zero network, and its scripts spawn only read-only git.

`.claude-plugin/marketplace.json`, `plugins/rulegate/.claude-plugin/plugin.json` and
`packages/cli/package.json` carry one version, and `node scripts/validate-plugin.mjs`
fails CI when they disagree. Hook scripts are TypeScript in `plugins/rulegate/src/`,
bundled into the committed `plugins/rulegate/dist/` — Claude Code runs a plugin from its
cache with no install step — and `node plugins/rulegate/build.mjs --check` fails CI on a
stale bundle, as `action/build.mjs --check` does for the Action.
