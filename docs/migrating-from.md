# Migrating from ruler, rulesync or agent-os

`rulegate init` reads an existing **ruler**, **rulesync** or **agent-os** setup and imports it into
`.rulegate/`. Nothing about it is one-directional in the other sense: Rulegate never
writes a `.ruler/`, `.rulesync/` or `.agent-os/` config, and never will. Interop is a way in, not a
two-way sync.

Run it the way you would on any repository:

```
rulegate init          # prints everything it would do, writes nothing
rulegate init --yes    # applies it, backing up every file it takes ownership of
```

## What comes across

| From                            | Becomes                     | Notes                                                                 |
| ------------------------------- | --------------------------- | --------------------------------------------------------------------- |
| `.ruler/*.md`                   | one canonical rule per file | The sources you edit, not the files ruler generated from them.        |
| `.rulesync/rules/*.md`          | one canonical rule per file | `description` and `globs` map straight across.                        |
| `targets:` (rulesync)           | `tools:`                    | `["*"]` becomes every tool; a named list becomes a `tools:` selector. |
| Per-tool frontmatter (rulesync) | preserved in `unknown`      | Not interpreted, not lost.                                            |

## The part worth understanding: your generated files are not imported twice

ruler and rulesync **generate the same files Rulegate's adapters import from** —
`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*`. A naive import would read both the source and
the copy built out of it, and write every rule into `.rulegate/` twice.

So `init` hides each tool's observed output from the adapter pass. Two details matter:

- **ruler is detected precisely.** Its output carries `<!-- Source: … -->` markers, so
  Rulegate can tell a file ruler wrote from one you wrote by hand. A `CLAUDE.md` with no
  marker is imported normally, because it is yours.
- **rulesync is detected less precisely,** and this is stated rather than hidden: rulesync
  writes no marker of its own, so the only available signal is that the repository is a
  rulesync repository and the file is one of rulesync's known outputs. In a repository that
  uses rulesync _and_ keeps a hand-written `CLAUDE.md` at a path rulesync also targets, that
  file will not be imported. `init` does not take it on trust, though: any such file whose
  bytes differ from what Rulegate would render is named with `W_INIT_NOT_IMPORTED` and marked
  in the plan as backed up, then replaced. A genuine rulesync output usually differs as well,
  so expect the warning on those too. Copy anything you wrote by hand into `.rulegate/rules/`
  before `init --yes`; afterwards the original is in `.rulegate/backup/`.

## What does not come across

Rulegate imports **rules**. Anything else is reported by name and left alone:

- `ruler.toml` — including its MCP configuration. Rulegate has no TOML parser outside the
  Codex adapter's own scoped one, and guessing at a config format is how an import loses
  something quietly.
- `.rulesync/mcp.jsonc`, `.rulesync/commands/`, `.rulesync/subagents/`, `.rulesync/skills/`
- `.ruler/skills/`, `.ruler/agents/`

`init` prints each of these as a `W_INTEROP_NOT_IMPORTED` warning. Copy them across by hand
before you delete the old directory — being told now is the point of the warning, rather
than finding out when an MCP server stops working.

Rulegate now has canonical skills, commands and subagents of its own (`.rulegate/skills/`,
`commands/`, `agents/`); importing them from ruler and rulesync is not built yet.

## agent-os

agent-os is Rulegate's predecessor for Claude Code, and its successor is the Rulegate CLI
plus the [Claude Code plugin](claude-code-plugin.md). Migrating is two steps: the files, then
Claude Code.

```
npx rulegate init                  # preview
npx rulegate init --plugin --yes   # import, sync, install the plugin and auto-route
```

Then open a Claude Code session in the project and run `/rulegate:init`. It turns agent-os
off, moves each agent's memory to its `rulegate-*` name, migrates the settings, and removes
agent-os's reminder hook — each with a preview first.

What `init` does with `.agent-os/`:

- `rules/*.md` become canonical rules, keeping their `paths:` scope (a quoted scalar `paths:`
  is read too). An empty rule is imported under its name, not dropped.
- `AGENTS.md` becomes the `agents` rule — unless it is still agent-os's untouched
  placeholder, which is skipped with a note.
- The `claude` block of `config.json` is not a rule: it is printed as the
  `.claude/rulegate.json` the plugin reads.
- A rule whose fence agent-os could not parse — a CRLF file, a BOM, an unterminated
  frontmatter fence — stays unscoped, exactly as agent-os compiled it.
- When two importers produce the same rule name, both are kept, as `<importer>-<name>`
  (with `-N` added if that is taken).
- Files agent-os generated (they carry its banner) are not imported a second time.

Memory: where both an agent-os and a Rulegate memory index exist, the agent-os one is kept
beside it as `MEMORY.agent-os.md`, and any file the migration overwrites is copied to
`<file>.rulegate.bak` first.

agent-os refuses to run in a repository that has `.rulegate/`, so the two never fight over
the same files. Once `rulegate check` is clean, delete `.agent-os/`.

## After importing

Your `.ruler/` or `.rulesync/` directory is still there and still works; Rulegate has not
touched it. Once `rulegate check` reports the repository in sync, removing the old
directory and its tool is a separate, reversible decision.

---

_Formats verified 2026-09-04 against `intellectronica/ruler`
(`src/constants.ts`, `src/core/RuleProcessor.ts`, `src/core/FileSystemUtils.ts`) and
`dyoshikawa/rulesync` (`src/constants/rulesync-paths.ts`,
`src/features/rules/rulesync-rule.ts`), read from source rather than from documentation._
