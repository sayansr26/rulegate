import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadOnlyFileSystem, NodeFileSystem } from '../src/io/node.js';
import { filesOnly } from '../src/fs/files-only.js';
import { maskPaths } from '../src/fs/mask.js';

/**
 * "Read-only by construction" has to be a fact about the object, not about the type.
 * `createHomeFileSystem` learned this at T016: a `NodeFileSystem` typed as
 * `ReadOnlyFileSystem` still carried its writers, one cast away. `check` holds this.
 */
describe('createReadOnlyFileSystem', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rulegate-ro-'));
    await writeFile(path.join(root, 'a.md'), 'hello\r\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('has no write method on the object at all', () => {
    const fs = createReadOnlyFileSystem(root);
    expect(Object.keys(fs).sort()).toEqual([
      'exists',
      'glob',
      'listDir',
      'readFile',
      'readFileRaw',
      'tryReadFile',
    ]);
    expect('writeFile' in fs).toBe(false);
    expect('deleteFile' in fs).toBe(false);
    expect('copyFile' in fs).toBe(false);
    // Control: the thing it wraps does have them, so the absence above is the function's doing.
    expect('writeFile' in new NodeFileSystem(root)).toBe(true);
  });

  it('reads through the same normalizing path as NodeFileSystem', async () => {
    const fs = createReadOnlyFileSystem(root);
    expect(await fs.readFile('a.md')).toBe('hello\n');
    expect(await fs.tryReadFile('missing.md')).toBeUndefined();
    expect(await fs.exists('a.md')).toBe(true);
    expect(await fs.glob('*.md')).toEqual(['a.md']);
    expect(new TextDecoder().decode(await fs.readFileRaw('a.md'))).toBe('hello\r\n');
  });

  it('inherits containment: a path escaping the root is refused', async () => {
    const fs = createReadOnlyFileSystem(root);
    await expect(fs.readFile('../outside.md')).rejects.toMatchObject({ code: 'E_PATH_ESCAPE' });
  });
});

/**
 * `.clinerules` is Cline's legacy file and its current directory, and importers probe it by
 * name. A directory there is not that tool's file, and must not throw EISDIR out of `init`
 * (T156).
 */
describe('filesOnly', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rulegate-files-only-'));
    await mkdir(path.join(root, '.clinerules'));
    await writeFile(path.join(root, '.clinerules/style.md'), 'Tabs.\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('answers undefined for a directory, where NodeFileSystem throws EISDIR', async () => {
    const node = new NodeFileSystem(root);
    // The control: without the decorator this is the crash.
    await expect(node.tryReadFile('.clinerules')).rejects.toMatchObject({ code: 'EISDIR' });
    const fs = filesOnly(node);
    expect(await fs.tryReadFile('.clinerules')).toBeUndefined();
    // And through a mask, which is how init hands it to the adapters.
    expect(await maskPaths(fs, ['AGENTS.md']).tryReadFile('.clinerules')).toBeUndefined();
  });

  it('changes nothing else: files read, the directory still exists and lists', async () => {
    const fs = filesOnly(new NodeFileSystem(root));
    expect(await fs.tryReadFile('.clinerules/style.md')).toBe('Tabs.\n');
    expect(await fs.tryReadFile('missing.md')).toBeUndefined();
    expect(await fs.exists('.clinerules')).toBe(true);
    expect(await fs.glob('.clinerules/*.md')).toEqual(['.clinerules/style.md']);
    await expect(fs.tryReadFile('../outside.md')).rejects.toMatchObject({
      code: 'E_PATH_ESCAPE',
    });
  });

  it('answers absent beneath a file, where NodeFileSystem throws ENOTDIR', async () => {
    // The mirror case: Cline's legacy `.clinerules` file, probed as the directory it is now.
    await writeFile(path.join(root, '.agent-os'), 'not a directory\n');
    const node = new NodeFileSystem(root);
    // The premise holds on POSIX only: Windows answers ENOENT there, which NodeFileSystem
    // already reports as absent. Either way filesOnly must answer absent.
    if (process.platform !== 'win32') {
      await expect(node.tryReadFile('.agent-os/config.json')).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
      await expect(node.exists('.agent-os/config.json')).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    }
    const fs = filesOnly(node);
    expect(await fs.tryReadFile('.agent-os/config.json')).toBeUndefined();
    expect(await fs.exists('.agent-os/config.json')).toBe(false);
    expect(await fs.listDir('.agent-os')).toEqual([]);
    expect(await fs.exists('.agent-os')).toBe(true);
  });
});
