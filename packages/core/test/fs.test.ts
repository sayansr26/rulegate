import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/io/memory.js';
import { escapesRoot, normalizeRelative } from '../src/fs/paths.js';
import { literalPrefix, matchesGlob, mayContain } from '../src/fs/glob.js';
import { ensureSingleTrailingNewline, normalizeText } from '../src/render/eol.js';

describe('path safety', () => {
  it.each([
    ['/etc/passwd', true],
    ['C:\\Windows', true],
    ['../outside.md', true],
    ['a/../../outside.md', true],
    ['', true],
    ['a/../b.md', false],
    ['.rulegate/rules/style.md', false],
  ])('escapesRoot(%s) === %s', (input, expected) => {
    expect(escapesRoot(input)).toBe(expected);
  });

  it('normalizes to POSIX with no . or .. segments', () => {
    expect(normalizeRelative('./a/b/../c.md')).toBe('a/c.md');
  });
});

describe('glob', () => {
  it.each([
    ['.rulegate/rules/a.md', '.rulegate/rules/**/*.md', true],
    ['.rulegate/rules/nested/a.md', '.rulegate/rules/**/*.md', true],
    ['.rulegate/rules/a.txt', '.rulegate/rules/**/*.md', false],
    ['src/a.ts', 'src/*.ts', true],
    ['src/nested/a.ts', 'src/*.ts', false],
  ])('matchesGlob(%s, %s) === %s', (p, pattern, expected) => {
    expect(matchesGlob(p, pattern)).toBe(expected);
  });

  /**
   * `literalPrefix` and `mayContain` let the walker skip subtrees. Being wrong costs a
   * *missing* file rather than a slow one — a rule that silently never renders — so the
   * pruning is pinned separately from the matcher it optimises.
   */
  it.each([
    ['packages/a/.rulegate/rules/**/*.md', 'packages/a/.rulegate/rules'],
    ['.rulegate/rules/**/*.md', '.rulegate/rules'],
    ['**/.rulegate/rulegate.yaml', ''],
    ['CLAUDE.md', ''],
    // A wildcard segment narrows nothing safely: which directory it names is not known
    // until the directory is read.
    ['packages/*/rules/*.md', 'packages'],
    ['.cursor/rules/*.mdc', '.cursor/rules'],
  ])('literalPrefix(%s) === %s', (pattern, expected) => {
    expect(literalPrefix(pattern)).toBe(expected);
  });

  it.each([
    // On the way down to the prefix.
    ['packages', 'packages/a/.rulegate/rules', true],
    ['packages/a', 'packages/a/.rulegate/rules', true],
    // At or below it.
    ['packages/a/.rulegate/rules', 'packages/a/.rulegate/rules', true],
    ['packages/a/.rulegate/rules/nested', 'packages/a/.rulegate/rules', true],
    // A different branch entirely.
    ['packages/b', 'packages/a/.rulegate/rules', false],
    ['docs', 'packages/a/.rulegate/rules', false],
    // The near-miss that a `startsWith` without the separator would get wrong.
    ['packages/ab', 'packages/a/.rulegate/rules', false],
    // No prefix means no pruning at all.
    ['anything/at/all', '', true],
  ])('mayContain(%s, %s) === %s', (dir, prefix, expected) => {
    expect(mayContain(dir, prefix)).toBe(expected);
  });

  it('finds the same files with pruning as an unpruned walk would', async () => {
    const fs = new MemoryFileSystem([
      ['.rulegate/rules/10-style.md', 'a'],
      ['.rulegate/rules/nested/20-deep.md', 'b'],
      ['packages/a/.rulegate/rules/30-a.md', 'c'],
      ['packages/ab/.rulegate/rules/40-ab.md', 'd'],
      ['docs/readme.md', 'e'],
    ]);

    expect(await fs.glob('packages/a/.rulegate/rules/**/*.md')).toEqual([
      'packages/a/.rulegate/rules/30-a.md',
    ]);
    expect(await fs.glob('.rulegate/rules/**/*.md')).toEqual([
      '.rulegate/rules/10-style.md',
      '.rulegate/rules/nested/20-deep.md',
    ]);
    expect((await fs.glob('**/.rulegate/rules/**/*.md')).length).toBe(4);
  });
});

describe('MemoryFileSystem', () => {
  it('normalizes CRLF and strips the BOM on read', async () => {
    const fs = new MemoryFileSystem([['a.md', '\uFEFFone\r\ntwo\r\n']]);
    expect(await fs.readFile('a.md')).toBe('one\ntwo\n');
  });

  it('returns listings and globs in codepoint order, not insertion order', async () => {
    const fs = new MemoryFileSystem([
      ['r/z.md', 'z'],
      ['r/a.md', 'a'],
      ['r/m.md', 'm'],
    ]);
    expect((await fs.listDir('r')).map((e) => e.name)).toEqual(['a.md', 'm.md', 'z.md']);
    expect(await fs.glob('r/*.md')).toEqual(['r/a.md', 'r/m.md', 'r/z.md']);
  });

  it('refuses reads that escape the repository root', async () => {
    const fs = new MemoryFileSystem();
    await expect(fs.tryReadFile('../secrets')).rejects.toThrow(/escapes the repository root/);
  });
});

describe('text normalization', () => {
  it.each([
    ['a', 'a\n'],
    ['a\n', 'a\n'],
    ['a\n\n\n', 'a\n'],
    ['', ''],
  ])('ensureSingleTrailingNewline(%j) === %j', (input, expected) => {
    expect(ensureSingleTrailingNewline(input)).toBe(expected);
  });

  it('makes CRLF and LF sources indistinguishable', () => {
    expect(normalizeText('a\r\nb')).toBe(normalizeText('a\nb'));
  });
});
