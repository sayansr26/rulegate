# The Rulegate plugin for Claude Code

The CLI keeps your agent config in sync and fails CI when it drifts. The plugin is the other
half: it works **inside** Claude Code, so the agent itself respects what Rulegate generated
and works from a known map of the codebase. It is optional and installed separately; nothing
in the CLI depends on it.

## Install

```bash
npx rulegate init --plugin --yes      # in a project: imports, syncs, then installs the plugin
```

`--plugin` asks your `claude` CLI to add the `rulegate` marketplace from GitHub and install
`rulegate@rulegate` (and **auto-route**, below) at project scope. It is the one Rulegate
command that goes online, and only because you named it. Without `--plugin`, `init` prints
the same `claude plugin …` commands for you to run.

Inside Claude Code the equivalent is:

```
/plugin marketplace add sayansr26/rulegate
/plugin install rulegate@rulegate
```

Then run `/rulegate:init` in a session to set up or repair the project (below).

## What it does

### Two hooks

- **SessionStart** prints a short snapshot (branch, recent commits, working tree) and the
  agent contract: which agents to use, and that generated files are not edited by hand.
  Claude Code adds it to the session's context.
- **PreToolUse** on `Edit`, `MultiEdit` and `Write` **denies an edit to any file recorded in
  `.rulegate/state.json`** — `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*` and the rest — and
  names the `.rulegate/rules/` file to change instead. An edit to a feature with no map yet
  gets an advisory nudge to ask the cartographer first. Every other edit passes untouched.

Both hooks run locally, read only the project, and never fail a session: on any error they
say nothing.

### Seven agents

| Agent                           | Use it                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `rulegate:feature-cartographer` | Before changing an existing feature: how it is built, its files, data flow and blast radius. Keeps durable maps. |
| `rulegate:architect`            | Before a new subsystem, a cross-module change or a data model others will depend on.                             |
| `rulegate:builder`              | To write the code once the shape is settled, enforcing the project's rules while writing.                        |
| `rulegate:tester`               | After building, to verify it actually works.                                                                     |
| `rulegate:reviewer`             | Before calling a change done.                                                                                    |
| `rulegate:documenter`           | Once verified: changelog, task state, docs the change invalidated.                                               |
| `rulegate:orchestrator`         | For work spanning several of the above.                                                                          |

Each keeps project-scoped memory under `.claude/agent-memory/rulegate-<agent>/`.

### Three skills

- `/rulegate:init` — set up or repair the project's Claude Code layer: audits `CLAUDE.md`,
  `.claude/rules/`, settings and memory, migrates from agent-os, and applies the settings
  (`/rulegate:init settings` is the in-session twin of `rulegate claude settings`).
- `/rulegate:map` — build or refresh the architecture map the cartographer works from.
- `/rulegate:memory` — inspect, repair or edit what the project remembers.

### auto-route

A Claude Code mod from the same marketplace. It picks the model and effort for each turn from
what the prompt asks for — a lookup goes to Haiku, a regular task to Sonnet, design or
debugging to Opus — and leaves subagents alone. `/route` pins a tier or turns it off.
`init --plugin` installs it beside the plugin; `--no-auto-route` leaves it out.

## Settings

```bash
npx rulegate claude settings                          # preview
npx rulegate claude settings --scope project --apply  # write .claude/settings.json, backed up first
```

It adds three things, merging and never replacing what is there: deny rules that stop the
agent running git write commands, `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` so the task tools are on,
and a task-tracking rule. In a Rulegate project that rule goes into `.rulegate/rules/`
followed by `sync`, since `CLAUDE.md` is generated. In a project migrating from agent-os it
also swaps agent-os's marketplace for Rulegate's. `--scope user` writes
`~/.claude/settings.json` instead, after backing it up.

## Checking it

`rulegate doctor` reports the plugin's installed and latest version, whether it is enabled,
and — when a settings file turns it off — which file. `rulegate doctor --json` includes the
same under `claudePlugin`.

## Commands the agent runs

Where the plugin has the agent run Rulegate, it uses `npx --no rulegate …`, so a project
without Rulegate installed fails fast instead of downloading it mid-session. The commands in
the README are for you to type, and stay bare (`npx rulegate …`).

## Rulegate Pro

The agents above ship with their full instructions and work on their own. Rulegate Pro, a
separate desktop app, adds served playbooks, feature maps and memory across projects; it is
not needed for anything on this page.
