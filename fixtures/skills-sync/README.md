# skills-sync

A skill rendered through the real adapter registry (T052). Claude Code, Codex, Copilot and
Cursor are enabled, so the skill needs two directories: `.agents/skills/` reaches Codex, Copilot
and Cursor, and `.claude/skills/` is added for Claude Code. Copilot and Cursor read both, which
`sync` reports as a double load.

`expected/` is hand-written from the tools' documented directories and keys (RFC-0001 §12.5):
`.agents/skills/` keeps `paths` and `disable-model-invocation`, which Cursor reads, and drops
`when_to_use`, which no tool there reads; `.claude/skills/` keeps all three. `tools:` never
appears in a generated copy. The PNG and the CRLF script are byte-identical to the source.
