---
name: init
description: Set up or repair this project's Claude Code context layer. Audits what is already there — CLAUDE.md size, whether .claude/rules/ files are path-scoped, dangling hooks, legacy memory-bank or serena stores, auto-memory state, and machine-level problems like user-scope agents shadowing plugin ones — then creates or migrates what is missing. Use for "set up rulegate", "rulegate init" inside Claude Code, "initialise this project", "bootstrap my context setup", "migrate off memory-bank", "my CLAUDE.md is too big", or when starting work in a repo with no setup.
---

# Memory bootstrap

Bring any repository up to the standard context layout, without inventing facts
and without ballooning what loads every session.

The layout this skill converges on:

| Tier          | Lives in                                              | Startup cost                | Holds                                |
| ------------- | ----------------------------------------------------- | --------------------------- | ------------------------------------ |
| Always-loaded | `CLAUDE.md`, ≤200 lines                               | small, fixed                | Only what is true in _every_ session |
| On-demand     | `.claude/rules/*.md` with `paths:` frontmatter        | **zero**                    | Durable facts scoped to some files   |
| Self-writing  | auto memory (`~/.claude/projects/<repo>/memory/`)     | index only                  | Corrections, preferences, decisions  |
| Explored      | `.claude/agent-memory/rulegate-feature-cartographer/` | **zero** (subagent context) | How each feature is actually built   |
| Task state    | the project's own vault / handoff file                | zero (read selectively)     | What is in flight right now          |

The principle the whole layout serves: **storing a fact and loading a fact are
different acts.** Anything that makes them the same act — a handbook CLAUDE.md,
a memory-bank read at every startup, a rules file with no `paths:` — is the bug.

## `$ARGUMENTS`

| Argument   | Do                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| _(none)_   | The full pass: audit, then route by MODE                                                                                |
| `audit`    | Run the audit and report. Change nothing.                                                                               |
| `settings` | The settings pass only — a preview of git write protection and the task tools for project and user settings. See below. |

Related skills: `/rulegate:map` builds the architecture map, `/rulegate:memory`
inspects and repairs what the project remembers.

## Step 1 — Run the audit

One call. Do not rediscover this with a dozen Read and Grep round trips — the
checks are deterministic and the script does all of them at once:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/audit.js"
```

Pass a path as the first argument to audit a project other than the working
directory. It is read-only and exits 0 even when checks fail, so a partial audit
still reaches you.

It reports: always-loaded files and their line counts, whether every
`.claude/rules/` file is path-scoped, whether each hook's target exists, legacy
stores (`memory-bank/`, `.serena/memories/`, cursor and windsurf rules, memory-ish
MCP servers), per-agent memory health, the machine layer (`~/.claude` CLAUDE.md,
shadowing agents or skills, a duplicate session-resume hook, permissions
posture), the setup state (fresh, repair or healthy), the startup byte and
token cost, and a ranked finding list.

**Show the output to the user before you change anything.** Do not restructure a
repo you have only just opened.

## Step 2 — Fresh setup or repair?

Above `MODE`, the audit prints a `SETUP` block: the install and settings state,
one line per item, and a verdict. Read it first — it decides how much of this
skill runs, so a project that is already set up is repaired, never re-initialised.

| SETUP     | What it means                          | Do                                                                                                                                                                                                                                   |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FRESH`   | Nothing of the plugin's setup here yet | The full pass: Step 3 by `MODE`, then the settings pass. If `.rulegate/ canonical rules` is missing, suggest `npx rulegate init` once — it imports the project's existing agent configs and prints its plan before writing anything. |
| `REPAIR`  | Set up, but items are `MISSING`        | Fix **only** the `MISSING` lines, each by the route below, then `MODE` as usual. Do not rebuild anything marked `ok`.                                                                                                                |
| `HEALTHY` | Every item `ok`                        | Skip the settings pass; `MODE` alone decides the rest.                                                                                                                                                                               |

Routes for `MISSING` items — batch them into the **one** confirmation the
settings pass asks, rather than a question per item:

| Item                                                 | Fix                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| git write protection, task tools, task-tracking rule | the settings pass below                                                                                                                                                                                                                                                                        |
| plugin version (older than latest)                   | `claude plugin marketplace update rulegate`, then `claude plugin update rulegate@rulegate --scope <its scope> --yes`. Tell the user to run `/reload-plugins` — the running session keeps the old version until then. If `claude` is not on PATH, give them `/plugin update rulegate@rulegate`. |
| plugin enabled                                       | `claude plugin enable rulegate@rulegate`                                                                                                                                                                                                                                                       |
| agent-os plugin disabled                             | `claude plugin disable agent-os@sayan-plugins` — both plugins enabled print two session blocks, and agent-os's guard knows nothing of `.rulegate/state.json`                                                                                                                                   |
| CLAUDE.md says when to use each agent                | `references/establishing.md`, Step 4b                                                                                                                                                                                                                                                          |
| CLAUDE.md                                            | `MODE` routes it (ESTABLISH)                                                                                                                                                                                                                                                                   |
| `.rulegate/ canonical rules`                         | `npx rulegate init` — the user runs it (it prints a plan and writes nothing without `--yes`); it imports `CLAUDE.md` and the other tools' configs into `.rulegate/`. Without it the plugin's generated-file guard has nothing to protect.                                                      |

## Step 3 — Route by MODE

The audit ends with a `MODE` line. It decides what this run is for:

