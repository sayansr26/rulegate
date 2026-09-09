#!/usr/bin/env bash
# SessionStart: name the maintainer notes that exist, so reading them is not a habit.
#
# The instruction to read them lived only in prose — in the canonical rules, and later in
# serena's `initial_prompt`. Both are advisory: nothing runs them, so a session that does
# not happen to look never learns the notes exist. The session that introduced this hook
# went a whole day of work without reading a memory, and appended to the progress log with
# a shell redirect rather than `write_memory` — twice — having authored the rule against
# doing exactly that earlier the same day.
#
# So this prints the inventory rather than the instruction. A name a session has seen is
# a thing it can ask for; an instruction it has merely been given is not.
#
# Read-only and silent when there is nothing to say: a contributor's clone has neither
# `task-breakdown.md` nor `.serena/memories/`, both being git-ignored, and telling them
# about notes they cannot have is noise.
set -uo pipefail

root=${CLAUDE_PROJECT_DIR:-$PWD}
memories="$root/.serena/memories"
tasks="$root/task-breakdown.md"

lines=()

if [ -d "$memories" ]; then
  names=$(find "$memories" -maxdepth 1 -name '*.md' -exec basename {} .md \; | sort | tr '\n' ' ')
  # `find` succeeding on an empty directory is not the same as there being memories.
  if [ -n "${names// /}" ]; then
    lines+=("Maintainer memories (serena, git-ignored): ${names% }")
    lines+=("  Read with \`read_memory\`, not by path. Start: 02-active-context, 03-system-patterns.")
    lines+=("  Progress log is split: read \`05-progress-log\` (index), then only the part it names.")
  fi
fi

if [ -f "$tasks" ]; then
  todo=$(grep -cE '^- \*\*Status\*\*: TODO' "$tasks" 2>/dev/null || echo 0)
  # Git-ignored, and this project sets `ignore_all_files_in_gitignore: true`, so serena's
  # file-search tools cannot reach it. Named here because it is otherwise invisible.
  lines+=("task-breakdown.md: ${todo} TODO. Git-ignored — open it directly; serena search cannot see it.")
fi

[ ${#lines[@]} -eq 0 ] && exit 0

printf '%s\n' "${lines[@]}"
exit 0
