import { resolve } from 'node:path';
import { claudeDirFromEnv, print } from './lib/entry.js';
import { describeMigration, planMemoryMigration } from './lib/migrate.js';
import { isDir } from './lib/read.js';
import { applyMemoryMigration } from './migrate/memory.js';

/**
 * `node dist/migrate-memory.js [--root <dir>] [--apply]` — moves agent-os's agent memory to
 * the names this plugin's agents read (T114). Previews by default; `--apply` copies,
 * verifies, and only then removes each source (`src/migrate/`).
 *
 * Exit codes follow the CLI's: 0 ok, 1 when any agent was refused or stopped (its memory
 * is left where it was), 2 usage. A preview that shows a refusal exits 1 too, so a caller
 * that goes on to `--apply` knows beforehand that something will stay behind.
 */
const usage = (message: string): never => {
  print([message, 'usage: migrate-memory.js [--root <dir>] [--apply]']);
  process.exit(2);
};

const argv = process.argv.slice(2);
let apply = false;
let rootArg: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i] ?? '';
  if (flag === '--apply') {
    apply = true;
    continue;
  }
  if (flag !== '--root') usage(`unknown argument "${flag}"`);
  const value = argv[++i];
  // Empty counts as missing: `--root "$UNSET"` would otherwise resolve to the cwd.
  if (value === undefined || value === '' || value.startsWith('--')) usage(`${flag} needs a value`);
  rootArg = value;
}

const root = resolve(rootArg ?? process.cwd());
if (!isDir(root)) usage(`--root must be an existing directory (got "${root}")`);
const claudeDir = claudeDirFromEnv();
if (apply) {
  const r = await applyMemoryMigration(root, claudeDir);
  print(describeMigration(r.plan, { dry: false, moved: r.moved, failed: r.failed }));
  if (r.failed.length > 0 || r.plan.agents.some((a) => a.kind === 'refused')) process.exitCode = 1;
} else {
  const plan = await planMemoryMigration(root, claudeDir);
  print(describeMigration(plan, { dry: true }));
  if (plan.agents.some((a) => a.kind === 'refused')) process.exitCode = 1;
}
