---
name: init
description: Set up or repair this project's Claude Code context layer. Audits what is already there — CLAUDE.md size, whether .claude/rules/ files are path-scoped, dangling hooks, legacy memory-bank or serena stores, auto-memory state, and machine-level problems like user-scope agents shadowing plugin ones — then creates or migrates what is missing. Use for "set up rulegate", "rulegate init" inside Claude Code, "initialise this project", "bootstrap my context setup", "migrate off memory-bank", "migrate from agent-os", "my CLAUDE.md is too big", or when starting work in a repo with no setup.
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

| Argument   | Do                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| _(none)_   | The full pass: audit, then route by MODE                                                                                     |
| `audit`    | Run the audit and report. Change nothing.                                                                                    |
| `settings` | The settings pass only — git write protection, the task tools and the task-tracking rule, previewed then applied. See below. |

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
| agent-os plugin disabled                             | the migration below — its disable command always carries the `--scope` the `SETUP` line names; both plugins enabled print two session blocks, and agent-os's guard knows nothing of `.rulegate/state.json`                                                                                     |
| agent-os memory moved to rulegate-\*                 | the migration below                                                                                                                                                                                                                                                                            |
| `.claude/settings.json` declares rulegate            | the migration below — the settings pass swaps agent-os's marketplace once agent-os is disabled                                                                                                                                                                                                 |
| CLAUDE.md says when to use each agent                | `references/establishing.md`, Step 4b                                                                                                                                                                                                                                                          |
| CLAUDE.md                                            | `MODE` routes it (ESTABLISH)                                                                                                                                                                                                                                                                   |
| `.rulegate/ canonical rules`                         | `npx rulegate init` — the user runs it (it prints a plan and writes nothing without `--yes`); it imports `CLAUDE.md` and the other tools' configs into `.rulegate/`. Without it the plugin's generated-file guard has nothing to protect.                                                      |

## Step 2b — Migrating from agent-os

Run this when the audit's `AGENT-OS` section lists anything, before Step 3. It is **one
confirmation** for the whole move, and every step before it is a preview.

1. **Preview**, writing nothing:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/migrate-memory.js"
   ```

   It lists each `agent-os-<agent>` memory directory and where it goes: `rulegate-<agent>`,
   the name this plugin's agents read. A new directory is copied whole; one that already
   exists is merged — new files copied, identical ones kept once, and the two `MEMORY.md`
   indexes unioned. A same-named file with different content is refused, and that agent's
   memory stays where it is. If `.agent-os/` is listed as not imported, also run
   `npx --no rulegate init` — it prints the import plan and writes nothing.

2. **Ask once.** One AskUserQuestion naming, in order: the memory moves; the `rulegate init`
   import (when `.agent-os/` is not imported); the disable command exactly as the audit prints
   it; and the settings pass at project scope, which replaces agent-os's marketplace
   (`sayan-plugins`) with `rulegate` in `extraKnownMarketplaces`. _Migrate_ (recommended) or
   _skip_.

3. **Apply, in this order**, and stop at the first step that fails — agent-os is disabled
   last, so it keeps working until everything before it has landed. One exception: a
   memory step that exits 1 only because an agent was **refused** still runs step 2 (the
   import does not depend on memory), then stops before the disable — agent-os's agent is
   the only one that reads that memory until it is merged by hand.

   1. `node "${CLAUDE_PLUGIN_ROOT}/dist/migrate-memory.js" --apply`. It copies each file,
      checks its bytes at the new name, and only then removes the original. A merged
      `MEMORY.md` keeps agent-os's index whole beside it as `MEMORY.agent-os.md` (a later
      merge of the same agent uses the next free `MEMORY.agent-os.<n>.md`), backs up the
      index it replaces as `MEMORY.md.rulegate[.<n>].bak`, and warns when the merged index
      runs past the 200 lines Claude Code loads. A target index written to while it ran is
      stopped with "changed during the move" — re-run it. Exit 1
      means an agent was refused or stopped; report it as printed and do **not** move files
      by hand. The setup state and the audit name a refusal until it is merged.
   2. `npx --no rulegate init --yes` when `.agent-os/` is not imported. If it printed a
      `.claude/rulegate.json` payload and that file does not exist, create it with exactly
      that payload — it is the plugin's config, not a generated file.
   3. The disable, as the audit prints it — `claude plugin disable agent-os@sayan-plugins
