import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { RulegateError } from '../model/errors.js';
import { compareCodepoint } from '../render/order.js';
import { normalizeText } from '../render/eol.js';
import { escapesRoot, normalizeRelative } from '../fs/paths.js';
import type { DirEntry, ReadOnlyFileSystem } from '../fs/types.js';

/**
 * The one directory in shipped source allowed to spawn a process, and the allowlist in
 * `packages/core/test/invariants.test.ts` has exactly one entry so it stays that way.
 *
 * `check --staged` has to read the git index, and there is no way to read it without
 * running `git` — the index is a binary format git reserves the right to change, and
 * parsing it ourselves would be a second implementation of somebody else's file format
 * inside a tool that promises to be boring. T023 deferred the flag rather than widen the
 * ban casually; this is that widening, made as narrow as it can be:
 *
 * - `execFile`, never `exec`. No shell, so no argument is ever parsed as a command, and a
 *   path containing `;` or `$(…)` is an ordinary argument.
 * - Arguments are an array. Nothing is interpolated into a command string anywhere here.
 * - Only three git subcommands are ever run, all of them read-only: `rev-parse`,
 *   `ls-files`, `cat-file`. None of them writes to the repository or the index.
 * - **`zero network calls` still holds, and it is now a stronger claim than a file scan.**
 *   `git fetch` and a submodule update are both one argument away, so the argument arrays
 *   here are fixed rather than assembled from user input, and `staged.test.ts` asserts the
 *   set of subcommands this module can run.
 * - **A read-only subcommand is not a read-only call (T113).** `core.fsmonitor` runs a
 *   configured program on `ls-files`, and in a partial clone `cat-file` on a blob that is
 *   not local fetches it from the remote. Every call switches the first off and sets
 *   `GIT_NO_LAZY_FETCH`; in a partial clone `--no-lazy-fetch` is passed too, so a git too
 *   old to honour either (both arrived in 2.44) rejects the call instead of fetching. Outside
 *   a partial clone there is nothing to fetch, so no git version is refused there.
 */

/** Where git's own root is. `undefined` when this is not a git working tree at all. */
export async function gitTopLevel(cwd: string): Promise<string | undefined> {
  try {
    const out = await run(['rev-parse', '--show-toplevel'], cwd);
    return out.trim() === '' ? undefined : out.trim();
  } catch {
    return undefined;
  }
}

/**
 * A read-only view of the git **index**, shaped as an ordinary `ReadOnlyFileSystem`.
 *
 * Shaping it this way is the whole design. `check --staged` then differs from `check` by
 * one argument — which filesystem it hands to `computePlan` and `verifyPlan` — and every
 * structural guarantee those two carry is inherited rather than re-argued: `computePlan`
 * is still the only renderer, so `--staged` cannot verify something `sync` would not
 * produce, and the object has no write method to call.
 *
 * **Both sides come from the index, deliberately.** The question a pre-commit hook is
 * asking is "if this commit lands, is the repository in sync?", so the canonical source
 * is read from the index too. Rendering from the working tree and comparing against the
 * index would report drift for a rule edited but not staged — a correct answer to a
 * question nobody asked, arriving as a blocked commit.
 */
export class StagedFileSystem implements ReadOnlyFileSystem {
  readonly #cwd: string;
  #listing: Promise<ReadonlyMap<string, true>> | undefined;
  #partial: Promise<boolean> | undefined;
  readonly #contents = new Map<string, Promise<string | undefined>>();

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  async readFile(relPath: string): Promise<string> {
    const text = await this.tryReadFile(relPath);
    if (text === undefined) {
      throw new RulegateError({
        code: 'E_GIT_NOT_STAGED',
        message: `${relPath} is not in the git index`,
        source: { file: relPath },
      });
    }
    return text;
  }

  async tryReadFile(relPath: string): Promise<string | undefined> {
    const rel = this.#rel(relPath);
    let pending = this.#contents.get(rel);
    if (pending === undefined) {
      pending = this.#show(rel);
      this.#contents.set(rel, pending);
    }
    return pending;
  }

  /**
   * Raw bytes are not available from the index without a second encoding path, and
   * nothing on the `check` route calls this — `readFileRaw` exists for `copyFile`'s
   * byte-exact backup, which is a write, which `--staged` cannot reach. Refusing is
   * honest; returning re-encoded text would be a silent lie about "raw".
   */
  readFileRaw(relPath: string): Promise<Uint8Array> {
    return Promise.reject(
      new RulegateError({
        code: 'E_GIT_NOT_STAGED',
        message: `reading raw bytes from the git index is not supported (${relPath})`,
        hint: 'this is a read-only staged view; run the command without --staged to read the working tree',
      }),
    );
  }

  async exists(relPath: string): Promise<boolean> {
    const rel = this.#rel(relPath);
    const files = await this.#files();
    if (files.has(rel)) return true;
    // A directory is not itself an index entry; it exists exactly when something is under it.
    const prefix = rel === '' ? '' : `${rel}/`;
    for (const path of files.keys()) if (path.startsWith(prefix)) return true;
    return false;
  }

