---
name: memory
description: Inspect, repair or edit what this project remembers — agent memory, Claude Code auto memory, and path-scoped rules. Use for "show my memories", "what does Claude remember about this project", "clean up agent memory", "forget X", "my agent memory is a mess", "which maps are stale", or when memory looks duplicated, orphaned or wrong.
---

# Project memory

Every durable store this project has, in one place: per-agent memory, Claude
Code's own auto memory, and `.claude/rules/`.

## Run the inspection first

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/memory.js"
```

Add `--stale` to also compare each map's `mapped:` date against the last commit
that touched the file it describes — that is how you find maps the code has
moved past. Pass a path as the first argument for a project other than the
working directory. Read-only.

It prints every store, every topic file with line counts and map dates, and a
health list: topic files missing from their index, hyphen/underscore duplicates
of the same subject, oversized indexes, and unscoped rules.

Show the output before changing anything.

## `$ARGUMENTS`

| Argument           | Do                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------- |
| _(none)_ or `list` | Run the inspection, report, stop                                                   |
| `show <name>`      | Read that topic file or index and summarise it                                     |
| `clean`            | Fix everything in the health list — see below                                      |
| `forget <subject>` | Delete that topic file **and** its index line, and anything derived solely from it |
| `stale`            | Run with `--stale` and report only what has drifted                                |

## `clean` — what to actually do

Work through the health list in this order. Show the user each change before
making it; this is their accumulated knowledge, not scratch.

1. **Merge duplicates.** Two files for one subject (`defect-patterns.md` and
   `defect_patterns.md`) hold different content written in different sessions —
   the agent thought it was updating one file. **Read both fully and merge**,
   keeping every distinct fact. Do not pick one and delete the other. Keep the
   kebab-case name.
2. **Index the orphans.** A topic file missing from `MEMORY.md` is invisible: the
   agent will not find it next session, will write the same knowledge again under
   a new name, and the copies will diverge. Add one line per file.
3. **Trim an oversized index.** Only the first 200 lines of `MEMORY.md` load at
   startup. Everything past that is silently dropped. One line per topic file,
   detail in the topic files.
4. **Scope unscoped rules.** A `.claude/rules/` file without `paths:` frontmatter
   loads every session, exactly like `CLAUDE.md`. Either give it `paths:` or move
   its content into `CLAUDE.md` where it belongs — in a Rulegate project, give the
   canonical rule `globs:` in `.rulegate/rules/` and run `rulegate sync` instead.
5. **Refresh stale maps.** For anything `--stale` flagged, dispatch
   `feature-cartographer` to re-map that area. Do not edit a map by hand from
   memory — that is how a map becomes confidently wrong.

## Where a fact belongs

If the user is adding something rather than repairing, route it:

**In a project with `.rulegate/`**, every `CLAUDE.md` and `.claude/rules/` destination
below is generated: write the fact as a rule in `.rulegate/rules/` instead (`globs:` where
this says `paths:`, none for an every-session fact) and run `rulegate sync`. Editing a
generated file is undone by the next sync, and `rulegate check` fails on it until then.

| Kind of fact                                             | Store                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| True in every session, every file                        | project `CLAUDE.md`, ≤200 lines                                  |
| Durable but scoped to some files                         | `.claude/rules/<topic>.md` with `paths:`                         |
| How a feature is built                                   | agent memory — let the cartographer write it, do not hand-author |
| A correction the user gave you, a preference, a decision | Claude Code auto memory — it writes this itself                  |
| Work in flight                                           | the project's task vault, not memory                             |
| Derivable by reading the code                            | **nowhere**                                                      |

Never hand-write into an agent's memory directory. That directory is the agent's
working knowledge and it maintains its own index; writing into it from outside
produces exactly the orphan-and-duplicate mess this skill exists to clean up. If
the cartographer's map is wrong, re-dispatch the cartographer.

## What this will not do

It will not delete a store because it looks untidy. Duplicates get merged, not
dropped. `forget` removes only what the user named.
