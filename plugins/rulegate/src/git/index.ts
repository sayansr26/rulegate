import { execFile } from 'node:child_process';

/**
 * The plugin's one door to a subprocess, and the second of the two directories in
 * shipped source allowed to spawn one (`packages/core/test/invariants.test.ts` pins both).
 *
 * The hooks need git for what agent-os's hooks already did with it: a capped snapshot of
 * where the work stands for SessionStart, and `ls-files` / `log` to tell a tracked feature
 * from a new one and a map from a stale one. Everything the core allowlist promises holds
 * here too, and hooks fire on their own at session start, so this goes further:
 *
 * - `execFile`, never `exec`, and arguments as an array — no shell ever parses a path.
 * - Four read-only subcommands, **and only allowlisted options before `--`.** A subcommand
 *   check alone is not read-only: `git log --output=<path>` writes anywhere on disk, and
 *   `--ext-diff` / textconv run commands from config. After `--`, git reads arguments as
 *   paths only, so hook input belongs there and nowhere else.
 * - Config that runs programs or reaches the network is switched off per call:
 *   `core.fsmonitor` runs a configured program on `status` and `ls-files`;
 *   `log.showSignature` runs gpg, which can fetch keys; and in a partial clone, `log` with
 *   a path fetches missing blobs from the remote unless lazy fetching is off. Both switches
 *   are passed: `--no-lazy-fetch` and `GIT_NO_LAZY_FETCH` arrived in git 2.44, and an older
 *   git rejects the unknown option — so there the call fails silent instead of fetching,
 *   which is the only acceptable way for it to fail.
 * - Data from a hook, a file or a memory entry goes after `--`, where git reads it as a
 *   path. Before `--` only allowlisted options are accepted; a bare word there is a
 *   revision (`HEAD`), and callers must not put data in that position.
 * - `--no-optional-locks`, because `git status` otherwise takes `index.lock` to refresh
 *   the index, and a hook firing mid-commit would fail the user's own git command.
 *
 * A hook fails silent (Phase 6 constraint), so this resolves `undefined` on any failure or
 * refusal — not a git repository, git missing, a timeout, a disallowed option.
 */

/** Every subcommand the plugin may run. Asserted by test, so the list is the contract. */
export const GIT_SUBCOMMANDS: readonly string[] = Object.freeze([
  'log',
  'ls-files',
  'rev-parse',
  'status',
]);

/**
 * Options a caller may pass before `--`, matched exactly or, for those ending in `=`, as a
 * prefix. Deliberately none that produce a patch or a diffstat (`-p`, `--stat`): those are
 * the options that run textconv and, in a partial clone, fetch blobs. Grow it with a test.
 */
export const GIT_OPTIONS: readonly string[] = Object.freeze([
  '-z',
  '--abbrev-ref',
  '--branch',
  '--cached',
  '--exclude-standard',
  '--format=',
  '--is-inside-work-tree',
  '--max-count=',
  '--others',
  '--porcelain',
  '--show-toplevel',
]);

/** Prepended to every call; asserted by test so an edit cannot drop one quietly. */
export const GIT_SAFETY_ARGS: readonly string[] = Object.freeze([
  '--no-lazy-fetch',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'log.showSignature=false',
]);

function allowed(args: readonly string[]): boolean {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || !GIT_SUBCOMMANDS.includes(subcommand)) return false;
  for (const arg of rest) {
    if (arg === '--') return true;
    if (!arg.startsWith('-')) continue;
    const ok = GIT_OPTIONS.some((opt) => (opt.endsWith('=') ? arg.startsWith(opt) : arg === opt));
    if (!ok) return false;
  }
  return true;
}

export function runGit(args: readonly string[], cwd: string): Promise<string | undefined> {
  if (!allowed(args)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_SAFETY_ARGS, ...args],
      {
        cwd,
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
        encoding: 'utf8',
        // A hook runs inside the 10-second timeout its hooks.json gives it; git must give up first.
        maxBuffer: 16 * 1024 * 1024,
        timeout: 5_000,
        shell: false,
      },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}
