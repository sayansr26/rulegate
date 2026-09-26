import { isUtf8 } from 'node:buffer';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * Filesystem reads that never throw. Every plugin script is advisory and hooks must never
 * fail a session, so an unreadable file is an absent one — and the audit reports absence,
 * which is the useful answer, where an exception would end the audit before it reached the
 * findings that explain it.
 */

/**
 * Larger than any instruction or settings file worth reading. A repository controls what
 * these paths are, and git commits symlinks: `CLAUDE.md -> /dev/zero` is a device that never
 * ends, and a hook that reads it hangs the session until Claude Code's timeout. So a read
 * follows a symlink — `CLAUDE.md -> AGENTS.md` is a real setup — but only to a regular
 * file, and only one this size or smaller.
 */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

export function read(path: string): string | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether `read()` returned the file's bytes exactly. It decodes as UTF-8, and a Latin-1
 * `CLAUDE.md` comes back with U+FFFD in place of every byte it could not decode — harmless to
 * a reader, but a writer that writes that text back has destroyed the original. `false`
 * when the file cannot be read at all.
 */
export function isUtf8File(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size <= MAX_READ_BYTES && isUtf8(readFileSync(path));
  } catch {
    return false;
  }
}

/**
 * `read(join(root, rel))`, but only when the file's real path is inside the root. For files
 * whose contents go into Claude's context on the repository's say-so — the session hook's
 * handoff note — a committed symlink to `~/.ssh/id_rsa` must read as absent.
 */
export function readInRepo(root: string, rel: string): string | undefined {
  try {
    const target = realpathSync(join(root, rel));
    const within = relative(realpathSync(root), target);
    if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      return undefined;
    }
    return read(target);
  } catch {
    return undefined;
  }
}

/** Parsed JSON; `undefined` when absent, `'INVALID'` when present and unparseable. */
export function readJson(path: string): unknown {
  const text = read(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return 'INVALID';
  }
}

/** Directory entries, sorted by code point so output is stable across platforms. */
export function ls(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A directory that is not a symlink. Every recursive walk uses this, never `isDir`: three
 * committed links to `.` make a tree whose walk is exponential until the OS's ELOOP limit.
 */
export function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Anything at all at `path`, a dangling symlink included — the question a writer asks
 * before claiming a name, where `read()`'s "absent" would be the wrong answer.
 */
export function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Modification time in ms since the epoch, for a regular file; `undefined` otherwise. */
export function mtimeMs(path: string): number | undefined {
  try {
    const st = statSync(path);
    return st.isFile() ? st.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

export function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
