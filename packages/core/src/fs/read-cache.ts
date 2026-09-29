import type { DirEntry, ReadOnlyFileSystem } from './types.js';

/**
 * How many reads a prefetch keeps in flight. Enough to hide per-file latency on a local disk
 * and a network mount alike, and far below the default descriptor limit (256 on macOS).
 */
const PREFETCH_CONCURRENCY = 32;

/**
 * A read-only view that reads each path at most once, and can read a known set ahead in
 * parallel (T062).
 *
 * `verifyPlan` compares every planned artifact to disk twice over — once for ownership in
 * `compareToDisk`, once for its own verdict — and awaited each read in turn, so a large
 * monorepo spent most of `check` idle between reads. This wrapper removes both costs without
 * changing a single comparison: every answer is the inner filesystem's, keyed by path, so the
 * result is identical to the sequential one whatever order the reads complete in.
 *
 * Only for a view whose disk does not change underneath it — a read-only pass, never across
 * `applyPlan`, whose writes a cache would hide from the reads after them.
 */
export class ReadCache implements ReadOnlyFileSystem {
  private readonly texts = new Map<string, Promise<string | undefined>>();
  private readonly strict = new Map<string, Promise<string>>();
  private readonly raws = new Map<string, Promise<Uint8Array>>();
  private readonly present = new Map<string, Promise<boolean>>();

  constructor(private readonly inner: ReadOnlyFileSystem) {}

  tryReadFile(relPath: string): Promise<string | undefined> {
    return memo(this.texts, relPath, () => this.inner.tryReadFile(relPath));
  }

  readFile(relPath: string): Promise<string> {
    return memo(this.strict, relPath, () => this.inner.readFile(relPath));
  }

  readFileRaw(relPath: string): Promise<Uint8Array> {
    return memo(this.raws, relPath, () => this.inner.readFileRaw(relPath));
  }

  exists(relPath: string): Promise<boolean> {
    return memo(this.present, relPath, () => this.inner.exists(relPath));
  }

  listDir(relPath: string): Promise<readonly DirEntry[]> {
    return this.inner.listDir(relPath);
  }

  glob(pattern: string): Promise<readonly string[]> {
    return this.inner.glob(pattern);
  }

  /**
   * Read these paths ahead, at most `PREFETCH_CONCURRENCY` at a time: as text, or — for a
   * binary artifact — as existence and raw bytes, the two reads `hashOnDisk` makes. A failure
   * is not raised here; it is cached, and surfaces where the read is actually asked for, as it
   * would have without the prefetch.
   */
  async prefetch(paths: readonly { path: string; raw: boolean }[]): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        const { path, raw } = paths[next++]!;
        if (!raw) {
          await this.tryReadFile(path).catch(() => undefined);
        } else if (await this.exists(path).catch(() => false)) {
          await this.readFileRaw(path).catch(() => undefined);
        }
      }
    };
    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
  }
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let hit = cache.get(key);
  if (hit === undefined) {
    hit = read();
    cache.set(key, hit);
  }
  return hit;
}
