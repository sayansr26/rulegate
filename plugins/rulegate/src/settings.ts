import { resolve } from 'node:path';
import { claudeDirFromEnv, print } from './lib/entry.js';
import { isDir } from './lib/read.js';
import { refusals } from './lib/refusals.js';
import { describeScope, planScope, type Scope } from './lib/settings.js';
import { applyScope } from './settings-writer/apply.js';

/**
 * `node dist/settings.js [--root <dir>] [--scope project|user|both] [--apply]` — the settings
 * pass: git write protection, the task tools, and the task-tracking rule. Previews by
 * default; `--apply` merges into the files and backs up each file it changes to
 * `<file>.rulegate.bak` first (`src/settings-writer/`).
 *
 * Exit codes follow the CLI's: 0 ok, 1 when `--apply` refused any item (invalid JSON, a
 * symlink, a generated file, a rule file the user already wrote, a file that is not UTF-8),
 * 2 usage. An unknown flag is a usage error rather than ignored, so a caller that believed a
 * flag worked learns otherwise from the code.
 */
const usage = (message: string): never => {
  print([message, 'usage: settings.js [--root <dir>] [--scope project|user|both] [--apply]']);
  process.exit(2);
};

const argv = process.argv.slice(2);
const values = new Map<string, string>();
let apply = false;
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i] ?? '';
  if (flag === '--apply') {
    apply = true;
    continue;
  }
  if (flag !== '--root' && flag !== '--scope') usage(`unknown argument "${flag}"`);
  const value = argv[++i];
  // Empty counts as missing: `--root "$UNSET"` would otherwise resolve to the cwd and
  // write there, the outcome the directory check below exists to prevent.
  if (value === undefined || value === '' || value.startsWith('--')) usage(`${flag} needs a value`);
  values.set(flag, value ?? '');
}

const scope = values.get('--scope') ?? 'both';
if (scope !== 'both' && scope !== 'project' && scope !== 'user') {
  usage(`--scope must be project, user or both (got "${scope}")`);
}
const scopes: Scope[] = scope === 'both' ? ['project', 'user'] : [scope as Scope];
// A mistyped `--root` is a usage error, not a new directory: the writer creates missing
// parents for `.claude/`, so an unchecked root would plant settings wherever the typo points.
const root = resolve(values.get('--root') ?? process.cwd());
if (!isDir(root)) usage(`--root must be an existing directory (got "${root}")`);
const claudeDir = claudeDirFromEnv();
const out = [
  `RULEGATE SETTINGS  ${apply ? 'applied' : 'preview — nothing written; re-run with --apply'}`,
  '',
];
let refused = false;
for (const s of scopes) {
  if (apply) {
    const r = await applyScope(s, root, claudeDir);
    refused ||= r.refused.length > 0;
    out.push(...describeScope(r.plan, { dry: false, refused: r.refused, backups: r.backups }), '');
  } else {
    // The preview names what `--apply` will refuse, so the user is never asked to confirm
    // a change the writer will then decline.
    const plan = planScope(s, root, claudeDir);
    const refused = await refusals(plan, root, claudeDir);
    out.push(...describeScope(plan, { dry: true, refused }), '');
  }
}
if (scopes.includes('user')) out.push('~/.claude applies to every project on this machine.');
print(out);
if (refused) process.exitCode = 1;
