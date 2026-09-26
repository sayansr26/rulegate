import { claudeDirFromEnv } from './lib/entry.js';
import { sessionStart } from './lib/session.js';

// SessionStart hook: prints the snapshot and the agent contract, which Claude Code injects
// as context. A hook must never fail a session, so every path exits 0 — with no output
// when anything goes wrong — and stdin, which this hook does not need, is never read.
// Claude Code may close the pipe once it has given up on the hook; an EPIPE then must not
// surface as an uncaught error and a non-zero exit.
process.stdout.on('error', () => undefined);
try {
  const text = await sessionStart({
    root: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    claudeDir: claudeDirFromEnv(),
    now: Date.now(),
  });
  if (text !== undefined) process.stdout.write(text);
} catch {
  // Silent by design.
}
process.exitCode = 0;