--scope local` for a user-scope install, `--scope project` for a project one. Never
      without `--scope`: for a user-scope install that turns agent-os off in every project
      on this machine, including the ones not yet migrated.
   4. `node "${CLAUDE_PLUGIN_ROOT}/dist/settings.js" --scope project --apply`, which now
      swaps the marketplace. It backs up `.claude/settings.json` first, like any apply.

   Then tell the user to run `/reload-plugins`, so this session stops loading agent-os. If
   a Bash call is denied, give the user the exact command to run with the `!` prefix.

`.agent-os/` stays where it is. Once imported, the audit calls it "already imported, safe to
delete": say so, and let the user delete it after `npx --no rulegate check` is clean. A
`.gitignore` line the preview names stops matching once the memory moves; point it out, do
not edit it. Committed maps show up in git as deletes plus adds — the user commits them.

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

In a project with `.rulegate/`, run `npx --no rulegate check` once after the audit. Exit 0
means every generated file matches its rules; exit 1 prints what is stale or
hand-edited and the recovery for each — `rulegate sync` for stale, `rulegate sync
--import` to keep a hand-edit. Do not diff generated files yourself: `check`
renders exactly what `sync` would write, and nothing else can. `--no` is load-bearing:
without a TTY, plain `npx` downloads the latest `rulegate` from the registry and runs it,
which may not be the version CI checks with. If it fails because the project has no local
`rulegate`, hand the user the command instead of dropping `--no`.

## Step 4 — Act on the findings

Each finding routes to one place. Load only what the audit actually surfaced:

| Finding                                                            | Read                                                                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `MODE ESTABLISH` or `MODE MAP`                                     | `references/establishing.md`                                                                                                      |
| `CLAUDE.md` has no "Agents in this project" section                | `references/establishing.md`, Step 4b                                                                                             |
| user asks how to change an existing feature                        | `references/changing-a-feature.md`                                                                                                |
| legacy store found; CLAUDE.md over budget                          | `references/migrating.md`                                                                                                         |
| anything under `AGENT-OS`                                          | Step 2b                                                                                                                           |
| rule without `paths:`; no rules layer yet; CLAUDE.md to trim       | `references/writing-rules.md` — in a Rulegate project, edit `.rulegate/rules/` and run `rulegate sync`, never the generated files |
| git write protection or task tools missing                         | the settings pass below — apply, don't hand over                                                                                  |
| LSP plugin recommended; checked-in generated dirs                  | `references/establishing.md`, "Stop Claude reading what it should not"                                                            |
| hook target missing                                                | delete the hook entry, or restore the script — say which                                                                          |
| shadowing agent or skill in `~/.claude` or `.claude/agents/`       | the user removes the standalone copy; a plugin cannot                                                                             |
| unindexed or near-duplicate agent memory topic files               | merge into the best-named file, delete the rest, rebuild `MEMORY.md` as one line per file                                         |
| project CLAUDE.md refers to a `~/.claude/CLAUDE.md` that is absent | the user creates it or drops the reference                                                                                        |

Shadowing agents and skills on the machine layer are the user's to remove.
Settings are not: the settings pass below writes them, including `~/.claude`.

## Step 5 — Verify by re-running

Run the audit again and show the before and after: the `SETUP` verdict (a
repair, and a migration from agent-os, should end `HEALTHY`), finding count, startup bytes, token estimate. Do not declare success on vibes — the script already produces the
numbers, so quote them.

## The settings pass

Runs when `SETUP` is `FRESH`, or `REPAIR` with a settings item missing (after Step 4), and
alone for `settings`. It **writes** the setup rather than describing it — handing the user a
JSON block to paste is how a project ends up with no git protection and no task tools.

1. **Preview.** One call:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/settings.js" --scope both
   ```

   It prints, per file, what it would add to project `.claude/settings.json` and
   `~/.claude/settings.json` — the git write-protection deny rules, and
   `env.CLAUDE_CODE_ENABLE_TODO_TOOLS` — plus the task-tracking rule. If it reports
   everything already present, say so and stop.

2. **Ask once.** One AskUserQuestion: apply to _project and user_ (recommended —
   `~/.claude` protects every other repo on this machine), _project only_, or _skip_. This
   is the one confirmation: `permissions.deny` is the guardrail on your own behaviour, so it
   is changed with the user's yes, never silently.

3. **Apply** with the same command plus `--apply` and `--scope both` or `--scope project`.
   The script merges — existing keys, allow rules, deny rules and a user-set env value
   survive — and backs up each file it changes to `<file>.rulegate.bak`, keeping
   the first backup if one is already there. Show its output. It exits 1 when it refused an
   item (invalid JSON, a symlink, a generated file, an existing rule file, a file that is
   not UTF-8); report each refusal as printed and do not work around it by hand. The
   preview already marks the items it will refuse.

   In a Rulegate project the task-tracking rule goes into
   `.rulegate/rules/working-agreement.md`, never into the generated `CLAUDE.md`, and the
   output says to run `rulegate sync`: run `npx --no rulegate sync` so `CLAUDE.md`
   carries it — `--no`, as for `check`, so nothing is fetched from the registry. The script cannot run it for you. If `working-agreement.md` already exists without
   the rule, the script leaves it alone — add the rule to it by hand, then sync.

4. **If the Bash call is denied** (writing under `~/.claude` can need approval), do not
   fall back to pasting JSON or editing the settings files yourself. Give the user the
   exact command to run with the `!` prefix so it runs in this session, with the scope the
   user chose in step 2 — never widened to `both` after they said _project only_:
   `! node "<plugin root>/dist/settings.js" --scope <both|project> --apply`.

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
