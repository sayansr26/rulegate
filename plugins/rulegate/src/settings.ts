import { claudeDirFromEnv, print } from './lib/entry.js';
import { describeScope, planScope, type Scope } from './lib/settings.js';

/**
 * `node dist/settings.js [--root <dir>] [--scope project|user|both]` — previews the settings
 * pass: git write protection, the task tools, and the task-tracking rule. Writes nothing;
 * applying the preview is not in this version of the plugin.
 *
 * Exit codes follow the CLI's: 0 ok, 2 usage. An unknown flag is a usage error rather than
 * ignored, so a caller that believed `--apply` worked learns otherwise from the code.
 */
const usage = (message: string): never => {
  print([message, 'usage: settings.js [--root <dir>] [--scope project|user|both]']);
  process.exit(2);
};

const argv = process.argv.slice(2);
const values = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i] ?? '';
  if (flag === '--apply') {
    usage('--apply is not supported in this version of the plugin; nothing was written.');
  }
  if (flag !== '--root' && flag !== '--scope') usage(`unknown argument "${flag}"`);
  const value = argv[++i];
  if (value === undefined || value.startsWith('--')) usage(`${flag} needs a value`);
  values.set(flag, value ?? '');
}

const scope = values.get('--scope') ?? 'both';
if (scope !== 'both' && scope !== 'project' && scope !== 'user') {
  usage(`--scope must be project, user or both (got "${scope}")`);
}
const scopes: Scope[] = scope === 'both' ? ['project', 'user'] : [scope as Scope];
const root = values.get('--root') ?? process.cwd();
const out = ['RULEGATE SETTINGS  preview — nothing written', ''];
for (const s of scopes) {
  out.push(...describeScope(planScope(s, root, claudeDirFromEnv()), { dry: true }), '');
}
if (scopes.includes('user')) out.push('~/.claude applies to every project on this machine.');
print(out);
