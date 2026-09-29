import { describe, expect, it } from 'vitest';
import { ReadCache } from '../src/fs/read-cache.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import type { ReadOnlyFileSystem } from '../src/fs/types.js';

/**
 * T062: the cache `verifyPlan` and `applyPlan` read through must answer exactly as the disk
 * would — once per path, with the disk's errors where the disk would raise them.
 */

function counting(inner: ReadOnlyFileSystem) {
  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const track =
    <T>(name: string, read: (p: string) => Promise<T>) =>
    async (p: string): Promise<T> => {
      calls.push(`${name} ${p}`);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 1));
        return await read(p);
      } finally {
        inFlight -= 1;
      }
    };
  const fs: ReadOnlyFileSystem = {
    readFile: track('readFile', (p) => inner.readFile(p)),
    tryReadFile: track('tryReadFile', (p) => inner.tryReadFile(p)),
    readFileRaw: track('readFileRaw', (p) => inner.readFileRaw(p)),
    exists: track('exists', (p) => inner.exists(p)),
    listDir: (p) => inner.listDir(p),
    glob: (p) => inner.glob(p),
  };
  return { fs, calls, peak: () => peak };
}

describe('ReadCache (T062)', () => {
  it('reads each path once, and answers as the filesystem does', async () => {
    const disk = counting(new MemoryFileSystem([['a.md', 'A\n']]));
    const cache = new ReadCache(disk.fs);
    expect(await cache.tryReadFile('a.md')).toBe('A\n');
    expect(await cache.tryReadFile('a.md')).toBe('A\n');
    expect(await cache.tryReadFile('missing.md')).toBeUndefined();
    expect(await cache.exists('missing.md')).toBe(false);
    expect(disk.calls).toEqual(['tryReadFile a.md', 'tryReadFile missing.md', 'exists missing.md']);
  });

  it('prefetches text and bytes in parallel, never more than 32 at a time', async () => {
    const files: [string, string | Uint8Array][] = [];
    for (let i = 0; i < 100; i++) files.push([`t/${i}.md`, `${i}\n`]);
    files.push(['b.png', new Uint8Array([0x89, 0x50])]);
    const disk = counting(new MemoryFileSystem(files));
    const cache = new ReadCache(disk.fs);
    await cache.prefetch([
      ...files.slice(0, 100).map(([path]) => ({ path, raw: false })),
      { path: 'b.png', raw: true },
      { path: 'gone.png', raw: true },
    ]);
    expect(disk.peak()).toBeGreaterThan(1);
    expect(disk.peak()).toBeLessThanOrEqual(32);
    const before = disk.calls.length;
    expect(await cache.tryReadFile('t/7.md')).toBe('7\n');
    expect(await cache.readFileRaw('b.png')).toEqual(new Uint8Array([0x89, 0x50]));
    expect(await cache.exists('gone.png')).toBe(false);
    expect(disk.calls.length).toBe(before);
  });

  it('raises a read failure where the read is asked for, not in the prefetch', async () => {
    const failing: ReadOnlyFileSystem = {
      ...new MemoryFileSystem([]),
      tryReadFile: () => Promise.reject(new Error('EACCES: denied')),
      readFile: () => Promise.reject(new Error('unused')),
      readFileRaw: () => Promise.reject(new Error('unused')),
      exists: () => Promise.resolve(true),
      listDir: () => Promise.resolve([]),
      glob: () => Promise.resolve([]),
    };
    const cache = new ReadCache(failing);
    await expect(cache.prefetch([{ path: 'x.md', raw: false }])).resolves.toBeUndefined();
    await expect(cache.tryReadFile('x.md')).rejects.toThrow('EACCES: denied');
  });
});
