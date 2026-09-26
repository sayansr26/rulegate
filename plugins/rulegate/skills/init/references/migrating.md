# Migrating an existing setup

Read this when the audit reports a legacy store, or a CLAUDE.md over budget.

**In a project with `.rulegate/`**, every `CLAUDE.md` and `.claude/rules/` destination
below is generated: write the fact as a rule in `.rulegate/rules/` instead (`globs:` where
this says `paths:`, none for an every-session fact) and run `rulegate sync`. Editing a
generated file is undone by the next sync, and `rulegate check` fails on it until then.

## Preserve before you delete

Content in a legacy store is usually real, hard-won knowledge. It is the
_loading_ that was wrong, not the writing. Never delete a legacy store until its
content has landed somewhere. For each fact in it, ask:

- **True in every session, for every file?** → `CLAUDE.md`. Rare — build commands,
  the hard rules, the definition of done, how to verify.
- **Durable but scoped to some files?** → a `.claude/rules/` file with `paths:`.
  This is where most of it goes.
- **Derivable from the code?** → delete it. Directory tours, dependency lists,
  architecture overviews, file inventories. The cartographer regenerates these on
  demand and cannot go stale the way a written copy does.
- **About the user, or a correction, or a decision?** → leave it; auto memory takes it.
- **About work in flight?** → the task vault.

Back up what you replace (`CLAUDE.md.pre-migration.bak`) and tell the user where
the backup is. In a Rulegate project nothing generated is replaced by hand, so there is
nothing to back up: `rulegate sync` backs up what it overwrites to `.rulegate/backup/`.

## Confirm the shared pieces are active

These ship with the Rulegate plugin, so normally there is nothing to install —
just confirm they are working and wire up anything project-specific:

- **`feature-cartographer`** answers "how is X built" and accumulates a per-repo
  map under `.claude/agent-memory/rulegate-feature-cartographer/`. Decide with the user
  whether that map is committed (useful shared knowledge for a team) or ignored
  (add `.claude/agent-memory/` to `.gitignore`). Check it appears in `/context`
  under Custom Agents.
- **The session-resume hook** prints the where-you-left-off block at every
  session start. It reads the first handoff note it finds —
  `.claude/session-handoff.md`, then `HANDOFF.md` — and the active task from
  `.claude/active-task.md`. A project that keeps them elsewhere lists its paths as
  `handoff` and `activeTask` in `.claude/rulegate.json`; that is a project change,
  not a plugin one.

If an agent or the hook is missing, the plugin is not loaded. Say so and point
the user at `/plugin` rather than writing a project-local copy — a per-project
fork of a shared tool is how the two silently drift apart.

## From agent-os

agent-os is this plugin's predecessor, and `SKILL.md` Step 2b migrates it in one
confirmation. What each piece becomes:

| agent-os                                       | Rulegate                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `.agent-os/` rules, `AGENTS.md`, `config.json` | `.rulegate/` — `npx rulegate init` imports it and takes ownership of the files agent-os generated           |
| `claude.*` in `.agent-os/config.json`          | `.claude/rulegate.json` — `init` prints the payload                                                         |
| `.claude/agent-memory/agent-os-<agent>/`       | `.claude/agent-memory/rulegate-<agent>/` — `migrate-memory.js` moves it; `-local` memory moves the same way |
| `agent-os@sayan-plugins` enabled               | disabled with an explicit `--scope`, so other projects on the machine keep it until they migrate            |
| `sayan-plugins` in `extraKnownMarketplaces`    | `rulegate`, swapped by the settings pass at project scope once agent-os is disabled                         |

The memory move never loses a map: every file is copied and its bytes checked at the new
name before the original goes, and a same-named file with different content stops that
agent's move instead of choosing a side. When both `agent-os-<agent>/` and
`rulegate-<agent>/` exist — the plugin's agent already ran here — the agent reads only the
`rulegate-` one, so the older entries are invisible until merged; the audit warns about
exactly that. A refused agent is merged by hand with `/rulegate:memory`, then the script
re-run.

`.agent-os/` itself is left in place. Once `.rulegate/` exists the audit calls it already
imported and safe to delete; the user deletes it, once `rulegate check` is clean.