  async listDir(relPath: string): Promise<readonly DirEntry[]> {
    const rel = this.#rel(relPath);
    const prefix = rel === '' || rel === '.' ? '' : `${rel}/`;
    const seen = new Map<string, DirEntry['kind']>();
    for (const path of (await this.#files()).keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      // A symlink is an index entry like any other and its mode is not read here. Nothing
      // on the `check` route asks: the symlink probe is `doctor`'s, and `doctor` has no
      // `--staged`. Reporting every entry as a file is therefore accurate for every caller
      // that exists, and wrong only for one that does not.
      if (slash === -1) seen.set(rest, 'file');
      else seen.set(rest.slice(0, slash), 'dir');
    }
    return [...seen]
      .map(([name, kind]) => ({ name, kind }))
      .sort((a, b) => compareCodepoint(a.name, b.name));
  }

  async glob(pattern: string): Promise<readonly string[]> {
    const { matchesGlob } = await import('../fs/glob.js');
    return [...(await this.#files()).keys()]
      .filter((p) => matchesGlob(p, pattern))
      .sort(compareCodepoint);
  }

  #rel(relPath: string): string {
    if (escapesRoot(relPath)) {
      throw new RulegateError({
        code: 'E_PATH_ESCAPE',
        message: `path escapes the repository root: ${relPath}`,
        source: { file: relPath },
      });
    }
    return normalizeRelative(relPath);
  }

  #files(): Promise<ReadonlyMap<string, true>> {
    this.#listing ??= this.#listFiles();
    return this.#listing;
  }

  async #listFiles(): Promise<ReadonlyMap<string, true>> {
    // `-z` because a filename may contain a newline, and `--cached` because the index is
    // the whole question — the working tree must not leak into the answer.
    const out = await run(['ls-files', '-z', '--cached'], this.#cwd);
    const files = new Map<string, true>();
    for (const name of out.split('\0')) {
      if (name !== '') files.set(normalizeRelative(name), true);
    }
    return files;
  }

  async #show(rel: string): Promise<string | undefined> {
    if (!(await this.#files()).has(rel)) return undefined;
    this.#partial ??= isPartialClone(this.#cwd);
    const partial = await this.#partial;
    let raw: string;
    try {
      // `:./` resolves the path against the process's cwd rather than the repository root,
      // which is what makes this correct when Rulegate's root is a subdirectory of git's.
      raw = await run(['cat-file', 'blob', `:./${rel}`], this.#cwd, partial);
    } catch (error) {
      if (!partial) return undefined;
      // In a partial clone the likely cause is a blob that was never downloaded, and the
      // only way to read it is the fetch this command promises not to make.
      const stderr = (error as { stderr?: unknown }).stderr;
      const old = typeof stderr === 'string' && /unknown option|usage: git/i.test(stderr);
      throw new RulegateError({
        code: 'E_GIT_FAILED',
        message: old
          ? 'this repository is a partial clone, and this git cannot read the index with lazy fetching switched off (that needs git 2.44 or newer)'
          : `${rel} is staged, but its contents are not available locally in this partial clone, and Rulegate does not fetch`,
        hint: old
          ? 'upgrade git to 2.44 or newer, or run the check without --staged'
          : `\`git cat-file -p :./${rel}\` downloads it; then run the check again`,
        source: { file: rel },
      });
    }
    // The same normalization `NodeFileSystem.readFile` applies. Without it a CRLF file
    // staged on Windows would compare unequal to the identical file read from disk, and
    // `--staged` would report drift that `check` does not — the two commands describing
    // one file two ways, which is the thing this codebase spends the most effort
    // preventing (T073).
    return normalizeText(raw);
  }
}

/**
 * Whether the repository fetches missing objects on demand: a promisor remote, recorded by a
 * partial clone as `extensions.partialClone` (or a remote's `promisor`) in the repository's
 * own config — where git itself reads it, so a global setting cannot make one.
 */
async function isPartialClone(cwd: string): Promise<boolean> {
  try {
    const dir = (await run(['rev-parse', '--git-common-dir'], cwd)).trim();
    const config = await readFile(join(isAbsolute(dir) ? dir : join(cwd, dir), 'config'), 'utf8');
    return /^\s*(partialclone\s*=\s*\S|promisor\s*=\s*true\b)/im.test(config);
  } catch {
    // Unknown is treated as partial: refusing a check is recoverable, a fetch is not.
    return true;
  }
}

/** Every subcommand this module may run. Asserted by test, so the list is the contract. */
export const GIT_SUBCOMMANDS: readonly string[] = ['rev-parse', 'ls-files', 'cat-file'];

/** Prepended to every call; asserted by test so an edit cannot drop one quietly. */
export const GIT_SAFETY_ARGS: readonly string[] = Object.freeze([
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
]);

/** Added in a partial clone, where it is the only thing standing between a read and a fetch. */
export const GIT_NO_LAZY_FETCH_ARG = '--no-lazy-fetch';

function run(args: readonly string[], cwd: string, partial = false): Promise<string> {
  const subcommand = args[0];
  if (subcommand === undefined || !GIT_SUBCOMMANDS.includes(subcommand)) {
    // Unreachable from this module's own callers, and that is the point: it is the guard
    // that keeps a future edit from adding a fourth subcommand without touching the
    // declared list — including one that reaches the network.
    return Promise.reject(
      new RulegateError({
        code: 'E_GIT_FAILED',
        message: `refusing to run git ${String(subcommand)}`,
      }),
    );
  }

  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...(partial ? [GIT_NO_LAZY_FETCH_ARG] : []), ...GIT_SAFETY_ARGS, ...args],
      // No shell, an explicit cwd, and a cap: a pathological repository must not be able
      // to make a pre-commit hook hang or exhaust memory.
      {
        cwd,
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
        shell: false,
      },
      (error, stdout, stderr) => {
        // `error` is typed loosely by the callback signature; normalize before it can
        // be stringified as `[object Object]` in somebody's terminal. stderr rides along
        // so a caller can tell an old git's usage error from a missing blob.
        if (error) {
          const e = error instanceof Error ? error : new Error('git failed');
          reject(Object.assign(e, { stderr }));
        } else resolve(stdout);
      },
    );
  });
}
