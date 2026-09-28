import type { ReadOnlyFileSystem } from './types.js';

/**
 * A read-only view in which a directory is never a file: `tryReadFile` on one is `undefined`,
 * and so is a path beneath a file, which nothing can occupy.
 *
 * Importers and detectors probe fixed paths that are a file for one tool and a directory for
 * another — `.clinerules` is Cline's legacy file and its current directory, and ruler lists
 * it among its outputs. `NodeFileSystem` throws EISDIR there, which escaped `init` from an
 * interop importer and refused the whole import from an adapter (T149). The legacy file is
 * the mirror case: a probe of `.clinerules/<name>` throws ENOTDIR, as does `.agent-os/…` or
 * `.github/…` where that name is a file, so `exists` and `listDir` answer absent there too.
 * `MemoryFileSystem` already answers that way, so this is also the two agreeing.
 *
 * A decorator on the import and detection side only, like `maskPaths`, and deliberately not
 * `NodeFileSystem`'s own behaviour: the pipeline asks `tryReadFile` whether an artifact's
 * path is free, and a directory standing there must stop `sync` before its first write,
 * not look free until `writeFile` fails half way through a run.
 */
export function filesOnly(fs: ReadOnlyFileSystem): ReadOnlyFileSystem {
  return {
    readFile: (relPath) => fs.readFile(relPath),
    async tryReadFile(relPath: string): Promise<string | undefined> {
      try {
        return await fs.tryReadFile(relPath);
      } catch (e) {
        if (notAFile(e)) return undefined;
        throw e;
      }
    },
    readFileRaw: (relPath) => fs.readFileRaw(relPath),
    async exists(relPath: string): Promise<boolean> {
      try {
        return await fs.exists(relPath);
      } catch (e) {
        if (errnoOf(e) === 'ENOTDIR') return false;
        throw e;
      }
    },
    async listDir(relPath: string) {
      try {
        return await fs.listDir(relPath);
      } catch (e) {
        if (errnoOf(e) === 'ENOTDIR') return [];
        throw e;
      }
    },
    glob: (pattern) => fs.glob(pattern),
  };
}

/** A directory where a file was asked for, or a file where a directory was. */
export function notAFile(e: unknown): boolean {
  const code = errnoOf(e);
  return code === 'EISDIR' || code === 'ENOTDIR';
}

function errnoOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined;
}
