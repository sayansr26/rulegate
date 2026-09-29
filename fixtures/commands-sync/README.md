# commands-sync

Two commands rendered through the real adapter registry (T053), with every adapter that has
commands enabled, plus Codex, which has none at project scope.

`expected/` is hand-written from the tools' documented folders and formats (RFC-0001 §13.4):

- `review` uses `$ARGUMENTS`, so it goes only to tools with an argument syntax: unchanged for
  Claude Code and OpenCode, `${input:args}` for Copilot, `{{args}}` for Gemini CLI. Kilo, Roo
  Code and Windsurf document none and do not get it (`W_COMMAND_ARGUMENTS`).
- `argument-hint` reaches Claude Code and Copilot, which read it; `model` reaches Claude Code,
  Copilot and OpenCode. `mode` reaches only Roo Code. Every other copy leaves them out, and
  `sync` says so (`W_COMMAND_FIELD_DROPPED`).
- Gemini CLI gets TOML: `description` and a multi-line `prompt`, with every `"` escaped and the
  marker as a `#` comment.
- Windsurf documents no frontmatter, so its workflow carries the description as the first
  paragraph.
- Codex gets nothing: its prompts are user-scope only.
