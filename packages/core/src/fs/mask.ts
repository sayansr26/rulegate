import type { DirEntry, ReadOnlyFileSystem } from './types.js';

/**
 * A read-only view of a filesystem with some paths hidden.
 *
 * Interop needs this because ruler and rulesync **generate the very files Rulegate's
 * adapters import from**. Run both passes over the same tree and every rule arrives twice:
 * once from `.ruler/*.md`, the source a user actually edits, and once from the `AGENTS.md`
 * ruler built out of it. Masking the observed outputs during the adapter pass keeps the
 * source and drops the copy.
 *
 * A decorator rather than a flag on `collectImports`: the adapters must not know that this
 * is happening, and a filesystem is the seam that already exists for showing them a
 * different view of the tree — `StagedFileSystem` (T046) does the same thing for the git
 * index. It carries no write methods, so nothing here can widen what an importer may do.
 *
 * A hidden entry hides what is under it too (T133): rulesync reports `.clinerules` as one
 * output, a directory, and an exact-path mask let the Cline adapter read `.clinerules/*.md`
 * through it and import every rule a second time.
 */
export function maskPaths(fs: ReadOnlyFileSystem, hidden: Iterable<string>): ReadOnlyFileSystem {
  const masked = new Set([...hidden].map((p) => p.replace(/\/+$/, '')));
  const isMasked = (relPath: string): boolean => {
    if (masked.has(relPath)) return true;
    for (let at = relPath.indexOf('/'); at !== -1; at = relPath.indexOf('/', at + 1)) {
      if (masked.has(relPath.slice(0, at))) return true;
    }
    return false;
  };

  return {
    async readFile(relPath: string): Promise<string> {
      if (isMasked(relPath)) throw notFound(relPath);
      return fs.readFile(relPath);
    },
    async tryReadFile(relPath: string): Promise<string | undefined> {
      return isMasked(relPath) ? undefined : fs.tryReadFile(relPath);
    },
    async readFileRaw(relPath: string): Promise<Uint8Array> {
      if (isMasked(relPath)) throw notFound(relPath);
      return fs.readFileRaw(relPath);
    },
    async exists(relPath: string): Promise<boolean> {
      return isMasked(relPath) ? false : fs.exists(relPath);
    },
    async listDir(relPath: string): Promise<readonly DirEntry[]> {
      const prefix = relPath === '' ? '' : `${relPath}/`;
      const entries = await fs.listDir(relPath);
      return entries.filter((e) => !isMasked(`${prefix}${e.name}`));
    },
    async glob(pattern: string): Promise<readonly string[]> {
      return (await fs.glob(pattern)).filter((p) => !isMasked(p));
    },
  };
}

function notFound(relPath: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, ${relPath}`);
  error.code = 'ENOENT';
  return error;
}
