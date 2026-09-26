import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { guard, reminder, type Decision } from './lib/guard.js';
import { isRecord } from './lib/read.js';

// PreToolUse hook on Edit|MultiEdit|Write. Reads Claude Code's JSON payload from stdin and
// answers with at most one JSON object on stdout: a deny for a generated file, or advisory
// context for an unmapped feature. Every path exits 0; anything unexpected says nothing.
process.stdout.on('error', () => undefined);

function emit(decision: Decision): void {
  const output =
    decision.kind === 'deny'
      ? { permissionDecision: 'deny', permissionDecisionReason: decision.reason }
      : { additionalContext: decision.text };
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...output } }),
  );
}

try {
  const payload: unknown = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const input = isRecord(payload) && isRecord(payload.tool_input) ? payload.tool_input : {};
  const file = typeof input.file_path === 'string' ? input.file_path : '';
  const projectDir =
    process.env.CLAUDE_PROJECT_DIR ??
    (isRecord(payload) && typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
  // Resolved as the edit tool resolves it: `~` is the home directory, and a relative path
  // is relative to the session's current directory — `payload.cwd`, which moves with a
  // `cd` — not to the project directory.
  const base = isRecord(payload) && typeof payload.cwd === 'string' ? payload.cwd : projectDir;
  if (file !== '') {
    const expanded =
      file === '~' ? homedir() : file.startsWith('~/') ? join(homedir(), file.slice(2)) : file;
    const target = resolve(base, expanded);
    const session =
      isRecord(payload) && typeof payload.session_id === 'string'
        ? payload.session_id
        : 'nosession';
    const decision = (await guard(target)) ?? (await reminder(target, projectDir, session));
    if (decision !== undefined) emit(decision);
  }
} catch {
  // Silent by design: the deny above is the only way this hook may affect a session.
}
process.exitCode = 0;
