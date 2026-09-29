# agents-sync

Two agents rendered through the real adapter registry (T054), with Claude Code, Codex, Copilot,
Cursor, Gemini CLI and OpenCode enabled.

`expected/` is hand-written from the tools' documented folders and keys (RFC-0001 §14.4):

- `planner` restricts nothing, so it reaches every tool through the fewest folders:
  `.claude/agents/` serves Claude Code, Cursor and Copilot at once, and Codex, Gemini CLI and
  OpenCode each get their own. Codex's copy is TOML, with the prompt as
  `developer_instructions`. `color` stays where a reader of the folder reads it and
  `temperature` likewise; each drop is named (`W_AGENT_FIELD_DROPPED`).
- `reviewer` restricts its tools with `tools: Read, Grep, Glob`, in Claude Code's names. Only
  Claude Code and Copilot's `.claude/agents/` read those, so it is written there alone, and
  Codex, Cursor, Gemini CLI and OpenCode do not get it (`W_AGENT_RESTRICTED`) rather than get
  an agent with every tool. Cursor still reads `.claude/agents/` and loads it unrestricted,
  which `sync` says (`W_AGENT_LOAD`).
