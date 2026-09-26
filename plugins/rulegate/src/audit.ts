import { runAudit } from './lib/audit.js';
import { bundledVersion, claudeDirFromEnv, print, rootArg } from './lib/entry.js';

// `node dist/audit.js [projectDir]` — the audit behind /rulegate:init. Exits 0 even when
// checks fail, so a partial audit still reaches the caller.
try {
  print(
    await runAudit({
      root: rootArg(process.argv.slice(2)),
      claudeDir: claudeDirFromEnv(),
      today: new Date().toISOString().slice(0, 10),
      expect: bundledVersion(import.meta.url),
    }),
  );
} catch (error) {
  print([`audit failed: ${error instanceof Error ? error.message : String(error)}`]);
}
