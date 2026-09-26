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
  map under `.claude/agent-memory/feature-cartographer/`. Decide with the user
  whether that map is committed (useful shared knowledge for a team) or ignored
  (add `.claude/agent-memory/` to `.gitignore`). Check it appears in `/context`
  under Custom Agents.
- **The session-resume hook** prints the where-you-left-off block at every
  session start. If this project keeps a handoff note at a path the hook does not
  already check, say so — the candidate paths are listed in the hook source, and
  changing them is a plugin change, not a project one.

If an agent or the hook is missing, the plugin is not loaded. Say so and point
the user at `/plugin` rather than writing a project-local copy — a per-project
fork of a shared tool is how the two silently drift apart.
