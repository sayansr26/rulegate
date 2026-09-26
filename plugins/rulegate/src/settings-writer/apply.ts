import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { exists } from '../lib/read.js';
import { refusals } from '../lib/refusals.js';
import {
  TASK_RULE_FILE,
  planScope,
  ruleTarget,
  settingsPath,
  type Refusal,
  type Scope,
  type ScopePlan,
} from '../lib/settings.js';

/**
 * The settings pass's writer (T109) — the plugin's second writer under the amended P3,
 * pinned in `invariants.test.ts` by shape. It lives in its own directory for the same reason
 * `session/` does: only `src/settings.ts` imports it, so no hook bundle and neither the audit
 * nor the state script can carry a write call, and the per-bundle pin proves that.
 *
 * It writes what `planScope` planned and nothing else — re-planned here, never taken from an
 * earlier preview, since the files may have changed since. Its targets are fixed: the two
 * `settings.json` files and `ruleTarget` — the user's `CLAUDE.md`, a project `CLAUDE.md`
 * that already exists outside a Rulegate project, or `.rulegate/rules/working-agreement.md`
 * inside one. What it refuses is `lib/refusals.ts`, which the preview and the setup state
 * ask too, so neither promises a write this then declines.
 *
 * Every file it replaces is copied to `<file>.rulegate.bak` first (D2), project files too:
 * a `.git` above the root says nothing about whether *this* file is tracked or committed,
 * and an untracked `CLAUDE.md` or an uncommitted edit has no other copy. Asking git would
 * need a spawn in this bundle. The copy is exclusive, so the *first*
 * original is the one kept: a second apply after an outside edit must not replace the only
 * copy of what the user had before Rulegate touched the file.
 */
export const BACKUP_SUFFIX = '.rulegate.bak';

export interface ApplyResult {
  /** The plan as it stood when applied. */
  readonly plan: ScopePlan;
  readonly written: readonly string[];
  /** Backups made by this run; one kept from an earlier run is not listed again. */
  readonly backups: readonly string[];
  readonly refused: readonly Refusal[];
}

/**
 * Replace `file` with `next` through a sibling and a rename, so a crash cannot leave half a
 * `settings.json` for Claude Code to reject on its next start. The sibling is created `wx`:
 * never an existing file, never through a planted link. It takes the original's mode, since
 * a rename carries the sibling's: a 0600 `settings.json` holding an API key in `env` would
 * otherwise come out world-readable. The umask can only narrow that, never widen it.
 */
function replaceFile(file: string, next: string): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  const mode = exists(file) ? lstatSync(file).mode & 0o777 : 0o666;
  let saved: string | undefined;
  if (exists(file)) {
    try {
      copyFileSync(file, `${file}${BACKUP_SUFFIX}`, constants.COPYFILE_EXCL);
      saved = `${file}${BACKUP_SUFFIX}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  const tmp = `${file}.${String(process.pid)}.rulegate-tmp`;
  // Only a sibling this call created is removed: when `wx` fails because something is
  // already at the name, that something is not ours to delete.
  let created = false;
  try {
    writeFileSync(tmp, next, { flag: 'wx', mode });
    created = true;
    renameSync(tmp, file);
  } catch (e) {
    if (created) rmSync(tmp, { force: true });
    throw e;
  }
  return saved;
}

const failure = (e: unknown): string =>
  `could not write (${(e as NodeJS.ErrnoException).code ?? String(e)})`;

export async function applyScope(
  scope: Scope,
  root: string,
  claudeDir: string,
): Promise<ApplyResult> {
  const plan = planScope(scope, root, claudeDir);
  const written: string[] = [];
  const backups: string[] = [];
  const refused: Refusal[] = await refusals(plan, root, claudeDir);
  const isRefused = (item: Refusal['item']): boolean => refused.some((x) => x.item === item);

  const s = plan.settings;
  const settingsFile = settingsPath(scope, root, claudeDir);
  if (s.status === 'changed' && s.next !== undefined && !isRefused('settings')) {
    try {
      const saved = replaceFile(settingsFile, s.next);
      if (saved !== undefined) backups.push(saved);
      written.push(settingsFile);
    } catch (e) {
      refused.push({ item: 'settings', file: settingsFile, reason: failure(e) });
    }
  }

  const r = plan.rule;
  if (r.status === 'add' && r.next !== undefined && !isRefused('rule')) {
    const ruleFile = ruleTarget(scope, root, claudeDir);
    try {
      if (r.file === TASK_RULE_FILE) {
        // A new canonical rule, created or not at all: `wx` fails on anything already
        // there, so a rule file that appeared since planning is never overwritten.
        mkdirSync(dirname(ruleFile), { recursive: true });
        writeFileSync(ruleFile, r.next, { flag: 'wx' });
      } else {
        const saved = replaceFile(ruleFile, r.next);
        if (saved !== undefined) backups.push(saved);
      }
      written.push(ruleFile);
    } catch (e) {
      refused.push({ item: 'rule', file: r.file, reason: failure(e) });
    }
  }

  return { plan, written, backups, refused };
}
