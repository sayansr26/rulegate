import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * "Has this session seen this key before?" — the one write in the plugin (decision P3,
 * pinned by `invariants.test.ts`). The PreToolUse reminder is once per feature per session,
 * and a hook is a fresh process every time, so the memory has to live on disk. It lives in
 * the OS temp directory and nowhere else: never the repository, never `~/.claude`.
 *
 * Each marker is an empty file created with `wx` — `O_CREAT | O_EXCL`, which fails on an
 * existing file *and* on a symlink planted in its place, so the check and the claim are one
 * atomic step and no marker write follows a link. The directory must be a real directory
 * owned by this user: on a shared `/tmp`, another user could otherwise pre-create it, or a
 * link in its place, and choose where these files land.
 *
 * Any failure answers "seen before": the reminder is advisory, and a hook that cannot keep
 * its memory stays quiet rather than repeating itself on every edit.
 */
export const MARKER_DIR = 'rulegate-plugin';

/** A digest, not a character substitution: `src/a-b` and `src/a.b` must not share a marker. */
const safe = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);

export function firstInSession(
  sessionId: string,
  key: string,
  base: string = join(tmpdir(), MARKER_DIR),
): boolean {
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const st = lstatSync(base);
    if (!st.isDirectory()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    writeFileSync(join(base, `${safe(sessionId)}--${safe(key)}`), '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}
