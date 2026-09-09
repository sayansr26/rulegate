#!/usr/bin/env bash
# PreToolUse guard: refuse edits to Rulegate's own generated output.
#
# This repository dogfoods itself. CLAUDE.md, AGENTS.md, GEMINI.md, the per-tool rule
# directories and .github/copilot-instructions.md are rendered from .rulegate/rules/;
# docs/tools/ and docs/adapters.md are rendered from each adapter's docs.ts; action/dist/
# is a committed esbuild bundle. A generator and an editor cannot both own a file: a
# hand-edit here makes the next `rulegate sync` correctly report the file as hand-edited
# and refuse to write it, and CI only catches that afterwards, in `rulegate check`,
# `generate-docs.mjs --check` and `action/build.mjs --check`.
#
# Exit 2 blocks the call and returns stderr to the model, so it retries against the source.
set -uo pipefail

path=$(jq -r '.tool_input.file_path // empty')
[ -n "$path" ] || exit 0

# Hook input carries an absolute path; the patterns below are repo-relative.
rel=${path#"${CLAUDE_PROJECT_DIR:-$PWD}/"}

case "$rel" in
  CLAUDE.md | AGENTS.md | GEMINI.md | CONVENTIONS.md | .rules)
    source="the rule it came from in .rulegate/rules/, then run \`rulegate sync\`" ;;
  .cursor/rules/* | .windsurf/rules/* | .clinerules/* | .roo/* | \
  .github/copilot-instructions.md | .github/instructions/*)
    source="the rule it came from in .rulegate/rules/, then run \`rulegate sync\`" ;;
  docs/tools/* | docs/adapters.md)
    source="the adapter's src/docs.ts, then run \`node scripts/generate-docs.mjs\`" ;;
  action/dist/*)
    source="action/src/, then run \`node action/build.mjs\`" ;;
  *)
    exit 0 ;;
esac

echo "$rel is generated output and must not be edited directly. Edit $source." >&2
exit 2
