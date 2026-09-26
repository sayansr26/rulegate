# Establishing a context layer from an existing codebase

Read this when the audit reports `MODE ESTABLISH` or `MODE MAP`: there is real
code but no context layer, or a layer but no architecture map.

The goal is not a smaller `CLAUDE.md`. The goal is that a request like _"change
the login flow from email to OTP"_ can be executed from **known structure and
known conventions**, instead of rediscovering the codebase from scratch every
time. Smaller context is a consequence, not the objective.

## The one rule

**Everything you write must be something you observed in this repository.** Not
something you know about React, or Django, or how projects like this usually
work. If you did not open the file, it does not go in.

An invented convention is worse than a missing one, because the next agent will
follow it and the reviewer will enforce it.

## Step 1 — Let Claude Code write the first draft

Do not hand-write `CLAUDE.md` from nothing. Claude Code's own `/init` explores
the codebase and generates a starting file; `/doctor` trims a checked-in one and
migrates guidance out of it. Use those first, then build on the result.

Tell the user to run `/init` if no `CLAUDE.md` exists, and take what it produces
as the starting point. The Rulegate plugin adds the layers `/init` does not: the
architecture map, conventions extracted from real code, and path-scoped rules.
Once the draft exists, `npx rulegate init` makes it the canonical source — it imports
`CLAUDE.md` into `.rulegate/rules/`, and from then on `CLAUDE.md` is generated.

## Step 2 — Map the architecture

Dispatch `feature-cartographer` with an explicit system-level brief, not a
feature question:

> Map this codebase at the system level. Produce `_architecture.md`: the stack
> and versions, the layers and what each owns, where a request enters and how it
> reaches data, the state management, the network edge, the auth and permission
> model, the build and run commands, and the three or four files a newcomer must
> read first. Name real files. Say what you could not determine.

It writes `_architecture.md` into its own memory and indexes it in `MEMORY.md`.
That file becomes the starting point for every later "how is X built" question —
the cartographer reads it before exploring, so the second question about any area
is cheap and the first is cheaper than cold.

Re-dispatch this when the architecture actually changes, not on a schedule.

## Step 3 — Extract conventions from real code

This is the part that makes a change follow the existing style rather than the
model's defaults. For each kind of thing the codebase contains — a service, a
component, a route, a migration, a test — do this:

1. **Find at least three independent examples.** Glob for the shape, pick three
   written at different times if you can tell.
2. **Read them.** Not outlines. The convention lives in the details: how errors
   are handled, where validation sits, what gets logged, how state is reached,
   how the network is called, what the file is named and where it lives.
3. **Write down only what is consistent across all three.** One file is a sample.
   Two is a coincidence. Three that agree is a convention.
4. **Note what varies.** If two services handle errors differently, that is not a
   convention — it is drift. Say so; do not pick a winner on the codebase's
   behalf.
5. **Record where you saw it.** Name the files the pattern came from. A future
   reader can re-check a cited rule; an uncited one rots.

The highest-value things to capture are the ones a newcomer gets wrong:

- **Registration sites.** Where does a new route, nav item, feature flag or
  migration have to be registered, and is that where the docs say? Check.
- **The seam.** How does this codebase talk to its backend, and what wraps it?
- **The gate.** How is a feature permitted — role, flag, config, middleware?
- **The thing that looks optional but is not.** A required call in every handler,
  an index that must be added, a twin file that must be updated together.

## Step 4 — Write the rules

If the project has `.rulegate/`, write rules there (`.rulegate/rules/<name>.md`,
with `globs:` where this section says `paths:`) and run `rulegate sync`. Every
tool's copy is generated from them, and the plugin's pre-edit hook blocks edits to
any file recorded in `.rulegate/state.json`.

Group by **what the reader is touching**, not by topic. Each file gets `paths:`
frontmatter narrow enough that it is absent most of the time.

```markdown
---
paths:
  - 'src/features/**'
  - 'src/pages/**'
---

# Working inside a feature

Services export one function per endpoint and go through the shared client
wrapper, never a bare fetch. Errors surface as a typed result, not a throw.
Verified across three services; see the ones named in `_architecture.md`.
```

Dense agent notes, not prose. Invariants and gotchas. Skip anything a `ls` or a
grep answers — `writing-rules.md` says why, and it applies hardest here.

## Step 4b — Wire the agents into CLAUDE.md

An agent nobody is told to use never runs. The session hook announces the
agents every session; `CLAUDE.md` makes it part of the project's own contract,
so it survives a machine without the plugin's hooks. Add this section once
(skip it if `CLAUDE.md` already has one), trimmed to the agents this project
actually needs. In a Rulegate project `CLAUDE.md` is generated, so the section
is a rule: `.rulegate/rules/claude-agents.md` with `tools: [claude-code]` in its
frontmatter — the other tools have no such agents — then `rulegate sync`. Not
`agents.md`: that is where `rulegate init` imports an `AGENTS.md`, and writing
over it loses the project's own rules. A project migrated from agent-os already
has the section, as `## Agents in this project (agent-os)` in the rule `init`
imported from `CLAUDE.md`: rewrite it there — `rulegate:` for `agent-os:`, no
`(agent-os)` in the heading — rather than adding a second one beside it.

```markdown
## Agents in this project

- Before changing an existing feature: ask `rulegate:feature-cartographer` how
  it is built. In plan mode ask it read-only, and have it file the map as the
  first step after plan mode ends.
- New subsystem, cross-module change, shared data model: `rulegate:architect`
  first.
- Writing the change: `rulegate:builder`, given the map and the files to change.
- Done means: `rulegate:tester` verified it and `rulegate:reviewer` found no
  rule violations.
- After it is verified: `rulegate:documenter` updates the changelog and docs.
- Work spanning several of these: `rulegate:orchestrator`.
- Rules live in `.rulegate/rules/`; run `rulegate sync` after changing one. Every
  file `.rulegate/state.json` lists is generated — never edit it by hand.
```

## Step 5 — Stop Claude reading what it should not

Two settings with a large effect on how much gets read, both worth proposing:

- **Code intelligence.** If the audit named an LSP plugin, install it:
  `/plugin install typescript-lsp@claude-plugins-official` (or the one for your
  language). Claude then jumps to a definition and finds references through the
  language server instead of scanning the tree. For "where is login handled and
  what calls it", this is the single biggest win available.
- **`Read` deny rules** for checked-in generated or vendored code:

  ```json
  {
    "permissions": {
      "deny": ["Read(./**/dist/**/*)", "Read(./**/generated/**/*)", "Read(./**/vendor/**/*)"]
    }
  }
  ```

  `.gitignore`d paths are already excluded from search; these cover the ones that
  are committed.

In a monorepo, also consider per-directory `CLAUDE.md` files so each package's
conventions load only when Claude reads there.

## Step 6 — Verify

Re-run the audit. `MODE` should move to `MAINTAIN`. Show the user the before and
after: finding count, startup bytes, and what got mapped.

Then prove it works on a real question. Ask the cartographer something you
already know the answer to, and check it. A map that is confidently wrong is
worse than no map, and this is the cheapest moment to find out.
