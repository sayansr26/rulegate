import type { DirEntry, ReadOnlyFileSystem } from './types.js';

/**
 * Path identity on a case-insensitive filesystem (T077).
 *
 * `computePlan` has case-folded its artifact-path conflict key since T063, because two
 * artifacts differing only in case are two entries for **one physical file** on APFS and
 * NTFS. Nothing downstream agreed: `state.json` lookups and `compareToDisk` matched paths
 * exactly, so a recorded `CLAUDE.md` and a planned `claude.md` were treated as two files —
 * which made `sync` refuse to write one of them as `unmanaged` *and* delete the other as an
 * orphan, both being the same file on disk.
 *
 * Two rules keep this from becoming a general "paths are case-insensitive" policy, which
 * would be wrong:
 *
 * 1. **Fold the lookup key, never the stored value.** A `StateArtifact.path` is written
 *    into a committed file and is what every message names; lower-casing it would put a
 *    spurious diff in every adopted repository and report a filename nobody has. Only map
 *    and set keys are folded.
 * 2. **Fold only where the filesystem actually folds.** On ext4 `CLAUDE.md` and
 *    `claude.md` are two real files, and treating them as one would leave a stale artifact
 *    on disk at exit 0 — the exact wrong answer T067 exists to fix. So the answer comes
 *    from `probeCaseInsensitive`, which asks the filesystem, rather than from
 *    `process.platform`, which is not evidence: a case-sensitive volume can be mounted on
 *    macOS and a case-insensitive one on Linux.
 *
 * Folding for *identity* is not folding for *order*. Every sort stays on
 * `compareCodepoint`; see `docs/determinism.md`.
 */

/** Case-fold a repo-relative path for use as an identity key. Never a stored value. */
export function foldPath(relPath: string): string {
  // `toLowerCase`, not `toLocaleLowerCase`: the locale-sensitive form makes the answer
  // depend on the host's locale, which `invariants.test.ts` bans for the same reason it
  // bans `.localeCompare`. `plan.ts` already folds this way.
  return relPath.toLowerCase();
}

/**
 * Normalise a repo-relative path to NFC for use as an identity key (T114). APFS resolves
 * `café` spelled NFC and spelled NFD to one file; ext4 keeps them as two. Never a stored value,
 * for the reason `foldPath` gives.
 */
export function foldUnicode(relPath: string): string {
  return relPath.normalize('NFC');
}

/** How to key a path for lookup. Identity where the filesystem distinguishes the spellings. */
export type PathKey = (relPath: string) => string;

export function pathKeyFor(caseInsensitive: boolean, normalizationInsensitive = false): PathKey {
  if (caseInsensitive && normalizationInsensitive) return (p) => foldPath(foldUnicode(p));
  if (normalizationInsensitive) return foldUnicode;
  return caseInsensitive ? foldPath : (relPath) => relPath;
}

/**
 * Does this filesystem resolve the NFC and NFD spellings of a name to one file (T114)?
 *
 * Asked of `candidates` — the paths about to be looked up — rather than of the root, which
 * `probeCaseInsensitive` can use because almost every name has a cased letter, while almost
 * no repository root has a name with a precomposed character. A path whose two spellings
 * are equal cannot answer, and needs no answer: no key it produces differs either way. So the
 * probe answers exactly when it matters, and otherwise keeps today's exact keys.
 *
 * The rule from `probeCaseInsensitive` holds: a directory listing both spellings has two
 * real files, so it proves nothing and is skipped.
 */
export async function probeNormalizationInsensitive(
  fs: Pick<ReadOnlyFileSystem, 'listDir' | 'exists'>,
  candidates: readonly string[],
): Promise<boolean> {
  for (const path of candidates) {
    const nfc = path.normalize('NFC');
    const nfd = path.normalize('NFD');
    if (nfc === nfd) continue;
    const other = path === nfc ? nfd : nfc;
    try {
      if (!(await fs.exists(path))) continue;
      const slash = path.lastIndexOf('/');
      const dir = slash === -1 ? '' : path.slice(0, slash);
      const names = new Set((await fs.listDir(dir)).map((e) => e.name));
      const name = path.slice(slash + 1);
      const otherName = other.slice(other.lastIndexOf('/') + 1);
      if (names.has(name) && names.has(otherName)) continue;
      return await fs.exists(other);
    } catch {
      continue;
    }
  }
  return false;
}

/** The same name with every cased character flipped. Unchanged if it has none. */
function flipCase(name: string): string {
  let flipped = '';
  for (const char of name) {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    flipped += char === lower ? upper : lower;
  }
  return flipped;
}

/**
 * Does this filesystem resolve two names differing only in case to one file?
 *
 * Read-only, and asked of the filesystem it is given rather than of the platform, so a
 * `MemoryFileSystem` and the git index view behind `check --staged` both answer "no" on
 * their own account — which is correct for the index, where git genuinely tracks
 * `CLAUDE.md` and `claude.md` as two entries.
 *
 * A directory that already lists both spellings is skipped rather than believed: the
 * second file is real there, not an alias for the first, so it proves nothing either way.
 */
export async function probeCaseInsensitive(
  // Only the two methods it calls: the Claude Code plugin's PreToolUse guard (T100) asks the
  // same question with a two-method view, rather than bundling a filesystem class whose
  // other half writes.
  fs: Pick<ReadOnlyFileSystem, 'listDir' | 'exists'>,
): Promise<boolean> {
  let entries: readonly DirEntry[];
  try {
    entries = await fs.listDir('');
  } catch {
    return false;
  }

  const listed = new Set(entries.map((e) => e.name));
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const flipped = flipCase(entry.name);
    // Skip any candidate the directory already lists. That covers both ways this question
    // goes unanswerable, which is why it is one check rather than two: a name with no
    // cased character flips to itself and is trivially listed, and a directory genuinely
    // holding both spellings has a real second file there — its existence is not evidence
    // of folding. An explicit "no cased character" branch ahead of this one was written
    // first and deleted: no input could reach it, which makes it a comment, not a guard.
    if (listed.has(flipped)) continue;
    return await fs.exists(flipped);
  }

  // Nothing at the root could answer. Assume case-sensitive, which is the behaviour
  // Rulegate had before this existed: a probe that cannot tell must not start folding.
  return false;
}
