#!/usr/bin/env bash
# PostToolUse: run the invariants suite after any edit under packages/core/src.
#
# invariants.test.ts is what mechanically enforces the constraint CLAUDE.md calls the most
# important one — that `check` and `sync` share a single rendering path, so `check` cannot
# lie — along with zero network calls, computePlan/applyPlan/verifyPlan as the only
# renderer/writer/reader, and packages/core/src/git/ as the only place allowed to spawn a
# process. Running it on every touch beats discovering the breakage at the end of a session.
#
# Never fails the tool call: this is a signal to the model, not a gate. The output is what
# matters, so a red run still exits 0 and lets the model react.
set -uo pipefail

path=$(jq -r '.tool_input.file_path // empty')
case "$path" in
  */packages/core/src/*) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0
pnpm vitest run packages/core/test/invariants.test.ts 2>&1 | tail -25
exit 0