| MODE        | What it means               | Do                                                                                                                                               |
| ----------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TOO-EARLY` | Barely any source           | **Build nothing.** Tell the user to write code, run Claude Code's `/init`, and come back. A layer over an empty project is invented conventions. |
| `ESTABLISH` | Real code, no context layer | `references/establishing.md` — build the layer _from the code_                                                                                   |
| `MAP`       | Layer healthy, never mapped | `references/establishing.md`, "Map the architecture"                                                                                             |
| `MIGRATE`   | Layer exists, has problems  | fix the findings; `references/migrating.md` for legacy stores                                                                                    |
| `MAINTAIN`  | Healthy and mapped          | report and stop                                                                                                                                  |

`ESTABLISH` and `MAP` are the modes that make a later request like _"change the
login flow from email to OTP"_ execute from known structure instead of
rediscovering the codebase. `references/changing-a-feature.md` is that workflow —
point the user at it once the layer exists.

### Drift is `rulegate check`'s

In a project with `.rulegate/`, run `npx rulegate check` once after the audit. Exit 0
means every generated file matches its rules; exit 1 prints what is stale or
hand-edited and the recovery for each — `rulegate sync` for stale, `rulegate sync
--import` to keep a hand-edit. Do not diff generated files yourself: `check`
renders exactly what `sync` would write, and nothing else can.

## Step 4 — Act on the findings

Each finding routes to one place. Load only what the audit actually surfaced:

| Finding                                                            | Read                                                                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `MODE ESTABLISH` or `MODE MAP`                                     | `references/establishing.md`                                                                                                      |
| `CLAUDE.md` has no "Agents in this project" section                | `references/establishing.md`, Step 4b                                                                                             |
| user asks how to change an existing feature                        | `references/changing-a-feature.md`                                                                                                |
| legacy store found; CLAUDE.md over budget                          | `references/migrating.md`                                                                                                         |
| rule without `paths:`; no rules layer yet; CLAUDE.md to trim       | `references/writing-rules.md` — in a Rulegate project, edit `.rulegate/rules/` and run `rulegate sync`, never the generated files |
| git write protection or task tools missing                         | the settings pass below — preview only in this version                                                                            |
| LSP plugin recommended; checked-in generated dirs                  | `references/establishing.md`, "Stop Claude reading what it should not"                                                            |
| hook target missing                                                | delete the hook entry, or restore the script — say which                                                                          |
| shadowing agent or skill in `~/.claude` or `.claude/agents/`       | the user removes the standalone copy; a plugin cannot                                                                             |
| unindexed or near-duplicate agent memory topic files               | merge into the best-named file, delete the rest, rebuild `MEMORY.md` as one line per file                                         |
| project CLAUDE.md refers to a `~/.claude/CLAUDE.md` that is absent | the user creates it or drops the reference                                                                                        |

Shadowing agents and skills on the machine layer are the user's to remove.
Settings are the user's too, for now: the settings pass below previews them and writes nothing.

## Step 5 — Verify by re-running

Run the audit again and show the before and after: the `SETUP` verdict (a
repair should end `HEALTHY`), finding count, startup bytes, token estimate. Do not declare success on vibes — the script already produces the
numbers, so quote them.

## The settings pass

Runs when `SETUP` is `FRESH`, or `REPAIR` with a settings item missing (after Step 4), and
alone for `settings`. **In this version of the plugin it previews and does not apply.**

1. **Preview.** One call:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/settings.js" --scope both
   ```

   It prints, per file, what the pass would add to project `.claude/settings.json` and
   `~/.claude/settings.json` — the git write-protection deny rules, and
   `env.CLAUDE_CODE_ENABLE_TODO_TOOLS` — plus the task-tracking rule. If it reports
   everything already present, say so and stop.

2. **Show the preview and stop there for the settings files.** Do **not** edit
   `.claude/settings.json`, `~/.claude/settings.json` or `~/.claude/CLAUDE.md` yourself,
   and do not retry with `--apply` — it refuses and writes nothing. `permissions.deny` is
   the guardrail on your own behaviour: a hand edit to it, made without the merge rules and
   the backup the writer will carry, is exactly the change this skill exists to prevent.
   Tell the user the deny rules and the env flag are theirs to add for now, and point at
   `references/git-permissions.md` for the list and the reasoning.

3. **The task-tracking rule is the exception, in a Rulegate project only.** It belongs in
   the repository, not in a settings file: with the user's yes, create
   `.rulegate/rules/working-agreement.md` exactly as the preview describes, then run
   `rulegate sync`. Never add it to the generated `CLAUDE.md`.

The rule set and every judgment call in it (why `git -C` is denied, why
`fetch` is allowed) are in `references/git-permissions.md`.

Also propose, when the audit flagged them — these are project-specific, so they
stay proposals:

- `Read` deny rules for checked-in generated or vendored paths
- a code intelligence plugin for the detected language
- `claudeMdExcludes` in a monorepo where other teams' files load

## What this skill will not do

- It will not write facts it has not verified in the repo. An invented rule is
  worse than a missing one, because it will be trusted.
- It will not delete a legacy store before its content has landed.
- It will not add a memory MCP server. A knowledge graph solves retrieval over
  unstructured memory; the common failure is that nothing was _written_, which a
  graph does not fix and which the cartographer's memory does — with no database,
  no embedding step, and no tokens in the main window.
